#!/usr/bin/env python3
"""Screenshot a generated map in the real Warsow client, headless.

    screenshots.py build/gen_first_light.pk3 --spec examples/gen_first_light.json \\
        --warsow ~/warsow-2.1.2 --out shots/

Needs the stock Warsow 2.1.2 client (the tarball server/Dockerfile downloads
has it), Xvfb, xdotool and a software GL (Mesa llvmpipe is fine). Output is one
PNG per view, taken by the engine's own `screenshot` command, so what you see
is exactly what a player sees: real lightmaps, real textures, the real
renderer.

HOW A VIEW IS PLACED. The race gametype script overrides the engine's
`position` command with its own save/load version that has no `set`, and it
picks a spectator's first spot itself from info_player_deathmatch, ignoring
info_player_intermission. So each view is its own copy of the
compiled bsp with the spawn point moved to the camera. That is an entity-lump
edit through tools/mapfix/bsp.py, with no recompile. Two engine rules shape
what a view can be: a spawn point is dropped to the floor below it
(G_DropSpawnpointToFloor), and only its yaw reaches the view
(p_client.cpp:628). So every view is level, at a racer's eye height. That is
the view a player judges a course by. The top-down plan (.svg) is the
overview. The
client loads the copies in turn with bound `map` commands. Nothing about the
real map is changed, and the copies are deleted afterwards.

Views come from the course itself (layout.Course.landmarks): the start, every
gap, checkpoint and shortcut, and the finish. Pass --views to use your own
[[name, [x, y, z], yaw], ...] instead; z only needs to be above the floor you
want to stand on.

OVERVIEW (--overview). Level views cannot show a course from above, so the
overview recompiles the map with invisible camera pads high over it
(layout._camera_pads; the sky shell grows to contain them). It then drops the
spectator onto a pad and tilts the view down by holding +lookdown for
pitch / cl_pitchspeed seconds, since that is the one control over pitch a
client has. It needs q3map2 as well as the client. Each overview view runs in
its own client session, so no pitch carries over from one to the next.

FLY-THROUGH (--flythrough VIDEO.webm). A start-to-finish video along the
course's centre line (flight_path), filmed frame by frame: the client loads
the map under the dm gametype, whose `position set` the race script does not
override, teleports the spectator for each frame and takes a JPEG screenshot,
which is piped to ffmpeg (MJPEG in, VP8 WebM out). The engine allows one
`position` command per 500 ms, so a 30 s video takes about ten minutes.
"""

import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "mapfix"))

import layout  # noqa: E402
from bsp import Bsp  # noqa: E402
from entities import EntityLump  # noqa: E402

KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
PREFIX = "zz_mapgen_view_"


CLOSE_UP = {"beam": 160, "split": 224}


def _back_along_route(route, pos, back):
    """The point `back` units before `pos` along the course's centre line
    (a polyline of (x, y, z)), or None if pos is not on it. pos may lie
    anywhere on an edge (a checkpoint in the middle of a straight). The edge
    is chosen in 3-D, so a landmark on an overpass is never matched to the
    corridor passing under it."""
    if len(route) < 2:
        return None
    best = None
    for k in range(1, len(route)):
        a, b = route[k - 1], route[k]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dy) / L2))
        q = tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
        d = math.dist(q, pos)
        if best is None or d < best[0]:
            best = (d, k, q)
    _, k, q = best
    if math.dist(q[:2], pos[:2]) > 1.0:
        return None
    left, here = back, q
    while k > 0:
        a = route[k - 1]
        d = math.dist(a[:2], here[:2])
        if d >= left:
            t = left / d if d else 0.0
            return tuple(here[i] + (a[i] - here[i]) * t for i in range(3))
        left -= d
        here = a
        k -= 1
    return tuple(route[0])


def auto_views(course):
    """Camera spots that show what matters on a race course."""
    views = []

    def behind(pos, heading, back, name):
        h = math.radians(heading)
        x = pos[0] - math.cos(h) * back
        y = pos[1] - math.sin(h) * back
        views.append([name, [round(x), round(y), round(pos[2] + 32)], round(heading) % 360])

    def along(pos, back, name):
        # Walk back along the centre line rather than straight back along the
        # heading: the camera then stands on the floor that is really there
        # (a ramp behind a landmark is lower or higher than the landmark) and
        # inside the corridor through a turn. It looks at the landmark.
        cam = _back_along_route(course.route, pos, back)
        if cam is None:
            return False
        yaw = math.degrees(math.atan2(pos[1] - cam[1], pos[0] - cam[0])) % 360
        views.append([name, [round(cam[0]), round(cam[1]), round(cam[2] + 32)], round(yaw) % 360])
        return True

    counts = {}
    width = course.spec["width"]
    for kind, pos, heading in course.landmarks:
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "start":
            behind(pos, heading, layout.ROOM_LEN - layout.SPAWN_BACK, "start")
        elif kind == "shortcut":
            # From the far side of the corridor, looking out of the window
            # along the line of stepping stones.
            behind(pos, heading, width - 48, f"shortcut{counts[kind]}")
        else:
            name = "finish" if kind == "stop" else f"{kind}{counts[kind]}"
            # Close enough that a beam or a split's two lanes fill the frame.
            back = CLOSE_UP.get(kind, 448)
            if not along(pos, back, name):
                behind(pos, heading, back, name)
    if len(views) <= len(KEYS):
        return views
    # More landmarks than keys: the start, the finish and the first of every
    # kind come first, then the rest in course order, and the pick is shown
    # in course order.
    firsts = {0, len(views) - 1}
    seen = set()
    for i, v in enumerate(views):
        kind = v[0].rstrip("0123456789")
        if kind not in seen:
            seen.add(kind)
            firsts.add(i)
    pick = sorted(firsts)[:len(KEYS)]
    pick += [i for i in range(len(views)) if i not in firsts][:len(KEYS) - len(pick)]
    return [views[i] for i in sorted(pick)]


# The client's field of view (cg_fov 100 across) at 16:9: half-angles used to
# fit the course in frame, with some room to spare.
HALF_FOV_X = math.radians(50)
HALF_FOV_Y = math.atan(math.tan(HALF_FOV_X) * 9 / 16)
PITCH_SPEED = 30.0   # cl_pitchspeed while tilting, degrees per second


def overview_views(course):
    """Two views from the air: straight down, and a three-quarter look from
    beyond the start side. Each is [name, pad (x, y, z), yaw, pitch]."""
    xs = [x for poly, _ in course.floor_polys for x, _ in poly]
    ys = [y for poly, _ in course.floor_polys for _, y in poly]
    zs = [z for _, _, z in course.route]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cx, cy, top = (x0 + x1) / 2, (y0 + y1) / 2, max(zs)
    ex, ey = x1 - x0, y1 - y0
    # Put the course's long axis across the screen. Looking down with yaw
    # 90, screen-up is +Y and screen-across is X.
    yaw = 90 if ex >= ey else 0
    across, along = (ex, ey) if yaw == 90 else (ey, ex)
    h = 1.15 * max(across / 2 / math.tan(HALF_FOV_X), along / 2 / math.tan(HALF_FOV_Y))
    views = [["overview_top", [round(cx), round(cy), round(top + h)], yaw, 89]]
    # Three-quarter: back off from the centre along -screen-up and rise so
    # the centre sits in the middle of a 40-degree downward look.
    pitch = 40
    back = 0.55 * along + 0.6 * across
    bx = cx - math.cos(math.radians(yaw)) * back
    by = cy - math.sin(math.radians(yaw)) * back
    views.append(["overview_angle", [round(bx), round(by), round(top + back * math.tan(math.radians(pitch)))],
                  yaw, pitch])
    return views


def tga_to_png(tga_path, png_path):
    d = open(tga_path, "rb").read()
    idlen, itype = d[0], d[2]
    w, h, bpp, desc = struct.unpack_from("<HHBB", d, 12)
    if itype != 2 or bpp not in (24, 32):
        raise ValueError(f"{tga_path}: unsupported TGA type {itype}/{bpp}")
    n, off = bpp // 8, 18 + idlen
    rows = [d[off + y * w * n: off + (y + 1) * w * n] for y in range(h)]
    if not desc & 0x20:
        rows.reverse()
    raw = bytearray()
    for r in rows:
        raw.append(0)
        for x in range(w):
            raw += bytes((r[x * n + 2], r[x * n + 1], r[x * n]))

    def chunk(t, body):
        return struct.pack(">I", len(body)) + t + body + struct.pack(">I", zlib.crc32(t + body) & 0xFFFFFFFF)

    with open(png_path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n"
                 + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                 + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def stage_views(pk3_path, views, basewsw):
    """Write one pk3 per view into the client's basewsw; return map names."""
    with zipfile.ZipFile(pk3_path) as src:
        member = next(n for n in src.namelist() if n.startswith("maps/") and n.endswith(".bsp"))
        others = {n: src.read(n) for n in src.namelist() if n != member}
        bsp_bytes = src.read(member)
    for f in os.listdir(basewsw):
        if f.startswith(PREFIX):
            os.remove(os.path.join(basewsw, f))
    names = []
    for i, view in enumerate(views):
        _, (x, y, z), yaw = view[:3]
        b = Bsp(bsp_bytes)
        lump = EntityLump(b.entity_text())
        spawns = [e for e in lump.entities if e.classname == "info_player_deathmatch"]
        if not spawns:
            raise RuntimeError("map has no info_player_deathmatch to move")
        for e in spawns:
            # "angle" is yaw only and would win over "angles" if parsed later.
            e.pairs = [(k, v) for k, v in e.pairs if k != "angle"]
            e.set("origin", f"{x} {y} {z}")
            e.set("angles", f"0 {yaw} 0")
        b.set_entity_text(lump.render())
        name = f"{PREFIX}{i}"
        with zipfile.ZipFile(os.path.join(basewsw, name + ".pk3"), "w") as zf:
            zf.writestr(f"maps/{name}.bsp", b.bytes())
            for n, data in others.items():
                zf.writestr(n, data)
        names.append(name)
    return names


class _Client:
    """One headless Warsow client session: Xvfb, the stock client with a
    private home directory, a startup cfg, and helpers to press keys, wait
    for map loads and take screenshots."""

    def __init__(self, warsow, cfg, first_map, gametype="race", width=1280, height=720,
                 display=":77"):
        self.home = tempfile.mkdtemp(prefix="mapgen-wsw-")
        self.udir = os.path.join(self.home, ".local/share/warsow-2.1/basewsw")
        os.makedirs(self.udir)
        self.console = os.path.join(self.udir, "console.log")
        with open(os.path.join(self.udir, "mapgen_views.cfg"), "w") as fh:
            fh.write("\n".join(cfg) + "\n")
        self.env = dict(os.environ, HOME=self.home, DISPLAY=display,
                        LIBGL_ALWAYS_SOFTWARE="1", SDL_AUDIODRIVER="dummy")
        self.xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{width}x{height}x24"],
                                     stderr=subprocess.DEVNULL)
        time.sleep(2)
        self.game = subprocess.Popen(
            ["./warsow.x86_64", "+set", "logconsole", "console.log", "+set", "logconsole_flush", "1",
             "+set", "s_module", "0", "+set", "vid_fullscreen", "0", "+set", "vid_mode", "-1",
             "+set", "vid_customwidth", str(width), "+set", "vid_customheight", str(height),
             "+set", "g_gametype", gametype, "+exec", "mapgen_views.cfg", "+map", first_map],
            cwd=warsow, env=self.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def text(self):
        try:
            with open(self.console, errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def key(self, k):
        subprocess.run(["xdotool", "key", "--clearmodifiers", k], env=self.env)

    def loaded(self, n):
        t0 = time.time()
        while self.text().count("connected from loopback") < n:
            if time.time() - t0 > 240 or self.game.poll() is not None:
                raise RuntimeError("client did not load the map:\n" + self.text()[-1500:])
            time.sleep(1)
        time.sleep(8)          # let the first frames settle
        self.key("Escape")     # dismiss the join menu a spectator gets
        time.sleep(2)
        if n == 1:
            wid = subprocess.run(["xdotool", "search", "--name", "Warsow"], env=self.env,
                                 capture_output=True, text=True).stdout.split()
            if wid:
                subprocess.run(["xdotool", "windowactivate", "--sync", wid[0]], env=self.env)

    def shot(self, what):
        """Take a screenshot (KP_Enter is bound to it); returns the file."""
        before = self.text().count("Wrote ")
        self.key("KP_Enter")
        t0 = time.time()
        while self.text().count("Wrote ") <= before:
            if time.time() - t0 > 30:
                raise RuntimeError(f"no screenshot for {what}")
            time.sleep(0.05)
        return [ln for ln in self.text().splitlines() if ln.startswith("Wrote ")][-1][6:].strip()

    def close(self):
        self.game.terminate()
        try:
            self.game.wait(5)
        except subprocess.TimeoutExpired:
            self.game.kill()
        self.xvfb.terminate()
        shutil.rmtree(self.home, ignore_errors=True)


def run(pk3_path, views, warsow, out, width=1280, height=720, display=":77", log=print, first=1):
    """Film each view; returns the PNG paths. One client session changes view
    with a bound key, so more views than KEYS are filmed in batches, and the
    files are numbered on across batches from `first`."""
    if len(views) > len(KEYS):
        written = []
        for k in range(0, len(views), len(KEYS)):
            written += run(pk3_path, views[k:k + len(KEYS)], warsow, out, width, height,
                           display, log, first + k)
        return written
    basewsw = os.path.join(warsow, "basewsw")
    os.makedirs(out, exist_ok=True)
    names = stage_views(pk3_path, views, basewsw)
    cfg = ["set cg_draw2D 0", "set cg_gun 0", "set r_screenshot_jpeg 0", "set cg_fov 100",
           f"set cl_pitchspeed {PITCH_SPEED:g}", 'bind KP_ENTER "screenshot"', 'bind l "+lookdown"']
    cfg += [f'bind {k} "map {n}"' for k, n in zip(KEYS, names)]
    client = None
    written = []
    try:
        client = _Client(warsow, cfg, names[0], width=width, height=height, display=display)
        client.loaded(1)
        for i, view in enumerate(views):
            if i:
                client.key(KEYS[i])
                client.loaded(i + 1)
            if len(view) > 3 and view[3]:
                subprocess.run(["xdotool", "keydown", "l"], env=client.env)
                time.sleep(view[3] / PITCH_SPEED)
                subprocess.run(["xdotool", "keyup", "l"], env=client.env)
                time.sleep(2)
            png = os.path.join(out, f"{first + i:02d}_{view[0]}.png")
            tga_to_png(client.shot(f"view {view[0]}"), png)
            written.append(png)
            log(f"wrote {png}")
    finally:
        if client:
            client.close()
        for n in names:
            try:
                os.remove(os.path.join(basewsw, n + ".pk3"))
            except OSError:
                pass
    return written


# Fly-through (--flythrough). The camera runs the course's centre line at a
# strafing racer's pace, EYE above the floor, looking LOOK_AHEAD down the
# route. The line is smoothed a little (SMOOTH samples either side), which
# rounds the polyline's corners but stays inside a slalom's gates; the view
# direction is smoothed more (LOOK_SMOOTH), so turns sweep rather than snap.
FLY_SPEED = 1100.0
FLY_FPS = 30
EYE = 36
LOOK_AHEAD = 384
SMOOTH = 2
LOOK_SMOOTH = 8
HOLD = 1.0            # seconds held on the first and last frame
# The engine rejects a second `position` command within 500 ms of game time
# (g_cmds.cpp, Cmd_Position_f), so each frame waits this long.
POSITION_EVERY = 0.52


def flight_path(course, speed=FLY_SPEED, fps=FLY_FPS):
    """Camera keyframes [(x, y, z, pitch, yaw)] from the start spawn to the
    finish room, one per video frame. pitch is Quake's (positive looks down)."""
    route = list(course.route)
    # Start at the spawn: the route begins at the start line, one room length
    # after it, straight ahead.
    (x0, y0, z0), (x1, y1, _) = route[0], route[1]
    d = math.dist((x0, y0), (x1, y1)) or 1.0
    back = layout.ROOM_LEN - layout.SPAWN_BACK
    route.insert(0, (x0 - (x1 - x0) / d * back, y0 - (y1 - y0) / d * back, z0))
    # Stop short of the finish room's end wall.
    route[-1] = tuple(route[-2][i] + (route[-1][i] - route[-2][i]) * 0.6 for i in range(3))

    step = speed / fps
    pts, carry = [route[0]], 0.0
    for a, b in zip(route, route[1:]):
        seg = math.dist(a[:2], b[:2])
        t = step - carry
        while t <= seg:
            pts.append(tuple(a[i] + (b[i] - a[i]) * t / seg for i in range(3)))
            t += step
        carry = seg - (t - step)
    n = len(pts)

    def avg(i, r):
        lo, hi = max(0, i - r), min(n, i + r + 1)
        return tuple(sum(p[k] for p in pts[lo:hi]) / (hi - lo) for k in range(3))

    cam = [avg(i, SMOOTH) for i in range(n)]
    ahead = max(1, round(LOOK_AHEAD / step))
    looks = []
    for i in range(n):
        j = min(n - 1, i + ahead)
        if j == i:
            looks.append(looks[-1] if looks else (1.0, 0.0, 0.0))
            continue
        v = [cam[j][k] - cam[i][k] for k in range(3)]
        L = math.sqrt(sum(c * c for c in v)) or 1.0
        looks.append(tuple(c / L for c in v))
    frames = []
    for i in range(n):
        lo, hi = max(0, i - LOOK_SMOOTH), min(n, i + LOOK_SMOOTH + 1)
        v = [sum(looks[k][c] for k in range(lo, hi)) for c in range(3)]
        yaw = math.degrees(math.atan2(v[1], v[0])) % 360.0
        pitch = -math.degrees(math.atan2(v[2], math.hypot(v[0], v[1]))) + 4.0
        x, y, z = cam[i]
        frames.append((x, y, z + EYE, pitch, yaw))
    hold = int(HOLD * fps)
    return [frames[0]] * hold + frames + [frames[-1]] * hold


def encode(mjpeg, out_video, ffmpeg, fps=FLY_FPS, bitrate="3M"):
    """Concatenated JPEG frames -> VP8 WebM."""
    r = subprocess.run(
        [ffmpeg, "-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg",
         "-framerate", str(fps), "-i", mjpeg, "-vf", "format=yuv420p",
         "-c:v", "libvpx", "-b:v", bitrate, "-crf", "8", "-deadline", "good", "-cpu-used", "2",
         "-auto-alt-ref", "0", out_video], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.strip()[-800:]}")


def flythrough(pk3_path, course, warsow, out_video, ffmpeg=None, width=1280, height=720,
               fps=FLY_FPS, speed=FLY_SPEED, display=":77", log=print, bitrate="3M"):
    """Film the course from start to finish in the real client and encode it
    as VP8 WebM. Each frame is a spectator teleport (`position set`) and a
    JPEG screenshot. The JPEGs are appended to one MJPEG stream next to the
    video (kept if the encode fails, so the shoot is not lost) and encoded at
    the end: not piped, because some ffmpeg builds (Playwright's) have no
    pipe: protocol.

    The client runs the map under the dm gametype: the race script overrides
    `position` with its own save/load command and has no `set`. The geometry,
    lightmaps and textures are the same whichever gametype loads the bsp.
    Needs an ffmpeg that decodes MJPEG and encodes libvpx (Playwright's
    bundled build is enough)."""
    ffmpeg = ffmpeg or os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("no ffmpeg: pass --ffmpeg or set FFMPEG")
    frames = flight_path(course, speed, fps)
    basewsw = os.path.join(warsow, "basewsw")
    first = frames[0]
    names = stage_views(pk3_path, [["fly", [round(first[0]), round(first[1]), round(first[2])],
                                    round(first[4])]], basewsw)
    cfg = ["set cg_draw2D 0", "set cg_gun 0", "set r_screenshot_jpeg 1",
           "set r_screenshot_jpeg_quality 92", "set cg_fov 100",
           'bind KP_ENTER "screenshot"', 'bind p "exec mapgen_frame.cfg"']
    os.makedirs(os.path.dirname(os.path.abspath(out_video)), exist_ok=True)
    stream_path = os.path.splitext(out_video)[0] + ".mjpeg"
    stream = open(stream_path, "wb")
    client = None
    last = None
    try:
        client = _Client(warsow, cfg, names[0], gametype="dm", width=width, height=height,
                         display=display)
        client.loaded(1)
        frame_cfg = os.path.join(client.udir, "mapgen_frame.cfg")
        t_last = 0.0
        t0 = time.time()
        for k, (x, y, z, pitch, yaw) in enumerate(frames):
            if k and frames[k] == frames[k - 1] and last is not None:
                stream.write(last)             # a held frame: no need to film it again
                continue
            with open(frame_cfg, "w") as fh:
                fh.write(f"position set {x:.1f} {y:.1f} {z:.1f} {pitch:.2f} {yaw:.2f}\n")
            wait = POSITION_EVERY - (time.time() - t_last)
            if wait > 0:
                time.sleep(wait)
            client.key("p")
            t_last = time.time()
            time.sleep(0.12)                   # a few rendered frames at the new spot
            path = client.shot(f"frame {k}")
            with open(path, "rb") as fh:
                last = fh.read()
            os.remove(path)
            stream.write(last)
            if k % 60 == 0:
                log(f"frame {k}/{len(frames)} ({time.time() - t0:.0f} s)")
    finally:
        if client:
            client.close()
        for n in names:
            try:
                os.remove(os.path.join(basewsw, n + ".pk3"))
            except OSError:
                pass
        stream.close()
    encode(stream_path, out_video, ffmpeg, fps, bitrate)
    os.remove(stream_path)
    log(f"wrote {out_video}: {len(frames)} frames, {len(frames) / fps:.1f} s")
    return out_video


def overview(spec, warsow, out, q3map2=None, width=1280, height=720, log=print):
    """Compile a camera-pad variant of the map and film it from above."""
    import build as buildmod

    course = layout.build(spec)
    views = overview_views(course)
    pads = [(x, y, z - 40) for _, (x, y, z), _, _ in views]
    for v in views:           # the spawn goes a little above its pad and drops onto it
        v[1][2] += 8
    tmp = tempfile.mkdtemp(prefix="mapgen-overview-")
    try:
        pk3, _ = buildmod.build(spec, tmp, q3map2=q3map2, camera_pads=pads)
        written = []
        for i, v in enumerate(views):
            shots = run(pk3, [v], warsow, tmp + f"/shot{i}", width, height, log=lambda m: None)
            dst = os.path.join(out, f"{v[0]}.png")
            os.makedirs(out, exist_ok=True)
            shutil.move(shots[0], dst)
            written.append(dst)
            log(f"wrote {dst}")
        return written
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("pk3")
    p.add_argument("--spec", help="the spec the pk3 was built from (for automatic views)")
    p.add_argument("--views", help="JSON [[name, [x,y,z], [pitch,yaw]], ...] instead of --spec")
    p.add_argument("--warsow", required=True, help="Warsow 2.1.2 client directory")
    p.add_argument("--out", required=True)
    p.add_argument("--size", default="1280x720")
    p.add_argument("--overview", action="store_true",
                   help="also film the course from above (needs --spec and q3map2)")
    p.add_argument("--q3map2", help="for --overview (default: $Q3MAP2, then PATH)")
    p.add_argument("--flythrough", metavar="VIDEO.webm",
                   help="also film a start-to-finish fly-through (needs --spec and ffmpeg)")
    p.add_argument("--ffmpeg", help="for --flythrough (default: $FFMPEG, then PATH)")
    args = p.parse_args(argv)
    if args.views:
        with open(args.views) as fh:
            views = json.load(fh)
    elif args.spec:
        with open(args.spec) as fh:
            views = auto_views(layout.build(json.load(fh)))
    else:
        p.error("pass --spec or --views")
    w, h = (int(v) for v in args.size.split("x"))
    if args.flythrough and not args.spec:
        p.error("--flythrough needs --spec")
    run(args.pk3, views, args.warsow, args.out, w, h)
    if args.overview:
        if not args.spec:
            p.error("--overview needs --spec")
        with open(args.spec) as fh:
            overview(json.load(fh), args.warsow, args.out, args.q3map2, w, h)
    if args.flythrough:
        with open(args.spec) as fh:
            course = layout.build(json.load(fh))
        flythrough(args.pk3, course, args.warsow, args.flythrough, args.ffmpeg, w, h)
    return 0


if __name__ == "__main__":
    sys.exit(main())
