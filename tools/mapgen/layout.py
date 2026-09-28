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
EXTENT_MAX_XY = 16384
EXTENT_MAX_Z = 8192
BRUSH_MAX = 1500

FIN_THICK = 32          # slalom and split fins, along the course
SPLIT_GATE = 96         # gates in a split's safe lane: 3 player widths
VOID_DEPTH = 160        # side walls reach this far below a floorless piece
EDGE_BAND = 16          # painted edge along an open floor, flush with it
WALLCLIMB_ARC = 96      # how far before a wall climb's ledge the centre line rises

TEX = {
    "floor": "mapgen_v1/floor",
    "wall": "mapgen_v1/wall",
    "start": "mapgen_v1/start",
    "finish": "mapgen_v1/finish",
    "checkpoint": "mapgen_v1/checkpoint",
    "edge": "mapgen_v1/edge",
    "trim": "mapgen_v1/trim",
    "platform": "mapgen_v1/edge",
    "beam": "mapgen_v1/edge",
    "pylon": "mapgen_v1/pylon",
    "kick": "mapgen_v1/kick",
    "sky": "mapgen_v1/sky",
    "trigger": "mapgen_v1/trigger",
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
        self.auto_checkpoints = []  # (segment, distance into it) of each checkpoint the generator added
        self.length = 0.0     # centre-line length, start trigger -> finish trigger


def _rect(o, f, l, back, fwd, right, left):
    """Footprint rectangle in a heading frame: origin o, forward f, left l.
    Spans [back, fwd] along f and [-right, left] along l. Returned CCW."""
    def p(a, b):
        return (o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b)
    return [p(back, -right), p(fwd, -right), p(fwd, left), p(back, left)]


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


class _Walker:
    def __init__(self, spec, camera_pads=()):
        self.camera_pads = camera_pads
        self.c = Course(spec)
        self.w = spec["width"]
        self.x = self.y = 0.0
        self.z = 0.0
        self.heading = 0.0
        self.runup = 0.0
        self.problems = []
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

    def turn(self, direction, angle, radius, walls=True):
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
            rings = [(r_in, r_out, "floor", self.z - FLOOR_THICK, self.z)]
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
                if tex == "floor":
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

    def slalom(self, length, count):
        """Fins off alternate walls, first from the left, each leaving a
        SLALOM_GATE gate beside it: the line through the gates is a weave."""
        o, f, l = self.frame()
        half = self.w / 2.0
        gate = specmod.SLALOM_GATE
        self.c.landmarks.append(("slalom", (self.x, self.y, self.z), self.heading))
        self.box_run(length)
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
            t = seg["type"]
            sides = () if seg.get("open") else (1, -1)
            if t == "straight":
                o, f, _ = self.frame()
                self.box_run(seg["length"], walls=sides)
                self.runup += seg["length"]
                if self.pending and self.pending["turn"] == i - 1:
                    self._shortcut(i)
                # After the shortcut, so landmarks stay in course order: a
                # checkpoint on a shortcut's exit leg is past its window.
                for a in auto.get(i, ()):
                    self.checkpoint_at(o, f, a)
                    self.c.auto_checkpoints.append((i, a))
            elif t == "ramp":
                self.box_run(seg["length"], seg["rise"], walls=sides)
                self.runup = 0.0
            elif t == "turn":
                if seg.get("shortcut"):
                    o, f, l = self.frame()
                    self.pending = {"turn": i, "origin": o, "f": f, "l": l, "z": self.z,
                                    "sign": 1 if seg["direction"] == "left" else -1,
                                    "radius": seg["radius"]}
                self.turn(seg["direction"], seg["angle"], seg["radius"], walls=bool(sides))
                self.runup += math.radians(seg["angle"]) * seg["radius"]
            elif t == "checkpoint":
                self.checkpoint()
            elif t == "gap":
                self._gap(i, seg, segs)
            elif t == "slalom":
                self.runup = self.slalom(seg["length"], seg["count"])
            elif t == "beam":
                self.beam(seg["length"], seg["beam_width"])
                self.runup += seg["length"]
            elif t == "split":
                self.split(seg["length"], seg["direction"], seg["count"])
                self.runup = float(specmod.SPLIT_MOUTH)
            elif t == "wallclimb":
                if self.runup + seg["length"] / 2.0 < specmod.WALL_RUNUP:
                    self.problems.append(
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

        self.seg = len(segs)
        self._finish_room()
        self._self_intersections()
        self._size_limits()
        if self.problems:
            raise LayoutError(self.problems)
        self._camera_pads()
        self._shell()
        return self.c

    def _size_limits(self):
        xs = [x for p in self.c.world for x, _ in p.poly]
        ys = [y for p in self.c.world for _, y in p.poly]
        zs = [z for p in self.c.world for z in (p.zmin, p.zmax())]
        dx, dy, dz = max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)
        if max(dx, dy) > EXTENT_MAX_XY:
            self.problems.append(
                f"the course spreads {int(dx)} x {int(dy)} units; at most {EXTENT_MAX_XY} "
                "in each direction (fold it back on itself with turns)")
        if dz > EXTENT_MAX_Z:
            self.problems.append(f"the course is {int(dz)} units tall; at most {EXTENT_MAX_Z}")
        brushes = len(self.c.world) + sum(len(b) for _, b in self.c.entities)
        if brushes > BRUSH_MAX:
            self.problems.append(
                f"the course needs {brushes} brushes; at most {BRUSH_MAX} "
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

    LANDINGS = ("straight", "turn", "slalom", "split", "wallclimb")

    def _landing(self, where, i, segs):
        nxt = segs[i + 1]["type"] if i + 1 < len(segs) else "finish"
        if nxt not in self.LANDINGS:
            self.problems.append(
                f"{where}: must land on a {', '.join(self.LANDINGS[:-1])} or "
                f"{self.LANDINGS[-1]}, not on {nxt!r}")

    def _gap(self, i, seg, segs, kick=None):
        """A pit to jump. With `kick` ("left"/"right") it is a wall-kick gap:
        open on both sides except one kick wall along it, from the lip to
        the landing, to wall-jump off mid-air."""
        kind = "wallgap" if kick else "gap"
        where = f"segment {i} ({kind})"
        if kick and self.runup < specmod.WALL_RUNUP:
            self.problems.append(
                f"{where}: only {int(self.runup)} units of flat floor before it; a wall-kick "
                f"gap needs {specmod.WALL_RUNUP} (straights and turns; a ramp resets it, "
                "because a jump off a ramp flies high enough to skip the kick)")
        elif self.runup < physics.MIN_RUNUP:
            self.problems.append(
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
                    self.problems.append(
                        f"course runs into itself: {_segname(a.seg)} overlaps {_segname(b.seg)}")
                    return
        # One entry per crossing: runs of adjacent segment pairs are the same
        # bridge seen piece by piece.
        for (lo, hi), clear in sorted(over.items()):
            if any(abs(lo - p["lower"]) <= 1 and abs(hi - p["upper"]) <= 1 for p in self.c.overpasses):
                continue
            self.c.overpasses.append({"lower": lo, "upper": hi, "clearance": round(clear)})

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


def build(spec, camera_pads=()):
    """Validate ranges, then lay out. Raises LayoutError listing every problem.
    camera_pads is for screenshots.py's overview only; see _camera_pads."""
    problems = specmod.validate(spec)
    if problems:
        raise LayoutError(problems)
    return _Walker(spec, camera_pads).run()


def preview_svg(course, px=900):
    """Top-down plan of the course: what the web form shows before compiling."""
    colors = {"floor": "#8a8f98", "start": "#3fae5a", "finish": "#d0463c", "platform": "#ff6a1a",
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
