"""The course spec: the one contract between "describe a map" and "build it".

A spec is plain JSON. The language model writes it (describe.py), a human may
edit it, and layout.py turns it into geometry. Keeping it small and physical —
lengths and angles in game units, never "make it fast" — is what lets every
field be checked against physics.py before anything is compiled.

    {
      "name":  "gen_icy_loop",          # bsp name; what players vote for
      "title": "Icy Loop",              # worldspawn "message"
      "width": 384,                     # corridor width, whole course
      "segments": [
        {"type": "straight", "length": 1024},
        {"type": "turn", "direction": "left", "angle": 90, "radius": 512},
        {"type": "ramp", "length": 512, "rise": -128},
        {"type": "gap", "length": 128, "drop": 64},
        {"type": "checkpoint"}
      ]
    }

A 180-degree turn may carry "shortcut": true: an optional, hard route across
the inside of the U on small stepping stones (layout._shortcut). It needs a
straight of at least SHORTCUT_MIN_LEG on both sides, because the windows are
cut into those two straights' walls.

Three pieces change the corridor itself (layout.py lays them out):

  slalom  fins off alternate walls, each leaving a SLALOM_GATE-wide gate
  beam    no floor but a beam_width-wide bridge down the middle, over the pit
  split   a median wall splits the corridor into two lanes: one a tight weave,
          the other ("direction" names its side) straight over `count` holes

A course may pass over itself where one part runs high enough above another
(layout's self-intersection test is 3-D); layout reports those as overpasses.

The start room, start timer, finish timer and finish room are implicit: every
course has exactly one of each, so the model is never asked to place them and
can never forget them. Checkpoints are partly implicit: any the spec places
are kept, and layout.plan_checkpoints adds more wherever a long stretch has
none.

This module validates field ranges only. Whether the pieces fit together — a
gap with no run-up, a course that crosses itself — is layout.py's job, because
that needs the geometry.
"""

import re

import physics

SEGMENT_TYPES = ("straight", "turn", "ramp", "gap", "checkpoint", "slalom", "beam", "split")
TURN_ANGLES = (45, 90, 135, 180)
NAME_RE = re.compile(r"^gen_[a-z0-9_]{2,36}$")

WIDTH_MIN, WIDTH_MAX = 256, 768
MAX_SEGMENTS = 64
STRAIGHT_MIN, STRAIGHT_MAX = 128, 4096
RAMP_MIN, RAMP_MAX = 128, 2048
TURN_RADIUS_MAX = 2048
GAP_MIN = 32
DROP_MAX = 512
SHORTCUT_MIN_LEG = 320   # layout.SHORTCUT_BACK + window/2 + footing; kept in step by a test

# Slalom: fins at least SLALOM_FIN_MIN long, gates SLALOM_GATE wide, and at
# least SLALOM_SPACING between fins so there is room to turn at speed.
SLALOM_GATE = 160
SLALOM_FIN_MIN = 64
SLALOM_SPACING = 256
SLALOM_COUNT = (2, 12)
# Beam: the player is 32 wide; 48 leaves 8 units either side.
BEAM_MIN = 48
BEAM_WALL_CLEAR = 64     # at least this much void between the beam and each wall
# Split: SPLIT_MOUTH of open floor at each end so the choice is visible, a
# median SPLIT_MEDIAN thick, holes SPLIT_HOLE long in the fast lane, each
# after SPLIT_RUNWAY of floor, and SPLIT_LANDING of floor after the last.
SPLIT_MOUTH = 160
SPLIT_MEDIAN = 32
SPLIT_LANE_MIN = 176
SPLIT_HOLE_FILL = 0.85
SPLIT_RUNWAY = 192       # physics.MIN_RUNUP: every hole is taken at full run speed
SPLIT_LANDING = 128
SPLIT_COUNT = (1, 6)


def split_hole():
    """Hole length in a split's fast lane: SPLIT_HOLE_FILL of a flat run-speed
    jump (physics.max_gap already carries its 0.8 margin)."""
    return int(physics.max_gap(0) * SPLIT_HOLE_FILL)


def split_min_length(count):
    return 2 * SPLIT_MOUTH + count * (SPLIT_RUNWAY + split_hole()) + SPLIT_LANDING

# The JSON Schema handed to the model as its structured-output format. It is
# deliberately flat — every segment carries every field, irrelevant ones set
# to 0 / "none" — because structured outputs guarantee the SHAPE, not the
# ranges. Ranges are enforced by validate() below, and a violation goes back
# to the model as a repair prompt (describe.py).
SEGMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(SEGMENT_TYPES)},
        "length": {"type": "integer"},
        "direction": {"type": "string", "enum": ["left", "right", "none"]},
        "angle": {"type": "integer"},
        "radius": {"type": "integer"},
        "rise": {"type": "integer"},
        "drop": {"type": "integer"},
        "shortcut": {"type": "boolean"},
        "count": {"type": "integer"},
        "beam_width": {"type": "integer"},
    },
    "required": ["type", "length", "direction", "angle", "radius", "rise", "drop", "shortcut",
                 "count", "beam_width"],
    "additionalProperties": False,
}

SPEC_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "title": {"type": "string"},
        "width": {"type": "integer"},
        "segments": {"type": "array", "items": SEGMENT_SCHEMA},
    },
    "required": ["name", "title", "width", "segments"],
    "additionalProperties": False,
}


def turn_radius_min(width):
    """Centre-line radius below which the inner wall would pinch the corridor."""
    return width // 2 + 64


def normalize(spec):
    """Drop the placeholder fields the flat schema forces on every segment, so a
    stored spec reads the way a human would write it."""
    keep = {
        "straight": ("length",),
        "turn": ("direction", "angle", "radius", "shortcut"),
        "ramp": ("length", "rise"),
        "gap": ("length", "drop"),
        "checkpoint": (),
        "slalom": ("length", "count"),
        "beam": ("length", "beam_width"),
        "split": ("length", "direction", "count"),
    }
    out = {k: spec[k] for k in ("name", "title", "width") if k in spec}
    out["segments"] = []
    for seg in spec.get("segments", []):
        t = seg.get("type")
        clean = {"type": t}
        for k in keep.get(t, ()):
            if k in seg:
                clean[k] = seg[k]
        if clean.get("shortcut") is False:
            del clean["shortcut"]   # the default; keep stored specs short
        out["segments"].append(clean)
    return out


def validate(spec):
    """Return a list of human-readable problems; empty means the ranges are ok."""
    errs = []
    if not isinstance(spec, dict):
        return ["spec must be a JSON object"]

    name = spec.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        errs.append(f"name {name!r} must match {NAME_RE.pattern} "
                    "(lowercase; the gen_ prefix marks generated maps in the pool)")
    if not isinstance(spec.get("title"), str) or not spec["title"].strip():
        errs.append("title must be a non-empty string")

    width = spec.get("width")
    if not isinstance(width, int) or not WIDTH_MIN <= width <= WIDTH_MAX:
        errs.append(f"width {width!r} must be an integer in [{WIDTH_MIN}, {WIDTH_MAX}]")
        width = 384

    segs = spec.get("segments")
    if not isinstance(segs, list) or not segs:
        errs.append("segments must be a non-empty list")
        return errs
    if len(segs) > MAX_SEGMENTS:
        errs.append(f"{len(segs)} segments; at most {MAX_SEGMENTS}")

    slope = physics.max_ramp_slope()
    for i, seg in enumerate(segs):
        where = f"segment {i}"
        if not isinstance(seg, dict):
            errs.append(f"{where}: must be an object")
            continue
        t = seg.get("type")
        where = f"segment {i} ({t})"

        def num(key, lo, hi):
            v = seg.get(key)
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi:
                errs.append(f"{where}: {key} {v!r} must be in [{lo}, {hi}]")
                return None
            return v

        def whole(key, lo, hi):
            v = seg.get(key)
            if not isinstance(v, int) or isinstance(v, bool) or not lo <= v <= hi:
                errs.append(f"{where}: {key} {v!r} must be a whole number in [{lo}, {hi}]")
                return None
            return v

        if t == "straight":
            num("length", STRAIGHT_MIN, STRAIGHT_MAX)
        elif t == "turn":
            if seg.get("direction") not in ("left", "right"):
                errs.append(f"{where}: direction must be 'left' or 'right'")
            if seg.get("angle") not in TURN_ANGLES:
                errs.append(f"{where}: angle {seg.get('angle')!r} must be one of {TURN_ANGLES}")
            num("radius", turn_radius_min(width), TURN_RADIUS_MAX)
            if seg.get("shortcut"):
                if seg.get("angle") != 180:
                    errs.append(f"{where}: a shortcut needs a 180-degree turn, not {seg.get('angle')!r}")
                for j, side in ((i - 1, "before"), (i + 1, "after")):
                    nb = segs[j] if 0 <= j < len(segs) else None
                    if (not isinstance(nb, dict) or nb.get("type") != "straight"
                            or not isinstance(nb.get("length"), (int, float))
                            or nb["length"] < SHORTCUT_MIN_LEG):
                        errs.append(f"{where}: a shortcut needs a straight of at least "
                                    f"{SHORTCUT_MIN_LEG} directly {side} the turn")
        elif t == "ramp":
            length = num("length", RAMP_MIN, RAMP_MAX)
            rise = num("rise", -1024, 1024)
            if length and rise is not None and abs(rise) > slope * length + 1e-6:
                errs.append(f"{where}: rise {rise} over length {length} is steeper than "
                            f"30 degrees; |rise| must be <= {int(slope * length)}")
        elif t == "gap":
            drop = num("drop", -int(physics.max_rise()), DROP_MAX)
            length = num("length", GAP_MIN, 4096)
            if drop is not None and length is not None:
                reach = physics.max_gap(drop)
                if length > reach:
                    errs.append(f"{where}: a {length}-unit gap with drop {drop} is not "
                                f"clearable from a 320 ups run-up; max is {int(reach)}")
        elif t == "checkpoint":
            pass
        elif t == "slalom":
            length = num("length", STRAIGHT_MIN, STRAIGHT_MAX)
            count = whole("count", *SLALOM_COUNT)
            if width - SLALOM_GATE < SLALOM_FIN_MIN:
                errs.append(f"{where}: a slalom needs width >= {SLALOM_GATE + SLALOM_FIN_MIN} "
                            f"(a {SLALOM_GATE}-unit gate beside each fin)")
            if length and count and length / (count + 1) < SLALOM_SPACING:
                errs.append(f"{where}: {count} fins in {length} units are closer than "
                            f"{SLALOM_SPACING}; length must be >= {SLALOM_SPACING * (count + 1)}")
        elif t == "beam":
            num("length", STRAIGHT_MIN, 2048)
            num("beam_width", BEAM_MIN, width - 2 * BEAM_WALL_CLEAR)
        elif t == "split":
            if seg.get("direction") not in ("left", "right"):
                errs.append(f"{where}: direction (the side of the fast lane with the holes) "
                            "must be 'left' or 'right'")
            count = whole("count", *SPLIT_COUNT)
            length = num("length", STRAIGHT_MIN, STRAIGHT_MAX)
            if (width - SPLIT_MEDIAN) / 2 < SPLIT_LANE_MIN:
                errs.append(f"{where}: a split needs width >= {2 * SPLIT_LANE_MIN + SPLIT_MEDIAN} "
                            f"for two {SPLIT_LANE_MIN}-unit lanes")
            if length and count and length < split_min_length(count):
                errs.append(f"{where}: {count} hole(s) need length >= {split_min_length(count)}")
        else:
            errs.append(f"{where}: unknown type; must be one of {SEGMENT_TYPES}")
    return errs
