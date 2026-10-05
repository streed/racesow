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
loads is a sealed arena holding one permanent platform, and every other piece
of floor they run on is an entity the dealer created.

Layout of the compiled map
--------------------------
    play    one big empty box. A server deals ONE route from ONE seed and
            every player on it races that same route together, so there is no
            per-player geometry to keep apart — and a seed on a leaderboard
            means something, because it names a course other people can run.
    pad     the start platform: worldspawn, at a fixed place in the play box,
            with the map's one spawn point standing on it. It is the only floor
            in there that is not dealt, which is the whole reason it exists — a
            player stands on solid ground before any gametype code runs, and
            still does when the deck fails to load and nothing is ever dealt.
            The dealt route begins at the platform's far end, which the
            manifest publishes so the dealer hard-codes none of this.
    slots   a grid well above the play box holding every tile at the position
            it was compiled and lit. Nothing renders or collides here.
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

It also publishes the footprint of every walkable surface in every tile,
which the dealer never reads: that is for drawing a PLAN of a seed's route
outside the game. Taking the shapes from the same file the servers read is
what stops a preview and a server disagreeing about what a seed looks like.

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

# Tile flags, mirrored by META_F_* in hrace/metamap.as and by DECK_FLAGS in
# web/random-deck.js — by VALUE, so no bit here can be renumbered or recycled
# without changing what an already-deployed reader thinks a tile is.
F_OPEN = 1        # no side walls: the player can leave it sideways
F_DASH = 2        # needs the dash
F_WALLJUMP = 4    # needs a wall jump
# 8 was F_START, from when the start pad was dealt like any other piece. The
# platform is worldspawn now (_start_pad), so no tile carries it and the bit
# stays retired rather than being reused: a reader that still knows bit 8 would
# deal whatever wore it from the play box origin, straight through the platform.
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

# -- the start platform ------------------------------------------------------
# How long the permanent platform is, which is also how far along +X the dealt
# route begins: the dealer's cursor starts at the platform's far end.
#
# 341 is a third of the 1024 this used to be, and the reason it moved is the
# prejump rule. A start is rejected when a player arrives at the gate having
# taken more than one jump, dash or walljump since they were last on the ground
# under 325 ups (RS_QueryPjState, warfork/enginepatches/gs_racesow.c, reset in
# PM_Move's grounded branch). Nothing about that rule mentions distance — but a
# hop cycle at the ground cap covers about 260 units, so 1024 handed a player
# room for three of them, and the second one is already a restart. Starting
# from the spawn and running the platform the way the platform invites was
# ALWAYS a "Prejumped!" and a respawn back to x=96. 341 leaves room for one
# jump and no more.
#
# The floor under it: the gate's near face stands at PAD_LEN - GATE_DEPTH/2 and
# a player's box reaches x=112 at the spawn, so the real run-up is
# PAD_LEN - 128. physics.MIN_RUNUP is 192 units to reach the 320 ups ground
# cap, which puts the smallest honest platform at 320; 341 gives 213. Below 129
# the gate's trigger wraps the spawn and the clock starts on spawn at zero
# speed, and below 112 the player's box hangs off the lip (_spawn_rests_on only
# checks the spawn POINT, so it catches neither — it refuses at 95).
#
# What changing it costs, because it is not free: the route's origin IS the
# platform's far end, so every other value slides every dealt route down the
# play box and re-rolls the weighted draw. A seed already sitting on the
# random_run board names a DIFFERENT course after a change here (measured at
# this one: 241 of 340 golden seeds deal a different piece sequence), and every
# stored route_units is a length off the old run-up. Move this number only with
# that board in hand. Nothing after the platform leans on the length itself —
# the mating contract makes every dealt piece carry its own entry apron.
PAD_LEN = 341
# Not a tile name, and never a key in deck.models: the platform is worldspawn,
# so the compiler leaves it no inline model to be placed by.
PAD_NAME = "__pad__"

# Where a player spawns: on the platform, 8 units above its floor. The platform
# runs from the play box's origin along +X with its walking surface at z = 0
# (_start_pad), a player's origin sits 24 units above their feet
# (physics.PLAYER_MINS), and x = 96 is clear of the wall across the back.
# _spawn_rests_on checks that arithmetic at build time instead of trusting it.
SPAWN = (96.0, 0.0, 32.0)

SHELL_MARGIN = 768
# Luxels per tile surface, indirectly: q3map2's default is one per 16 units,
# and this multiplies that. See _place for why coarse is free here.
LIGHTMAP_SCALE = 8
# Half-extent of the origin brush that marks a tile's entry. Small enough to
# sit inside the entry apron's floor slab, big enough that no snapping moves
# its centre off the entry point.
ORIGIN_BRUSH = 16
GATE_HEIGHT = layout.TRIGGER_HEIGHT
GATE_DEPTH = 32


class Tile:
    """One dealt-able piece: its brushes in the tile's own local frame, and the
    transform that carries the cursor from its entry to its exit.

    The start platform is built as one of these too — see PAD_RECIPE — purely
    for that arithmetic. It is the one that is never dealt."""

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


def _start_pad(w):
    """The run-up every route begins on: level floor, start-coloured, with a
    wall across the back so a player cannot run off behind the spawn. The
    dealer puts the start gate at the far end, so the clock starts the moment
    the player leaves the platform.

    This is the old `start` tile's body unchanged — the shape was never the
    problem, where it lived was. build_deck puts these brushes into WORLDSPAWN
    rather than into an mg_tile entity, so the floor under the spawn is part of
    the .bsp's own tree: solid and lit before any gametype code runs.
    """
    w.seg = 0
    w.end_wall(behind=True)
    w.box_run(PAD_LEN, tex="start")


# The platform goes through lay() even though it is not a tile, because lay()
# is where the mating contract's arithmetic lives: the bounds a dealt piece has
# to keep clear of, and the exit cursor that BECOMES the route's origin, are
# then computed by exactly the code that computes them for the pieces that must
# fit onto it. A lay()-built piece's frame has its origin at (0, 0, 0) and
# heading 0, which for the platform is not a local frame at all — it is the
# play box's own — so the prisms go into the world untranslated and every
# number the manifest publishes about the platform is read straight off the
# Tile.
PAD_RECIPE = {"name": PAD_NAME, "kind": "pad", "build": _start_pad, "weight": 0}


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

    # -- the one fixed end ---------------------------------------------------
    # Only the finish is a tile. The start platform cannot move, so it is not
    # dealt and is not in the deck at all (_start_pad, build_deck); the finish
    # has to land wherever the route ran out, so it still travels with it.
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
        self.pad = None       # the start platform, laid straight into worldspawn
        self.gate = None
        # name -> inline model index, filled in from the COMPILED bsp.
        self.models = {}
        # Short content hash naming the pk3 FILE this deck is packed into
        # (build.deck_version); the map inside keeps `name`.
        self.version = ""


def _slab(cx, cy, hx, hy, zlo, zhi, tex, heading=None):
    return Prism.flat([(cx - hx, cy - hy), (cx + hx, cy - hy),
                       (cx + hx, cy + hy), (cx - hx, cy + hy)], zlo, zhi, tex, heading)


def _place(deck, name, prisms, dx, dy, dz, extra=None):
    """Emit one brush entity holding `prisms` moved by (dx, dy, dz), with an
    ORIGIN BRUSH marking the tile's entry.

    That brush is the whole trick, and it is the one thing here that had to be
    measured rather than reasoned about. q3map2 takes the centre of a brush
    wearing the origin shader as the entity's origin, subtracts it from the
    entity's other brushes and drops it, so the compiled inline model comes out
    expressed around the tile's own entry point. THAT is what makes
    `ent.origin = somewhere` put the tile's entry there and `ent.angles` turn
    the tile about its entry instead of about a point thousands of units away.

    An "origin" KEY does not do this. The first version of this file set the
    key and no brush, on the strength of func_bobbing entities in the map pool
    whose submodels are plainly relative — but those carry origin brushes, and
    q3map2 WRITES the key from them. A key alone left every tile's collision
    and geometry parked in the compile grid, 4,600 units up, so the dealer
    built routes nobody could reach. Setting both is worse than either: q3map2
    adds the key to the brush-derived origin and the tile lands at double the
    offset.

    _castShadows / _receiveShadows are off so a tile's lightmap does not depend
    on which slot it happened to be compiled in: a dealt tile has to look the
    same wherever the dealer puts it.

    That decision is also what makes _lightmapscale affordable. With no shadows
    to resolve, a tile's lightmap holds one near-constant value per surface, so
    coarse luxels lose nothing — and at the default scale the deck's 1,287
    brushes compile to a 21 MB lightmap that every player would download.
    """
    keys = {"classname": "mg_tile", "mg_name": name,
            "_castShadows": 0, "_receiveShadows": 0,
            "_lightmapscale": LIGHTMAP_SCALE}
    if extra:
        keys.update(extra)
    brushes = [translate(p, dx, dy, dz) for p in prisms]
    brushes.append(_slab(dx, dy, ORIGIN_BRUSH, ORIGIN_BRUSH,
                         dz - ORIGIN_BRUSH, dz + ORIGIN_BRUSH, "origin"))
    deck.course.entities.append((keys, brushes))


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

    # -- the start platform, in WORLDSPAWN.
    #
    # This is the point of the whole arrangement. Three separate rounds of "the
    # player is not on the start platform" came out of a spawn whose floor only
    # existed if GT_SpawnGametype had run AND the manifest had loaded AND the
    # dealer had managed to place a piece. World geometry cannot fail to arrive.
    deck.pad = lay(PAD_RECIPE)
    deck.course.world += deck.pad.prisms

    # -- the spawn point, ON the platform.
    #
    # The first version put the spawn in a lobby off to the side and had the
    # gametype move the player onto the route; that move silently does nothing
    # on the FIRST spawn after a map change, because Entity.origin only writes
    # a client's pmove origin once the client reaches CS_SPAWNED
    # (g_ascript.cpp, objectGameEntity_SetOrigin) — so the player stood in the
    # lobby. Spawning where the floor is needs no move at all, and skips the
    # one-frame jump across the arena that a think-loop fix leaves behind.
    #
    # spawnflags 1 is belt-and-braces now; it used to be load-bearing.
    # SP_info_player_deathmatch calls G_DropSpawnpointToFloor
    # (game/g_utils.cpp:1927), which traces 16,000 units DOWN from the spawn and
    # puts it on whatever it hits, during entity spawn — before GT_SpawnGametype
    # deals anything. With the pad dealt there was no floor under the spawn yet,
    # so the trace fell all the way to the sky shell and the spawn was
    # permanently relocated ~3,300 units below where the pad was about to
    # appear. Now the trace lands on the platform and the drop would be
    # correct — trace.endpos plus one unit of plane normal, so z = 25 instead of
    # 32 (g_utils.cpp:1950). The flag is kept for the two smaller reasons: it
    # holds the spawn exactly where SPAWN says it is, which is what lets the
    # manifest's `spawn` line and RACE_MetaCheckStartPad's 8-unit drift test
    # describe the entity the engine actually has rather than one 7 units below
    # it; and it costs nothing, because the check that still matters comes
    # FIRST — a spawn inside solid is FREED at g_utils.cpp:1941, and the flag
    # only returns at :1945, after that.
    _spawn_rests_on(deck.pad)
    deck.course.entities.append(({"classname": "info_player_deathmatch",
                                  "origin": SPAWN, "angle": deck.pad.yaw,
                                  "spawnflags": 1}, []))

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
    y1 = max(PLAY_HALF, gy) + m
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


# The walkable surfaces: the texture roles a player can stand on. wall, pylon,
# sky, trigger and origin are geometry they only ever run past, and publishing
# those would fill a plan in solid instead of drawing the route through it.
FLOOR_TEX = ("floor", "start", "finish", "checkpoint", "edge", "trim",
             "platform", "beam")


def floor_faces(tile):
    """A tile's walkable prisms, in the tile's own frame. Whole footprints, not
    top faces: a prism IS its footprint extruded, so a floor slab and the trim
    along its lip each contribute one polygon, which is what gives a plan its
    edges."""
    return [p for p in tile.prisms if p.tex in FLOOR_TEX]


def _over(poly, x, y, eps=1e-6):
    """Is (x, y) on this footprint? Every polygon layout lays down is convex and
    wound counter-clockwise (layout._rect, and the turn wedges built from it),
    so "left of every edge" is the whole test."""
    for i, (x1, y1) in enumerate(poly):
        x2, y2 = poly[(i + 1) % len(poly)]
        if (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1) < -eps:
            return False
    return True


def _floor_under(piece, x, y):
    """The highest walkable top plane over (x, y), or None if there is no
    walkable surface there at all."""
    tops = [p.top_at(x, y) for p in floor_faces(piece) if _over(p.poly, x, y)]
    return max(tops) if tops else None


def _spawn_rests_on(pad):
    """SPAWN, PAD_LEN and layout's own floor thickness are separate numbers that
    have to agree, and the way they disagree is silent: the map compiles, the
    platform is there, and the player is standing beside it or inside it. So
    they are checked here rather than left to whoever edits one of them next."""
    top = _floor_under(pad, SPAWN[0], SPAWN[1])
    if top is None:
        raise layout.LayoutError([f"the spawn at {SPAWN[0]:g}, {SPAWN[1]:g} is not over "
                                  f"the start platform's floor"])
    # The player's feet relative to the surface: on it, or at most one step
    # above. Below it is a spawn inside solid, which G_DropSpawnpointToFloor
    # FREES outright (game/g_utils.cpp:1941) leaving the map with no spawn at
    # all; well above it is a drop on arrival, which reads as a bug.
    feet = SPAWN[2] + physics.PLAYER_MINS[2] - top
    if not 0.0 <= feet <= physics.STEP_SIZE:
        raise layout.LayoutError([f"the spawn stands {feet:.0f} units over the start "
                                  f"platform; it has to be between 0 and "
                                  f"{physics.STEP_SIZE:.0f}"])


def manifest(deck):
    """The text the dealer reads (hrace/metamap.as, via G_LoadFile).

    Whitespace-separated tokens with // comments, because AngelScript's
    String::getToken is COM_Parse, which understands exactly that. Model
    indices come from deck.models, read back out of the compiled bsp — never
    predicted from the order entities were written.

    Three blocks: what the permanent start platform is and where it hands over
    to the dealt route, then the `tile` lines the dealer fits together, then the
    `face` lines that say what each tile LOOKS like.

    RACE_MetaLoadDeck's head dispatch is a plain if/else-if chain ending at
    `tile` with NO trailing else (metamap.as:222-268), so a head it does not
    know costs one getToken and is skipped in silence; web/random-deck.js copies
    that deliberately. That is the licence for `face`, and it is what lets
    `pad`, `begin`, `spawn` and `padface` be added to a grammar servers in the
    field already read. The `deck` version stays 1 for the same reason: a bump
    is the ONE thing an old reader does not ignore (it is a fatal version error
    and it deals nothing), and nothing here changes the meaning of a token any
    old reader uses.
    """
    missing = [t.name for t in deck.tiles if t.name not in deck.models]
    if GATE_NAME not in deck.models:
        missing.append(GATE_NAME)
    if missing:
        raise layout.LayoutError(
            ["the compiler did not keep an inline model for: " + ", ".join(missing)])

    pad = deck.pad
    if pad is None:
        raise layout.LayoutError(["the deck has no start platform"])
    # Where the route begins is the platform's exit, which lay() has already
    # worked out; the platform's frame IS the world frame, so that exit is a
    # world point. The heading goes out in the dealer's own unit, an eighth of a
    # circle (META_STEP_DEG), because that lattice is what its heading table is
    # indexed by — a yaw in degrees would only be rounded back to this.
    step = int(round(pad.yaw / 45.0)) % 8

    f = mapfile._fmt
    out = [
        f"// racesow tile deck for {deck.name} — generated by tools/mapgen/tiles.py.",
        "// Read by server/racemod .../hrace/metamap.as. Geometry is in the .bsp;",
        "// these are the numbers needed to fit one tile onto the next.",
        f"deck 1 {len(deck.tiles)} {TILE_WIDTH}",
        f"play {f(PLAY_HALF)} {PLAY_UP} {PLAY_DOWN}",
        f"gate {deck.models[GATE_NAME]} {GATE_DEPTH} {f(TILE_WIDTH / 2.0 + layout.WALL_THICK)} "
        f"{GATE_HEIGHT}",
        "",
        "// The start platform. It is WORLDSPAWN rather than a dealt piece, so it",
        "// has no inline model and cannot be a tile row — and it is the one piece",
        "// of floor in the play box that is there whether or not the dealer ran.",
        "// Every number below is already in world units: it never moves, and it",
        "// never turns.",
        "//",
        "// `pad` is its box, and the dealer needs it because the platform",
        "// occupies space a later piece must not be dealt into. A route that",
        "// folded back over its own start used to be stopped by the start TILE",
        "// sitting in the dealer's placed list; nothing stops it now unless this",
        "// box is seeded there. Walls included: it is the space, not the floor.",
        "// pad <minx> <miny> <minz> <maxx> <maxy> <maxz>",
        f"pad {f(pad.mins[0])} {f(pad.mins[1])} {f(pad.mins[2])} "
        f"{f(pad.maxs[0])} {f(pad.maxs[1])} {f(pad.maxs[2])}",
        "// Where the dealt route starts and which way it faces: the platform's",
        "// far end, as a point and a 45-degree step. The dealer's first placement",
        "// goes there and the start gate sits on it, so the clock starts when the",
        "// player leaves the platform. It is exactly on the box's far face, so",
        "// that first piece touches the platform without overlapping it. The",
        "// platform's own run-up is this point's distance from the origin, for a",
        "// dealer that wants to count it toward the route's length.",
        "// begin <x> <y> <z> <step>",
        f"begin {f(pad.fwd)} {f(pad.lat)} {f(pad.rise)} {step}",
        "// The map's own info_player_deathmatch, which stands on the platform.",
        "// Published so that putting a player back on the platform — on joining,",
        "// on /kill, after a re-deal — needs no second copy of this number",
        "// compiled into the gametype.",
        "// spawn <x> <y> <z> <step>",
        f"spawn {f(SPAWN[0])} {f(SPAWN[1])} {f(SPAWN[2])} {step}",
        "// ...and the platform's walkable footprint, so a plan still draws the",
        "// start now that it is not a tile. A `face` line without the model",
        "// index, kept apart from the face block below because those points are",
        "// in their tile's own frame for a plan to turn and move, and these are",
        "// already in the world's.",
        "// padface <tex> <top> <points> <x> <y> ... (<points> pairs)",
    ]
    for p in floor_faces(pad):
        out.append("padface {} {} {} {}".format(
            p.tex, round(p.zmax()), len(p.poly),
            " ".join(f"{round(x)} {round(y)}" for x, y in p.poly)))

    out += [
        "",
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

    out += [
        "",
        "// Walkable footprints, for drawing a plan of a dealt route away from the",
        "// game. The dealer needs none of them — a tile's box is all it takes to",
        "// fit one piece onto the next. Points are in the TILE'S OWN frame (entry",
        "// at the origin, running +X, walking surface at z = 0), so a plan turns",
        "// and moves them the way the engine turns and moves the tile's model.",
        "// face <model> <tex> <top> <points> <x> <y> ... (<points> pairs)",
    ]
    for t in deck.tiles:
        for p in floor_faces(t):
            # Whole units. The smallest face in the deck is 98 across and a plan
            # draws a 6,000-unit route a few hundred pixels wide, so half a unit
            # is invisible — and this file ships inside every copy of the pack.
            # `top` is the top plane's HIGHEST point: a ramp's top is a plane and
            # not a height, and a plan shades by it rather than measuring from it.
            out.append("face {} {} {} {} {}".format(
                deck.models[t.name], p.tex, round(p.zmax()), len(p.poly),
                " ".join(f"{round(x)} {round(y)}" for x, y in p.poly)))
    return "\n".join(out) + "\n"
