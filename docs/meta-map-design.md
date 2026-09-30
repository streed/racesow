# The meta map: a course that builds itself

`random_map` is a map that does not exist until someone plays it. The server
**deals** a course out of pre-built pieces — a few pieces ahead of whoever is
furthest along — and stops when the route is long enough. Everyone on the
server races the same route, because the whole course comes from one number: a
seed.

Status (2026-09-29): **built**. `tools/mapgen/tiles.py` compiles the deck,
`server/racemod/.../hrace/metamap.as` deals it, and finished runs land on a
seed board at `/random` rather than on any leaderboard.

## The problem, and the one fact that solves it

The engine cannot make geometry after a map loads. A BSP's collision hulls,
vis tree and lightmaps are all baked by the compiler; nothing in AngelScript
or the game module can add a brush at runtime. So a course that "builds
itself" cannot generate anything — it can only **move pieces that were
compiled in advance.**

Four engine facts make that work, each checked against the qfusion source
(and, for the first, against the 4,257-pack map pool):

1. **A brush entity with an `origin` key is compiled relative to that origin.**
   q3map2's `ParseMapEntity` → `AdjustBrushesForOrigin` subtracts it, so the
   inline model's coordinates are expressed in the *tile's own frame*. This is
   what lets `ent.angles` turn a tile about its own entry point instead of
   about whatever far-away spot it happened to be compiled at.
2. **A script can point an entity at any inline model.**
   `Entity.setupModel("*7")` reaches `GClip_SetBrushModel` (`game/g_clip.cpp:981`),
   which resolves the model, takes its bounds and links the entity;
   `GClip_LinkEntity` then stamps `s.solid = SOLID_BMODEL`
   (`game/g_clip.cpp:552-557`).
3. **The client predicts it.** `CG_ClipMoveToEntities` pulls
   `trap_CM_InlineModel(ent->modelindex)` and runs a transformed box trace
   against the entity's origin *and angles* (`cgame/cg_predict.cpp:261-280`).
   A dealt tile is not a moving platform you fight — strafing on it feels
   exactly like strafing on the world.
4. **Brush models are not PVS-culled when drawn.** `R_AddBrushModelToDrawList`
   passes `pvsCull = false` (`ref_gl/r_surf.c:443`), so a tile renders wherever
   it is put, carrying the lightmap baked at the slot it was compiled in.

The corollary that shapes everything else: **a submodel's surfaces are not part
of worldspawn, so an inline model nothing references is invisible and
non-solid.** The compiled deck is a dormant library. The map a player loads is
an empty sealed arena, and every piece of floor they run on is an entity the
dealer created.

## The deck

`tools/mapgen/tiles.py` lays 78 pieces — straights, turns at four angles and
several radii, ramps up and down, gaps, slaloms, beams, splits, wall climbs,
wall-kick gaps, dashes, and two-feature combinations — using the *same piece
builders* `layout.py` already uses for a written spec. That is the reason the
deck is only a few hundred lines: a tile is a one-to-five-segment course laid
by a bare `_Walker`, so every physics guarantee mapgen already makes (a gap
clearable from a 320 ups run-up, a landing on real floor, a piece that does
not run through itself) applies to a tile unchanged.

Every tile obeys one **mating contract**, which is what lets any tile follow
any other:

> A tile ENTERS at its local origin running along +X on level, full-width,
> walled floor, and EXITS on level, full-width floor. Anything with a run-up
> requirement carries that run-up inside itself.

That last clause matters: a gap tile begins with its own 256-unit apron and a
wall-kick tile with a 384-unit one, so a tile is never unfair because of what
happened to precede it.

Two more properties are enforced by tests rather than by hope:

- **Turns are whole 45-degree steps.** The dealer carries the route's heading
  as an index into an exact sin/cos table, not as an accumulating float. A
  tile turning by anything else would drift the route off the lattice and open
  a seam at every join after it.
- **Every piece keeps its inline model through compilation.** A tile folded
  into worldspawn is one the dealer cannot place *and* one that stays visible,
  parked in the compile grid, forever. `build.check_deck_bsp` reads the
  compiled entity lump back and fails the build if any piece lost its model.

### Layout of the compiled map

```
  play    one big empty box, +/-13312 units. The route is dealt inside it.
  slots   a grid above the play box holding every tile where it was compiled
          and lit. Nothing renders or collides here.
  lobby   one pad with the map's info_player_deathmatch, for the frame before
          a player is put on the route.
  shell   the sky box sealing all of it, plus a trigger_hurt under the play
          box: falling off a dealt route is the pit, as on any race map.
```

Two compile settings are worth knowing about, because the map is an unusual
shape for q3map2:

- **`_blocksize "0 0 0"`.** q3map2 splits the world tree on a 1024-unit grid.
  For a course that grid does real work; for one 31k x 35k empty arena it
  produced **9,800 portal clusters that could all see each other** — an 11.8 MB
  visibility lump carrying no information. Turning it off took the compiled
  map from 21.6 MB to 5.6 MB.
- **`_castShadows 0` / `_receiveShadows 0` / `_lightmapscale 8` per tile.** A
  tile has to look the same wherever it is dealt, so its lightmap must not
  depend on which slot it was compiled in. With no shadows to resolve, coarse
  luxels lose nothing.

### The manifest

Geometry lives in the `.bsp`; the numbers needed to fit one tile onto the next
live in `maps/random_map.deck`, a text file packed into the same `.pk3` and
read in AngelScript with `G_LoadFile` (which goes through the engine FS, so a
file inside a pk3 is readable).

It is written **after** compiling, because q3map2 assigns the inline-model
index of each tile and those are read back out of the compiled entity lump
rather than predicted from the order the entities were written.

## The dealer

`hrace/metamap.as` keeps `META_AHEAD` (6) tiles in front of whoever is
furthest along, and never recycles: the whole route stays on the ground for
players still behind, for anyone who joins, and for anyone who respawns. A
route is capped at 44 tiles, which keeps it well under the ~64 entities a
client snapshot can carry before the server's `client_entities` ring starts
overwriting frames still inside the delta window (`server/server.h:210`,
`sv_init.c:360`).

Choosing the next tile is a weighted draw over every tile that *fits*:

- its box must be inside the play box, and clear of route already on the
  ground (an overpass is allowed with 96 units of headroom);
- its exit must leave room for whatever comes next.

All the steering is in the weights. Out near the wall a tile that turns back
inwards outscores one that runs on; near the top or bottom of the box a climb
or a dive is damped the same way. Nothing forbids a shape — it only makes the
route bend before it has to.

**When nothing fits, the dealer backs up.** It undoes the last placement — but
only ever one no player has reached — and tries a different line. This is the
single most valuable thing in the file: a simulation of 600 dealt routes put
dead ends at 31% without it and 7% with it.

Those last few percent end on a **gate with no run-out**: the player crosses
the finish line, the clock stops, and they drop into the pit, which respawns
them — and `completeRace` was going to respawn them in five seconds anyway.
Driving a finish corridor through a corridor already on the ground would be
the worse answer, and the same 600-route simulation reports **zero**
overlapping routes with this rule in place.

### The clock

The deck carries no `target_starttimer` or `target_stoptimer` — a map-placed
timer would fire for whatever part of whatever route happened to be dealt over
it. The dealer owns the clock: a start gate at the end of the start pad and a
finish gate at the front of the finish tile, both trigger entities wearing the
deck's one gate model. A `SOLID_TRIGGER` brush entity is not networked as
solid at all (`g_clip.cpp:552-557`), so a gate costs nothing on the wire and
lives entirely on the server, where its touch is dispatched.

## Why there is no leaderboard, and what there is instead

A time on `random_map` is not comparable to a time on a real map, or even to a
time on a different seed: the course was invented a minute ago. So
`completeRace` skips the record path entirely — no top-scores row, no personal
best, no demo, no ghost, nothing to `/api/ingest` — and `hrace.as` does not
start a demo on this map at all.

What *is* worth keeping is the pair: the time, and the seed that produced the
route. That goes to `POST /api/game/random` (native `RS_ApiReportRandomRun`)
and lands in `random_run`, which is shown at `/random` as **one small ladder
per seed**. Flattening the seeds into one list would invite exactly the
comparison this whole design avoids.

The table has no `map_id` on purpose. `random_map` is one name covering an
unbounded family of courses, and a map row for it would collect rows from
thousands of different courses under a single leaderboard.

## Playing it

```
callvote map random_map     # get there — it is never dealt by a blind randmap
/seed                       # what course is this?
/seed 4242                  # deal that course, for everyone
/newseed                    # deal a fresh one
```

Changing the seed changes the ground under every player, so it is refused
while anyone else is mid-run. Nothing here is a vote: a route is cheap to
re-deal and any seed can be dealt again at any time, which is what makes the
board's seed column useful.

`random_map` is excluded from **blind** draws only — a bare `randmap`, the
idle rotation's cycle, a meshvote wildcard. Naming it always works, so it stays
votable and stays listed in `/maps`.

## Building the deck

```
docker build -t racesow-mapgen -f tools/mapgen/Dockerfile tools
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/build:/out" \
    racesow-mapgen deck --out /out
```

The result is `random_map.pk3` (~360 KB), which installs into the shared map
store like any other map.

## Previewing a seed on the site

`/random` deals a seed in the browser and draws the route it produces, before
anyone has raced it.

The dealer's placement is pure arithmetic over the manifest, so the same walk
runs anywhere — `web/public/assets/js/random-dealer.js` is a port of
`hrace/metamap.as`. That port is the whole risk: a preview that drew a route
the servers would NOT deal is worse than no preview. So it is pinned to 340
golden routes generated from the Python model of the gametype
(`web/test/fixtures/random-dealer-golden.json`), covering several target
distances and the awkward endings — routes that rewind twenty times, routes
that end on a gate with no run-out. One mismatched piece fails the test.

Two things keep the preview honest beyond that:

- **The deck comes out of the compiled pack the servers deal from.**
  `web/random-deck.js` reads `maps/random_map.deck` straight out of
  `random_map.pk3` under the map-store mount, never from a copy kept beside the
  web code — a second copy of the manifest is exactly how a preview starts
  lying. The parse is cached on the pack's mtime and size, so a republished
  pack is picked up without a restart.
- **The manifest carries each piece's walkable footprint** (`face` lines, added
  for this), so the plan draws the real shape of a turn rather than its
  bounding box. `RACE_MetaLoadDeck`'s head chain has no trailing else, so the
  gametype ignores them; the pack grew 5 KB.

## What is not done

- **Difficulty.** Every tile carries flags for the moves it needs (dash, wall
  jump) and a weight, but nothing reads them yet. A server cvar offering an
  easier deck is a few lines on top of `RACE_MetaPick`.
- **Checkpoints.** A dealt route has none, so the in-game per-checkpoint
  comparison has nothing to show. Each tile could carry one.
