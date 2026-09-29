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

Three pieces need the "special" key (physics.py models both moves from the
engine's own numbers). The two wall pieces end on a ledge no jump reaches at
any speed; the dash drop is longer than a perfect run-speed jump:

  wallclimb  a ledge `rise` high (too high to jump onto) halfway along, with a
             kick wall on `direction`: jump, wall-jump off it, land on top
  wallgap    a gap up onto a ledge too high to jump onto, with a kick wall
             along `direction`: jump and wall-jump off it mid-air
  dash       a DASH_PAD open take-off pad, then a long gap `drop` down that
             only a dash's 451 ups carries

Any straight, turn, ramp or gap may set "open": true to lose its side walls
and float over the void, with its floor edges painted. The special-move pieces
are open on every side except their kick wall.

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

import math
import re

import physics

SEGMENT_TYPES = ("straight", "turn", "ramp", "gap", "checkpoint", "slalom", "beam", "split",
                 "wallclimb", "wallgap", "dash")
OPENABLE = ("straight", "turn", "ramp", "gap")
TURN_ANGLES = (45, 90, 135, 180)
NAME_RE = re.compile(r"^gen_[a-z0-9_]{2,36}$")
# The title is the one free-text field the model writes, and it lands in the
# compiled map (worldspawn "message", shown on the loading screen) and on the
# site. The model's output is as untrusted as the description that steered it,
# so the title is held to plain words: letters, digits, spaces and a little
# punctuation. No quotes, braces, backslashes or newlines (they would break out
# of the .map key/value syntax and add entities), no ^ (Warsow colour codes),
# no . or / (no URLs), no @ or # (no handles).
TITLE_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9 '&!?,:-]{0,38}[A-Za-z0-9!?'])?$")

# Size ceilings, so a runaway plan cannot produce a map that is slow to build,
# slow to download or heavy for every game server to load. The examples use
# a fraction of each (the largest route is ~31,600 units).
ROUTE_MAX = 40000        # centre-line units, start line to finish line (~125 s par)
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
# Wall climb: the ledge must beat a plain jump (apex + step) by a clear
# margin and stay within a jump plus a wall jump; each half of the piece is a
# full run-up / landing.
WALLCLIMB_RISE = (int(physics.plain_climb()) + 8, int(physics.wall_climb()))
WALLCLIMB_MIN = 2 * int(physics.MIN_RUNUP)
# Wall-kick gap: a gap UP onto a ledge WALLCLIMB_RISE higher (drop is minus the
# rise). Height is what makes it a requirement: strafing adds speed, never
# height, so no jump reaches the ledge without the kick however fast it is.
# (A gap that only needs distance could be strafe-jumped instead.)
WALLGAP_DROP = (-WALLCLIMB_RISE[1], -WALLCLIMB_RISE[0])
WALLGAP_MIN = 64
# A jump from an upward ramp starts with the ramp's upward speed on top of its
# own and flies far higher (PM_CheckJump adds the jump speed to it). After
# WALL_RUNUP of level floor that arc is back below the lowest wall ledge, so a
# wall climb or wall-kick gap needs that much before its take-off.
WALL_RUNUP = 384
# Dash drop: below DASH_DROP[0] a run-speed jump reaches nearly as far as a
# dash. DASH_PAD of open floor keeps any wall out of wall-jump reach of the lip.
DASH_DROP = (384, 1024)
DASH_PAD = 192


def wallgap_window(drop):
    """(shortest, longest) wall-kick gap up onto a ledge -drop higher: no
    jump reaches that ledge at all, and a jump plus a wall jump carries this
    far at run speed."""
    return WALLGAP_MIN, int(physics.wall_jump_reach(drop))


def dash_window(drop):
    """(shortest, longest) dash gap at this drop: longer than a perfect
    run-speed jump, within a dash."""
    return int(physics.jump_reach(drop)) + 1, int(physics.dash_reach(drop))


def route_length(seg):
    """Centre-line length a segment adds to the route."""
    t = seg.get("type")
    if t == "turn":
        a = seg.get("angle")
        return math.radians(a if isinstance(a, (int, float)) else 0) * seg.get("radius", 0)
    if t == "checkpoint":
        return 0.0
    n = seg.get("length", 0)
    return float(n) + (DASH_PAD if t == "dash" else 0)


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
        "open": {"type": "boolean"},
    },
    "required": ["type", "length", "direction", "angle", "radius", "rise", "drop", "shortcut",
                 "count", "beam_width", "open"],
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
        "straight": ("length", "open"),
        "turn": ("direction", "angle", "radius", "shortcut", "open"),
        "ramp": ("length", "rise", "open"),
        "gap": ("length", "drop", "open"),
        "checkpoint": (),
        "slalom": ("length", "count"),
        "beam": ("length", "beam_width"),
        "split": ("length", "direction", "count"),
        "wallclimb": ("length", "rise", "direction"),
        "wallgap": ("length", "drop", "direction"),
        "dash": ("length", "drop"),
    }
    out = {k: spec[k] for k in ("name", "title", "width") if k in spec}
    out["segments"] = []
    for seg in spec.get("segments", []):
        t = seg.get("type")
        clean = {"type": t}
        for k in keep.get(t, ()):
            if k in seg:
                clean[k] = seg[k]
        for flag in ("shortcut", "open"):
            if clean.get(flag) is False:
                del clean[flag]     # the default; keep stored specs short
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
    title = spec.get("title")
    if not isinstance(title, str) or not TITLE_RE.match(title) or "  " in title:
        errs.append(f"title {title!r} must be 1-40 characters of letters, digits, single "
                    "spaces and ' & ! ? , : - (no other punctuation), naming the course's theme")

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

    route = 0.0
    for seg in segs:
        if not isinstance(seg, dict):
            continue
        v = seg.get("radius" if seg.get("type") == "turn" else "length")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            route += route_length(seg)
    if route > ROUTE_MAX:
        errs.append(f"the route is {int(route)} units long; at most {ROUTE_MAX} "
                    f"(about {ROUTE_MAX // 320} s at 320 ups)")

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

        if "open" in seg and not isinstance(seg["open"], bool):
            errs.append(f"{where}: open must be true or false")
        elif seg.get("open") and t not in OPENABLE:
            errs.append(f"{where}: only {', '.join(OPENABLE)} can be open "
                        "(the special-move pieces are open already)")

        def side():
            if seg.get("direction") not in ("left", "right"):
                errs.append(f"{where}: direction (the side of the kick wall) must be "
                            "'left' or 'right'")

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
        elif t == "wallclimb":
            side()
            num("length", WALLCLIMB_MIN, STRAIGHT_MAX)
            whole("rise", *WALLCLIMB_RISE)
        elif t == "wallgap":
            side()
            drop = whole("drop", *WALLGAP_DROP)
            length = num("length", GAP_MIN, 4096)
            if drop is not None and length is not None:
                lo, hi = wallgap_window(drop)
                if not lo <= length <= hi:
                    errs.append(f"{where}: at drop {drop} a wall-kick gap must be {lo}-{hi} "
                                "long; longer cannot be made even with the wall jump")
        elif t == "dash":
            drop = whole("drop", *DASH_DROP)
            length = num("length", GAP_MIN, 4096)
            if drop is not None and length is not None:
                lo, hi = dash_window(drop)
                if not lo <= length <= hi:
                    errs.append(f"{where}: at drop {drop} a dash gap must be {lo}-{hi} long: "
                                "shorter can be jumped, longer cannot be dashed")
        else:
            errs.append(f"{where}: unknown type; must be one of {SEGMENT_TYPES}")
    return errs
