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

Any straight, turn, ramp or slalom may set "ice": true to floor it with the
slick ice texture (surfaceparm slick). Ice only removes ground friction
(physics.py): the player still accelerates to run speed on it, so every
run-up rule holds, but keeps whatever speed they bring and slides wide
through a corner instead of braking.

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

# What the language model is taught to write (describe.py's prompt documents
# every one of these, and SEGMENT_SCHEMA's enum is built from them). A
# described map goes in the pool with nobody having looked at it, so the
# model's vocabulary is kept to the pieces whose rules the prompt can state.
MODEL_SEGMENT_TYPES = ("straight", "turn", "ramp", "gap", "checkpoint", "slalom", "beam",
                       "split", "wallclimb", "wallgap", "dash")
# ...and what the map editor can lay as well. These are shape rather than
# move: corridor built differently, asking nothing of the player that
# physics.py has to model. A person picks them, sees the result, and an admin
# approves it, so they need no prompt to explain them — and keeping them out
# of the model's enum means it can never reach for one it was not told about.
EDITOR_SEGMENT_TYPES = ("stairs", "platforms", "pillars", "tunnel", "chicane", "bumps",
                        "pinch", "ledge", "hazard", "strafepads")
SEGMENT_TYPES = MODEL_SEGMENT_TYPES + EDITOR_SEGMENT_TYPES
# A piece can be open (no side walls, floating over the void) if it HAS side
# walls to lose and a floor to paint the edge of.
OPENABLE = ("straight", "turn", "ramp", "gap", "stairs", "platforms", "pillars",
            "chicane", "bumps", "pinch", "hazard")
# Ice floors a piece. Anything with a walking surface can carry it; a piece
# that is only jumped from has nothing to be slick.
ICEABLE = ("straight", "turn", "ramp", "slalom", "stairs", "platforms", "pillars",
           "tunnel", "chicane", "bumps", "pinch", "ledge", "strafepads")
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

# -- the pieces that are shape rather than move -----------------------------
# None of these ask anything of the player that physics.py has to model: they
# are corridor, laid differently. That is why their bounds are mostly about
# the geometry closing (a fin that does not touch the next one, a gate a
# player fits through) rather than about what a run can clear.
FIN_THICK = 32           # layout.FIN_THICK; a test keeps the two in step
PLAYER_WIDTH = 32        # the engine's own player box, and the floor of every gate

# Stairs: `count` steps over `length`, climbing or dropping `rise` in total.
# A step taller than the engine's step height has to be jumped, which is
# allowed (it is just a harder staircase) but never generated.
STAIRS_RISE_MAX = 2048
STAIR_TREAD_MIN = 16     # a tread shorter than this is a wall, not a step
# Platforms: `count` stepping stones with a hole between each, over a pit.
PLATFORM_MIN = 64        # a stone shorter than this is not a landing
PLATFORM_FILL = 0.55     # of each stone-and-hole cell that is stone
# Bumps: a rolling floor of `count` humps, each a rise and a fall.
BUMP_MIN = 64            # shorter than this and a hump is a kerb
# Pillars: columns standing clear of both walls, to weave around.
PILLAR_MIN = 48
PILLAR_CLEAR = 64        # gate left between a pillar and each wall
# Tunnel: a roofed straight. The roof has to clear a jump or the piece is a
# trap, which the strict tier insists on and the editor may ignore.
TUNNEL_MIN = 96          # the player box is 56 tall; this is crawl-free headroom
TUNNEL_SAFE = 160        # clears a jump, so the roof is scenery and not a trap
# Pinch: the corridor narrows to `gate` for the length of the piece.
PINCH_MIN = PLAYER_WIDTH + 16
PINCH_BITE = 32          # each side must take at least this much
# Ledge: a walkway along one wall, the rest of the corridor void.
LEDGE_MIN = 48
LEDGE_CLEAR = 64         # void left between the ledge and the far wall
# Hazard: a strip of lethal floor, jumped like a gap but with ground to land
# short on. The strict tier keeps it inside a run-speed jump.
HAZARD_MIN = 64
# Strafe pads: a line of pads over the void with a gap between each, taken by
# strafe-jumping from one to the next. `count` pads, `spacing` centre to
# centre, and `curve` degrees of bend across the whole run -- signed, so one
# control runs from a left arc through dead straight to a right arc.
STRAFE_PAD_LEN = 128     # the pad itself, along the run
STRAFE_GAP_MIN = 32      # a pad run with no gap between pads is just a floor
# Chicane: a left-right (or right-left) pair of turns that leaves the course
# pointing the way it came in, offset sideways. Its bounds are a turn's.
CHICANE_ANGLE = (10, 90)

# -- placing a piece relative to the one before -----------------------------
# Every piece may carry five of these. Three move the cursor BEFORE the piece
# is laid, so the course itself goes somewhere different:
#
#   away    along the way it is facing: + opens a gap to the piece before
#   shift   across that: + is left
#   rotate  turn on the spot: + is left
#
# ...and two turn the piece's BRUSHES after it is laid, leaving the course's
# own line alone (layout._tilt_for), which is what stops a banked corner
# dragging everything after it off the floor:
#
#   roll    bank about the line it runs along: + lifts the left side
#   pitch   tip about the line across it: + raises the far end
#
# All five work on every piece kind without any piece knowing they exist.
PLACEMENT = ("away", "shift", "rotate", "roll", "pitch")
SHIFT_MAX = 4096
ROTATE_MAX = 180
AWAY_MAX = 8192
ROLL_MAX = 180
PITCH_MAX = 180
# The strict tier keeps the two cursor turns small — a described course should
# read as a course, not as pieces scattered near each other — and forbids the
# other three outright:
#
#   away  opens a floorless gap between two pieces, which is precisely the
#         unclearable jump every physics rule in this tier exists to prevent;
#   roll and pitch leave the upright, 2-D world the rest of this tier reasons
#         in. Whether a course crosses itself, what a jump lands on and where
#         a player can cut the route are all answered from footprints, and a
#         banked piece has no honest footprint. The editor may have them
#         because there those answers are notes for a person to weigh, not
#         guarantees made on nobody's behalf.
STRICT_SHIFT_MAX = 256
STRICT_ROTATE_MAX = 30

# ---------------------------------------------------------------------------
# Two rule tiers.
#
# "strict" is the generator's own, and every bound in it is one physics.py can
# defend. A described map (describe.py) and every random_map tile (tiles.py)
# go in the pool with nobody having looked at them, so they have to be
# raceable by construction: a gap no wider than a jump reaches, a ledge no
# higher than a wall jump climbs, a run-up before every take-off.
#
# "open" is the map editor. A person is laying the course out piece by piece,
# they can see it as they go, and an admin approves it before it is built — so
# the judgement the strict tier has to make by rule, this tier leaves to them.
# What survives are the limits that decide whether the map can be COMPILED and
# LOADED at all: geometry that closes instead of turning inside out, a world
# inside the compiler's reach, and a brush count a server can hold. Nothing
# here is about whether the course is fair or even possible.
#
# The editor still OFFERS the strict numbers — PIECES.make() in
# mapgen-pieces.js builds every new piece from them, so the default course is
# a sane one. These wider bounds are only how far a value may be pushed by
# hand once someone means to.
# ---------------------------------------------------------------------------

class Tier:
    """The bounds and switches one rule tier applies.

    `physics` is the difference that matters: with it off, lengths and heights
    are no longer measured against what a player can actually do, which is
    the whole of what "the editor is less strict" means."""

    def __init__(self, name, **kw):
        self.name = name
        for k, v in kw.items():
            setattr(self, k, v)


STRICT = Tier(
    "strict",
    physics=True,            # measure every take-off against physics.py
    combine=True,            # run-ups, landings, self-intersection, cuts (layout.py)
    angles=TURN_ANGLES,      # the four angles the model may ask for
    angle_range=None,
    route=ROUTE_MAX,
    segments=MAX_SEGMENTS,
    width=(WIDTH_MIN, WIDTH_MAX),
    straight=(STRAIGHT_MIN, STRAIGHT_MAX),
    ramp=(RAMP_MIN, RAMP_MAX),
    rise=1024,
    slope=None,              # None: physics.max_ramp_slope(), i.e. 30 degrees
    radius_slack=64,         # centre-line radius floor over half the width
    radius_max=TURN_RADIUS_MAX,
    gap=(GAP_MIN, 4096),
    drop_max=DROP_MAX,
    drop_min=None,           # None: -physics.max_rise()
    slalom_count=SLALOM_COUNT,
    slalom_spacing=SLALOM_SPACING,
    beam=(STRAIGHT_MIN, 2048),
    beam_clear=BEAM_WALL_CLEAR,
    split_count=SPLIT_COUNT,
    split_runway=SPLIT_RUNWAY,
    wallclimb_rise=WALLCLIMB_RISE,
    wallclimb_min=WALLCLIMB_MIN,
    wallgap_drop=WALLGAP_DROP,
    dash_drop=DASH_DROP,
    chicane_angle=(10, 90),
    bumps_rise=(16, 256),
    pads_count=(2, 16),
    pads_spacing=(STRAFE_PAD_LEN + STRAFE_GAP_MIN, 512),
    pads_curve=90,
    stairs_count=(2, 32),
    platforms_count=(2, 12),
    pillars_count=(1, 12),
    bumps_count=(1, 12),
    tunnel_height=(TUNNEL_SAFE, 512),
    pinch_gate=(PINCH_MIN, None),      # None: width - 2 * PINCH_BITE
    ledge_width=(LEDGE_MIN, None),     # None: width - LEDGE_CLEAR
    hazard=(HAZARD_MIN, None),         # None: physics.max_gap(0), it is jumped
    shift=STRICT_SHIFT_MAX,
    rotate=STRICT_ROTATE_MAX,
    away=0,
    roll=0,
    pitch=0,
    # The laid-out course's ceilings. This is where they are written down;
    # layout.EXTENT_MAX_XY and friends are aliases of these three.
    extent_xy=16384,
    extent_z=8192,
    brushes=1500,
)

# "Within reason" for every one of these means the same thing: the map still
# compiles, still loads, and the piece is still the shape its name says. A
# 64-unit corridor is tight but a 32-wide player fits; a 6,000-brush map is
# heavy but it builds; a 71-degree ramp is a wall to run up but a fine one to
# come down. Past these the geometry stops being geometry.
OPEN = Tier(
    "open",
    physics=False,
    combine=False,
    angles=None,             # any angle, not just the model's four
    angle_range=(5, 180),
    route=200000,
    segments=256,
    width=(64, 2048),
    straight=(32, 16384),
    ramp=(32, 16384),
    rise=8192,
    slope=3.0,               # ~71 degrees: still a ramp, not a wall
    radius_slack=8,          # the inner wall may almost pinch shut
    radius_max=8192,
    gap=(16, 8192),
    drop_max=8192,
    drop_min=-8192,
    slalom_count=(1, 48),
    slalom_spacing=FIN_THICK + PLAYER_WIDTH,   # fins that do not touch
    beam=(32, 8192),
    beam_clear=16,
    split_count=(1, 24),
    split_runway=32,
    wallclimb_rise=(16, 1024),
    wallclimb_min=64,
    wallgap_drop=(-1024, 0),
    dash_drop=(32, 4096),
    chicane_angle=(5, 170),
    bumps_rise=(8, 1024),
    pads_count=(1, 64),
    pads_spacing=(STRAFE_PAD_LEN + STRAFE_GAP_MIN, 4096),
    pads_curve=270,
    stairs_count=(1, 128),
    platforms_count=(1, 48),
    pillars_count=(1, 48),
    bumps_count=(1, 48),
    tunnel_height=(TUNNEL_MIN, 4096),
    pinch_gate=(PINCH_MIN, None),
    ledge_width=(LEDGE_MIN, None),
    hazard=(HAZARD_MIN, 8192),
    shift=SHIFT_MAX,
    rotate=ROTATE_MAX,
    away=AWAY_MAX,
    roll=ROLL_MAX,
    pitch=PITCH_MAX,
    # Further out, and still the compile-and-load limits rather than taste: a
    # 30,000-unit spread keeps a centred course inside the compiler's own
    # +-16,384 half-world, and 6,000 brushes builds in seconds and loads like
    # any hand-made map already in the pool.
    extent_xy=30000,
    extent_z=16000,
    brushes=6000,
)

TIERS = {"strict": STRICT, "open": OPEN}


def tier(rules):
    """The Tier named by `rules`; anything unknown is the strict one, so a
    caller that forgets to pass it gets the safe tier, never the loose one."""
    return TIERS.get(rules, STRICT)


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
    if t in ("turn", "chicane"):
        a = seg.get("angle")
        a = math.radians(a if isinstance(a, (int, float)) else 0)
        # A chicane is two arcs of the same angle, one each way.
        return a * seg.get("radius", 0) * (2 if t == "chicane" else 1)
    if t == "strafepads":
        # The run is its pads end to end, however it bends.
        n, sp = seg.get("count", 0), seg.get("spacing", 0)
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (n, sp)):
            return 0.0
        return float(n) * float(sp)
    if t == "checkpoint":
        return 0.0
    n = seg.get("length", 0)
    if not isinstance(n, (int, float)) or isinstance(n, bool):
        n = 0
    return float(n) + (DASH_PAD if t == "dash" else 0)


def split_hole():
    """Hole length in a split's fast lane: SPLIT_HOLE_FILL of a flat run-speed
    jump (physics.max_gap already carries its 0.8 margin)."""
    return int(physics.max_gap(0) * SPLIT_HOLE_FILL)


def split_min_length(count, rules="strict"):
    runway = tier(rules).split_runway
    return 2 * SPLIT_MOUTH + count * (runway + split_hole()) + SPLIT_LANDING


def platform_cell():
    """The smallest stone-plus-hole a platforms piece can be cut into."""
    return int(PLATFORM_MIN / PLATFORM_FILL)

# The JSON Schema handed to the model as its structured-output format. It is
# deliberately flat — every segment carries every field, irrelevant ones set
# to 0 / "none" — because structured outputs guarantee the SHAPE, not the
# ranges. Ranges are enforced by validate() below, and a violation goes back
# to the model as a repair prompt (describe.py).
SEGMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": list(MODEL_SEGMENT_TYPES)},
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
        "ice": {"type": "boolean"},
    },
    "required": ["type", "length", "direction", "angle", "radius", "rise", "drop", "shortcut",
                 "count", "beam_width", "open", "ice"],
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


def turn_radius_min(width, rules="strict"):
    """Centre-line radius below which the inner wall would pinch the corridor.
    The editor's tier leaves only the geometric margin: at the strict slack a
    corner is comfortable, at the open one the inner wall nearly closes."""
    return width // 2 + tier(rules).radius_slack


def normalize(spec):
    """Drop the placeholder fields the flat schema forces on every segment, so a
    stored spec reads the way a human would write it."""
    keep = {
        "straight": ("length", "open", "ice"),
        "turn": ("direction", "angle", "radius", "shortcut", "open", "ice"),
        "ramp": ("length", "rise", "open", "ice"),
        "gap": ("length", "drop", "open"),
        "checkpoint": (),
        "slalom": ("length", "count", "ice"),
        "beam": ("length", "beam_width"),
        "split": ("length", "direction", "count"),
        "wallclimb": ("length", "rise", "direction"),
        "wallgap": ("length", "drop", "direction"),
        "dash": ("length", "drop"),
        "stairs": ("length", "rise", "count", "open", "ice"),
        "platforms": ("length", "count", "drop", "open", "ice"),
        "pillars": ("length", "count", "open", "ice"),
        "tunnel": ("length", "height", "ice"),
        "chicane": ("direction", "angle", "radius", "open", "ice"),
        "bumps": ("length", "count", "rise", "open", "ice"),
        "pinch": ("length", "gate", "open", "ice"),
        "ledge": ("length", "direction", "ledge_width", "ice"),
        "hazard": ("length", "open"),
        "strafepads": ("count", "spacing", "curve", "ice"),
    }
    out = {k: spec[k] for k in ("name", "title", "width") if k in spec}
    out["segments"] = []
    for seg in spec.get("segments", []):
        t = seg.get("type")
        clean = {"type": t}
        # Every piece may be nudged sideways and turned on the spot, so these
        # two survive normalize whatever the piece is.
        for k in keep.get(t, ()) + PLACEMENT:
            if k in seg:
                clean[k] = seg[k]
        for flag in ("shortcut", "open", "ice"):
            if clean.get(flag) is False:
                del clean[flag]     # the default; keep stored specs short
        for z in PLACEMENT:
            if clean.get(z) == 0:
                del clean[z]        # likewise: no nudge is the normal case
        out["segments"].append(clean)
    return out


def validate(spec, rules="strict"):
    """Return a list of human-readable problems; empty means the ranges are ok.

    `rules` names the tier (STRICT / OPEN above). The strict tier measures
    every take-off against physics.py, so a described map or a random_map tile
    is raceable by construction. The open tier — the map editor — keeps only
    the bounds that decide whether the course can be built at all, and leaves
    the rest to the person laying it out and the admin who approves it.
    """
    L = tier(rules)
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
                    "spaces and \' & ! ? , : - (no other punctuation), naming the course\'s theme")

    width = spec.get("width")
    if not isinstance(width, int) or not L.width[0] <= width <= L.width[1]:
        errs.append(f"width {width!r} must be an integer in [{L.width[0]}, {L.width[1]}]")
        width = 384

    segs = spec.get("segments")
    if not isinstance(segs, list) or not segs:
        # The start and the finish are implicit, so this is the whole of
        # "a course needs a start, a finish, and something in between".
        errs.append("segments must be a non-empty list: a course needs at least one "
                    "piece between its start and its finish")
        return errs
    if len(segs) > L.segments:
        errs.append(f"{len(segs)} segments; at most {L.segments}")

    route = 0.0
    for seg in segs:
        if not isinstance(seg, dict):
            continue
        v = seg.get("radius" if seg.get("type") in ("turn", "chicane") else "length")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            route += route_length(seg)
    if route > L.route:
        errs.append(f"the route is {int(route)} units long; at most {L.route} "
                    f"(about {L.route // 320} s at 320 ups)")

    slope = L.slope if L.slope is not None else physics.max_ramp_slope()
    radius_min = turn_radius_min(width, rules)
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

        def needs_width(least, why):
            if width < least:
                errs.append(f"{where}: needs width >= {least} ({why})")

        if "open" in seg and not isinstance(seg["open"], bool):
            errs.append(f"{where}: open must be true or false")
        elif seg.get("open") and t not in OPENABLE:
            errs.append(f"{where}: only {', '.join(OPENABLE)} can be open "
                        "(the rest have no side walls to lose)")
        if "ice" in seg and not isinstance(seg["ice"], bool):
            errs.append(f"{where}: ice must be true or false")
        elif seg.get("ice") and t not in ICEABLE:
            errs.append(f"{where}: only {', '.join(ICEABLE)} can be ice "
                        "(a piece with no walking surface has nothing to be slick)")

        # Every piece may be placed relative to the one before it. A tier
        # that forbids one of these bounds it to [0, 0], so the message says
        # so rather than pretending the field is unknown.
        for key in PLACEMENT:
            if key in seg:
                num(key, -getattr(L, key), getattr(L, key))

        def side(what="the side of the kick wall"):
            if seg.get("direction") not in ("left", "right"):
                errs.append(f"{where}: direction ({what}) must be \'left\' or \'right\'")

        def arc(what):
            """A turn\'s three fields, shared by turn and chicane."""
            if seg.get("direction") not in ("left", "right"):
                errs.append(f"{where}: direction must be \'left\' or \'right\'")
            lo, hi = L.chicane_angle if what == "chicane" else (None, None)
            a = seg.get("angle")
            if what == "chicane":
                whole("angle", lo, hi)
            elif L.angles is not None:
                if a not in L.angles:
                    errs.append(f"{where}: angle {a!r} must be one of {L.angles}")
            else:
                whole("angle", *L.angle_range)
            num("radius", radius_min, L.radius_max)

        if t == "straight":
            num("length", *L.straight)
        elif t == "turn":
            arc("turn")
            if seg.get("shortcut"):
                if seg.get("angle") != 180:
                    errs.append(f"{where}: a shortcut needs a 180-degree turn, "
                                f"not {seg.get('angle')!r}")
                elif L.combine:
                    for j, rel in ((i - 1, "before"), (i + 1, "after")):
                        nb = segs[j] if 0 <= j < len(segs) else None
                        if (not isinstance(nb, dict) or nb.get("type") != "straight"
                                or not isinstance(nb.get("length"), (int, float))
                                or nb["length"] < SHORTCUT_MIN_LEG):
                            errs.append(f"{where}: a shortcut needs a straight of at least "
                                        f"{SHORTCUT_MIN_LEG} directly {rel} the turn")
        elif t == "ramp":
            length = num("length", *L.ramp)
            rise = num("rise", -L.rise, L.rise)
            if length and rise is not None and abs(rise) > slope * length + 1e-6:
                errs.append(f"{where}: rise {rise} over length {length} is steeper than "
                            f"{round(math.degrees(math.atan(slope)))} degrees; "
                            f"|rise| must be <= {int(slope * length)}")
        elif t == "gap":
            drop = num("drop", L.drop_min if L.drop_min is not None
                       else -int(physics.max_rise()), L.drop_max)
            length = num("length", *L.gap)
            if L.physics and drop is not None and length is not None:
                reach = physics.max_gap(drop)
                if length > reach:
                    errs.append(f"{where}: a {length}-unit gap with drop {drop} is not "
                                f"clearable from a 320 ups run-up; max is {int(reach)}")
        elif t == "checkpoint":
            pass
        elif t == "slalom":
            length = num("length", *L.straight)
            count = whole("count", *L.slalom_count)
            needs_width(SLALOM_GATE + SLALOM_FIN_MIN,
                        f"a {SLALOM_GATE}-unit gate beside each fin")
            if length and count and length / (count + 1) < L.slalom_spacing:
                errs.append(f"{where}: {count} fins in {length} units are closer than "
                            f"{L.slalom_spacing}; length must be >= "
                            f"{L.slalom_spacing * (count + 1)}")
        elif t == "beam":
            num("length", *L.beam)
            num("beam_width", BEAM_MIN, max(BEAM_MIN, width - 2 * L.beam_clear))
        elif t == "split":
            side("the side of the fast lane with the holes")
            count = whole("count", *L.split_count)
            length = num("length", *L.straight)
            needs_width(2 * SPLIT_LANE_MIN + SPLIT_MEDIAN,
                        f"two {SPLIT_LANE_MIN}-unit lanes")
            least = split_min_length(count, rules) if count else None
            if length and least and length < least:
                errs.append(f"{where}: {count} hole(s) need length >= {least}")
        elif t == "wallclimb":
            side()
            num("length", L.wallclimb_min, L.straight[1])
            whole("rise", *L.wallclimb_rise)
        elif t == "wallgap":
            side()
            drop = whole("drop", *L.wallgap_drop)
            length = num("length", *L.gap)
            if L.physics and drop is not None and length is not None:
                lo, hi = wallgap_window(drop)
                if not lo <= length <= hi:
                    errs.append(f"{where}: at drop {drop} a wall-kick gap must be {lo}-{hi} "
                                "long; longer cannot be made even with the wall jump")
        elif t == "dash":
            drop = whole("drop", *L.dash_drop)
            length = num("length", *L.gap)
            if L.physics and drop is not None and length is not None:
                lo, hi = dash_window(drop)
                if not lo <= length <= hi:
                    errs.append(f"{where}: at drop {drop} a dash gap must be {lo}-{hi} long: "
                                "shorter can be jumped, longer cannot be dashed")

        # -- shape pieces ---------------------------------------------------
        elif t == "stairs":
            length = num("length", *L.straight)
            count = whole("count", *L.stairs_count)
            rise = num("rise", -min(L.rise, STAIRS_RISE_MAX), min(L.rise, STAIRS_RISE_MAX))
            if length and count and length / count < STAIR_TREAD_MIN:
                errs.append(f"{where}: {count} steps in {length} units leave treads under "
                            f"{STAIR_TREAD_MIN}; length must be >= {STAIR_TREAD_MIN * count}")
            if L.physics and count and rise is not None and abs(rise) / count > physics.STEP_SIZE:
                errs.append(f"{where}: steps of {int(abs(rise) / count)} are taller than the "
                            f"{int(physics.STEP_SIZE)}-unit step the engine walks up; use more "
                            "steps or less rise")
        elif t == "platforms":
            length = num("length", *L.straight)
            count = whole("count", *L.platforms_count)
            drop = num("drop", L.drop_min if L.drop_min is not None
                       else -int(physics.max_rise()), L.drop_max)
            cell = platform_cell()
            if length and count and length / count < cell:
                errs.append(f"{where}: {count} stones need length >= {cell * count} "
                            f"(each is a {PLATFORM_MIN}-unit landing and the hole before it)")
            if L.physics and length and count:
                hole = (length / count) * (1.0 - PLATFORM_FILL)
                reach = physics.max_gap(drop or 0)
                if hole > reach:
                    errs.append(f"{where}: the holes are {int(hole)} units; at drop "
                                f"{int(drop or 0)} a run-speed jump clears {int(reach)}")
        elif t == "pillars":
            length = num("length", *L.straight)
            count = whole("count", *L.pillars_count)
            needs_width(PILLAR_MIN + 2 * PILLAR_CLEAR,
                        f"a {PILLAR_CLEAR}-unit gate either side of each pillar")
            if length and count and length / count < FIN_THICK + PLAYER_WIDTH:
                errs.append(f"{where}: {count} pillars in {length} units would touch; "
                            f"length must be >= {(FIN_THICK + PLAYER_WIDTH) * count}")
        elif t == "tunnel":
            num("length", *L.straight)
            num("height", *L.tunnel_height)
        elif t == "chicane":
            arc("chicane")
        elif t == "bumps":
            length = num("length", *L.straight)
            count = whole("count", *L.bumps_count)
            rise = num("rise", *L.bumps_rise)
            if length and count and length / count < BUMP_MIN:
                errs.append(f"{where}: {count} bumps in {length} units are shorter than "
                            f"{BUMP_MIN}; length must be >= {BUMP_MIN * count}")
            if L.physics and length and count and rise:
                half = length / count / 2.0
                if rise > slope * half + 1e-6:
                    errs.append(f"{where}: bumps {int(rise)} tall over {int(half)}-unit "
                                f"faces are steeper than {round(math.degrees(math.atan(slope)))} "
                                f"degrees; rise must be <= {int(slope * half)}")
        elif t == "pinch":
            num("length", *L.straight)
            needs_width(PINCH_MIN + 2 * PINCH_BITE,
                        f"a {PINCH_MIN}-unit gate with {PINCH_BITE} taken off each side")
            num("gate", PINCH_MIN, max(PINCH_MIN, width - 2 * PINCH_BITE))
        elif t == "ledge":
            side("the wall the walkway runs along")
            num("length", *L.beam)
            num("ledge_width", LEDGE_MIN, max(LEDGE_MIN, width - LEDGE_CLEAR))
        elif t == "strafepads":
            count = whole("count", *L.pads_count)
            spacing = num("spacing", *L.pads_spacing)
            num("curve", -L.pads_curve, L.pads_curve)
            if L.physics and spacing is not None:
                gap = spacing - STRAFE_PAD_LEN
                reach = physics.max_gap(0)
                if gap > reach:
                    errs.append(f"{where}: {int(gap)} units between pads; a run-speed jump "
                                f"clears {int(reach)}")
        elif t == "hazard":
            lo, hi = L.hazard
            if hi is None:
                hi = int(physics.max_gap(0))
            num("length", lo, hi)
        else:
            errs.append(f"{where}: unknown type; must be one of {SEGMENT_TYPES}")
    return errs
