# mapgen

Describe a race map in words; get a compiled, checked, raceable `.pk3`.

```
mapgen.py plan  "a fast flowing course, two big drops, finish on a long straight" -o spec.json
mapgen.py check spec.json --svg plan.svg     # layout rules only, instant, offline
mapgen.py build spec.json --out build/       # q3map2 -> FBSP -> pk3 -> checks
mapgen.py generate "..." --out build/        # plan + build
```

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
   gap landing on anything but floor, and a course that crosses itself.
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
