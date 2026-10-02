"""Spec -> geometry: walk the course like a turtle and lay down brushes.

Every piece of the course is a Prism: a convex footprint polygon extruded from
a flat bottom up to a (possibly sloped) top plane. That one shape covers every
floor, wall, ramp, curve wedge, trigger volume and the sky shell, so there is
exactly one brush writer (mapfile.py) and one overlap test.

The walk also enforces the rules that need geometry rather than ranges:

  * a gap needs MIN_RUNUP of flat floor before it (physics.py);
  * a gap must land on floor, not on another gap, a beam or the finish trigger
    (so must a wall-kick gap or a dash);
  * the course must not run through itself. It may pass OVER itself: the test
    is 3-D, and every such crossing is reported in Course.overpasses.

Coordinates are Quake's: Z up, heading 0 = +X, angles counter-clockwise.
"""

import math

import physics
import spec as specmod

FLOOR_THICK = 32
WALL_THICK = 16
WALL_HEIGHT = 256
ROOM_LEN = 384          # start and finish rooms
SPAWN_BACK = 96         # spawn point distance from the start room's back wall
TRIGGER_DEPTH = 32
TRIGGER_HEIGHT = 192
SHELL_MARGIN = 512      # sky shell distance from the course bounds
PIT_DEPTH = 384         # how far below the lowest floor the kill volume sits
WEDGE_DEG = 11.25       # turn tessellation; 8 wedges per 90 degrees

# Unintended cuts: a place a player can leave the route and rejoin it further
# along, skipping part of the course. A DECLARED shortcut (turn.shortcut) is a
# designed one with its own stepping stones; these are the accidents, and they
# are what makes a generated map's records meaningless.
#
# CUT_MIN_SKIP is how much route a cut has to save before it is worth
# rejecting a plan over: below it the "cut" is a corner trimmed at a turn,
# which every race map has and which no record depends on.
CUT_MIN_SKIP = 1024.0
# ...and at least this share of the whole course. An open switchback lets a
# player trim the inside of its corner, which every race map allows and no
# record depends on; those trims measure a few percent, while a fold that
# lands somewhere else entirely measures 15-40%. Without the share, a long
# twisty course reports a dozen corner trims and a short one reports none.
CUT_MIN_FRACTION = 0.10
# A roof slab over a crossed-under piece (see _roof).
ROOF_THICK = 16
# There is deliberately no cap on how many crossings get roofed. A corkscrew
# stacks its coils over each other by design -- the example needs 23 -- and the
# cost of roofing is brushes, which _size_limits already bounds with a message
# that says so. A second, arbitrary limit here only rejected good courses.
# A cut is judged by the SPEED it needs, not by whether some fixed reach
# covers it. physics.py promises only what run speed (320) clears, because
# that is what makes a course raceable by everyone; a cut has to be ruled out
# for a fast player instead.
#
# At or above this speed a cut is left in place. Reaching 1000 ups takes a long
# committed strafe run, and a player who can do that on demand has earned the
# line — every real race map has such routes and they are part of the craft.
# Below it the cut is something anyone stumbles into, which is what makes a
# map's records meaningless. A straight drop needs no speed at all, so it is
# always caught.
CUT_SPEED_OK = 1000.0

# Shortcuts across the inside of a 180-degree turn (spec: turn.shortcut).
# A window is cut in the inner wall of both legs, SHORTCUT_BACK from the turn,
# and a line of PLATFORM-sized stepping stones crosses the drop between them.
# The gaps are made as long as physics allows at run speed (physics.max_gap,
# already carrying its 0.8 margin), times SHORTCUT_GAP_FILL, so the route is
# precise rather than impossible: 64-unit stones leave 32 units of footing
# for a 32-unit player, and ground acceleration (pm_accelerate 12,
# gs_pmove.c:98) reaches 320 ups in ~13 units, so every stone can be taken
# off from at full run speed without a run-up.
SHORTCUT_BACK = 192
SHORTCUT_WINDOW = 96
SHORTCUT_PLATFORM = 64
SHORTCUT_GAP_FILL = 0.92
SHORTCUT_MIN_LEG = SHORTCUT_BACK + SHORTCUT_WINDOW // 2 + 80

# Checkpoints the generator adds itself (plan_checkpoints). One every
# CP_EVERY of route (8 s of par at 320 ups), never closer than CP_MIN to
# another checkpoint, none within CP_END_MIN of the start or finish line, and
# each on a straight at least CP_EDGE from its ends, so the trigger and its
# painted line sit on plain, level floor.
CP_EVERY = 2560
CP_MIN = 1024
CP_END_MIN = 768
CP_EDGE = 64

# Size ceilings on the laid-out course (spec.ROUTE_MAX bounds its length):
# how far it may spread and how many brushes it may take, so no plan builds a
# map that is slow to compile, heavy to download or heavy for every server to
# load. The examples reach about 11,400 across and 420 brushes.
# The strict tier's own numbers, and the only place they are written down is
# spec.STRICT — these are aliases so that reading them here still works.
EXTENT_MAX_XY = specmod.STRICT.extent_xy
EXTENT_MAX_Z = specmod.STRICT.extent_z
BRUSH_MAX = specmod.STRICT.brushes

FIN_THICK = 32          # slalom and split fins, along the course
SPLIT_GATE = 96         # gates in a split's safe lane: 3 player widths
VOID_DEPTH = 160        # side walls reach this far below a floorless piece
EDGE_BAND = 16          # painted edge along an open floor, flush with it
WALLCLIMB_ARC = 96      # how far before a wall climb's ledge the centre line rises
HAZARD_DEPTH = 64       # how far a hazard's lethal floor sits below the corridor
HAZARD_LIP = 8          # ...and how far its kill volume stops short of the top
JOINT_DEPTH = 64        # how far a nudge's bridging plate reaches into each piece

TEX = {
    "floor": "mapgen_v1/floor",
    "ice": "mapgen_v1/ice",
    "wall": "mapgen_v1/wall",
    "start": "mapgen_v1/start",
    "finish": "mapgen_v1/finish",
    "checkpoint": "mapgen_v1/checkpoint",
    "edge": "mapgen_v1/edge",
    "trim": "mapgen_v1/trim",
    "platform": "mapgen_v1/edge",
    "beam": "mapgen_v1/edge",
    "pylon": "mapgen_v1/pylon",
    "hazard": "mapgen_v1/hazard",
    "kick": "mapgen_v1/kick",
    "sky": "mapgen_v1/sky",
    "trigger": "mapgen_v1/trigger",
    "origin": "mapgen_v1/origin",
}


class LayoutError(Exception):
    def __init__(self, problems):
        super().__init__("; ".join(problems))
        self.problems = problems


class Prism:
    """Convex CCW footprint `poly` [(x, y)], bottom at `zmin`, top plane
    z = top0 + gx * x + gy * y. `heading` (degrees) turns the top face's
    texture so its "up" points down the course: chevrons and lettering on
    the floor read the way the player runs."""

    def __init__(self, poly, zmin, top0, gx=0.0, gy=0.0, tex="floor", heading=None):
        self.poly = [(float(x), float(y)) for x, y in poly]
        self.zmin = float(zmin)
        self.top0, self.gx, self.gy = float(top0), float(gx), float(gy)
        self.tex = tex
        self.heading = heading

    def top_at(self, x, y):
        return self.top0 + self.gx * x + self.gy * y

    def zmax(self):
        return max(self.top_at(x, y) for x, y in self.poly)

    @classmethod
    def flat(cls, poly, zmin, zmax, tex, heading=None):
        return cls(poly, zmin, zmax, 0.0, 0.0, tex, heading)


class Hull:
    """A piece's footprint and vertical extent, for the self-intersection test."""

    def __init__(self, poly, zlo, zhi, seg):
        self.poly, self.zlo, self.zhi, self.seg = poly, zlo, zhi, seg


class Course:
    def __init__(self, spec):
        self.spec = spec
        self.world = []       # Prisms in worldspawn
        self.entities = []    # (keys dict, [Prism]) — brush list empty for point ents
        self.hulls = []
        self.floor_polys = [] # (poly, tex) for the preview
        self.route = []       # centre-line points (x, y, z) for the preview + future bot
        self.landmarks = []   # (kind, (x, y, z), heading): start, gap, checkpoint, shortcut, finish
        self.shortcuts = []   # one dict per turn.shortcut: platforms, gap, distance saved
        self.features = []    # one dict per slalom / beam / split
        self.overpasses = []  # (lower seg, upper seg, clearance): where the course crosses itself
        self.seg_dist = []    # route distance at the START of each segment, for cut sizes
        self.open_segs = set()  # segments built without side walls (spec: open)
        self.falloff_segs = set()  # segments a player can leave downwards from
        self.worldspawn = {}  # extra worldspawn keys for the compiler (tiles.py)
        self.cuts = []        # unintended shortcuts found by _cuts(), reported with the map
        self.notes = []       # open tier: the pieces-fit-together problems, kept as notes
        self.auto_checkpoints = []  # (segment, distance into it) of each checkpoint the generator added
        self.length = 0.0     # centre-line length, start trigger -> finish trigger


def _rect(o, f, l, back, fwd, right, left):
    """Footprint rectangle in a heading frame: origin o, forward f, left l.
    Spans [back, fwd] along f and [-right, left] along l. Returned CCW."""
    def p(a, b):
        return (o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b)
    return [p(back, -right), p(fwd, -right), p(fwd, left), p(back, left)]


def _area(poly):
    """Twice the signed area of a footprint; sign gives the winding."""
    return abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1]
                   - poly[(i + 1) % len(poly)][0] * poly[i][1]
                   for i in range(len(poly)))) / 2.0


def _hull(points):
    """Convex hull, counter-clockwise (monotone chain). Every brush footprint
    has to be convex, and the hull is how a nudge's seam stays one."""
    pts = sorted(set((round(x, 4), round(y, 4)) for x, y in points))
    if len(pts) < 3:
        return pts

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2:
                (ax, ay), (bx, by) = out[-2], out[-1]
                if (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) > 0:
                    break
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return lower[:-1] + upper[:-1]


def _band(o, f, l, back, fwd, lo, hi):
    """Footprint spanning [back, fwd] along f and [lo, hi] across it (left +)."""
    return _rect(o, f, l, back, fwd, -lo, hi)


def _seg_length(seg):
    return specmod.route_length(seg)


def plan_checkpoints(spec):
    """Where the generator adds checkpoints: a sorted list of
    (segment index, distance into that straight).

    Like the start and finish, checkpoints are the generator's job, so no
    course ships without splits however the plan was written. Checkpoints the
    plan already has are kept and counted. The rest are added greedily: at
    the first allowed spot once CP_EVERY of route has gone by without one.

    Allowed spots are on straights, CP_EDGE clear of the straight's ends,
    outside the stretch a shortcut skips (a player who takes the stones must
    still cross every checkpoint), CP_MIN from any other checkpoint and
    CP_END_MIN from the start and finish lines. A course with no checkpoint
    after that, but room for one, gets one at the allowed spot nearest its
    middle.
    """
    segs = spec["segments"]
    at = [0.0]
    for seg in segs:
        at.append(at[-1] + _seg_length(seg))
    total = at[-1]
    planned = [at[i] for i, seg in enumerate(segs) if seg["type"] == "checkpoint"]

    # Allowed intervals of route distance, each tagged with its straight.
    allowed = [(at[i] + CP_EDGE, at[i + 1] - CP_EDGE, i) for i, seg in enumerate(segs)
               if seg["type"] == "straight" and seg["length"] > 2 * CP_EDGE]
    blocked = [(0.0, CP_END_MIN), (total - CP_END_MIN, total)]
    reach = SHORTCUT_BACK + SHORTCUT_WINDOW / 2 + CP_EDGE
    for i, seg in enumerate(segs):
        if seg["type"] == "turn" and seg.get("shortcut"):
            blocked.append((at[i] - reach, at[i + 1] + reach))

    def carve(spans, cut):
        out = []
        for a, b, i in spans:
            for c, d in cut:
                if d <= a or c >= b:
                    continue
                if c > a:
                    out.append((a, c, i))
                a = max(a, d)
                if a >= b:
                    break
            else:
                out.append((a, b, i))
                continue
            if a < b:
                out.append((a, b, i))
        return [(a, b, i) for a, b, i in out if b >= a]

    for cut in blocked:
        allowed = carve(allowed, [cut])
    allowed = carve(allowed, [(c - CP_MIN, c + CP_MIN) for c in planned])
    allowed.sort()

    def first_from(target):
        for a, b, i in allowed:
            if b >= target:
                return max(a, target), i
        return None

    added = []
    last = 0.0
    while True:
        spot = first_from(last + CP_EVERY)
        if spot is None:
            break
        d, i = spot
        passed = [c for c in planned if last < c <= d]
        if passed:
            last = max(passed)
            continue
        added.append((d, i))
        last = d
        allowed = carve(allowed, [(d - CP_MIN, d + CP_MIN)])
    if not planned and not added and allowed:
        a, b, i = min(allowed, key=lambda s: min(abs(s[0] - total / 2), abs(s[1] - total / 2)))
        added.append((min(max(total / 2, a), b), i))
    return [(i, round(d - at[i], 1)) for d, i in sorted(added)]


def _sat_overlap(a, b, eps=1.0):
    """Separating-axis test for two convex polygons; touching is not overlap."""
    for poly in (a, b):
        n = len(poly)
        for i in range(n):
            x1, y1 = poly[i]
            x2, y2 = poly[(i + 1) % n]
            ax, ay = y2 - y1, x1 - x2
            L = math.hypot(ax, ay) or 1.0
            ax, ay = ax / L, ay / L
            pa = [x * ax + y * ay for x, y in a]
            pb = [x * ax + y * ay for x, y in b]
            if max(pa) <= min(pb) + eps or max(pb) <= min(pa) + eps:
                return False
    return True


def _seg_gap(p1, p2, q1, q2):
    """Shortest distance between two line segments in 2-D."""
    def point_seg(px, py, ax, ay, bx, by):
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0.0:
            return math.dist((px, py), (ax, ay))
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.dist((px, py), (ax + t * dx, ay + t * dy))
    # Segments that cross are zero apart; otherwise the minimum is reached at
    # one of the four endpoints against the other segment.
    d1x, d1y = p2[0] - p1[0], p2[1] - p1[1]
    d2x, d2y = q2[0] - q1[0], q2[1] - q1[1]
    den = d1x * d2y - d1y * d2x
    if den != 0.0:
        t = ((q1[0] - p1[0]) * d2y - (q1[1] - p1[1]) * d2x) / den
        u = ((q1[0] - p1[0]) * d1y - (q1[1] - p1[1]) * d1x) / den
        if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
            return 0.0
    return min(point_seg(*p1, *q1, *q2), point_seg(*p2, *q1, *q2),
               point_seg(*q1, *p1, *p2), point_seg(*q2, *p1, *p2))


def _poly_gap(a, b):
    """Shortest distance between the edges of two convex polygons; 0 if they
    overlap. Used to ask how far a player would have to jump to get from one
    piece to another."""
    if _sat_overlap(a, b):
        return 0.0
    best = float("inf")
    for i in range(len(a)):
        p1, p2 = a[i], a[(i + 1) % len(a)]
        for j in range(len(b)):
            q1, q2 = b[j], b[(j + 1) % len(b)]
            best = min(best, _seg_gap(p1, p2, q1, q2))
    return best


class _Walker:
    def __init__(self, spec, camera_pads=(), rules="strict"):
        self.camera_pads = camera_pads
        self.rules = rules
        self.L = specmod.tier(rules)
        self.c = Course(spec)
        self.w = spec["width"]
        self.x = self.y = 0.0
        self.z = 0.0
        self.heading = 0.0
        self.runup = 0.0
        self.problems = []
        self._roofed = set()   # hull indices already capped by _roof()
        self.seg = -1          # index of the segment being laid (-1 = start room)
        self.tn = 0
        self.walls = {}        # seg -> the frame and world indexes of a straight's walls
        self.pending = None    # a shortcut turn waiting for the straight after it

    # -- frame helpers ------------------------------------------------------
    def frame(self):
        h = math.radians(self.heading)
        return (self.x, self.y), (math.cos(h), math.sin(h)), (-math.sin(h), math.cos(h))

    def advance(self, dist, dz=0.0):
        _, f, _ = self.frame()
        self.x += f[0] * dist
        self.y += f[1] * dist
        self.z += dz
        self.c.length += dist
        self.c.route.append((self.x, self.y, self.z))

    def targetname(self, kind):
        self.tn += 1
        return f"mg_{kind}{self.tn}"

    def hull(self, poly, zlo, zhi):
        self.c.hulls.append(Hull(poly, zlo, zhi, self.seg))

    def _note(self, msg):
        """A problem with how the pieces fit TOGETHER — a missing run-up, a
        landing on nothing, the course crossing itself, a cut round the side.

        In the strict tier these are refusals: a described map or a random_map
        tile has to be raceable by construction, because nothing looks at it
        before it is in the pool. In the open tier the person in the editor can
        see the course and an admin signs it off, so the same finding is worth
        saying and not worth refusing — it lands on the report instead."""
        if self.L.combine:
            self.problems.append(msg)
        else:
            self.c.notes.append(msg)

    # -- pieces -------------------------------------------------------------
    def box_run(self, length, rise=0.0, tex="floor", floor=True, wall_floor=None, walls=(1, -1)):
        """A straight run: floor slab (optionally sloped) + the side walls in
        `walls` (+1 left, -1 right). A side without a wall is open: its floor
        edge is painted instead."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z0 = self.z
        # Top plane z = z0 + rise * along/length, written in world coords.
        slope = rise / length if length else 0.0
        gx, gy = f[0] * slope, f[1] * slope
        top0 = z0 - (gx * o[0] + gy * o[1])
        lo = min(z0, z0 + rise)
        base = lo - FLOOR_THICK if wall_floor is None else wall_floor
        if floor:
            poly = _rect(o, f, l, 0, length, half, half)
            self.c.world.append(Prism(poly, lo - FLOOR_THICK, top0, gx, gy, tex, self.heading))
            self.c.floor_polys.append((poly, tex))
        idx = {}
        for side in (+1, -1):
            if side in walls:
                idx[side] = len(self.c.world)
                self.c.world.append(Prism(self._wall_poly(o, f, l, side, 0, length),
                                          base, top0 + WALL_HEIGHT, gx, gy, "wall"))
            elif floor:
                band = (_band(o, f, l, 0, length, half - EDGE_BAND, half) if side > 0
                        else _band(o, f, l, 0, length, -half, -half + EDGE_BAND))
                self.c.world.append(Prism(band, lo - 4, top0 + 1, gx, gy, "edge"))
        if rise == 0:
            self.walls[self.seg] = {"o": o, "f": f, "l": l, "length": length, "idx": idx,
                                    "base": base, "top": z0 + WALL_HEIGHT}
        self.hull(_rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
                  base, max(z0, z0 + rise) + WALL_HEIGHT)
        self.advance(length, rise)

    def _wall_poly(self, o, f, l, side, a, b):
        """Side wall footprint from a to b along a straight: +1 left, -1 right."""
        half = self.w / 2.0
        if side > 0:
            return _rect(o, f, l, a, b, -half, half + WALL_THICK)
        return _rect(o, f, l, a, b, half + WALL_THICK, -half)

    def cut_window(self, seg, side, a, b):
        """Replace a straight's side wall with two pieces, leaving [a, b] open."""
        w = self.walls.get(seg)
        if w is None or side not in w["idx"]:
            return          # an open side: nothing to cut
        o, f, l, n = w["o"], w["f"], w["l"], w["length"]
        k = w["idx"][side]
        self.c.world[k] = Prism.flat(self._wall_poly(o, f, l, side, 0, a), w["base"], w["top"], "wall")
        self.c.world.append(Prism.flat(self._wall_poly(o, f, l, side, b, n), w["base"], w["top"], "wall"))

    def _shortcut(self, leg_b):
        """Stepping stones across the inside of the U-turn just laid.

        Both legs are straight (spec.validate insists), parallel, and 2r apart
        centre to centre. The inside of the U is the drop between their inner
        floor edges: span = 2r - width. The windows face each other across it.
        """
        p = self.pending
        self.pending = None
        sign, r = p["sign"], p["radius"]
        (ax, ay), f, l = p["origin"], p["f"], p["l"]
        half = self.w / 2.0
        leg_a = p["turn"] - 1
        back = SHORTCUT_BACK
        # Leg A runs toward the turn: its window is `back` before the leg's end.
        la = self.walls[leg_a]["length"]
        self.cut_window(leg_a, sign, la - back - SHORTCUT_WINDOW / 2, la - back + SHORTCUT_WINDOW / 2)
        # Leg B runs away from it: its window is `back` after the leg's start.
        # The inside of the U is on the same side (left for a left turn) of
        # both legs, because leg B runs the opposite way.
        self.cut_window(leg_b, sign, back - SHORTCUT_WINDOW / 2, back + SHORTCUT_WINDOW / 2)

        u = (l[0] * sign, l[1] * sign)                   # across the U, A to B
        v = (-u[1], u[0])
        edge = (ax - f[0] * back + u[0] * half, ay - f[1] * back + u[1] * half)
        span = 2 * r - self.w
        gmax = physics.max_gap(0) * SHORTCUT_GAP_FILL
        P = SHORTCUT_PLATFORM
        n = 0 if span <= gmax else math.ceil((span - gmax) / (P + gmax))
        gap = (span - n * P) / (n + 1)
        heading = math.degrees(math.atan2(u[1], u[0])) % 360.0
        z = p["z"]
        for i in range(n):
            d = gap * (i + 1) + P * i + P / 2
            c = (edge[0] + u[0] * d, edge[1] + u[1] * d)
            poly = _rect(c, u, v, -P / 2, P / 2, P / 2, P / 2)
            self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, "platform", heading))
            self.c.floor_polys.append((poly, "platform"))
        # Centre line A -> B along the main route: back + half the circle + back.
        # Straight across: 2r. Both measured between the two window centres.
        saves = 2 * back + math.pi * r - 2 * r
        self.c.shortcuts.append({"turn": p["turn"], "platforms": n, "gap": round(gap),
                                 "span": round(span), "saves": round(saves)})
        self.c.landmarks.append(("shortcut", (edge[0], edge[1], z), heading))

    def end_wall(self, behind):
        """Wall across the corridor, just behind the cursor or just ahead."""
        o, f, l = self.frame()
        half = self.w / 2.0 + WALL_THICK
        a, b = (-WALL_THICK, 0) if behind else (0, WALL_THICK)
        self.c.world.append(Prism.flat(_rect(o, f, l, a, b, half, half),
                                       self.z - FLOOR_THICK, self.z + WALL_HEIGHT, "wall"))

    def stripe(self, tex, back, fwd):
        """A painted strip across the floor: a 5-unit slab standing 1 unit
        proud of it (well under STEP_SIZE, so it never trips a player, and
        never coplanar, so it never z-fights)."""
        o, f, l = self.frame()
        poly = _rect(o, f, l, back, fwd, self.w / 2.0, self.w / 2.0)
        self.c.world.append(Prism.flat(poly, self.z - 4, self.z + 1, tex, self.heading))

    def trigger(self, classname_target, target_keys, stripe=None):
        """Full-width trigger slab straddling the cursor + its target entity,
        with the line painted on the floor under it."""
        o, f, l = self.frame()
        half = self.w / 2.0
        if stripe:
            self.stripe(stripe, -TRIGGER_DEPTH, TRIGGER_DEPTH)
        kind = target_keys["classname"].replace("target_", "").replace("timer", "")
        self.c.landmarks.append((kind, (self.x, self.y, self.z), self.heading))
        name = self.targetname(target_keys["classname"].split("_")[-1])
        poly = _rect(o, f, l, -TRIGGER_DEPTH / 2, TRIGGER_DEPTH / 2, half, half)
        brush = Prism.flat(poly, self.z, self.z + TRIGGER_HEIGHT, "trigger")
        self.c.entities.append(({"classname": classname_target, "target": name}, [brush]))
        ent = dict(target_keys)
        ent["targetname"] = name
        ent["origin"] = (self.x, self.y, self.z + 32)
        self.c.entities.append((ent, []))

    def checkpoint(self):
        self.trigger("trigger_multiple", {"classname": "target_checkpoint"}, stripe="checkpoint")

    def checkpoint_at(self, o, f, a):
        """A checkpoint `a` units into the straight that starts at o along f
        and has just been laid (straights are level, so the cursor's z holds)."""
        here = (self.x, self.y)
        self.x, self.y = o[0] + f[0] * a, o[1] + f[1] * a
        self.checkpoint()
        self.x, self.y = here

    def turn(self, direction, angle, radius, walls=True, floor_tex="floor"):
        sign = 1.0 if direction == "left" else -1.0
        o, f, l = self.frame()
        cx, cy = o[0] + l[0] * radius * sign, o[1] + l[1] * radius * sign
        half = self.w / 2.0
        r_in, r_out = radius - half, radius + half
        # Angle of the cursor as seen from the centre.
        a0 = math.atan2(o[1] - cy, o[0] - cx)
        n = max(1, int(round(angle / WEDGE_DEG)))
        step = math.radians(angle) / n * sign

        def pt(r, a):
            return (cx + r * math.cos(a), cy + r * math.sin(a))

        for i in range(n):
            a, b = a0 + step * i, a0 + step * (i + 1)
            rings = [(r_in, r_out, floor_tex, self.z - FLOOR_THICK, self.z)]
            if walls:
                rings.append((r_out, r_out + WALL_THICK, "wall", self.z - FLOOR_THICK,
                              self.z + WALL_HEIGHT))
                if r_in - WALL_THICK > 1:
                    rings.append((r_in - WALL_THICK, r_in, "wall",
                                  self.z - FLOOR_THICK, self.z + WALL_HEIGHT))
            else:   # open: paint both floor edges
                rings += [(r_out - EDGE_BAND, r_out, "edge", self.z - 4, self.z + 1),
                          (r_in, r_in + EDGE_BAND, "edge", self.z - 4, self.z + 1)]
            mid_heading = self.heading + sign * angle * (i + 0.5) / n
            for ri, ro, tex, zlo, zhi in rings:
                poly = [pt(ri, a), pt(ro, a), pt(ro, b), pt(ri, b)]
                if sign < 0:
                    poly.reverse()
                self.c.world.append(Prism.flat(poly, zlo, zhi, tex, mid_heading))
                if tex in ("floor", "ice"):
                    self.c.floor_polys.append((poly, tex))
            ri = max(r_in - WALL_THICK, 0.0)
            hp = [pt(ri, a), pt(r_out + WALL_THICK, a), pt(r_out + WALL_THICK, b), pt(ri, b)]
            if sign < 0:
                hp.reverse()
            self.hull(hp, self.z - FLOOR_THICK, self.z + WALL_HEIGHT)
            mid = pt(radius, b)
            self.c.route.append((mid[0], mid[1], self.z))
        self.x, self.y = pt(radius, a0 + step * n)
        self.heading = (self.heading + sign * angle) % 360.0
        self.c.length += math.radians(angle) * radius

    def _fins(self, o, f, l, spots, lanes, tex="pylon"):
        """Full-height fins across a lane. spots: distances along the piece;
        lanes: for each spot, the [lo, hi] lateral band the fin fills."""
        for a, (lo, hi) in zip(spots, lanes):
            poly = _band(o, f, l, a - FIN_THICK / 2, a + FIN_THICK / 2, lo, hi)
            self.c.world.append(Prism.flat(poly, self.z - FLOOR_THICK, self.z + WALL_HEIGHT, tex))

    def _reroute(self, o, f, l, points):
        """Replace the straight centre line of the piece just laid with one
        through `points` [(along, across)], keeping the length honest."""
        end = self.c.route.pop()
        prev = self.c.route[-1]
        self.c.length -= math.dist(prev[:2], end[:2])
        z = self.z
        for a, b in points:
            p = (o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b, z)
            self.c.length += math.dist(prev[:2], p[:2])
            self.c.route.append(p)
            prev = p
        self.c.length += math.dist(prev[:2], end[:2])
        self.c.route.append(end)

    def slalom(self, length, count, tex="floor"):
        """Fins off alternate walls, first from the left, each leaving a
        SLALOM_GATE gate beside it: the line through the gates is a weave."""
        o, f, l = self.frame()
        half = self.w / 2.0
        gate = specmod.SLALOM_GATE
        self.c.landmarks.append(("slalom", (self.x, self.y, self.z), self.heading))
        self.box_run(length, tex=tex)
        spacing = length / (count + 1)
        spots = [spacing * (i + 1) for i in range(count)]
        # Even fins hang off the left wall, so their gate is on the right.
        lanes = [(-half + gate, half) if i % 2 == 0 else (-half, half - gate) for i in range(count)]
        self._fins(o, f, l, spots, lanes)
        mid = half - gate / 2
        self._reroute(o, f, l, [(a, -mid if i % 2 == 0 else mid) for i, a in enumerate(spots)])
        self.c.features.append({"type": "slalom", "segment": self.seg, "fins": count,
                                "gate": gate, "spacing": round(spacing)})
        return spacing   # clear floor after the last fin: the run-up it leaves

    def beam(self, length, width):
        """No floor but a beam down the middle; the walls reach down past it
        so the only way out of a fall is the kill volume in the pit."""
        o, f, l = self.frame()
        z = self.z
        self.stripe("edge", -32, 0)
        self.c.landmarks.append(("beam", (self.x, self.y, z), self.heading))
        self.box_run(length, floor=False, wall_floor=z - FLOOR_THICK - VOID_DEPTH)
        poly = _rect(o, f, l, 0, length, width / 2.0, width / 2.0)
        self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, "beam", self.heading))
        self.c.floor_polys.append((poly, "beam"))
        self.c.features.append({"type": "beam", "segment": self.seg, "width": width,
                                "length": length})

    def split(self, length, direction, count):
        """Two lanes either side of a median wall. The fast lane (`direction`)
        runs straight over `count` holes, each SPLIT_HOLE_FILL of a run-speed
        jump and each after a full run-up; a fall is death. The safe lane is
        solid floor through a tight weave of fins. SPLIT_MOUTH of open floor at
        each end lets the player see both lanes and choose."""
        o, f, l = self.frame()
        z = self.z
        half = self.w / 2.0
        m = specmod.SPLIT_MEDIAN / 2.0
        mouth = specmod.SPLIT_MOUTH
        fast = 1 if direction == "left" else -1
        lane_w = half - m
        self.c.landmarks.append(("split", (self.x, self.y, z), self.heading))
        self.box_run(length, floor=False, wall_floor=z - FLOOR_THICK - VOID_DEPTH)

        def lane(side):
            return (m, half) if side > 0 else (-half, -m)

        def floor(a, b, lo, hi, tex="floor"):
            poly = _band(o, f, l, a, b, lo, hi)
            self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, tex, self.heading))
            self.c.floor_polys.append((poly, tex))

        floor(0, mouth, -half, half)
        floor(length - mouth, length, -half, half)
        self.c.world.append(Prism.flat(_band(o, f, l, mouth, length - mouth, -m, m),
                                       z - FLOOR_THICK - VOID_DEPTH, z + WALL_HEIGHT, "wall"))
        # Fast lane: runway, hole, runway, hole, ..., landing. Spare length is
        # shared out between the runways.
        hole = specmod.split_hole()
        inner = length - 2 * mouth
        runway = specmod.SPLIT_RUNWAY + (inner - specmod.SPLIT_LANDING
                                         - count * (specmod.SPLIT_RUNWAY + hole)) / count
        lo, hi = lane(fast)
        a = mouth
        for _ in range(count):
            floor(a, a + runway, lo, hi)
            a += runway
            lip = _band(o, f, l, a - 32, a, lo, hi)
            self.c.world.append(Prism.flat(lip, z - 4, z + 1, "edge", self.heading))
            a += hole
        floor(a, length - mouth, lo, hi)
        # Safe lane: solid, with count + 1 fins alternating between its two
        # sides (outer wall and median), each leaving a SPLIT_GATE gate.
        slo, shi = lane(-fast)
        floor(mouth, length - mouth, slo, shi)
        n = count + 1
        spacing = inner / (n + 1)
        spots = [mouth + spacing * (i + 1) for i in range(n)]
        bands = [(slo, shi - SPLIT_GATE), (slo + SPLIT_GATE, shi)]
        self._fins(o, f, l, spots, [bands[i % 2] for i in range(n)])
        # The centre line takes the fast lane (par assumes the brave route).
        c = fast * (m + lane_w / 2)
        self._reroute(o, f, l, [(mouth, c), (length - mouth, c)])
        self.c.features.append({"type": "split", "segment": self.seg, "fast_lane": direction,
                                "holes": count, "hole": hole, "safe_fins": n,
                                "gate": SPLIT_GATE})

    # -- the walk -----------------------------------------------------------
    # -- shape pieces -------------------------------------------------------
    # None of these ask the player for a move physics.py has to model: they
    # are corridor, laid differently, and that is why the editor can hand them
    # out freely. Each one is built from the same box_run / _band / Prism
    # vocabulary as the rest, so there is still one brush writer.

    def stairs(self, length, rise, count, tex="floor", walls=(1, -1)):
        """A staircase: `count` level treads climbing or dropping `rise` in
        total. Each tread is its own slab reaching down to the run's base, so
        no step floats, and the side walls span the whole run."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z0 = self.z
        tread, step = length / count, rise / count
        lo, hi = z0 + min(0.0, rise), z0 + max(0.0, rise)
        base = lo - FLOOR_THICK
        for n in range(count):
            poly = _rect(o, f, l, n * tread, (n + 1) * tread, half, half)
            self.c.world.append(Prism.flat(poly, base, z0 + step * (n + 1), tex, self.heading))
            self.c.floor_polys.append((poly, tex))
        for side in (+1, -1):
            if side in walls:
                self.c.world.append(Prism.flat(self._wall_poly(o, f, l, side, 0, length),
                                               base, hi + WALL_HEIGHT, "wall"))
            else:
                band = (_band(o, f, l, 0, length, half - EDGE_BAND, half) if side > 0
                        else _band(o, f, l, 0, length, -half, -half + EDGE_BAND))
                self.c.world.append(Prism.flat(band, base, hi + 1, "edge"))
        self.hull(_rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
                  base, hi + WALL_HEIGHT)
        self.c.features.append({"type": "stairs", "segment": self.seg, "steps": count,
                                "step": round(abs(step), 1)})
        self.advance(length, rise)

    def platforms(self, length, count, drop, tex="platform", walls=(1, -1)):
        """Stepping stones over a pit: `count` cells, each a hole and then the
        stone that ends it, stepping `drop` over the piece. The first hole is
        at the lip, so the piece is entered by jumping, and the last stone ends
        flush with the piece so the next one connects."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z0 = self.z
        cell = length / count
        stone = cell * specmod.PLATFORM_FILL
        lo, hi = z0 + min(0.0, drop), z0 + max(0.0, drop)
        base = lo - FLOOR_THICK - VOID_DEPTH
        for side in (+1, -1):
            if side in walls:
                self.c.world.append(Prism.flat(self._wall_poly(o, f, l, side, 0, length),
                                               base, hi + WALL_HEIGHT, "wall"))
        for n in range(count):
            a = (n + 1) * cell - stone
            z = z0 + drop * (n + 1) / count
            poly = _rect(o, f, l, a, a + stone, half, half)
            self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, tex, self.heading))
            self.c.floor_polys.append((poly, tex))
        self.hull(_rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
                  base, hi + WALL_HEIGHT)
        self.c.features.append({"type": "platforms", "segment": self.seg, "stones": count,
                                "hole": round(cell - stone)})
        self.advance(length, drop)

    def pillars(self, length, count, tex="floor", walls=(1, -1)):
        """Free-standing columns down the middle: pass either side of each.
        Unlike a slalom (fins off the walls) the line through them is a choice,
        so the centre line is drawn weaving alternate sides."""
        o, f, l = self.frame()
        half = self.w / 2.0
        pw = specmod.PILLAR_MIN
        self.box_run(length, tex=tex, walls=walls)
        cell = length / count
        spots = [cell * (n + 0.5) for n in range(count)]
        for a in spots:
            poly = _band(o, f, l, a - pw / 2.0, a + pw / 2.0, -pw / 2.0, pw / 2.0)
            self.c.world.append(Prism.flat(poly, self.z - FLOOR_THICK,
                                           self.z + WALL_HEIGHT, "pylon"))
        lane = (half - pw / 2.0) / 2.0
        self._reroute(o, f, l, [(a, lane if n % 2 else -lane) for n, a in enumerate(spots)])
        self.c.features.append({"type": "pillars", "segment": self.seg, "pillars": count,
                                "gate": round(half - pw / 2.0)})

    def tunnel(self, length, height, tex="floor"):
        """A roofed straight. Always walled — a tunnel with open sides is just
        a straight with a canopy — and the roof is a full-width slab."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z0 = self.z
        self.box_run(length, tex=tex)
        poly = _rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK)
        self.c.world.append(Prism.flat(poly, z0 + height, z0 + height + ROOF_THICK, "wall"))
        self.hull(poly, z0 - FLOOR_THICK, z0 + height + ROOF_THICK)
        self.c.features.append({"type": "tunnel", "segment": self.seg, "height": height})

    def chicane(self, direction, angle, radius, walls=True, floor_tex="floor"):
        """A turn each way: the course leaves pointing the way it came in,
        offset sideways by 2r(1 - cos angle). Two turn() calls and no geometry
        of its own, so it curves and tessellates exactly like a turn does."""
        other = "right" if direction == "left" else "left"
        self.turn(direction, angle, radius, walls=walls, floor_tex=floor_tex)
        self.turn(other, angle, radius, walls=walls, floor_tex=floor_tex)
        self.c.features.append({"type": "chicane", "segment": self.seg, "angle": angle,
                                "offset": round(2 * radius * (1 - math.cos(math.radians(angle))))})

    def bumps(self, length, count, rise, tex="floor", walls=(1, -1)):
        """A rolling floor: `count` humps, each a rise and an equal fall, so
        the piece ends at the height it started. Two box_runs per hump, which
        is what gives each face its sloped top plane."""
        cell = length / count
        for _ in range(count):
            self.box_run(cell / 2.0, rise, tex=tex, walls=walls)
            self.box_run(cell / 2.0, -rise, tex=tex, walls=walls)
        self.c.features.append({"type": "bumps", "segment": self.seg, "bumps": count,
                                "rise": rise})

    def pinch(self, length, gate, tex="floor", walls=(1, -1)):
        """The corridor narrows to `gate` for the length of the piece: full
        floor, with a block against each wall taking the rest of the width."""
        o, f, l = self.frame()
        half = self.w / 2.0
        self.box_run(length, tex=tex, walls=walls)
        for side in (+1, -1):
            lo, hi = ((gate / 2.0, half) if side > 0 else (-half, -gate / 2.0))
            self.c.world.append(Prism.flat(_band(o, f, l, 0, length, lo, hi),
                                           self.z - FLOOR_THICK, self.z + WALL_HEIGHT, "pylon"))
        self.c.features.append({"type": "pinch", "segment": self.seg, "gate": gate})

    def ledge(self, length, direction, width, tex="floor"):
        """A walkway along one wall, the rest of the corridor void. A beam
        pushed against a side: the walls reach down past it, so the only way
        out of a fall is the kill volume in the pit."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z = self.z
        sign = 1.0 if direction == "left" else -1.0
        self.stripe("edge", -32, 0)
        self.box_run(length, floor=False, wall_floor=z - FLOOR_THICK - VOID_DEPTH)
        lo, hi = ((half - width, half) if sign > 0 else (-half, -half + width))
        poly = _band(o, f, l, 0, length, lo, hi)
        self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, tex, self.heading))
        self.c.floor_polys.append((poly, tex))
        self._reroute(o, f, l, [(length / 2.0, sign * (half - width / 2.0))])
        self.c.features.append({"type": "ledge", "segment": self.seg, "width": width,
                                "side": direction})

    def hazard(self, length, walls=(1, -1)):
        """A recessed strip of lethal floor: jumped like a gap, but with
        ground to land short on and ground to see it from.

        The kill volume stops HAZARD_LIP below the corridor so that running
        across the top never touches it — a jump apex is only about 46 units,
        so a trigger standing proud of the floor would kill the player who
        cleared it. Falling in touches it."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z = self.z
        self.box_run(length, floor=False, wall_floor=z - HAZARD_DEPTH - FLOOR_THICK, walls=walls)
        poly = _rect(o, f, l, 0, length, half, half)
        self.c.world.append(Prism.flat(poly, z - HAZARD_DEPTH - FLOOR_THICK, z - HAZARD_DEPTH,
                                       "hazard", self.heading))
        self.c.floor_polys.append((poly, "hazard"))
        self.c.landmarks.append(("hazard", (self.x, self.y, z), self.heading))
        self.c.entities.append(({"classname": "trigger_hurt", "dmg": 9999},
                                [Prism.flat(poly, z - HAZARD_DEPTH, z - HAZARD_LIP, "trigger")]))
        self.c.features.append({"type": "hazard", "segment": self.seg, "length": length})

    def strafepads(self, count, spacing, curve, tex="platform"):
        """A line of pads over the void, `spacing` apart centre to centre,
        bending `curve` degrees across the whole run — signed, so one control
        runs from a left arc through dead straight to a right arc.

        There is nothing between the pads: the run is taken by strafe-jumping
        from each to the next, and missing one is a fall into the pit. The
        pads are parametrised exactly as turn() is, which is why a curved run
        and a straight one are the same piece and not two."""
        total = float(count) * spacing
        o, f, l = self.frame()
        h0 = self.heading
        half = self.w / 2.0
        pad = specmod.STRAFE_PAD_LEN
        z = self.z
        sweep = abs(curve)
        sign = 1.0 if curve > 0 else -1.0
        r = total / math.radians(sweep) if sweep else 0.0
        cx = cy = a0 = 0.0
        if sweep:
            cx, cy = o[0] + l[0] * r * sign, o[1] + l[1] * r * sign
            a0 = math.atan2(o[1] - cy, o[0] - cx)

        def at(dist):
            """(x, y), heading in degrees, at `dist` along the run."""
            if not sweep:
                return (o[0] + f[0] * dist, o[1] + f[1] * dist), h0
            a = a0 + math.radians(sweep) * (dist / total) * sign
            return (cx + r * math.cos(a), cy + r * math.sin(a)), h0 + sign * sweep * dist / total

        for n in range(count):
            (px, py), hd = at((n + 0.5) * spacing)
            ph = math.radians(hd)
            pf, pl = (math.cos(ph), math.sin(ph)), (-math.sin(ph), math.cos(ph))
            poly = _rect((px, py), pf, pl, -pad / 2.0, pad / 2.0, half, half)
            self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, z, tex, hd))
            self.c.floor_polys.append((poly, tex))
            self.hull(poly, z - FLOOR_THICK, z)
            self.c.route.append((px, py, z))

        (ex, ey), _ = at(total)
        self.x, self.y = ex, ey
        self.heading = (h0 + sign * sweep) % 360.0
        self.c.length += total
        self.c.route.append((self.x, self.y, self.z))
        self.c.landmarks.append(("strafepads", (o[0], o[1], z), h0))
        self.c.features.append({"type": "strafepads", "segment": self.seg, "pads": count,
                                "spacing": round(spacing), "gap": round(spacing - pad),
                                "curve": curve})

    # -- shifting and rotating a piece --------------------------------------

    def _mouth(self):
        """The corridor's cross-section at the cursor: its two corners, and
        the forward direction a joint extrudes it along."""
        o, f, l = self.frame()
        half = self.w / 2.0
        return ([(o[0] + l[0] * half, o[1] + l[1] * half),
                 (o[0] - l[0] * half, o[1] - l[1] * half)], f)

    def _nudge(self, seg):
        """Move the cursor sideways (`shift`, + is left) and turn it on the
        spot (`rotate`, + is left) before the piece is laid.

        Both are cursor transforms, which is why every piece kind gets them
        without knowing they exist: frame() is what each piece builds from.
        The seam they open is bridged by _joint, so a nudge bends the course
        instead of cutting it in two."""
        shift = seg.get("shift") or 0
        rot = seg.get("rotate") or 0
        if not shift and not rot:
            return
        before = self._mouth()
        if shift:
            _, _, l = self.frame()
            self.x += l[0] * shift
            self.y += l[1] * shift
            # A sideways step is distance the player covers, so the route and
            # the par time have to carry it.
            self.c.length += abs(shift)
            self.c.route.append((self.x, self.y, self.z))
        if rot:
            self.heading = (self.heading + rot) % 360.0
        self._joint(before)

    def _joint(self, before):
        """Floor bridging the seam a nudge opened.

        Both cross-sections are extruded a little along their own heading —
        the one being left backwards, the one about to be laid forwards — and
        the plate is the convex hull of all of it. The extrusion is what makes
        a plain sideways shift work: on its own, shifting moves the cursor
        ALONG its cross-section, so the four corners are collinear and there is
        no plate to be had. Giving each a little depth turns that line into an
        area that covers both lanes and the ground between them.

        The hull is also what keeps a hard rotation safe: past 90 degrees the
        two cross-sections cross, and the quad through their corners in order
        would be self-intersecting, which is not a brush. Its hull still is.

        The plate sits one unit under the floor, for the reason stripe() does:
        where it laps the corridor it is hidden instead of z-fighting with it,
        and where it bridges, a 1-unit step is far under the engine's own
        18-unit step and no player ever feels it."""
        pts_b, fb = before
        pts_a, fa = self._mouth()
        d = JOINT_DEPTH
        plate = _hull(pts_b + [(x - fb[0] * d, y - fb[1] * d) for x, y in pts_b]
                      + pts_a + [(x + fa[0] * d, y + fa[1] * d) for x, y in pts_a])
        if len(plate) < 3 or _area(plate) < 16.0:
            return
        top = self.z - 1
        self.c.world.append(Prism.flat(plate, top - FLOOR_THICK, top, "floor", self.heading))
        self.c.floor_polys.append((plate, "floor"))
        self.hull(plate, top - FLOOR_THICK, self.z + WALL_HEIGHT)

    def _lay_segment(self, i, seg, segs, auto):
        """Lay one spec segment at the cursor.

        Split out of run(), which stays the only caller that matters: it has
        already set self.seg and the open/falloff bookkeeping this needs. tiles.py
        calls it directly to lay a tile's pieces in the tile's own local frame,
        which is how a tile deck gets every piece kind the spec language has
        without a second geometry writer.
        """
        t = seg["type"]
        # Sideways and on the spot, before anything is laid: see _nudge.
        self._nudge(seg)
        sides = () if seg.get("open") else (1, -1)
        # Ice changes only the walking surface's texture, and with it the
        # surfaceparm slick the compiler bakes into the bsp: never the shape.
        tex = "ice" if seg.get("ice") else "floor"
        if t == "straight":
            o, f, _ = self.frame()
            self.box_run(seg["length"], tex=tex, walls=sides)
            self.runup += seg["length"]
            if self.pending and self.pending["turn"] == i - 1:
                self._shortcut(i)
            # After the shortcut, so landmarks stay in course order: a
            # checkpoint on a shortcut's exit leg is past its window.
            for a in auto.get(i, ()):
                self.checkpoint_at(o, f, a)
                self.c.auto_checkpoints.append((i, a))
        elif t == "ramp":
            self.box_run(seg["length"], seg["rise"], tex=tex, walls=sides)
            self.runup = 0.0
        elif t == "turn":
            if seg.get("shortcut"):
                o, f, l = self.frame()
                self.pending = {"turn": i, "origin": o, "f": f, "l": l, "z": self.z,
                                "sign": 1 if seg["direction"] == "left" else -1,
                                "radius": seg["radius"]}
            self.turn(seg["direction"], seg["angle"], seg["radius"], walls=bool(sides), floor_tex=tex)
            self.runup += math.radians(seg["angle"]) * seg["radius"]
        elif t == "checkpoint":
            self.checkpoint()
        elif t == "gap":
            self._gap(i, seg, segs)
        elif t == "slalom":
            self.runup = self.slalom(seg["length"], seg["count"], tex)
        elif t == "beam":
            self.beam(seg["length"], seg["beam_width"])
            self.runup += seg["length"]
        elif t == "split":
            self.split(seg["length"], seg["direction"], seg["count"])
            self.runup = float(specmod.SPLIT_MOUTH)
        elif t == "wallclimb":
            if self.runup + seg["length"] / 2.0 < specmod.WALL_RUNUP:
                self._note(
                    f"segment {i} (wallclimb): only {int(self.runup + seg['length'] / 2)} "
                    f"units of flat floor before its ledge; it needs {specmod.WALL_RUNUP} "
                    "(a ramp resets it, because a jump off a ramp flies high enough "
                    "to skip the kick). Lengthen it or put a straight before it")
            self.wallclimb(seg["length"], seg["rise"], seg["direction"])
            self.runup = seg["length"] / 2.0
        elif t == "wallgap":
            self._gap(i, seg, segs, kick=seg["direction"])
        elif t == "dash":
            self._dash(i, seg, segs)
        elif t == "stairs":
            self.stairs(seg["length"], seg["rise"], seg["count"], tex=tex, walls=sides)
            # A staircase is not flat floor: it cannot be the run-up to a jump.
            self.runup = 0.0
        elif t == "platforms":
            self.platforms(seg["length"], seg["count"], seg.get("drop", 0), walls=sides)
            # The last stone is the only footing, and it is one stone long.
            self.runup = (seg["length"] / seg["count"]) * specmod.PLATFORM_FILL
        elif t == "pillars":
            self.pillars(seg["length"], seg["count"], tex=tex, walls=sides)
            self.runup += seg["length"]
        elif t == "tunnel":
            self.tunnel(seg["length"], seg["height"], tex=tex)
            self.runup += seg["length"]
        elif t == "chicane":
            self.chicane(seg["direction"], seg["angle"], seg["radius"],
                         walls=bool(sides), floor_tex=tex)
            self.runup += 2 * math.radians(seg["angle"]) * seg["radius"]
        elif t == "bumps":
            self.bumps(seg["length"], seg["count"], seg["rise"], tex=tex, walls=sides)
            # Like a ramp: a jump off a hump leaves with the hump's own lift.
            self.runup = 0.0
        elif t == "pinch":
            self.pinch(seg["length"], seg["gate"], tex=tex, walls=sides)
            self.runup += seg["length"]
        elif t == "ledge":
            self.ledge(seg["length"], seg["direction"], seg["ledge_width"], tex=tex)
            self.runup += seg["length"]
        elif t == "hazard":
            self.hazard(seg["length"], walls=sides)
            self.runup = 0.0
        elif t == "strafepads":
            self.strafepads(seg["count"], seg["spacing"], seg.get("curve", 0),
                            tex="ice" if seg.get("ice") else "platform")
            # One pad is all the footing there is.
            self.runup = float(specmod.STRAFE_PAD_LEN)

    def run(self):
        s = self.c.spec
        # Start room: back wall, spawn, then the start trigger at its far end.
        self._start_room()

        segs = s["segments"]
        auto = {}
        for i, a in plan_checkpoints(s):
            auto.setdefault(i, []).append(a)
        for i, seg in enumerate(segs):
            self.seg = i
            # Route distance so far, so a cut's size can be measured in the
            # units of course it skips rather than in segment counts.
            self.c.seg_dist.append(self.c.length)
            t = seg["type"]
            sides = () if seg.get("open") else (1, -1)
            if not sides:
                self.c.open_segs.add(i)
            # Where a player can leave a piece DOWNWARDS. An ordinary walled
            # piece cannot be left at all: WALL_HEIGHT is 256 and the tallest
            # climb in the game is about 94, so the corridor holds the player
            # whatever the plan does above or below it. These can be left: an
            # open piece has no walls to stop a step sideways, and the rest
            # have a hole in the floor by construction — the pit under a gap
            # or a dash drop, the sides of a beam, the holes in a split's fast
            # lane. Falling there is normally punished by the pit's
            # trigger_hurt; it is only a cut when a later piece is underneath.
            if not sides or t in ("gap", "wallgap", "dash", "beam", "split",
                                  "platforms", "ledge", "hazard", "strafepads"):
                self.c.falloff_segs.add(i)
            self._lay_segment(i, seg, segs, auto)

        self.seg = len(segs)
        self._finish_room()
        self._self_intersections()
        self._cuts()
        self._size_limits()
        if self.problems:
            raise LayoutError(self.problems)
        self._camera_pads()
        self._shell()
        return self.c

    def _size_limits(self):
        """How far the course may spread and how many brushes it may take.

        These are the one set of limits BOTH tiers enforce, because they are
        not about the course being fair or even possible: past them the map
        does not compile, or does not load, or hurts every server that holds
        it. The open tier's are further out (spec.OPEN), not absent."""
        xy, zmax, bmax = self.L.extent_xy, self.L.extent_z, self.L.brushes
        xs = [x for p in self.c.world for x, _ in p.poly]
        ys = [y for p in self.c.world for _, y in p.poly]
        zs = [z for p in self.c.world for z in (p.zmin, p.zmax())]
        dx, dy, dz = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
        if max(dx, dy) > xy:
            self.problems.append(
                f"the course spreads {int(dx)} x {int(dy)} units; at most {xy} "
                "in each direction (fold it back on itself with turns)")
        if dz > zmax:
            self.problems.append(f"the course is {int(dz)} units tall; at most {zmax}")
        brushes = len(self.c.world) + sum(len(b) for _, b in self.c.entities)
        if brushes > bmax:
            self.problems.append(
                f"the course needs {brushes} brushes; at most {bmax} "
                "(fewer slalom fins, splits or tight turns)")

    def _camera_pads(self):
        """Screenshot-only: invisible solid pads high above the course.

        The engine drops a spawn point to the floor under it and gives a
        spectator only its yaw (screenshots.py), so the one way to film from
        the air is to give the spawn something to stand on. The pads use the
        nodraw trigger shader, so they are solid but never rendered. They go
        in BEFORE the sky shell is sized, so the shell grows to contain them.
        Never used for a map anyone plays: only screenshots.py passes them.
        """
        for x, y, z in self.camera_pads:
            poly = [(x - 48, y - 48), (x + 48, y - 48), (x + 48, y + 48), (x - 48, y + 48)]
            self.c.world.append(Prism.flat(poly, z - 16, z, "trigger"))

    def _start_room(self):
        o, f, l = self.frame()
        self.end_wall(behind=True)
        # The room is laid from the back wall forward.
        self.box_run(ROOM_LEN, tex="start")
        self.c.length = 0.0
        self.c.route = [(self.x, self.y, self.z)]
        spawn = (o[0] + f[0] * SPAWN_BACK, o[1] + f[1] * SPAWN_BACK, self.z + 40)
        self.c.entities.append(({"classname": "info_player_deathmatch",
                                 "origin": spawn, "angle": self.heading}, []))
        self.trigger("trigger_multiple", {"classname": "target_starttimer"}, stripe="trim")
        self.runup = ROOM_LEN - SPAWN_BACK

    def _finish_room(self):
        self.trigger("trigger_multiple", {"classname": "target_stoptimer"}, stripe="trim")
        self.box_run(ROOM_LEN, tex="finish")
        self.end_wall(behind=False)

    # What a gap, a wall-kick gap or a dash may land on: a piece whose floor
    # is solid where the jump arrives. The shape pieces that qualify do so for
    # the same reason a straight does — you land on floor and keep running.
    # platforms (a hole at its lip), ledge (void but for the walkway) and
    # hazard (lethal) do not, and neither does another gap.
    LANDINGS = ("straight", "turn", "slalom", "split", "wallclimb",
                "stairs", "pillars", "tunnel", "chicane", "bumps", "pinch")

    def _landing(self, where, i, segs):
        nxt = segs[i + 1]["type"] if i + 1 < len(segs) else "finish"
        if nxt not in self.LANDINGS:
            self._note(
                f"{where}: must land on a {', '.join(self.LANDINGS[:-1])} or "
                f"{self.LANDINGS[-1]}, not on {nxt!r}")

    def _gap(self, i, seg, segs, kick=None):
        """A pit to jump. With `kick` ("left"/"right") it is a wall-kick gap:
        open on both sides except one kick wall along it, from the lip to
        the landing, to wall-jump off mid-air."""
        kind = "wallgap" if kick else "gap"
        where = f"segment {i} ({kind})"
        if kick and self.runup < specmod.WALL_RUNUP:
            self._note(
                f"{where}: only {int(self.runup)} units of flat floor before it; a wall-kick "
                f"gap needs {specmod.WALL_RUNUP} (straights and turns; a ramp resets it, "
                "because a jump off a ramp flies high enough to skip the kick)")
        elif self.runup < physics.MIN_RUNUP:
            self._note(
                f"{where}: only {int(self.runup)} units of flat floor before it; a gap "
                f"needs {int(physics.MIN_RUNUP)} of straight/turn run-up (ramps and "
                "other gaps reset it)")
        self._landing(where, i, segs)
        # Mark the take-off lip so the gap reads from a distance.
        self.stripe("edge", -32, 0)
        self.c.landmarks.append((kind, (self.x, self.y, self.z), self.heading))
        land = self.z - seg["drop"]
        wall_floor = min(self.z, land) - FLOOR_THICK - 128
        if kick:
            o, f, l = self.frame()
            side = 1 if kick == "left" else -1
            self.c.world.append(Prism.flat(self._wall_poly(o, f, l, side, 0, seg["length"]),
                                           wall_floor, max(self.z, land) + WALL_HEIGHT, "kick"))
            self.box_run(seg["length"], floor=False, wall_floor=wall_floor, walls=())
            self.c.features.append({"type": "wallgap", "segment": self.seg, "side": kick,
                                    "length": seg["length"], "drop": seg["drop"]})
        else:
            sides = () if seg.get("open") else (1, -1)
            self.box_run(seg["length"], floor=False, wall_floor=wall_floor, walls=sides)
        self.z = land
        self.c.route[-1] = (self.x, self.y, self.z)
        self.runup = 0.0

    def _dash(self, i, seg, segs):
        """A DASH_PAD open take-off pad, then an open gap `drop` down that is
        longer than any run-speed jump (spec.dash_window). The pad keeps any
        wall of the piece before it out of wall-jump reach of the lip."""
        where = f"segment {i} (dash)"
        self._landing(where, i, segs)
        self.box_run(specmod.DASH_PAD, walls=())
        self.stripe("edge", -32, 0)
        self.c.landmarks.append(("dash", (self.x, self.y, self.z), self.heading))
        land = self.z - seg["drop"]
        self.box_run(seg["length"], floor=False, walls=())
        self.z = land
        self.c.route[-1] = (self.x, self.y, self.z)
        self.runup = 0.0
        self.c.features.append({"type": "dash", "segment": self.seg,
                                "length": seg["length"], "drop": seg["drop"]})

    def wallclimb(self, length, rise, direction):
        """A ledge `rise` high halfway along, too high to jump onto, with a
        kick wall on `direction` the whole way: run along the wall, jump,
        wall-jump off it and land on top. The other side is open."""
        o, f, l = self.frame()
        half = self.w / 2.0
        z = self.z
        a = length / 2.0
        side = 1 if direction == "left" else -1
        self.c.landmarks.append(("wallclimb", (self.x, self.y, z), self.heading))
        for b0, b1, top in ((0, a, z), (a, length, z + rise)):
            poly = _rect(o, f, l, b0, b1, half, half)
            self.c.world.append(Prism.flat(poly, z - FLOOR_THICK, top, "floor", self.heading))
            self.c.floor_polys.append((poly, "floor"))
            band = (_band(o, f, l, b0, b1, -half, -half + EDGE_BAND) if side > 0
                    else _band(o, f, l, b0, b1, half - EDGE_BAND, half))
            self.c.world.append(Prism.flat(band, top - 4, top + 1, "edge"))
        # The ledge's lip, so its height reads from the run-up.
        self.c.world.append(Prism.flat(_rect(o, f, l, a, a + 32, half - EDGE_BAND, half - EDGE_BAND),
                                       z + rise - 4, z + rise + 1, "edge", self.heading))
        wall = self._wall_poly(o, f, l, side, 0, length)
        self.c.world.append(Prism.flat(wall, z - FLOOR_THICK, z + rise + WALL_HEIGHT, "kick"))
        self.hull(_rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
                  z - FLOOR_THICK, z + rise + WALL_HEIGHT)
        # The centre line climbs over the last WALLCLIMB_ARC before the ledge,
        # the way the jump does, so a camera on it never cuts through the face.
        self.advance(a - WALLCLIMB_ARC)
        self.z += rise
        self.advance(WALLCLIMB_ARC)
        self.advance(length - a)
        self.c.features.append({"type": "wallclimb", "segment": self.seg, "side": direction,
                                "rise": rise})

    def _self_intersections(self):
        hs = self.c.hulls
        over = {}
        for i in range(len(hs)):
            for j in range(i + 1, len(hs)):
                a, b = hs[i], hs[j]
                if abs(a.seg - b.seg) <= 1:
                    continue  # neighbours share an edge by construction
                if a.zhi <= b.zlo or b.zhi <= a.zlo:
                    # One passes cleanly over the other: an overpass, if their
                    # footprints actually cross.
                    if _sat_overlap(a.poly, b.poly):
                        lo, hi = (a, b) if a.zhi <= b.zlo else (b, a)
                        key = (lo.seg, hi.seg)
                        over[key] = min(over.get(key, 1e9), hi.zlo - lo.zhi)
                    continue
                if _sat_overlap(a.poly, b.poly):
                    self._note(
                        f"course runs into itself: {_segname(a.seg)} overlaps {_segname(b.seg)}")
                    return
        # One entry per crossing: runs of adjacent segment pairs are the same
        # bridge seen piece by piece.
        for (lo, hi), clear in sorted(over.items()):
            if any(abs(lo - p["lower"]) <= 1 and abs(hi - p["upper"]) <= 1 for p in self.c.overpasses):
                continue
            self.c.overpasses.append({"lower": lo, "upper": hi, "clearance": round(clear)})

    def _cuts(self):
        """Reject or repair plans a player can short-circuit.

        A cut is any way to leave the route and rejoin it further along. The
        generator designs one kind on purpose (turn.shortcut, with its stepping
        stones and its own checkpoint rules); everything else is an accident of
        the plan folding back on itself, and it matters because it makes the
        map's records meaningless -- the fast line stops being the course.

        One rule covers every shape of it. For each piece a player can leave
        (`open`, or with a hole in its floor by construction: a gap, a dash
        drop, a beam, a split) ask whether the floor of a LATER piece is
        within reach:

        * How fast you would have to be going. The horizontal distance
          between the two footprints, divided by the air time a jump from that
          height gives, is the speed the cut needs. At CUT_SPEED_OK or more it
          is left alone -- that is a line a player earns. Footprints that
          overlap are zero apart, a straight fall needing no speed at all, and
          are always caught.
        * Whether the player can get IN. An open piece has nothing in the way.
          A walled one is enterable only from above its walls, because
          WALL_HEIGHT is 256 and the tallest climb in the game is about 94: a
          player level with a walled corridor bounces off it, and a player
          above its wall top drops straight in. Walls stop a player leaving a
          corridor, never entering one.

        Where the target is walled the fix is geometric: cap it with a roof
        (_roof), so the fall lands on the roof and the only way off a roof is
        into the pit, which respawns the player at the start. That keeps the
        crossing -- usually the best part of the design -- and costs no model
        call. An open target cannot be roofed, so that one is rejected and the
        repair loop gets a specific complaint.

        Climbing UP into a later piece is not checked: it needs 256 units of
        climb and the game's best is about 94.
        """
        walk = self._walk_surfaces()
        for src in sorted(self.c.falloff_segs):
            if src not in walk:
                continue
            zs, polys_s = walk[src]
            for tgt in sorted(walk):
                if tgt - src <= 1:
                    continue  # the route's own next piece
                if self._declared_shortcut(src, tgt):
                    continue
                saved = self._cut_skip(src, tgt)
                if saved < max(CUT_MIN_SKIP, CUT_MIN_FRACTION * self.c.length):
                    continue
                zt, polys_t = walk[tgt]
                drop = zs - zt
                if drop < 0:
                    continue  # the target is higher: no move in the game gets there
                # Walls stop a player entering from the side, not from above.
                if tgt not in self.c.open_segs and drop <= WALL_HEIGHT:
                    continue
                gap = min(_poly_gap(a, b) for a in polys_s for b in polys_t)
                # The speed a player would need to cover `gap` in the air time
                # a jump from this height gives. No margin either way: this is
                # a capability question, not a "can everyone do it" one.
                flight = physics.air_time(drop)
                if flight is None or flight <= 0.0:
                    continue
                needed = gap / flight
                if needed >= CUT_SPEED_OK:
                    continue
                reach = CUT_SPEED_OK * flight
                if tgt not in self.c.open_segs and self._roof(tgt, polys_s, reach):
                    self.c.cuts.append({"kind": "drop", "from": src, "to": tgt,
                                        "saves": round(saved), "gap": round(gap),
                                        "needs_ups": round(needed), "fixed": "roofed"})
                    continue
                self.c.cuts.append({"kind": "jump" if gap else "drop", "from": src, "to": tgt,
                                    "saves": round(saved), "gap": round(gap),
                                    "needs_ups": round(needed)})
                how = (f"drop straight down onto {_segname(tgt)}" if gap <= 1.0
                       else f"jump the {int(gap)} units to {_segname(tgt)} at only "
                            f"{int(needed)} ups")
                self._note(
                    f"unintended shortcut: from {_segname(src)} a player can {how}, skipping "
                    f"about {int(saved)} units of the course. Both are open, so there is "
                    "nothing in the way — give the later one walls (drop its \"open\": "
                    "true), or bend the course so the two do not pass so close")

    def _walk_surfaces(self):
        """Per segment: (lowest walking surface, [footprints]).

        The hull's zlo is the underside of the floor slab, so the surface a
        player stands on is FLOOR_THICK above it.
        """
        out = {}
        for h in self.c.hulls:
            top = h.zlo + FLOOR_THICK
            cur = out.get(h.seg)
            if cur is None:
                out[h.seg] = (top, [h.poly])
            else:
                out[h.seg] = (min(cur[0], top), cur[1] + [h.poly])
        return out

    def _roof(self, seg, src_polys, reach):
        """Cap a walled piece where a player could land on it from above, so
        the fall lands on a roof rather than on the course.

        Only the parts within `reach` of the source footprint are capped: a
        turn is many hull slices, and roofing all of them for a crossing that
        covers two would spend brushes the budget needs elsewhere (it put the
        kickflip example over its limit). Returns False if nothing could be
        capped, so the caller falls back to rejecting the plan. Idempotent per
        (piece, slice).
        """
        done = False
        for idx, h in enumerate(self.c.hulls):
            if h.seg != seg or idx in self._roofed:
                continue
            if min(_poly_gap(sp, h.poly) for sp in src_polys) > reach:
                continue
            # The hull's top IS the wall top (box_run builds the hull to
            # floor + WALL_HEIGHT), so the slab lands flush on the walls.
            self.c.world.append(Prism.flat(h.poly, h.zhi - ROOF_THICK, h.zhi, "wall"))
            self._roofed.add(idx)
            done = True
        # Already capped by an earlier crossing counts as capped.
        return done or any(h.seg == seg and i in self._roofed
                           for i, h in enumerate(self.c.hulls))

    def _cut_skip(self, a, b):
        """Route distance between the starts of segments a and b."""
        d = self.c.seg_dist
        if a >= len(d) or b >= len(d):
            return 0.0
        return abs(d[b] - d[a])

    def _declared_shortcut(self, a, b):
        """True if a-to-b is exactly the stepping-stone hop across a shortcut
        turn: the straight before it to the straight after it.

        Narrow on purpose. Exempting every pair that merely SPANS a shortcut
        turn would mask real cuts on any course that has one — on the
        corkscrew that hid three of them.
        """
        return b == a + 2 and any(s["turn"] == a + 1 for s in self.c.shortcuts)

    def _shell(self):
        """Seal the course in a sky box and put a kill volume in the pit.

        q3map2 needs a leak-free hull or it refuses to vis/light; the sky box is
        the simplest one. Falling into a gap lands in trigger_hurt, and the
        racemod respawns the player at the start.
        """
        xs, ys, zs = [], [], []
        for p in self.c.world:
            for x, y in p.poly:
                xs.append(x); ys.append(y)
            zs += [p.zmin, p.zmax()]
        m = SHELL_MARGIN
        x0, x1 = min(xs) - m, max(xs) + m
        y0, y1 = min(ys) - m, max(ys) + m
        z0, z1 = min(zs) - PIT_DEPTH, max(zs) + m
        T = 16
        box = lambda a, b, c, d, lo, hi: Prism.flat([(a, c), (b, c), (b, d), (a, d)], lo, hi, "sky")
        self.c.world += [
            box(x0 - T, x1 + T, y0 - T, y1 + T, z0 - T, z0),     # floor
            box(x0 - T, x1 + T, y0 - T, y1 + T, z1, z1 + T),     # ceiling
            box(x0 - T, x0, y0, y1, z0, z1),
            box(x1, x1 + T, y0, y1, z0, z1),
            box(x0 - T, x1 + T, y0 - T, y0, z0, z1),
            box(x0 - T, x1 + T, y1, y1 + T, z0, z1),
        ]
        hurt = Prism.flat([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z0 + 64, "trigger")
        self.c.entities.append(({"classname": "trigger_hurt", "dmg": 9999}, [hurt]))
        self.c.bounds = ((x0, y0, z0), (x1, y1, z1))


def _segname(i):
    if i < 0:
        return "the start room"
    return f"segment {i}"


def build(spec, camera_pads=(), rules="strict"):
    """Validate ranges, then lay out. Raises LayoutError listing every problem.
    camera_pads is for screenshots.py's overview only; see _camera_pads.

    `rules` is the tier (spec.STRICT / spec.OPEN). The strict one is the
    generator's: it refuses a course whose pieces do not fit together, because
    nobody looks at a described map or a random_map tile before it is in the
    pool. The open one is the map editor's: a person laid this out and an admin
    approves it, so the pieces-fit-together rules become notes on the report
    (course.notes) instead of refusals, and only the limits that decide whether
    the map compiles and loads are still enforced."""
    problems = specmod.validate(spec, rules)
    if problems:
        raise LayoutError(problems)
    return _Walker(spec, camera_pads, rules).run()


def preview_svg(course, px=900):
    """Top-down plan of the course: what the web form shows before compiling."""
    colors = {"floor": "#8a8f98", "ice": "#9fdcf0", "start": "#3fae5a", "finish": "#d0463c", "platform": "#ff6a1a",
              "edge": "#e8b923", "beam": "#ff6a1a"}
    (x0, y0, _), (x1, y1, _) = course.bounds
    w, h = x1 - x0, y1 - y0
    s = px / max(w, h)
    def tx(x, y):
        return f"{(x - x0) * s:.1f},{(y1 - y) * s:.1f}"
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w * s:.0f}" height="{h * s:.0f}" '
           f'viewBox="0 0 {w * s:.0f} {h * s:.0f}"><rect width="100%" height="100%" fill="#1d2127"/>']
    for poly, tex in course.floor_polys:
        pts = " ".join(tx(x, y) for x, y in poly)
        out.append(f'<polygon points="{pts}" fill="{colors.get(tex, "#8a8f98")}" '
                   'stroke="#1d2127" stroke-width="0.5"/>')
    for ent, _ in course.entities:
        if ent["classname"] == "target_checkpoint":
            x, y, _ = ent["origin"]
            out.append(f'<circle cx="{(x - x0) * s:.1f}" cy="{(y1 - y) * s:.1f}" r="6" fill="#e8b923"/>')
    route = " ".join(tx(x, y) for x, y, _ in course.route)
    out.append(f'<polyline points="{route}" fill="none" stroke="#ffffff" '
               'stroke-width="1.5" stroke-dasharray="6 4"/>')
    out.append("</svg>")
    return "\n".join(out)
