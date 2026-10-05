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

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

import assets
import layout
import mapfile
import tiles

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


def uses_ice(course):
    """Whether any brush wears the ice texture, so the pack needs its shader."""
    return any(p.tex == "ice" for p in course.world)


def uses_hazard(course):
    """Whether any brush wears the hazard texture, so the pack needs it."""
    return any(p.tex == "hazard" for p in course.world)


def stage(course, work):
    """Write the .map and the assets into a q3map2 basepath layout."""
    name = course.spec["name"]
    base = os.path.join(work, "base")   # game_qfusion's gamePath (games.cpp)
    for rel, data in assets.files(ice=uses_ice(course), hazard=uses_hazard(course)).items():
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


def compile_map(q3map2, work, map_path, fast=True, log=None, bsp_extra=()):
    # Stage flag first, then the common options: q3map2 reads anything before
    # the stage as noise ("Unknown option -light") and quietly skips it.
    common = ["-game", "qfusion", "-fs_basepath", work, "-fs_home", work]
    # Light runs single-threaded: with several threads the light grid differs
    # run to run, and the same spec must compile to the same bytes. A greybox
    # course lights in about a second either way.
    light = ["-fast", "-samples", "2"] if fast else ["-samples", "3", "-bounce", "2"]
    stages = [
        ["-bsp"] + common + ["-meta"] + list(bsp_extra),
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


def members_version(members):
    """A short content hash over EVERY byte a pk3 will contain.

    It names the file (pack(versioned=True)), and it has to cover the whole archive
    rather than just the map: the refusal we are avoiding is a checksum
    mismatch, and the checksum is of the FILE. Hashing only the bsp would let a
    changed texture ship under a name a client already has cached, which is the
    bug with extra steps."""
    h = hashlib.sha1()
    for rel in sorted(members):
        h.update(rel.encode())
        h.update(b"\0")
        h.update(members[rel])
        h.update(b"\0")
    return h.hexdigest()[:8]


def pack(name, bsp_bytes, out_dir, extra=None, ice=False, hazard=False, versioned=False):
    """Write the pk3 holding maps/<name>.bsp. Returns (path, version).

    `versioned` puts a content hash in the FILENAME while the map inside keeps
    its own name. That is what makes a deck safe to update: a client holding an
    older build has it under a different filename, and sv_pure restricts the
    client to the files the server lists, so the stale one is ignored rather
    than fought over. Reusing one filename for changing contents is what
    produces the pk3-mismatch refusal on connect."""
    os.makedirs(out_dir, exist_ok=True)
    members = {f"maps/{name}.bsp": bsp_bytes}
    members.update(assets.files(ice=ice, hazard=hazard))
    if extra:
        members.update(extra)
    version = members_version(members)
    path = os.path.join(out_dir, (f"{name}_{version}" if versioned else name) + ".pk3")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(members):
            info = zipfile.ZipInfo(rel, ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16   # world-readable, like fetch-maps.sh
            zf.writestr(info, members[rel])
    return path, version


SURF_SLICK = 0x2   # gameshared/q_collision.h:65


def check_bsp(bsp_bytes, ice=False):
    """Judge the compiled map. Returns a list of problems; empty means raceable
    as far as static analysis can tell. ice=True: the course has icy floor,
    and the compiled shaderref for it must carry SURF_SLICK, because that flag
    (not the texture) is what the engine's movement code reads."""
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

    if ice:
        want = f"textures/{assets.VERSION}/ice"
        refs = [(n, fl) for n, fl, _ in bsp.shaderrefs() if n == want]
        if not refs:
            problems.append(f"the course has ice but the bsp has no {want} shader")
        elif not all(fl & SURF_SLICK for _, fl in refs):
            problems.append(f"{want} compiled without SURF_SLICK: q3map2 did not read "
                            f"{assets.ICE_SHADER_PATH}, so the ice would have grip")

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


def build(spec, out_dir, q3map2=None, work=None, fast=True, keep_work=False, camera_pads=(),
          rules="strict"):
    """spec -> (pk3 path, report dict). Raises LayoutError / BuildError.
    camera_pads: screenshots.py's overview variant only (layout._camera_pads).
    rules: the tier (spec.STRICT / spec.OPEN); the worker builds a course from
    the map editor with the open one."""
    course = layout.build(spec, camera_pads, rules=rules)
    q3 = find_q3map2(q3map2)
    if not q3:
        raise BuildError("q3map2 not found: pass --q3map2, set Q3MAP2, or build "
                         "tools/mapgen/Dockerfile")
    own_work = work is None
    if own_work:
        work = tempfile.mkdtemp(prefix="mapgen-")
    try:
        map_path = stage(course, work)
        with open(os.path.join(work, "q3map2.log"), "w") as log:
            bsp_path, _ = compile_map(q3, work, map_path, fast=fast, log=log)
        with open(bsp_path, "rb") as fh:
            bsp_bytes = strip_timestamp(fh.read())
        if len(bsp_bytes) > BSP_MAX_BYTES:
            raise BuildError(f"compiled bsp is {len(bsp_bytes)} bytes; at most {BSP_MAX_BYTES}")
        ice = uses_ice(course)
        problems = check_bsp(bsp_bytes, ice=ice)
        if problems:
            raise BuildError("compiled map failed its checks:\n  " + "\n  ".join(problems))
        name = spec["name"]
        pk3, _ = pack(name, bsp_bytes, out_dir, ice=ice, hazard=uses_hazard(course))
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
            # Which pieces are floored with slick ice (spec "ice": true).
            "ice_segments": [i for i, seg in enumerate(spec["segments"]) if seg.get("ice")],
            "overpasses": course.overpasses,
        }
        return pk3, report
    finally:
        if own_work and not keep_work:
            shutil.rmtree(work, ignore_errors=True)


# The deck ships once but every player downloads it, so it gets its own
# ceilings rather than a course's.
DECK_BSP_MAX_BYTES = 8 * 1024 * 1024
DECK_PK3_MAX_BYTES = 2 * 1024 * 1024

# --- the tile deck (tools/mapgen/tiles.py, dealt by hrace/metamap.as) --------
#
# A deck is compiled like a course, but what is checked afterwards is almost
# the opposite. A course must have a finish line; a deck must NOT — its finish
# is a tile the dealer places when the route is long enough. What a deck must
# have is an inline model per tile, because a tile whose brushes the compiler
# folded into worldspawn is a tile the dealer cannot place (and would leave
# visible, in the compile grid, forever).

def deck_models(bsp_bytes):
    """name -> inline model index, read out of the COMPILED entity lump.

    q3map2 assigns submodel numbers itself, so they are read back rather than
    predicted from the order tiles.py wrote the entities in.
    """
    _, lump, _, _ = mapfix.analyse(bsp_bytes, 0.9)
    out = {}
    for e in lump.entities:
        name = e.get("mg_name")
        model = e.get("model", "")
        if name and model.startswith("*"):
            out[name] = int(model[1:])
    return out


def check_deck_bsp(bsp_bytes, deck):
    problems = []
    try:
        bsp, lump, findings, _ = mapfix.analyse(bsp_bytes, 0.9)
    except mapfix.BspError as e:
        return [f"compiled bsp does not parse: {e}"]
    if bsp.magic != b"FBSP":
        problems.append(f"compiled as {bsp.magic!r}, expected FBSP (q3map2 -game qfusion)")
    for f in findings:
        if f.severity is mapfix.BROKEN:
            problems.append(f"mapfix: {f}")

    by_class = {}
    for e in lump.entities:
        by_class.setdefault(e.classname, []).append(e)
    if not by_class.get("info_player_deathmatch"):
        problems.append("no info_player_deathmatch: players would spawn at the origin")
    if not by_class.get("trigger_hurt"):
        problems.append("no trigger_hurt: falling off a dealt route would never respawn")
    for cls in ("target_starttimer", "target_stoptimer"):
        if by_class.get(cls):
            problems.append(f"a deck must not carry a {cls}: the dealer owns the clock, "
                            "and a map-placed timer would fire for whichever lane "
                            "happened to be built over it")

    models = deck_models(bsp_bytes)
    want = [t.name for t in deck.tiles] + [tiles.GATE_NAME]
    lost = [n for n in want if n not in models]
    if lost:
        problems.append(f"{len(lost)} of {len(want)} pieces lost their brush model "
                        f"(the compiler folded them into worldspawn): "
                        + ", ".join(lost[:6]) + ("..." if len(lost) > 6 else ""))
    # The engine only accepts 0 < index < CM_NumInlineModels (ISBRUSHMODEL,
    # game/g_local.h:680), and the count comes from the models lump.
    n = bsp.model_count()
    over = sorted(k for k, v in models.items() if not 0 < v < n)
    if over:
        problems.append(f"inline model index out of range for: {', '.join(over[:6])} "
                        f"(the bsp has {n} models)")
    return problems


def build_deck(name, title, out_dir, q3map2=None, work=None, fast=True, keep_work=False):
    """tiles.catalogue() -> compiled, packed, checked deck .pk3.

    Returns (pk3_path, deck, problems, log).
    """
    deck = tiles.build_deck(name, title)
    q3 = find_q3map2(q3map2)
    if not q3:
        raise BuildError("q3map2 not found: pass --q3map2, set Q3MAP2, or build "
                         "the tools/mapgen Docker image")
    own_work = work is None
    work = work or tempfile.mkdtemp(prefix="mapgen-deck-")
    try:
        map_path = stage(deck.course, work)
        with open(os.path.join(work, "q3map2.log"), "w") as log:
            bsp_path, out = compile_map(q3, work, map_path, fast=fast, log=log)
        with open(bsp_path, "rb") as fh:
            bsp_bytes = strip_timestamp(fh.read())
        if len(bsp_bytes) > DECK_BSP_MAX_BYTES:
            raise BuildError(f"the compiled deck is {len(bsp_bytes) // 1024} KB; "
                             f"at most {DECK_BSP_MAX_BYTES // 1024} KB (tiles.LIGHTMAP_SCALE "
                             "is what keeps the lightmap small)")
        deck.models = deck_models(bsp_bytes)
        problems = check_deck_bsp(bsp_bytes, deck)
        if problems:
            return None, deck, problems, out
        text = tiles.manifest(deck)
        # The map keeps its name; the FILE carrying it is versioned, so
        # updating the deck never asks a client to reconcile two different
        # pk3s with the same name.
        pk3, version = pack(name, bsp_bytes, out_dir, versioned=True,
                            extra={f"maps/{name}.deck": text.encode()})
        deck.version = version
        return pk3, deck, [], out
    finally:
        if own_work and not keep_work:
            shutil.rmtree(work, ignore_errors=True)
