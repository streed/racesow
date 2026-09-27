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

The start room, start timer, finish timer and finish room are implicit: every
course has exactly one of each, so the model is never asked to place them and
can never forget them.

This module validates field ranges only. Whether the pieces fit together — a
gap with no run-up, a course that crosses itself — is layout.py's job, because
that needs the geometry.
"""

import re

import physics

SEGMENT_TYPES = ("straight", "turn", "ramp", "gap", "checkpoint")
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
    },
    "required": ["type", "length", "direction", "angle", "radius", "rise", "drop", "shortcut"],
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
        else:
            errs.append(f"{where}: unknown type; must be one of {SEGMENT_TYPES}")
    return errs
