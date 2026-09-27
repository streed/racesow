"""Spec -> geometry: walk the course like a turtle and lay down brushes.

Every piece of the course is a Prism: a convex footprint polygon extruded from
a flat bottom up to a (possibly sloped) top plane. That one shape covers every
floor, wall, ramp, curve wedge, trigger volume and the sky shell, so there is
exactly one brush writer (mapfile.py) and one overlap test.

The walk also enforces the rules that need geometry rather than ranges:

  * a gap needs MIN_RUNUP of flat floor before it (physics.py);
  * a gap must land on floor, not on another gap or the finish trigger;
  * the course must not run through itself.

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

TEX = {
    "floor": "mapgen_v1/floor",
    "wall": "mapgen_v1/wall",
    "start": "mapgen_v1/start",
    "finish": "mapgen_v1/finish",
    "checkpoint": "mapgen_v1/checkpoint",
    "edge": "mapgen_v1/edge",
    "sky": "mapgen_v1/sky",
    "trigger": "mapgen_v1/trigger",
}


class LayoutError(Exception):
    def __init__(self, problems):
        super().__init__("; ".join(problems))
        self.problems = problems


class Prism:
    """Convex CCW footprint `poly` [(x, y)], bottom at `zmin`, top plane
    z = top0 + gx * x + gy * y."""

    def __init__(self, poly, zmin, top0, gx=0.0, gy=0.0, tex="floor"):
        self.poly = [(float(x), float(y)) for x, y in poly]
        self.zmin = float(zmin)
        self.top0, self.gx, self.gy = float(top0), float(gx), float(gy)
        self.tex = tex

    def top_at(self, x, y):
        return self.top0 + self.gx * x + self.gy * y

    def zmax(self):
        return max(self.top_at(x, y) for x, y in self.poly)

    @classmethod
    def flat(cls, poly, zmin, zmax, tex):
        return cls(poly, zmin, zmax, 0.0, 0.0, tex)


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
        self.length = 0.0     # centre-line length, start trigger -> finish trigger


def _rect(o, f, l, back, fwd, right, left):
    """Footprint rectangle in a heading frame: origin o, forward f, left l.
    Spans [back, fwd] along f and [-right, left] along l. Returned CCW."""
    def p(a, b):
        return (o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b)
    return [p(back, -right), p(fwd, -right), p(fwd, left), p(back, left)]


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
    def __init__(self, spec):
        self.c = Course(spec)
        self.w = spec["width"]
        self.x = self.y = 0.0
        self.z = 0.0
        self.heading = 0.0
        self.runup = 0.0
        self.problems = []
        self.seg = -1          # index of the segment being laid (-1 = start room)
        self.tn = 0

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
    def box_run(self, length, rise=0.0, tex="floor", floor=True, wall_floor=None):
        """A straight run: floor slab (optionally sloped) + two side walls."""
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
            self.c.world.append(Prism(poly, lo - FLOOR_THICK, top0, gx, gy, tex))
            self.c.floor_polys.append((poly, tex))
        for side in (+1, -1):
            if side > 0:
                poly = _rect(o, f, l, 0, length, -half, half + WALL_THICK)
            else:
                poly = _rect(o, f, l, 0, length, half + WALL_THICK, -half)
            self.c.world.append(Prism(poly, base, top0 + WALL_HEIGHT, gx, gy, "wall"))
        self.hull(_rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
                  base, max(z0, z0 + rise) + WALL_HEIGHT)
        self.advance(length, rise)

    def end_wall(self, behind):
        """Wall across the corridor, just behind the cursor or just ahead."""
        o, f, l = self.frame()
        half = self.w / 2.0 + WALL_THICK
        a, b = (-WALL_THICK, 0) if behind else (0, WALL_THICK)
        self.c.world.append(Prism.flat(_rect(o, f, l, a, b, half, half),
                                       self.z - FLOOR_THICK, self.z + WALL_HEIGHT, "wall"))

    def trigger(self, classname_target, target_keys):
        """Full-width trigger slab straddling the cursor + its target entity."""
        o, f, l = self.frame()
        half = self.w / 2.0
        name = self.targetname(target_keys["classname"].split("_")[-1])
        poly = _rect(o, f, l, -TRIGGER_DEPTH / 2, TRIGGER_DEPTH / 2, half, half)
        brush = Prism.flat(poly, self.z, self.z + TRIGGER_HEIGHT, "trigger")
        self.c.entities.append(({"classname": classname_target, "target": name}, [brush]))
        ent = dict(target_keys)
        ent["targetname"] = name
        ent["origin"] = (self.x, self.y, self.z + 32)
        self.c.entities.append((ent, []))

    def turn(self, direction, angle, radius):
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
            rings = [(r_in, r_out, "floor", self.z - FLOOR_THICK, self.z),
                     (r_out, r_out + WALL_THICK, "wall", self.z - FLOOR_THICK, self.z + WALL_HEIGHT)]
            if r_in - WALL_THICK > 1:
                rings.append((r_in - WALL_THICK, r_in, "wall",
                              self.z - FLOOR_THICK, self.z + WALL_HEIGHT))
            for ri, ro, tex, zlo, zhi in rings:
                poly = [pt(ri, a), pt(ro, a), pt(ro, b), pt(ri, b)]
                if sign < 0:
                    poly.reverse()
                self.c.world.append(Prism.flat(poly, zlo, zhi, tex))
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

    # -- the walk -----------------------------------------------------------
    def run(self):
        s = self.c.spec
        # Start room: back wall, spawn, then the start trigger at its far end.
        self._start_room()

        segs = s["segments"]
        for i, seg in enumerate(segs):
            self.seg = i
            t = seg["type"]
            if t == "straight":
                self.box_run(seg["length"])
                self.runup += seg["length"]
            elif t == "ramp":
                self.box_run(seg["length"], seg["rise"])
                self.runup = 0.0
            elif t == "turn":
                self.turn(seg["direction"], seg["angle"], seg["radius"])
                self.runup += math.radians(seg["angle"]) * seg["radius"]
            elif t == "checkpoint":
                self.trigger("trigger_multiple", {"classname": "target_checkpoint"})
            elif t == "gap":
                self._gap(i, seg, segs)

        self.seg = len(segs)
        self._finish_room()
        self._self_intersections()
        if self.problems:
            raise LayoutError(self.problems)
        self._shell()
        return self.c

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
        self.trigger("trigger_multiple", {"classname": "target_starttimer"})
        self.runup = ROOM_LEN - SPAWN_BACK

    def _finish_room(self):
        self.trigger("trigger_multiple", {"classname": "target_stoptimer"})
        self.box_run(ROOM_LEN, tex="finish")
        self.end_wall(behind=False)

    def _gap(self, i, seg, segs):
        where = f"segment {i} (gap)"
        if self.runup < physics.MIN_RUNUP:
            self.problems.append(
                f"{where}: only {int(self.runup)} units of flat floor before it; a gap "
                f"needs {int(physics.MIN_RUNUP)} of straight/turn run-up (ramps and "
                "other gaps reset it)")
        nxt = segs[i + 1]["type"] if i + 1 < len(segs) else "finish"
        if nxt not in ("straight", "turn"):
            self.problems.append(
                f"{where}: must land on a straight or turn, not on {nxt!r}")
        # Mark the take-off lip so the gap reads from a distance.
        o, f, l = self.frame()
        lip = _rect(o, f, l, -32, 0, self.w / 2.0, self.w / 2.0)
        self.c.world.append(Prism.flat(lip, self.z - 4, self.z + 1, "edge"))
        land = self.z - seg["drop"]
        wall_floor = min(self.z, land) - FLOOR_THICK - 128
        self.box_run(seg["length"], floor=False, wall_floor=wall_floor)
        self.z = land
        self.c.route[-1] = (self.x, self.y, self.z)
        self.runup = 0.0

    def _self_intersections(self):
        hs = self.c.hulls
        for i in range(len(hs)):
            for j in range(i + 1, len(hs)):
                a, b = hs[i], hs[j]
                if abs(a.seg - b.seg) <= 1:
                    continue  # neighbours share an edge by construction
                if a.zhi <= b.zlo or b.zhi <= a.zlo:
                    continue  # one passes cleanly over the other
                if _sat_overlap(a.poly, b.poly):
                    self.problems.append(
                        f"course runs into itself: {_segname(a.seg)} overlaps {_segname(b.seg)}")
                    return

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


def build(spec):
    """Validate ranges, then lay out. Raises LayoutError listing every problem."""
    problems = specmod.validate(spec)
    if problems:
        raise LayoutError(problems)
    return _Walker(spec).run()


def preview_svg(course, px=900):
    """Top-down plan of the course: what the web form shows before compiling."""
    colors = {"floor": "#8a8f98", "start": "#3fae5a", "finish": "#d0463c",
              "edge": "#e8b923"}
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
