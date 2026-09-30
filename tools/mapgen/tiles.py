"""A deck of course pieces, compiled once and dealt to the player at runtime.

This is the build side of the `random_map` meta map: a course that assembles
itself in front of whoever is running it. The engine cannot create geometry
after a map loads — no BSP tree, no collision hull and no lightmap can be made
at runtime — so nothing here generates a course. It generates a LIBRARY of
courses pieces, and hrace/metamap.as deals them.

What makes that work is four engine facts, each checked against the source in
/home/reed/warfork-build/warfork-qfusion (and, for the first, against the
4,257-pack map pool):

  1. A brush entity carrying an "origin" key is compiled with its brushes
     RELATIVE to that origin (q3map2 ParseMapEntity -> AdjustBrushesForOrigin).
     So a tile's model space is centred on the tile's own entry point, which is
     what lets the dealer both move AND turn it.
  2. `Entity.setupModel("*N")` reaches GClip_SetBrushModel (game/g_clip.cpp:981),
     which resolves the inline model, takes its bounds and links the entity.
     GClip_LinkEntity then stamps s.solid = SOLID_BMODEL (g_clip.cpp:552-557).
  3. The client PREDICTS those: CG_ClipMoveToEntities pulls
     trap_CM_InlineModel(ent->modelindex) and runs a transformed box trace
     against the entity's origin *and angles* (cgame/cg_predict.cpp:261-280).
     A dealt tile therefore feels exactly like world geometry to strafe on.
  4. Brush-model entities are NOT PVS-culled when drawn —
     R_AddBrushModelToDrawList passes pvsCull = false (ref_gl/r_surf.c:443) — so
     a tile renders wherever it is put, carrying the lightmap baked at its slot.

The corollary that shapes this whole file: a submodel's surfaces are not part
of worldspawn, so an inline model NOTHING references is invisible and
non-solid. The compiled deck is therefore a dormant library. The map a player
loads is an empty sealed arena; every piece of floor they run on is an entity
the dealer created.

Layout of the compiled map
--------------------------
    play    one big empty box. A server deals ONE route from ONE seed and
            every player on it races that same route together, so there is no
            per-player geometry to keep apart — and a seed on a leaderboard
            means something, because it names a course other people can run.
    slots   a grid well above the play box holding every tile at the position
            it was compiled and lit. Nothing renders or collides here.
    lobby   one small pad with the map's info_player_deathmatch, for the frame
            between spawning and being put on the route (and as the fallback if
            the deck manifest fails to load).
    shell   the sky box sealing all of it, plus a trigger_hurt under the play
            box: falling off a dealt route is the pit, as on any race map.

The manifest
------------
Tile geometry lives in the .bsp; the numbers the dealer needs to fit tiles
together live in `maps/<name>.deck`, a text file packed into the same .pk3 and
read in AngelScript with G_LoadFile (which goes through the engine FS, so a
file inside a pk3 is readable). It is written AFTER compiling, because the
inline-model index of each tile is assigned by q3map2 and read back out of the
compiled entity lump rather than predicted from emission order.

Every tile obeys one mating contract, which is what makes any tile follow any
other: it ENTERS at its local origin running along +X on level, full-width,
walled floor, and it EXITS on level, full-width floor. Whatever it does in
between is its own business. Anything with a run-up requirement carries that
run-up inside itself (an entry apron), so a tile is never unfair because of
what preceded it.
"""

import math

import layout
import mapfile
import physics
import spec as specmod
from layout import Prism, _rect

# One corridor width for the whole deck: two tiles can only mate if their
# entry and exit faces are the same size.
TILE_WIDTH = 384

# Aprons. The entry apron is what makes a tile self-sufficient: physics.MIN_RUNUP
# of level floor before a gap, spec.WALL_RUNUP before a wall kick (a jump off a
# ramp flies high enough to skip the kick, which is why that one is longer).
APRON = 256
assert APRON >= physics.MIN_RUNUP
WALL_APRON = specmod.WALL_RUNUP
# Landing apron: floor after a gap/dash, so the piece that follows starts level.
LAND_APRON = 384

# Tile flags, mirrored by META_TILE_* in hrace/metamap.as.
F_OPEN = 1        # no side walls: the player can leave it sideways
F_DASH = 2        # needs the dash
F_WALLJUMP = 4    # needs a wall jump
F_START = 8       # carries the start pad
F_FINISH = 16     # carries the finish pad

# -- the arena ---------------------------------------------------------------
# One play box, not one per player. Every player on the server runs the SAME
# route from the same seed, so there is one route on the ground and everyone
# races it together — which is also what makes a seed worth putting on a
# leaderboard. The box is sized so a route of spec.ROUTE_MAX folds inside it
# with room to spare, and the whole map still fits well within any Quake 3
# derived compiler's world bounds.
PLAY_HALF = 13312        # the square a route must stay inside, from the centre
PLAY_UP = 2560           # how far above the start a route may climb
PLAY_DOWN = 1536         # ...and how far below

PIT_TOP = -(PLAY_DOWN + 768)     # trigger_hurt ceiling: below any dealt floor
PIT_THICK = 256

SLOT_Z = 4608            # the compile/lighting grid, clear above the play box
SLOT_PITCH = 3072

LOBBY_Y = -(PLAY_HALF + 1536)
LOBBY_HALF = 192

SHELL_MARGIN = 768
# Luxels per tile surface, indirectly: q3map2's default is one per 16 units,
# and this multiplies that. See _place for why coarse is free here.
LIGHTMAP_SCALE = 8
GATE_HEIGHT = layout.TRIGGER_HEIGHT
GATE_DEPTH = 32


class Tile:
    """One dealt-able piece: its brushes in the tile's own local frame, and the
    transform that carries the cursor from its entry to its exit."""

    def __init__(self, name, kind, flags, weight, prisms, exit_xyz, exit_yaw, route):
        self.name = name
        self.kind = kind
        self.flags = flags
        self.weight = weight
        self.prisms = prisms
        self.fwd, self.lat, self.rise = exit_xyz
        self.yaw = exit_yaw
        self.route = route
        xs = [x for p in prisms for x, _ in p.poly]
        ys = [y for p in prisms for _, y in p.poly]
        zs = [z for p in prisms for z in (p.zmin, p.zmax())]
        self.mins = (min(xs), min(ys), min(zs))
        self.maxs = (max(xs), max(ys), max(zs))

    def span(self):
        return max(self.maxs[0] - self.mins[0], self.maxs[1] - self.mins[1])


def translate(prism, dx, dy, dz):
    """The same prism moved. The top plane is stored in world coordinates
    (z = top0 + gx*x + gy*y), so moving the footprint has to move top0 back by
    the gradient it just travelled or a sloped piece would shear."""
    out = Prism([(x + dx, y + dy) for x, y in prism.poly],
                prism.zmin + dz,
                prism.top0 + dz - prism.gx * dx - prism.gy * dy,
                prism.gx, prism.gy, prism.tex, prism.heading)
    return out


def lay(recipe):
    """Build one tile in its own local frame (entry at the origin, heading 0).

    A fresh _Walker starts at exactly that cursor, so the tile's local frame IS
    a walker's world frame and every piece builder in layout.py can be used
    unchanged. run() is deliberately not used: it would add a start room, a
    finish room, a sky shell and a pit, none of which belong to a tile.

    self.runup starts at 0 and is never seeded from a previous tile, which is
    what forces each tile's entry apron to justify its own feature.
    """
    segs = recipe.get("segments")
    build = recipe.get("build")
    spec = {"name": "gen_deck_tile", "title": "Deck Tile", "width": TILE_WIDTH,
            "segments": segs if segs else [{"type": "straight", "length": 256}]}
    problems = specmod.validate(spec)
    if problems:
        raise layout.LayoutError([f"tile {recipe['name']}: {p}" for p in problems])

    w = layout._Walker(spec)
    # The piece builders that re-route the centre line (slalom, split) read
    # route[-1]; run() seeds it in _start_room, so a bare walker must too.
    w.c.route = [(0.0, 0.0, 0.0)]
    if build is not None:
        build(w)
    else:
        for i, seg in enumerate(segs):
            w.seg = i
            w.c.seg_dist.append(w.c.length)
            if seg.get("open"):
                w.c.open_segs.add(i)
            w._lay_segment(i, seg, segs, {})
    if w.problems:
        raise layout.LayoutError([f"tile {recipe['name']}: {p}" for p in w.problems])
    if not w.c.world:
        raise layout.LayoutError([f"tile {recipe['name']}: laid no brushes"])

    return Tile(recipe["name"], recipe["kind"], recipe.get("flags", 0),
                recipe.get("weight", 10), w.c.world,
                (w.x, w.y, w.z), w.heading % 360.0, w.c.length)


# -- the catalogue -----------------------------------------------------------
# Windows are computed from physics.py / spec.py rather than written out, so a
# change to the engine numbers those modules mirror moves every tile with it
# instead of silently making one unclearable.

def _gap_len(drop, fill=0.92):
    """A gap at `drop` that a 320 ups run-up clears with margin to spare.
    physics.max_gap already carries JUMP_MARGIN; `fill` keeps a little more."""
    return max(specmod.GAP_MIN, int(physics.max_gap(drop) * fill))


def _wallgap_len(drop):
    lo, hi = specmod.wallgap_window(drop)
    return max(lo, int(lo + (hi - lo) * 0.55))


def _dash_len(drop):
    lo, hi = specmod.dash_window(drop)
    return (lo + hi) // 2


def _start_tile(w):
    """The run-up pad every route begins on: level floor, start-coloured, with
    the back wall behind the spawn. The dealer puts the start gate at the exit
    and the player on the pad, so the clock starts when they leave it."""
    w.seg = 0
    w.end_wall(behind=True)
    w.box_run(1024, tex="start")


def _finish_tile(w, length=1024):
    """Where a route ends: finish-coloured floor with a wall across the far
    end. The dealer puts the finish gate at this tile's entry, so the clock
    stops the moment the player arrives and the run-out catches them."""
    w.seg = 0
    w.box_run(length, tex="finish")
    w.end_wall(behind=False)


def _finish_tile_short(w):
    """The same, folded small.

    A route has to end somewhere, and by the time it does the play box is full
    of the route itself. When the roomy finish will not fit anywhere the dealer
    can back up to, this one usually will — which is the difference between a
    course that ends properly and one whose last piece is driven through an
    earlier corridor."""
    _finish_tile(w, 384)


def catalogue():
    """Every tile in the deck, most-common first. Weight is the relative draw
    chance; the dealer also steers by flags and by the tile's turn."""
    R = []

    def add(name, kind, segments, weight=10, flags=0):
        R.append({"name": name, "kind": kind, "segments": segments,
                  "weight": weight, "flags": flags})

    # -- the two fixed ends --------------------------------------------------
    R.append({"name": "start", "kind": "start", "build": _start_tile,
              "weight": 0, "flags": F_START})
    R.append({"name": "finish", "kind": "finish", "build": _finish_tile,
              "weight": 0, "flags": F_FINISH})
    R.append({"name": "finish_short", "kind": "finish", "build": _finish_tile_short,
              "weight": 0, "flags": F_FINISH})

    # -- straights: the connective tissue, so they are the most likely draw --
    for length in (384, 640, 1024, 1536):
        add(f"run_{length}", "straight", [{"type": "straight", "length": length}],
            weight=22 if length <= 640 else 14)
    for length in (640, 1024):
        add(f"ledge_{length}", "straight",
            [{"type": "straight", "length": length, "open": True}],
            weight=8, flags=F_OPEN)

    # -- turns: what keeps a route inside its lane ---------------------------
    for d, ds in (("left", "l"), ("right", "r")):
        for angle, radii in ((45, (384, 768)), (90, (320, 576, 1024)),
                             (135, (448, 768)), (180, (576, 896))):
            for r in radii:
                add(f"turn_{ds}{angle}_{r}", "turn",
                    [{"type": "turn", "direction": d, "angle": angle, "radius": r}],
                    weight=20 if angle <= 90 else 10)
        add(f"sweep_{ds}90", "turn",
            [{"type": "turn", "direction": d, "angle": 90, "radius": 768,
              "open": True}], weight=7, flags=F_OPEN)

    # -- ramps ---------------------------------------------------------------
    for length, rise in ((512, 192), (768, 256), (1024, 384),
                         (512, -192), (768, -256), (1024, -384)):
        add(f"{'climb' if rise > 0 else 'dive'}_{abs(rise)}", "ramp",
            [{"type": "ramp", "length": length, "rise": rise}], weight=12)

    # -- gaps: a pit to jump, each with its own run-up and landing -----------
    for drop in (0, 128, 256, 384, 512):
        add(f"gap_{drop}", "gap",
            [{"type": "straight", "length": APRON},
             {"type": "gap", "length": _gap_len(drop), "drop": drop},
             {"type": "straight", "length": LAND_APRON}], weight=14)
    for drop in (128, 384):
        add(f"leap_{drop}", "gap",
            [{"type": "straight", "length": APRON},
             {"type": "gap", "length": _gap_len(drop), "drop": drop, "open": True},
             {"type": "straight", "length": LAND_APRON}], weight=8, flags=F_OPEN)

    # -- corridor shapes ----------------------------------------------------
    for count in (3, 5, 7):
        add(f"slalom_{count}", "slalom",
            [{"type": "slalom", "length": specmod.SLALOM_SPACING * (count + 1),
              "count": count}], weight=10)
    for bw in (64, 128, 224):
        add(f"beam_{bw}", "beam",
            [{"type": "straight", "length": 192},
             {"type": "beam", "length": 768, "beam_width": bw},
             {"type": "straight", "length": 192}], weight=9, flags=F_OPEN)
    for d, ds in (("left", "l"), ("right", "r")):
        for count in (1, 2, 3):
            add(f"split_{ds}{count}", "split",
                [{"type": "split", "length": specmod.split_min_length(count),
                  "direction": d, "count": count}], weight=7, flags=F_OPEN)

    # -- the special moves ---------------------------------------------------
    lo, hi = specmod.WALLCLIMB_RISE
    for d, ds in (("left", "l"), ("right", "r")):
        for rise in (lo + 4, (lo + hi) // 2, hi - 2):
            add(f"wallclimb_{ds}{rise}", "wallclimb",
                [{"type": "straight", "length": WALL_APRON},
                 {"type": "wallclimb", "length": specmod.WALLCLIMB_MIN,
                  "rise": rise, "direction": d},
                 {"type": "straight", "length": APRON}],
                weight=6, flags=F_WALLJUMP | F_OPEN)
        for drop in specmod.WALLGAP_DROP:
            add(f"wallgap_{ds}{abs(drop)}", "wallgap",
                [{"type": "straight", "length": WALL_APRON},
                 {"type": "wallgap", "length": _wallgap_len(drop), "drop": drop,
                  "direction": d},
                 {"type": "straight", "length": LAND_APRON}],
                weight=6, flags=F_WALLJUMP | F_OPEN)
    for drop in (specmod.DASH_DROP[0], 640, specmod.DASH_DROP[1]):
        add(f"dash_{drop}", "dash",
            [{"type": "straight", "length": APRON},
             {"type": "dash", "length": _dash_len(drop), "drop": drop},
             {"type": "straight", "length": LAND_APRON}],
            weight=6, flags=F_DASH | F_OPEN)

    # -- combinations: two features in one tile, for routes that read as
    # designed rather than as a shuffled list of parts --------------------
    add("climb_turn_l", "combo",
        [{"type": "ramp", "length": 768, "rise": 256},
         {"type": "turn", "direction": "left", "angle": 90, "radius": 576}], weight=9)
    add("climb_turn_r", "combo",
        [{"type": "ramp", "length": 768, "rise": 256},
         {"type": "turn", "direction": "right", "angle": 90, "radius": 576}], weight=9)
    add("dive_turn_l", "combo",
        [{"type": "turn", "direction": "left", "angle": 90, "radius": 576},
         {"type": "ramp", "length": 768, "rise": -256}], weight=9)
    add("dive_turn_r", "combo",
        [{"type": "turn", "direction": "right", "angle": 90, "radius": 576},
         {"type": "ramp", "length": 768, "rise": -256}], weight=9)
    add("gap_turn_l", "combo",
        [{"type": "straight", "length": APRON},
         {"type": "gap", "length": _gap_len(256), "drop": 256},
         {"type": "turn", "direction": "left", "angle": 45, "radius": 576}], weight=8)
    add("gap_turn_r", "combo",
        [{"type": "straight", "length": APRON},
         {"type": "gap", "length": _gap_len(256), "drop": 256},
         {"type": "turn", "direction": "right", "angle": 45, "radius": 576}], weight=8)
    add("slalom_turn_l", "combo",
        [{"type": "slalom", "length": specmod.SLALOM_SPACING * 4, "count": 3},
         {"type": "turn", "direction": "left", "angle": 90, "radius": 448}], weight=7)
    add("slalom_turn_r", "combo",
        [{"type": "slalom", "length": specmod.SLALOM_SPACING * 4, "count": 3},
         {"type": "turn", "direction": "right", "angle": 90, "radius": 448}], weight=7)
    add("stair_down", "combo",
        [{"type": "straight", "length": APRON},
         {"type": "gap", "length": _gap_len(192), "drop": 192},
         {"type": "straight", "length": LAND_APRON},
         {"type": "gap", "length": _gap_len(192), "drop": 192},
         {"type": "straight", "length": LAND_APRON}], weight=8)
    add("switchback_l", "combo",
        [{"type": "straight", "length": 384},
         {"type": "turn", "direction": "left", "angle": 180, "radius": 576},
         {"type": "straight", "length": 384}], weight=6)
    add("switchback_r", "combo",
        [{"type": "straight", "length": 384},
         {"type": "turn", "direction": "right", "angle": 180, "radius": 576},
         {"type": "straight", "length": 384}], weight=6)
    return R


# The gate: one trigger-shaped box the dealer re-uses for both the start and
# the finish line. It is a brush entity purely so the compiler emits an inline
# model for it; the entity itself is freed at spawn like every tile's.
GATE_NAME = "__gate__"

DECK_BRUSH_MAX = 4000


class Deck:
    def __init__(self, name, title):
        self.name = name
        self.title = title
        self.course = layout.Course({"name": name, "title": title,
                                     "width": TILE_WIDTH, "segments": []})
        self.tiles = []
        self.gate = None
        # name -> inline model index, filled in from the COMPILED bsp.
        self.models = {}


def _slab(cx, cy, hx, hy, zlo, zhi, tex, heading=None):
    return Prism.flat([(cx - hx, cy - hy), (cx + hx, cy - hy),
                       (cx + hx, cy + hy), (cx - hx, cy + hy)], zlo, zhi, tex, heading)


def _place(deck, name, prisms, dx, dy, dz, extra=None):
    """Emit one brush entity holding `prisms` moved by (dx, dy, dz).

    The "origin" key is the point the tile's LOCAL origin lands on. q3map2
    subtracts it from every brush, so the compiled inline model is expressed in
    the tile's own frame — which is what makes `ent.origin = somewhere` place
    the tile's entry there, and `ent.angles` turn it about its entry rather than
    about a point thousands of units away.

    _castShadows / _receiveShadows are off so a tile's lightmap does not depend
    on which slot it happened to be compiled in: a dealt tile has to look the
    same wherever the dealer puts it.

    That decision is also what makes _lightmapscale affordable. With no shadows
    to resolve, a tile's lightmap holds one near-constant value per surface, so
    coarse luxels lose nothing — and at the default scale the deck's 1,287
    brushes compile to a 21 MB lightmap that every player would download.
    """
    keys = {"classname": "mg_tile", "mg_name": name,
            "origin": (dx, dy, dz),
            "_castShadows": 0, "_receiveShadows": 0,
            "_lightmapscale": LIGHTMAP_SCALE}
    if extra:
        keys.update(extra)
    deck.course.entities.append((keys, [translate(p, dx, dy, dz) for p in prisms]))


def build_deck(name, title):
    """Lay every tile, park it in the compile grid, and seal the lanes it will
    be dealt into inside one sky shell."""
    deck = Deck(name, title)
    deck.tiles = [lay(r) for r in catalogue()]

    brushes = sum(len(t.prisms) for t in deck.tiles)
    if brushes > DECK_BRUSH_MAX:
        raise layout.LayoutError([f"the deck needs {brushes} brushes; at most "
                                  f"{DECK_BRUSH_MAX} (drop tiles or tighten the turns)"])

    # -- the compile grid. Each cell holds one tile, centred by its BOUNDS
    # rather than by its entry, so a 180-degree turn that reaches 1,800 units
    # sideways does not lean into its neighbour's cell and shadow it.
    cols = int(math.ceil(math.sqrt(len(deck.tiles) + 1)))
    rows = int(math.ceil((len(deck.tiles) + 1) / cols))
    x0 = -(cols - 1) * SLOT_PITCH / 2.0
    y0 = -(rows - 1) * SLOT_PITCH / 2.0
    widest = max(t.span() for t in deck.tiles)
    if widest + 512 > SLOT_PITCH:
        raise layout.LayoutError([f"a tile spans {int(widest)} units, too wide for the "
                                  f"{SLOT_PITCH}-unit compile grid"])
    for i, t in enumerate(deck.tiles):
        cx = x0 + (i % cols) * SLOT_PITCH
        cy = y0 + (i // cols) * SLOT_PITCH
        t.slot = (cx - (t.mins[0] + t.maxs[0]) / 2.0,
                  cy - (t.mins[1] + t.maxs[1]) / 2.0,
                  SLOT_Z - t.mins[2])
        _place(deck, t.name, t.prisms, *t.slot)

    # The gate shares the grid: one more cell at the end.
    half = TILE_WIDTH / 2.0 + layout.WALL_THICK
    deck.gate = _slab(0, 0, GATE_DEPTH / 2.0, half, 0, GATE_HEIGHT, "trigger")
    i = len(deck.tiles)
    _place(deck, GATE_NAME, [deck.gate],
           x0 + (i % cols) * SLOT_PITCH, y0 + (i // cols) * SLOT_PITCH, SLOT_Z)

    # -- the lobby: somewhere to stand for the frame before the first deal, and
    # the fallback if the manifest ever fails to load.
    deck.course.world.append(_slab(0, LOBBY_Y, LOBBY_HALF, LOBBY_HALF, -32, 0, "start", 90))
    deck.course.floor_polys.append((deck.course.world[-1].poly, "start"))
    deck.course.entities.append(({"classname": "info_player_deathmatch",
                                  "origin": (0.0, LOBBY_Y, 40.0), "angle": 90}, []))

    # -- the pit under every lane. Leaving a dealt route is the same mistake as
    # leaving any race map's: trigger_hurt, and the racemod respawns you.
    deck.course.entities.append((
        {"classname": "trigger_hurt", "dmg": 9999},
        [_slab(0, 0, PLAY_HALF, PLAY_HALF, PIT_TOP - PIT_THICK, PIT_TOP, "trigger")]))

    _shell(deck, x0, y0)
    return deck


def _shell(deck, x0, y0):
    """Seal everything in a sky box. q3map2 refuses to vis or light a leaking
    hull, and the player must always be inside a real leaf — so the shell has
    to contain the lanes, the compile grid and the lobby all at once."""
    # The grid runs from x0 to -x0; half a cell more covers each tile's own
    # half-span, which _place centred on its cell.
    gx = abs(x0) + SLOT_PITCH / 2.0
    gy = abs(y0) + SLOT_PITCH / 2.0
    m = SHELL_MARGIN
    x1 = max(PLAY_HALF, gx) + m
    y1 = max(PLAY_HALF, gy, abs(LOBBY_Y) + LOBBY_HALF) + m
    z0 = PIT_TOP - PIT_THICK - m
    z1 = SLOT_Z + 1024 + m
    T = 16
    deck.course.world += [
        _slab(0, 0, x1 + T, y1 + T, z0 - T, z0, "sky"),
        _slab(0, 0, x1 + T, y1 + T, z1, z1 + T, "sky"),
        _slab(-(x1 + T / 2.0), 0, T / 2.0, y1, z0, z1, "sky"),
        _slab(x1 + T / 2.0, 0, T / 2.0, y1, z0, z1, "sky"),
        _slab(0, -(y1 + T / 2.0), x1 + T, T / 2.0, z0, z1, "sky"),
        _slab(0, y1 + T / 2.0, x1 + T, T / 2.0, z0, z1, "sky"),
    ]
    deck.course.bounds = ((-x1, -y1, z0), (x1, y1, z1))
    # q3map2 splits the world tree on a grid of _blocksize (1024 by default).
    # For a course that grid does real work; for one 31k x 35k empty arena it
    # produces ~9,800 portal clusters that every other cluster can see — an
    # 11.8 MB visibility lump carrying no information at all. Off.
    deck.course.worldspawn["_blocksize"] = "0 0 0"
    # Likewise the light grid, which is what lights PLAYERS and models rather
    # than surfaces: at the default 64 x 64 x 128 an arena this size is
    # 17 million cells. The arena is uniformly lit, so coarse costs nothing.
    # ("gridsize" is the name q3map2 reads; "_lightgridsize" is Radiant's alias
    # and this build ignores it.)
    deck.course.worldspawn["gridsize"] = "512 512 512"
    # And the surface lightmaps. _lightmapscale is set per tile in _place, but
    # worldspawn's is what the shell and the lobby use.
    deck.course.worldspawn["_lightmapscale"] = LIGHTMAP_SCALE


def manifest(deck):
    """The text the dealer reads (hrace/metamap.as, via G_LoadFile).

    Whitespace-separated tokens with // comments, because AngelScript's
    String::getToken is COM_Parse, which understands exactly that. Model
    indices come from deck.models, read back out of the compiled bsp — never
    predicted from the order entities were written.
    """
    missing = [t.name for t in deck.tiles if t.name not in deck.models]
    if GATE_NAME not in deck.models:
        missing.append(GATE_NAME)
    if missing:
        raise layout.LayoutError(
            ["the compiler did not keep an inline model for: " + ", ".join(missing)])

    f = mapfile._fmt
    out = [
        f"// racesow tile deck for {deck.name} — generated by tools/mapgen/tiles.py.",
        "// Read by server/racemod .../hrace/metamap.as. Geometry is in the .bsp;",
        "// these are the numbers needed to fit one tile onto the next.",
        f"deck 1 {len(deck.tiles)} {TILE_WIDTH}",
        f"play {f(PLAY_HALF)} {PLAY_UP} {PLAY_DOWN}",
        f"gate {deck.models[GATE_NAME]} {GATE_DEPTH} {f(TILE_WIDTH / 2.0 + layout.WALL_THICK)} "
        f"{GATE_HEIGHT}",
        "// tile <model> <flags> <weight> <fwd> <lat> <rise> <yaw>"
        " <minx> <miny> <minz> <maxx> <maxy> <maxz> <route> <kind> <name>",
    ]
    for t in deck.tiles:
        out.append("tile {} {} {} {} {} {} {} {} {} {} {} {} {} {} {} {}".format(
            deck.models[t.name], t.flags, t.weight,
            f(t.fwd), f(t.lat), f(t.rise), f(t.yaw),
            f(t.mins[0]), f(t.mins[1]), f(t.mins[2]),
            f(t.maxs[0]), f(t.maxs[1]), f(t.maxs[2]),
            f(t.route), t.kind, t.name))
    return "\n".join(out) + "\n"
