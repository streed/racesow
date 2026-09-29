"""Course -> compiled, packed, checked .pk3.

    layout  -> .map text  (mapfile.py)
    q3map2 -game qfusion  -meta, -vis, -light   -> FBSP v1, the format Warsow loads
    pack    -> <name>.pk3 holding maps/<name>.bsp + the mapgen_v1 assets
    check   -> the compiled bsp read back and judged by what it actually contains

The last step matters most. The .map says there is a start trigger; only the
compiled bsp says whether q3map2 kept it as a brush model the engine will
spawn. So the checks run against the bsp — through tools/mapfix, the same
code that audits the imported pool — plus the race-specific rules mapfix
does not know: exactly one start timer and one stop timer, each fired by a
trigger that survived compilation, and a spawn point.
"""

import os
import shutil
import subprocess
import sys
import zipfile

import assets
import layout
import mapfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "mapfix"))
import mapfix  # noqa: E402  (tools/mapfix, imported by path)
from entities import EntityLump  # noqa: E402

# Zip timestamps are pinned so the same spec always yields the same bytes.
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


class BuildError(Exception):
    pass


def find_q3map2(explicit=None):
    for cand in (explicit, os.environ.get("Q3MAP2"), shutil.which("q3map2")):
        if cand and os.path.exists(cand):
            return cand
    return None


def stage(course, work):
    """Write the .map and the assets into a q3map2 basepath layout."""
    name = course.spec["name"]
    base = os.path.join(work, "base")   # game_qfusion's gamePath (games.cpp)
    for rel, data in assets.files().items():
        path = os.path.join(base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data)
    maps = os.path.join(base, "maps")
    os.makedirs(maps, exist_ok=True)
    map_path = os.path.join(maps, name + ".map")
    with open(map_path, "w") as fh:
        fh.write(mapfile.write(course))
    return map_path


# Ceilings on a build (the course's own size limits are in spec.ROUTE_MAX and
# layout.EXTENT_MAX_* / BRUSH_MAX). A greybox course compiles in seconds and
# the largest example is a 6.1 MB bsp in a 0.36 MB pack, so these only stop a
# runaway: a compile that hangs, or a map too heavy to ship to every server
# and every player who downloads it.
STAGE_TIMEOUT = {"-bsp": 300, "-vis": 300, "-light": 600}   # seconds
BSP_MAX_BYTES = 16 * 1024 * 1024
PK3_MAX_BYTES = 4 * 1024 * 1024


def compile_map(q3map2, work, map_path, fast=True, log=None):
    # Stage flag first, then the common options: q3map2 reads anything before
    # the stage as noise ("Unknown option -light") and quietly skips it.
    common = ["-game", "qfusion", "-fs_basepath", work, "-fs_home", work]
    # Light runs single-threaded: with several threads the light grid differs
    # run to run, and the same spec must compile to the same bytes. A greybox
    # course lights in about a second either way.
    light = ["-fast", "-samples", "2"] if fast else ["-samples", "3", "-bounce", "2"]
    stages = [
        ["-bsp"] + common + ["-meta"],
        ["-vis"] + common + (["-fast"] if fast else []),
        ["-light"] + common + ["-threads", "1"] + light,
    ]
    out = []
    for args in stages:
        try:
            p = subprocess.run([q3map2] + args + [map_path], capture_output=True, text=True,
                               timeout=STAGE_TIMEOUT[args[0]])
        except subprocess.TimeoutExpired:
            raise BuildError(f"q3map2 {args[0]} took longer than {STAGE_TIMEOUT[args[0]]} s")
        out.append(p.stdout + p.stderr)
        if log:
            log.write(out[-1])
        unknown = [ln for ln in out[-1].splitlines() if "Unknown option" in ln]
        if unknown:
            raise BuildError(f"q3map2 {args[0]} ignored options: {unknown}")
        if p.returncode != 0:
            raise BuildError(f"q3map2 {args[0]} failed (exit {p.returncode}):\n"
                             + "\n".join(out[-1].splitlines()[-25:]))
        # A leak is not an error exit — q3map2 carries on with a broken map.
        if "LEAKED" in out[-1]:
            raise BuildError("q3map2 reports a leak: the sky shell does not seal the course")
    bsp = map_path[:-4] + ".bsp"
    if not os.path.exists(bsp):
        raise BuildError("q3map2 finished without writing a .bsp")
    return bsp, "".join(out)


def strip_timestamp(bsp_bytes):
    """q3map2 writes "I LOVE MY Q3MAP2 <version> on <ctime>" between the lump
    directory and the first lump. Blank the time (same length, so no offset
    moves) so the same spec compiles to the same bytes."""
    tag = b"I LOVE MY Q3MAP2 "
    i = bsp_bytes.find(tag, 0, 512)
    if i < 0:
        return bsp_bytes
    on = bsp_bytes.find(b" on ", i)
    end = bsp_bytes.find(b"\n", i)
    if on < 0 or end < 0 or on > end:
        return bsp_bytes
    return bsp_bytes[:on + 4] + b"-" * (end - on - 4) + bsp_bytes[end:]


def pack(name, bsp_bytes, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name + ".pk3")
    members = {f"maps/{name}.bsp": bsp_bytes}
    members.update(assets.files())
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(members):
            info = zipfile.ZipInfo(rel, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16   # world-readable, like fetch-maps.sh
            zf.writestr(info, members[rel])
    return path


def check_bsp(bsp_bytes):
    """Judge the compiled map. Returns a list of problems; empty means raceable
    as far as static analysis can tell."""
    problems = []
    try:
        bsp, lump, findings, _ = mapfix.analyse(bsp_bytes, 0.9)
    except mapfix.BspError as e:
        return [f"compiled bsp does not parse: {e}"]
    if bsp.magic != b"FBSP":
        problems.append(f"compiled as {bsp.magic!r}, expected FBSP (q3map2 -game qfusion)")
    for f in findings:
        if f.severity in (mapfix.BROKEN, mapfix.WARN):
            problems.append(f"mapfix: {f}")

    ents = lump.entities
    by_class = {}
    for e in ents:
        by_class.setdefault(e.classname, []).append(e)
    for cls in ("target_starttimer", "target_stoptimer"):
        if len(by_class.get(cls, [])) != 1:
            problems.append(f"expected exactly one {cls}, found {len(by_class.get(cls, []))}")
    if not by_class.get("info_player_deathmatch"):
        problems.append("no info_player_deathmatch: players would spawn at the origin")

    # Every timer / checkpoint must be fired by a trigger that has a brush
    # model — a trigger without one is freed at spawn (g_clip.cpp:985).
    triggers = {}
    for e in by_class.get("trigger_multiple", []):
        if e.get("model", "").startswith("*"):
            triggers.setdefault(e.get("target"), []).append(e)
    for cls in ("target_starttimer", "target_stoptimer", "target_checkpoint"):
        for e in by_class.get(cls, []):
            if not triggers.get(e.get("targetname")):
                problems.append(f"{cls} {e.get('targetname')!r} is not fired by any "
                                "trigger_multiple with a brush model")
    return problems


def build(spec, out_dir, q3map2=None, work=None, fast=True, keep_work=False, camera_pads=()):
    """spec -> (pk3 path, report dict). Raises LayoutError / BuildError.
    camera_pads: screenshots.py's overview variant only (layout._camera_pads)."""
    course = layout.build(spec, camera_pads)
    q3 = find_q3map2(q3map2)
    if not q3:
        raise BuildError("q3map2 not found: pass --q3map2, set Q3MAP2, or build "
                         "tools/mapgen/Dockerfile")
    own_work = work is None
    if own_work:
        import tempfile
        work = tempfile.mkdtemp(prefix="mapgen-")
    try:
        map_path = stage(course, work)
        with open(os.path.join(work, "q3map2.log"), "w") as log:
            bsp_path, _ = compile_map(q3, work, map_path, fast=fast, log=log)
        with open(bsp_path, "rb") as fh:
            bsp_bytes = strip_timestamp(fh.read())
        if len(bsp_bytes) > BSP_MAX_BYTES:
            raise BuildError(f"compiled bsp is {len(bsp_bytes)} bytes; at most {BSP_MAX_BYTES}")
        problems = check_bsp(bsp_bytes)
        if problems:
            raise BuildError("compiled map failed its checks:\n  " + "\n  ".join(problems))
        name = spec["name"]
        pk3 = pack(name, bsp_bytes, out_dir)
        if os.path.getsize(pk3) > PK3_MAX_BYTES:
            raise BuildError(f"pack is {os.path.getsize(pk3)} bytes; at most {PK3_MAX_BYTES}")
        with open(os.path.join(out_dir, name + ".svg"), "w") as fh:
            fh.write(layout.preview_svg(course))
        with open(os.path.join(out_dir, name + ".map"), "w") as fh:
            fh.write(mapfile.write(course))
        report = {
            "name": name,
            "pk3": pk3,
            "bsp_bytes": len(bsp_bytes),
            "brushes": len(course.world) + sum(len(b) for _, b in course.entities),
            "route_length": round(course.length),
            # Par: the centre line at plain run speed. A strafing player beats
            # it; nobody should be slower. Shown on the form as "about N s".
            "par_seconds": round(course.length / 320.0, 1),
            # The plan's own checkpoints plus the ones the generator added.
            "checkpoints": sum(1 for e, _ in course.entities if e["classname"] == "target_checkpoint"),
            "auto_checkpoints": len(course.auto_checkpoints),
            # Optional stepping-stone routes across U-turns, and the par with
            # every one of them taken.
            "shortcuts": course.shortcuts,
            "par_seconds_shortcuts": round((course.length - sum(s["saves"] for s in course.shortcuts))
                                           / 320.0, 1),
            # Slaloms, beams and splits, and where the course passes over itself.
            "features": course.features,
            "overpasses": course.overpasses,
        }
        return pk3, report
    finally:
        if own_work and not keep_work:
            shutil.rmtree(work, ignore_errors=True)
