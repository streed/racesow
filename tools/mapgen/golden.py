#!/usr/bin/env python3
"""Golden vectors that pin the browser's copy of the generator to this one.

The map editor (/mapgen/editor) lays a course out in the page with
web/public/assets/js/mapgen-course.js, a port of physics.py, spec.py and
layout.py, so it can draw what will be built and say what will be refused
while the course is being edited. That port is only worth anything while it
agrees with this tree, so this script lays a set of courses out HERE and writes
what came out:

  * for a course the generator refuses, its problems, word for word;
  * for one it accepts, every brush (texture, heading, floor, top plane and
    footprint), every entity, the centre line, and the report's facts.

web/test/mapgen-course.test.js lays the same courses out in JavaScript and
must match. test_mapgen.py runs `golden.py --check`, so a change here that is
not carried to the port (and the fixture re-dumped) fails this lane too:

    python3 tools/mapgen/golden.py            # rewrite the fixture
    python3 tools/mapgen/golden.py --check    # exit 1 if it is out of date
"""

import copy
import gzip
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import assets  # noqa: E402
import layout  # noqa: E402
import spec as specmod  # noqa: E402

FIXTURE = os.path.join(HERE, "..", "..", "web", "test", "fixtures", "mapgen-layout-golden.json.gz")
TEXTURES = os.path.join(HERE, "..", "..", "web", "test", "fixtures", "mapgen-textures.json")
EXAMPLES = os.path.join(HERE, "examples")


def course(*segments, width=384, name="gen_golden", title="Golden"):
    return {"name": name, "title": title, "width": width, "segments": list(segments)}


S = lambda n, **k: dict(type="straight", length=n, **k)            # noqa: E731
T = lambda d, a, r, **k: dict(type="turn", direction=d, angle=a, radius=r, **k)  # noqa: E731
R = lambda n, rise, **k: dict(type="ramp", length=n, rise=rise, **k)  # noqa: E731
G = lambda n, drop, **k: dict(type="gap", length=n, drop=drop, **k)  # noqa: E731
CP = {"type": "checkpoint"}


def spiral_down(open_top=False, open_bottom=False):
    segs = [S(1024)]
    for lap in range(2):
        top = S(2048)
        if (open_top and lap == 0) or (open_bottom and lap == 1):
            top["open"] = True
        segs += [top, T("left", 180, 384), R(1024, -512), R(1024, -512)]
    return course(*segs)


def cases():
    """[(label, spec, rules)]: every example, plus courses that reach each
    piece, each rule and each message the editor can show — in both rule
    tiers, because the editor lays out in the open one and the generator in
    the strict one, and the port has to agree on both."""
    out = []
    for fn in sorted(os.listdir(EXAMPLES)):
        if fn.endswith(".json"):
            with open(os.path.join(EXAMPLES, fn)) as fh:
                out.append((fn[:-5], json.load(fh), "strict"))

    loop = [S(1024)]
    for _ in range(4):
        loop += [T("left", 90, 320), S(1024)]
    lap = [R(1024, 512), T("left", 180, 512), R(1024, 512), T("left", 180, 512)]

    out += [
        ("ice", course(S(512), R(768, -256, ice=True), T("left", 90, 512, ice=True),
                       {"type": "slalom", "length": 1024, "count": 3, "ice": True},
                       S(1024, ice=True), T("right", 135, 700, ice=True, open=True), S(512))),
        ("every_piece", course(
            S(640), CP, T("right", 45, 600), R(512, 128), S(384), G(160, 0), S(512),
            {"type": "slalom", "length": 1280, "count": 4},
            {"type": "beam", "length": 768, "beam_width": 96}, S(512),
            {"type": "split", "length": 1600, "direction": "left", "count": 2}, S(512),
            {"type": "wallclimb", "length": 768, "rise": 80, "direction": "right"}, S(512),
            {"type": "wallgap", "length": 180, "drop": -80, "direction": "left"}, S(768),
            {"type": "dash", "length": 500, "drop": 512}, S(640), width=448)),
        ("open", course(S(512), S(512, open=True), G(150, 64, open=True), S(512, open=True),
                        T("left", 90, 400), S(800))),
        ("open_jump_cut", course(S(512, open=True), G(150, 64, open=True), S(512),
                                  R(1024, -400, open=True), S(256), T("left", 90, 400, open=True),
                                  S(800))),
        ("shortcut", course(S(1024), S(512), T("left", 180, 640, shortcut=True), S(512), S(2048))),
        ("long_auto_checkpoints", course(*[S(4096)] * 3, T("right", 180, 900), *[S(4096)] * 3)),
        ("spiral_up_overpass", course(S(512), *lap, *lap)),
        ("spiral_down_roofed", spiral_down(open_top=True)),
        ("narrow", course(S(512), T("right", 180, 192), S(512), width=256)),

        # Refused: ranges.
        ("bad_words", course(S(512), name="Gen Bad", title="no <tags> here")),
        ("bad_title_spaces", course(S(512), title="Two  spaces")),
        ("bad_width", course(S(512), width=900)),
        ("empty", course()),
        ("bad_ranges", course(S(50), T("up", 60, 100), R(256, 300), G(400, 0), G(64, 700),
                              {"type": "slalom", "length": 300, "count": 3},
                              {"type": "beam", "length": 4000, "beam_width": 20},
                              {"type": "split", "length": 500, "direction": "none", "count": 9},
                              {"type": "wallclimb", "length": 100, "rise": 30, "direction": "up"},
                              {"type": "wallgap", "length": 400, "drop": -80, "direction": "left"},
                              {"type": "dash", "length": 100, "drop": 512},
                              {"type": "jetpack"}, "not an object")),
        ("bad_flags", course(S(512, open="yes", ice=1), G(100, 0, ice=True),
                             {"type": "beam", "length": 512, "beam_width": 64, "open": True})),
        ("bad_shortcut", course(R(512, 64), T("left", 90, 512, shortcut=True), CP)),
        ("too_long", course(*[S(4096)] * 10)),
        ("too_many", course(*[S(128)] * 65)),
        ("narrow_specials", course(S(512), {"type": "slalom", "length": 1024, "count": 2},
                                   {"type": "split", "length": 1024, "direction": "left", "count": 1},
                                   width=256)),

        # Refused: layout.
        ("gap_no_runup", course(R(512, -128), G(96, 0), S(512))),
        ("gap_bad_landing", course(S(512), G(96, 0), R(512, 64))),
        ("gap_at_finish", course(S(512), G(96, 0))),
        ("self_overlap", course(*loop)),
        ("wall_runups", course(R(512, 64), {"type": "wallgap", "length": 120, "drop": -80,
                                            "direction": "left"}, S(512),
                               R(256, 64), {"type": "wallclimb", "length": 384, "rise": 80,
                                            "direction": "left"}, S(512))),
        ("open_cut", spiral_down(open_top=True, open_bottom=True)),
        ("too_wide", course(*[S(4096)] * 5)),
    ]

    # -- the editor's own pieces --------------------------------------------
    ST = {"type": "stairs", "length": 512, "rise": 128, "count": 8}
    PL = {"type": "platforms", "length": 768, "count": 4, "drop": 0}
    PI = {"type": "pillars", "length": 768, "count": 4}
    TU = {"type": "tunnel", "length": 768, "height": 192}
    CH = {"type": "chicane", "direction": "left", "angle": 30, "radius": 512}
    BU = {"type": "bumps", "length": 768, "count": 4, "rise": 48}
    PN = {"type": "pinch", "length": 512, "gate": 192}
    LE = {"type": "ledge", "length": 512, "direction": "left", "ledge_width": 96}
    HZ = {"type": "hazard", "length": 128}
    SP = {"type": "strafepads", "count": 6, "spacing": 256, "curve": 0}
    out += [
        ("shape_pieces", course(S(640), ST, S(512), PL, S(512), PI, S(512), TU, S(512),
                                CH, S(512), BU, S(512), PN, S(512), LE, S(512), HZ, S(640),
                                width=448)),
        ("strafepads_straight", course(S(640), SP, S(640))),
        ("strafepads_curved", course(S(640), dict(SP, curve=60), S(640))),
        ("strafepads_curved_right", course(S(640), dict(SP, curve=-45, count=4), S(640))),
        ("shape_pieces_iced", course(S(512), dict(ST, ice=True), S(512), dict(BU, ice=True),
                                     S(512), dict(TU, ice=True), S(512))),
        ("shape_pieces_open", course(S(512), dict(ST, open=True), S(512), dict(PI, open=True),
                                     S(512), dict(HZ, open=True), S(512))),
        ("stairs_down", course(S(512), dict(ST, rise=-128), S(512))),
        ("platforms_dropping", course(S(512), dict(PL, drop=192), S(512))),

        # Nudges: sideways, on the spot, and both, inside the strict bounds.
        ("nudge_shift", course(S(1024), S(1024, shift=200), S(1024))),
        ("nudge_shift_right", course(S(1024), S(1024, shift=-200), S(1024))),
        ("nudge_rotate", course(S(1024), S(1024, rotate=25), S(1024))),
        ("nudge_both", course(S(1024), S(1024, shift=180, rotate=-20), S(1024))),
        ("nudge_on_a_turn", course(S(1024), T("left", 90, 512, shift=120, rotate=15), S(1024))),

        # Refused: the editor's pieces out of range, and nudges past strict.
        ("bad_shape_ranges", course(
            S(512), {"type": "stairs", "length": 64, "rise": 0, "count": 8},
            {"type": "platforms", "length": 100, "count": 4, "drop": -50},
            {"type": "pillars", "length": 96, "count": 4},
            {"type": "tunnel", "length": 768, "height": 96},
            {"type": "chicane", "direction": "none", "angle": 120, "radius": 512},
            {"type": "bumps", "length": 512, "count": 2, "rise": 240},
            {"type": "pinch", "length": 512, "gate": 900},
            {"type": "ledge", "length": 512, "direction": "left", "ledge_width": 400},
            {"type": "hazard", "length": 600},
            {"type": "strafepads", "count": 200, "spacing": 900, "curve": 400})),
        ("bad_nudge", course(S(512), S(512, shift=1024, rotate=90))),
        ("bad_shape_flags", course(S(512), dict(TU, open=True), dict(HZ, ice=True))),
        ("narrow_shape_pieces", course(S(512), PI, PN, width=256)),
    ]

    # Every one of those, laid again in the editor's tier: the same specs, the
    # looser rules. This is what pins the port's open tier, where a refusal
    # becomes a note and the numbers may run much wider.
    out += [(f"open_{label}", spec, "open") for label, spec, *_ in list(out)
            if not label.startswith("open_")]
    # ...and courses only the open tier will take at all.
    out += [
        ("open_far_nudge", course(S(1024), S(1024, shift=1200, rotate=120), S(1024)), "open"),
        ("open_unclearable", course({"type": "gap", "length": 900, "drop": 0},
                                    {"type": "gap", "length": 700, "drop": 0},
                                    {"type": "stairs", "length": 256, "rise": 640, "count": 4},
                                    {"type": "strafepads", "count": 8, "spacing": 900,
                                     "curve": 170}), "open"),
        ("open_odd_angles", course(S(512), T("left", 37, 200), S(512),
                                   {"type": "chicane", "direction": "right", "angle": 160,
                                    "radius": 220}, S(512), width=96), "open"),
        ("open_huge_pieces", course(S(8000), {"type": "tunnel", "length": 5000, "height": 3000},
                                    {"type": "hazard", "length": 4000}), "open"),
        ("open_tiny_pieces", course(S(32), {"type": "stairs", "length": 64, "rise": 16,
                                            "count": 4}, S(32), width=64), "open"),
        ("open_self_overlap", course(*[S(1024), T("left", 90, 320)] * 4), "open"),
    ]
    return [(c[0], c[1], c[2] if len(c) > 2 else "strict") for c in out]


R3 = lambda v: round(v, 3)  # noqa: E731


def prism(p):
    return [p.tex, None if p.heading is None else R3(p.heading), R3(p.zmin), R3(p.top0),
            R3(p.gx), R3(p.gy), [R3(c) for xy in p.poly for c in xy]]


def value(v):
    if isinstance(v, tuple):
        return [R3(c) if isinstance(c, float) else c for c in v]
    return R3(v) if isinstance(v, float) else v


def dump_case(label, spec, rules="strict"):
    case = {"label": label, "spec": spec, "rules": rules}
    try:
        c = layout.build(copy.deepcopy(spec), rules=rules)
    except layout.LayoutError as e:
        case["problems"] = e.problems
        return case
    case["problems"] = []
    # The open tier keeps the pieces-fit-together findings instead of
    # refusing over them, so they are part of what the port has to match.
    case["notes"] = c.notes
    case["course"] = {
        "length": R3(c.length),
        "world": [prism(p) for p in c.world],
        "entities": [[{k: value(v) for k, v in keys.items()}, [prism(b) for b in brushes]]
                     for keys, brushes in c.entities],
        "route": [[R3(x), R3(y), R3(z)] for x, y, z in c.route],
        "landmarks": [[k, [R3(x) for x in pos], R3(h)] for k, pos, h in c.landmarks],
        "shortcuts": c.shortcuts,
        "features": c.features,
        "overpasses": c.overpasses,
        "cuts": c.cuts,
        "auto_checkpoints": [[i, a] for i, a in c.auto_checkpoints],
        "bounds": [[R3(v) for v in corner] for corner in c.bounds],
    }
    return case


def dump():
    return {
        "_": "Dumped by tools/mapgen/golden.py; do not edit. See web/test/mapgen-course.test.js.",
        "constants": {
            "WALLCLIMB_RISE": list(specmod.WALLCLIMB_RISE),
            "WALLGAP_DROP": list(specmod.WALLGAP_DROP),
            "split_hole": specmod.split_hole(),
            "max_rise": specmod.physics.max_rise(),
            "max_gap": {str(d): specmod.physics.max_gap(d) for d in (-36, 0, 64, 128, 256, 512)},
            "wallgap_window": {str(d): list(specmod.wallgap_window(d)) for d in range(-94, -71)},
            "dash_window": {str(d): list(specmod.dash_window(d)) for d in (384, 512, 768, 1024)},
        },
        "cases": [dump_case(label, spec, rules) for label, spec, rules in cases()],
    }


def texture_hashes():
    """sha256 of each texture's pixels as drawn: RGB, top row first. The
    editor's public/assets/js/mapgen-textures.js must draw the same bytes."""
    out = {}
    for kind, make in {**assets.TEXTURES, **assets.ICE_TEXTURES}.items():
        out[kind] = hashlib.sha256(bytes(v for px in make().px for v in px)).hexdigest()
    return out


def load_texture_hashes():
    with open(TEXTURES) as fh:
        return json.load(fh)


def encode(data):
    text = json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n"
    # mtime pinned so the same layout always dumps the same bytes.
    return gzip.compress(text.encode(), compresslevel=9, mtime=0)


def main(argv):
    blob = encode(dump())
    if "--check" in argv:
        try:
            with open(FIXTURE, "rb") as fh:
                have = json.loads(gzip.decompress(fh.read()))
        except FileNotFoundError:
            have = None
        if have != json.loads(gzip.decompress(blob)):
            print(f"{os.path.relpath(FIXTURE)} is out of date: run tools/mapgen/golden.py "
                  "and bring web/public/assets/js/mapgen-course.js along", file=sys.stderr)
            return 1
        return 0
    with open(FIXTURE, "wb") as fh:
        fh.write(blob)
    with open(TEXTURES, "w") as fh:
        json.dump(texture_hashes(), fh, indent=2, sort_keys=True)
        fh.write("\n")
    print(f"wrote {os.path.relpath(FIXTURE)} ({len(blob)} bytes) and {os.path.relpath(TEXTURES)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
