#!/usr/bin/env python3
"""Screenshot a generated map in the real Warsow client, headless.

    screenshots.py build/gen_first_light.pk3 --spec examples/gen_first_light.json \\
        --warsow ~/warsow-2.1.2 --out shots/

Needs the stock Warsow 2.1.2 client (the tarball server/Dockerfile downloads
has it), Xvfb, xdotool and a software GL (Mesa llvmpipe is fine). Output is one
PNG per view, taken by the engine's own `screenshot` command, so what you see
is exactly what a player sees: real lightmaps, real textures, the real
renderer.

HOW A VIEW IS PLACED. Game commands (`position set`, `noclip`) need a joined,
cheating player and proved unreliable from a scripted client, and the race
gametype picks a spectator's first spot itself from info_player_deathmatch,
ignoring info_player_intermission. So each view is its own copy of the
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
gap and checkpoint, and the finish. Pass --views to use your own
[[name, [x, y, z], yaw], ...] instead; z only needs to be above the floor you
want to stand on.
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


def auto_views(course):
    """Camera spots that show what matters on a race course."""
    views = []

    def behind(pos, heading, back, name):
        h = math.radians(heading)
        x = pos[0] - math.cos(h) * back
        y = pos[1] - math.sin(h) * back
        views.append([name, [round(x), round(y), round(pos[2] + 32)], round(heading) % 360])

    counts = {}
    for kind, pos, heading in course.landmarks:
        counts[kind] = counts.get(kind, 0) + 1
        if kind == "start":
            behind(pos, heading, layout.ROOM_LEN - layout.SPAWN_BACK, "start")
        elif kind == "stop":
            behind(pos, heading, 448, "finish")
        else:
            behind(pos, heading, 448, f"{kind}{counts[kind]}")
    return views[:len(KEYS)]


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
    for i, (_, (x, y, z), yaw) in enumerate(views):
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


def run(pk3_path, views, warsow, out, width=1280, height=720, display=":77", log=print):
    basewsw = os.path.join(warsow, "basewsw")
    os.makedirs(out, exist_ok=True)
    names = stage_views(pk3_path, views, basewsw)
    home = tempfile.mkdtemp(prefix="mapgen-wsw-")
    udir = os.path.join(home, ".local/share/warsow-2.1/basewsw")
    os.makedirs(udir)
    console = os.path.join(udir, "console.log")

    cfg = ["set cg_draw2D 0", "set cg_gun 0", "set r_screenshot_jpeg 0", "set cg_fov 100",
           'bind KP_ENTER "screenshot"']
    cfg += [f'bind {k} "map {n}"' for k, n in zip(KEYS, names)]
    with open(os.path.join(udir, "mapgen_views.cfg"), "w") as fh:
        fh.write("\n".join(cfg) + "\n")

    env = dict(os.environ, HOME=home, DISPLAY=display,
               LIBGL_ALWAYS_SOFTWARE="1", SDL_AUDIODRIVER="dummy")
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{width}x{height}x24"],
                            stderr=subprocess.DEVNULL)
    time.sleep(2)
    game = subprocess.Popen(
        ["./warsow.x86_64", "+set", "logconsole", "console.log", "+set", "logconsole_flush", "1",
         "+set", "s_module", "0", "+set", "vid_fullscreen", "0", "+set", "vid_mode", "-1",
         "+set", "vid_customwidth", str(width), "+set", "vid_customheight", str(height),
         "+set", "g_gametype", "race", "+exec", "mapgen_views.cfg", "+map", names[0]],
        cwd=warsow, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def text():
        try:
            with open(console, errors="replace") as fh:
                return fh.read()
        except OSError:
            return ""

    def key(k):
        subprocess.run(["xdotool", "key", "--clearmodifiers", k], env=env)

    def loaded(n):
        t0 = time.time()
        while text().count("connected from loopback") < n:
            if time.time() - t0 > 240 or game.poll() is not None:
                raise RuntimeError("client did not load the map:\n" + text()[-1500:])
            time.sleep(1)
        time.sleep(8)          # let the first frames settle
        key("Escape")          # dismiss the join menu a spectator gets
        time.sleep(2)

    written = []
    try:
        loaded(1)
        wid = subprocess.run(["xdotool", "search", "--name", "Warsow"], env=env,
                             capture_output=True, text=True).stdout.split()
        if wid:
            subprocess.run(["xdotool", "windowactivate", "--sync", wid[0]], env=env)
        for i, (view, name) in enumerate(zip(views, names)):
            if i:
                key(KEYS[i])
                loaded(i + 1)
            before = text().count("Wrote ")
            key("KP_Enter")
            t0 = time.time()
            while text().count("Wrote ") <= before:
                if time.time() - t0 > 30:
                    raise RuntimeError(f"no screenshot for view {view[0]}")
                time.sleep(0.5)
            tga = [l for l in text().splitlines() if l.startswith("Wrote ")][-1][6:].strip()
            png = os.path.join(out, f"{i + 1:02d}_{view[0]}.png")
            tga_to_png(tga, png)
            written.append(png)
            log(f"wrote {png}")
    finally:
        game.terminate()
        try:
            game.wait(5)
        except subprocess.TimeoutExpired:
            game.kill()
        xvfb.terminate()
        for n in names:
            try:
                os.remove(os.path.join(basewsw, n + ".pk3"))
            except OSError:
                pass
        shutil.rmtree(home, ignore_errors=True)
    return written


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("pk3")
    p.add_argument("--spec", help="the spec the pk3 was built from (for automatic views)")
    p.add_argument("--views", help="JSON [[name, [x,y,z], [pitch,yaw]], ...] instead of --spec")
    p.add_argument("--warsow", required=True, help="Warsow 2.1.2 client directory")
    p.add_argument("--out", required=True)
    p.add_argument("--size", default="1280x720")
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
    run(args.pk3, views, args.warsow, args.out, w, h)
    return 0


if __name__ == "__main__":
    sys.exit(main())
