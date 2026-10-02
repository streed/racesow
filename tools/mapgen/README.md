# mapgen

Describe a race map in words; get a compiled, checked, raceable `.pk3`.

```
mapgen.py plan  "a fast flowing course, two big drops, finish on a long straight" -o spec.json
mapgen.py check spec.json --svg plan.svg     # layout rules only, instant, offline
mapgen.py build spec.json --out build/       # q3map2 -> FBSP -> pk3 -> checks
mapgen.py generate "..." --out build/        # plan + build
mapgen.py deck --out build/                  # the random_map tile deck
```

`deck` builds the **meta map**: one `.pk3` holding every course piece as a
dormant inline model plus a manifest, which the gametype deals into a route at
runtime, a few pieces ahead of the player. It takes no spec — the deck *is* the
catalogue in `tiles.py`. See
[docs/meta-map-design.md](../../docs/meta-map-design.md).

This is the first slice of [docs/map-generation-design.md](../../docs/map-generation-design.md).
It supports **strafe-only greybox courses**: straights, curves, ramps, jumpable
gaps and checkpoints. There are no walljumps, jump pads or weapons yet.

## How it works

```
description ──Claude──▶ spec.json ──layout──▶ brushes ──q3map2──▶ FBSP ──▶ .pk3
                 ▲           │                                        │
                 └─ problems ┘ (spec.validate + layout rules)         └─ check_bsp
```

1. **`describe.py`**: Claude writes a *spec*, a short JSON list of segments
   (`spec.py`). It never writes coordinates. Structured output guarantees the
   JSON shape. The ranges and geometry rules are checked locally, and any
   problem goes back to the model as a repair turn, for up to 4 attempts.
2. **`layout.py`**: walks the spec like a turtle and lays down convex brushes
   for floors, walls, curve wedges and trigger volumes. It adds the start room,
   spawn, start timer, finish timer and finish room, and seals everything in a
   sky box with a kill volume in the pit. It rejects a gap without run-up, a
   gap landing on anything but floor, and a course that runs into itself. A
   course may pass *over* itself (the test is 3-D); every crossing is
   reported as an overpass.
3. **`mapfile.py`**: writes the brushes as Quake 3 `.map` text. Each face's
   point order is chosen from its known outward normal, so it never relies on
   a winding convention.
4. **`build.py`**: runs `q3map2 -game qfusion` (`-bsp -meta`, `-vis`,
   `-light`) and packs `maps/<name>.bsp` with the generated `mapgen_v1`
   textures and shader. It then re-reads the **compiled** bsp: it runs
   `tools/mapfix` (the same checks the imported pool gets), and checks that
   there is exactly one start timer and one stop timer, that every timer and
   checkpoint is fired by a trigger that kept its brush model, and that there
   is a spawn point.

### Course pieces

| segment | fields | what it lays down |
| --- | --- | --- |
| `straight` | `length` | floor and two walls |
| `turn` | `direction`, `angle` (45/90/135/180), `radius`, `shortcut` | a curved corridor; a 180 with `shortcut: true` adds wall windows and stepping stones across the U |
| `ramp` | `length`, `rise` | a sloped straight, at most 30 degrees |
| `gap` | `length`, `drop` | a pit to jump, sized against `physics.max_gap(drop)` |
| `checkpoint` | none | a timing split, painted across the floor (optional: see below) |
| `slalom` | `length`, `count` | full-height fins off alternate walls, each leaving a 160-unit gate: the line is a weave |
| `beam` | `length`, `beam_width` | no floor but a bridge down the middle, over the pit |
| `split` | `length`, `direction`, `count` | a median wall and two lanes: the `direction` lane runs straight over `count` holes (85% of a run-speed jump, each after a full run-up), the other is solid but weaves through tight fins |

**Ice.** A `straight`, `turn`, `ramp` or `slalom` may set `"ice": true` to
floor it with the slick `ice` texture, whose shader carries `surfaceparm slick`.
In the engine `SURF_SLICK` only skips ground friction
(`gameshared/gs_pmove.c:483`); acceleration and gravity are unchanged, so a
player still reaches run speed on an icy run-up and every gap guarantee holds.
They just cannot brake, and slide wide through corners. Ice only changes the
walking surface's texture, never the geometry. `build.check_bsp` confirms the
compiled shaderref carries `SURF_SLICK`, and the site's slick scan
(`web/bsp.js`) tags the map as slick like any icy pool map.

**Checkpoints are guaranteed.** Like the start and finish, the generator adds
them itself (`layout.plan_checkpoints`). It keeps any the plan placed, then adds
one on a straight every 2,560 units of route (8 s of par) wherever the plan left
a longer stretch without one. Each added checkpoint is at least 1,024 from any
other, 768 from the start and finish lines, 64 clear of its straight's ends,
and never inside the stretch a shortcut skips, so a player who takes the stones
still crosses every one. A course too short for that spacing still gets one,
near its middle. The report's `checkpoints` counts both kinds, and
`auto_checkpoints` counts the added ones.

The holes, stones and gates are sized from `physics.py`, so every route is
clearable at a plain 320 ups. The risky routes (shortcuts, a split's fast lane,
a narrow beam) are faster, and a fall is death.

A course can cross itself if the upper floor is high enough: at least the
lower corridor's wall height plus both floor slabs above it. The report lists
each crossing as `{"lower": seg, "upper": seg, "clearance": units}`.

### What "raceable" means here

`physics.py` holds the engine's own movement numbers, each cited to a line in
the qfusion tree the servers build: gravity 850, jump 280, run speed 320,
step 18, and the player box. Every gap is sized so a player running at a
plain 320 ups clears it, with a 20% margin. Strafing makes a generated course
faster, but it is never required. That is the static guarantee.

Two things are **not** proven yet: that a bot can actually drive the route
(the design doc's phase 2, a headless pmove bot), and that the *server* loads
the map. The e2e CI lane covers the second: it builds this toolchain and boots
the real `warsow-race` image on `examples/gen_first_light.json` through
`server/test/boot-test.sh --maps-dir`.

### Limits and untrusted input

The description and the model's output are both treated as untrusted, and
every map is size-capped before it can reach the servers: route length,
footprint, brush count, q3map2 time, bsp size and pack size. The title is
held to plain words, and the `.map` writer refuses anything that could add an
entity. The full list, with values, is in `docs/map-generation-design.md`
("Untrusted input, bounded output").

## Output

`build/` receives:

| file | what |
| --- | --- |
| `<name>.pk3` | the map: bsp + textures + shader; drop it in `server/maps/` |
| `<name>.svg` | top-down plan (start green, finish red, checkpoints yellow, route dashed) |
| `<name>.map` | the source brushes, openable in NetRadiant for hand edits |

The same spec always builds the same bytes. The zip timestamps are pinned,
lighting runs single-threaded, and q3map2's compile-time banner is blanked. So
a spec is the thing to store, review and diff.

Generated maps are named `gen_*`. Like any new bsp name, each one starts with
an empty leaderboard.

## Map editor: building a spec by hand

`/mapgen/editor` builds the same spec in the browser. You pick pieces from a
palette, set lengths, heights, angles, directions, open/ice flags with
sliders, drag pieces to reorder them, and see the course in 3-D with the
`mapgen_v1` textures (you can also ride its centre line). It imports and
exports spec JSON (a model's reply, a `spec.json`, or a generated map via
`?from=<token>`), and "Build it" queues the spec through `POST /api/mapgen/spec`
under the same daily quota. The worker skips planning for these `source =
'editor'` jobs: it normalizes the spec, checks it, and builds it.

The page lays the course out with `web/public/assets/js/mapgen-course.js`, a
port of `physics.py`, `spec.py` and `layout.py`, and draws it with
`mapgen-textures.js`, a port of `assets.py`. Both are pinned by `golden.py`:

```
python3 tools/mapgen/golden.py            # re-dump after changing the generator
python3 tools/mapgen/golden.py --check    # test_mapgen.py runs this
```

It writes `web/test/fixtures/mapgen-layout-golden.json.gz` (every example and
a set of valid and refused courses: problems word for word, brushes, entities,
route) and `mapgen-textures.json` (a sha256 per texture).
`web/test/mapgen-course.test.js` and `mapgen-textures.test.js` must reproduce
them exactly. A generator change that is not carried to the port fails both
lanes.

## Worker: player requests from the website

`worker.py` serves the `/mapgen` page. The web queues a request only after
checking the requester's daily identity quota (1 map a day by default, see
`web/mapgen-identity.js`) and the site's daily budget (admins requesting from
`/admin/mapgen` skip both), and returns the job's
token; the requester lands on `/mapgen/<token>`, which follows the job live.
The worker plans, builds and checks the map in `MAPGEN_DIR/<token>/`, then
publishes it: a map that passes every check is copied into the shared map
store (`MAPGEN_STORE`), where each game server's `sv_mapscan` loads it and
confirms it over `/api/game/map-sync`. The page says "On the servers" once
every active server has it. Every built map is then listed on
`/mapgen/gallery` (an admin can hide one from `/admin/mapgen`).

```
docker compose --profile mapgen up -d mapgen    # needs ANTHROPIC_API_KEY in .env
```

A failed build refunds the requester's map. A failed plan does not, because
the model call is the cost the quota bounds. See the design doc's phase 3.

## Look: racesow dev textures

`assets.py` draws the texture set procedurally in pure Python, so no image
files are committed. It uses the site's palette: `--orange #ff6a1a`,
`--cyan`, `--green`, on navy.

| texture | use |
| --- | --- |
| `floor` | light grey, 64-unit cells, 16-unit sub-grid, unit labels |
| `wall` | dark slate, the same grid, orange pinstripe + RACESOW wordmark; clearly darker than any floor |
| `start` | navy pad, green chevrons pointing down the course, START |
| `finish` | black / white checker with an orange FINISH band |
| `checkpoint` | cyan line painted across the floor under each checkpoint trigger |
| `edge` | orange / black hazard stripes on every gap lip |
| `trim` | orange stripe on the start and finish lines |
| `pylon` | navy with cyan bands on slalom and split fins: steer round it (orange means a fall) |
| `ice` | pale ice blue, the same grid, frost glints and ICE; `surfaceparm slick` (no friction). Ships only in packs that use it, in its own `mapgen_v1_ice.shader`, so an older pack's `mapgen_v1.shader` cannot shadow it |

Textures are 256 px and the texture scale is 1, so 1 px = 1 unit and the grid
measures true distances. Floor textures are rotated per piece so chevrons and
lettering face down the course. Wall faces that Quake would texture
mirror-image get a negative scale, so RACESOW reads correctly on both sides.

## Screenshots in the real client

```
screenshots.py build/gen_first_light.pk3 --spec examples/gen_first_light.json \
    --warsow ~/warsow-2.1.2 --out shots/
```

This runs the stock Warsow 2.1.2 client (the same tarball `server/Dockerfile`
downloads) under Xvfb with software GL, and takes one screenshot per
landmark: the start, each gap, checkpoint, slalom, beam, split and shortcut,
and the finish. Cameras stand on the course's centre line a set distance
before the landmark (closer for a beam or split), so they are on the real
floor through turns and ramps, and look at it. With more landmarks than the
ten view keys, the first of every kind is kept. Each view is a
throwaway copy of the bsp with the spawn point moved to the camera, and the
real map is untouched. Views are level at eye height, because the engine drops
spawns to the floor and applies only their yaw; the plan `.svg` is the
overview. Needs `Xvfb`, `xdotool` and Mesa.

### Fly-through video

```
screenshots.py build/gen_gordian_knot.pk3 --spec examples/gen_gordian_knot.json \
    --warsow ~/warsow-2.1.2 --out shots/ --flythrough shots/gen_gordian_knot.webm
```

This films the course from the start pad to the finish in the same client,
along its centre line at 1,100 units per second (a strafing racer's pace),
through slalom gates, over the split's holes and beams, and under every
overpass. Each frame is a spectator teleport (`position set`) and a JPEG
screenshot, so it is the engine's own renderer and lighting. The engine allows
one `position` command per 500 ms, so 30 s of video takes about ten minutes.
The map loads under the dm gametype for filming, because the race script
replaces `position` with a version that has no `set`. Needs an ffmpeg that
reads MJPEG and writes VP8 (`--ffmpeg`, `$FFMPEG`, or PATH); Playwright's
bundled build is enough.

## q3map2

Use the Docker image, which builds a pinned netradiant-custom q3map2:

```
docker build -t racesow-mapgen -f tools/mapgen/Dockerfile tools
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/build:/out" racesow-mapgen \
    build examples/gen_first_light.json --out /out
```

To build q3map2 on the host instead, you need **GCC 14**. GCC 13 and Clang 18
both reject the tree's C++20. Then pass `--q3map2` or set `Q3MAP2`:

```
make -C netradiant-custom CC=gcc-14 CXX=g++-14 DEPENDENCIES_CHECK=off \
     DOWNLOAD_GAMEPACKS=no binaries-q3map2
```

## Tests

```
python3 tools/mapgen/test_mapgen.py                  # compile tests skip without q3map2
Q3MAP2=/path/to/q3map2 python3 tools/mapgen/test_mapgen.py
```

The fast CI lane runs the offline tests: physics, spec ranges, layout rules,
the brush winding of every face, and the describe repair loop against a fake
client. The Docker build runs all of them, including compiling the example and
checking byte-for-byte reproducibility.
