# mapfix

Finds and repairs imported race maps that the engine quietly mis-runs.

Almost every map in the pool was built for Quake 3 / defrag and imported as-is.
Most of it works, because the racemod supplies the entity spawn functions Warsow
lacks. What does not work fails **silently** — nothing is printed, nothing
crashes, the map just plays wrong until someone says so in chat:

| symptom a player reports | what the engine is actually doing |
| --- | --- |
| "you can't walljump on this map" | every shaderref carries `SURF_NOWALLJUMP`, so `gs_pmove.c:178` skips the wall |
| "this teleport does nothing" | the destination `targetname` resolves to nothing, so `G_Find` returns NULL |
| "this trigger doesn't fire" | the brush entity has no `model` key, so `g_clip.cpp:985` freed it at spawn |

```
tools/mapfix/mapfix.py scan server/maps/                    # report
tools/mapfix/mapfix.py fix  server/maps/foo.pk3 --out /tmp/fixed
tools/mapfix/mapfix.py fix  server/maps/ --dry-run          # what would change
```

`scan` exits 1 if anything at `broken` severity was found. `--json` gives
machine-readable output for both commands.

## Naming: the suffix says what was repaired

A repaired map is written with a suffix naming the repair families that were
actually applied, following the pool's own convention — 577 maps are already
called `-wjfix` for exactly the walljump repair:

| token | repairs it covers |
| --- | --- |
| `wjfix` | `walljump` |
| `trigfix` | `drop-dead-brush-ent`, `reattach-orphan-model` |
| `telefix` | `drop-dead-teleport`, `retarget-teleport` |
| `entfix` | `translate-classname` |

```
bluetown.pk3     -> bluetown-wjfix.pk3
aryshok_mew.pk3  -> aryshok_mew-trigfix.pk3
foo.pk3          -> foo-wjfix-telefix.pk3      (both families applied)
```

Token order is fixed, so the same set of repairs always yields the same name.
`--no-suffix` keeps the original filename; `--in-place` implies it.

**By default the `.bsp` inside is renamed too**, along with its levelshot and
map scripts — `bluetown.pk3` becomes `bluetown-wjfix.pk3` holding
`maps/bluetown-wjfix.bsp`. This is the pool convention, and it means the fixed
map can sit alongside the untouched original rather than replacing it.

The cost is that the engine and the site see a **new map**: leaderboards,
topscores and `map_index` all key on the bsp name, so a renamed map starts with
an **empty board**. That is why `bluetown` and `bluetown-wjfix` are separate
maps on the site today. Two operational consequences worth planning for:

* the original stays voteable, so players can still land on the broken version
  — block the originals (`/admin` map flags) once the fixed ones are installed;
* the old records stay attached to the old name and do not migrate.

`--keep-bsp-name` inverts that: only the `.pk3` filename carries the suffix, the
bsp keeps its name, and the map keeps every record. In that mode the output is
meant to **replace** the original `.pk3` — leaving both installed means two
archives offering the same `maps/bluetown.bsp` and the engine's load order
decides which wins.

Renaming the levelshot and `.defi` along with the bsp is the one place mapfix
improves on the hand-made maps: `bluetown-wjfix.pk3` in the pool still points at
`levelshots/bluetown.jpg`, so the fixed map lost its menu image.

## The walljump fix

`SURF_NOWALLJUMP` (`q_collision.h:83`) makes `gs_pmove.c:178` skip a wall
entirely, so a player cannot walljump off it. Some maps carry the bit on
essentially **every** shaderref — including `noshader`, `common/trigger` and the
skybox, none of which a mapper would ever mark by hand. That is a compile
artifact and it kills walljumping map-wide.

The pool already contains 577 hand-made `-wjfix` maps. Diffing four of them
against their surviving originals shows lump 1 as the *only* difference, and
only this one bit within it. `mapfix fix` reproduces all four **byte for byte**
— that is `test_matches_handmade_wjfix`, and it is the main reason to trust the
repair.

The opposite case is left alone. A map carrying the bit on a *minority* of its
shaderrefs has it on shaders named `common/noob`, `nowalljumpclip`,
`nowj_orange` — deliberate, unwalljumpable surfaces. The `--walljump-threshold`
(default 0.9) is the dividing line, and an intent-named shader is preserved even
inside a blanket map.

## Regenerating the engine tables

`gamedata.py` holds the three tables `G_CallSpawn` consults, so that "will this
entity spawn?" is answered the way the engine answers it — including the case
asymmetry, where native lookups use `Q_stricmp` but the AngelScript lookup is an
exact function-name match. It is generated, not hand-written:

```
tools/mapfix/extract_gamedata.py           # needs docker + the built images
```

Re-run it after an engine or racemod change that adds or removes an entity spawn
function.

## Tests

```
python3 tools/mapfix/test_mapfix.py
```

No dependencies. Includes the four real hand-made-fix comparisons, plus the
regression for the mistake worth remembering: a `target_teleporter` with no
`target` is a **destination marker**, not a dead teleporter — 1,880 of the
1,884 in the pool look exactly like that, and an earlier cut of this tool would
have deleted every one of them.
