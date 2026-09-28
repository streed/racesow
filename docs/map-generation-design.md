# Map generation

A player describes a map in words: "a fast flowing course, two big drops,
finish on a long straight." The system builds it, proves it can be raced, and
puts it in the rotation. No mapper is involved.

Status (2026-09-28): **phase 1 is built** as `tools/mapgen` (CLI + Docker
image + CI), and so is phase 3's request path: the `/mapgen` page, the
daily-identity quota and the worker. Phase 2 and publishing are design only.

## The one idea worth remembering

**The language model never touches geometry. It writes a plan, and code that
knows the physics turns the plan into brushes.**

Asking a model for `.map` brushes would give maps that look plausible and fail
in ways nobody sees until a player is stuck behind an unjumpable gap. So the
model's only output is a *spec*: a short JSON list of segments such as
`straight 1024`, `turn left 90 r512` or `gap 128 drop 32`. Each segment is
checked against the engine's own movement numbers before anything is
compiled, and each has exactly one way to become brushes. That split gives
three properties:

- **Every map is raceable by construction.** A gap exists only if a player
  running at a plain 320 ups clears it with margin. Strafing makes a map
  faster, never possible.
- **A bad plan is a repair prompt, not a broken map.** Validation errors go
  back to the model verbatim, and the loop runs until the plan passes or a
  budget runs out. The compiler never sees an unchecked plan.
- **A spec is the source of truth.** The same spec builds the same bytes, so
  specs are what get stored, reviewed, diffed and re-rendered when the
  generator improves.

## Pipeline

```
 description
     │  describe.py — Claude, structured output (shape), repair loop (sense)
     ▼
 spec.json ───── spec.validate: ranges vs physics.py ─────┐
     │                                                    │ problems
     │  layout.py — turtle walk, convex prisms            │ go back to
     ▼            run-up / landing / self-crossing rules ─┘ the model
 brushes + entities
     │  mapfile.py — .map text, faces ordered by known outward normal
     ▼
 q3map2 -game qfusion   -bsp -meta │ -vis │ -light      (pinned, Docker)
     │
     ▼
 FBSP v1 ──▶ check_bsp: tools/mapfix + race rules on the COMPILED entities
     │
     ▼
 <name>.pk3 (+ plan .svg, source .map)
     │  phase 2: headless pmove bot drives the route
     │  phase 1: boot-test.sh --maps-dir: the real server loads it
     ▼
 publish (phase 3)
```

## Where the numbers come from

`tools/mapgen/physics.py` cites each constant to its line in the qfusion tree
that `server/Dockerfile` builds (DenMSC/racemod_2.1, `race-demos`):

| constant | value | source |
| --- | --- | --- |
| gravity | 850 | `gameshared/gs_public.h:65` |
| jump speed | 280 | `gs_public.h:73` |
| race run speed | 320 | `gs_public.h:72` |
| step height | 18 | `gs_public.h:272` |
| player box | 32 × 32 × 64 | `gs_pmove.c:31-32` |
| walkable slope | normal.z ≥ 0.7 | `gs_public.h:223` |

These give a flat-gap limit of 168 units and a ledge limit of 36 units, both
with the 0.8 margin applied. Ramps are capped at 30°.

## The segment vocabulary (phase 1)

| segment | fields | rule beyond ranges |
| --- | --- | --- |
| `straight` | length | counts toward run-up |
| `turn` | direction, angle ∈ {45, 90, 135, 180}, radius | radius ≥ width/2 + 64 |
| `ramp` | length, rise | ≤ 30°; resets run-up |
| `gap` | length, drop | ≤ `max_gap(drop)`; needs 192 units of run-up; must land on a straight, turn, slalom or split |
| `checkpoint` | — | `trigger_multiple` → `target_checkpoint`; optional, since the generator fills any stretch over 2,560 units without one |
| `turn` + `shortcut` | a 180 with straights ≥ 320 either side | stepping stones at 92% of `max_gap(0)` across the U |
| `slalom` | length, count 2–12 | fins leave 160-unit gates; ≥ 256 between fins; width ≥ 224 |
| `beam` | length, beam_width | 48 ≤ beam ≤ width − 128; walls reach 160 below it |
| `split` | length, direction, count 1–6 | lanes ≥ 176; fast-lane holes at 85% of `max_gap(0)`, each after 192 of run-up; safe lane weaves 96-unit gates |

A course may pass over itself. The self-intersection test is 3-D, so a
crossing is legal when the upper floor clears the lower corridor's walls, and
every crossing is reported as an overpass.

The start room, spawn, start timer, stop timer, finish room, sky shell and pit
kill volume are implicit: every course has exactly one of each, so the model
cannot forget them. Checkpoints are guaranteed the same way: the generator
keeps the plan's own and adds one on a straight roughly every 8 s of par,
never inside a stretch a shortcut skips. The timers use the racemod's defrag-style entities
(`hrace/entities/timers.as`), so a generated map races exactly like an
imported one.

## Proving "raceable": three layers

1. **Static, on the plan (built).** Ranges and geometry rules in `spec.py` and
   `layout.py`. This is instant and runs inside the model's repair loop.
2. **Static, on the compiled bsp (built).** `build.check_bsp` re-reads what
   q3map2 actually wrote. It runs `tools/mapfix` (dead brush entities,
   unresolved targets, walljump flags) plus the race rules: exactly one start
   timer and one stop timer, each timer and checkpoint fired by a
   `trigger_multiple` that kept a brush model, and a spawn point. A trigger
   that loses its brush in compilation is freed at spawn, so the map looks
   right and never starts a timer.
3. **Dynamic (phase 2).** A headless run of the engine's own movement code. The
   plan is to compile `gs_pmove.c` and the collision model (`cm_*.c`) from
   the same tree into a small native harness that loads the bsp. A bot then
   follows `Course.route`, the centre-line polyline layout already records,
   holding forward and jumping at each gap lip, and must touch the stop
   trigger from the start trigger. This replaces "the numbers say it's
   clearable" with "the engine cleared it". It is also the prerequisite for
   anything the static rules cannot vouch for: strafe-only gaps, jump pads,
   walljumps. The bot's run is recorded as a demo and shown in the existing
   replay viewer, so reviewers watch the proof rather than read it.

The e2e lane already covers the server side: it builds the mapgen image, which
compiles the example with the pinned q3map2, and boots the real `warsow-race`
image on the result with `boot-test.sh --maps-dir`.

## Phase 3: the website form

Status: **the form, quota, queue and worker are built** (`/mapgen`,
`web/mapgen-identity.js`, `tools/mapgen/worker.py`). Publishing is still design.

**Who is asking: a daily identity, not an account.** The site has no player
login, and a map request should not need one. Each request is attributed to
an identity computed the way Tastatur counts visitors
(`streed/tastatur`, `app/lib/ingest/identifier.rb`, `salt_store.rb`):

```
identity = HMAC-SHA256(daily_salt, "mapgen" ‖ ip ‖ coarse browser profile)[0:16]
```

- **IP handling:** IPv6 is cut to its /64, so privacy-extension addresses stay
  one person. The browser profile is family + major version + OS family +
  desktop/mobile/tablet, never the raw user-agent.
- **The salt:** 32 random bytes under `racesow:mapgen:salt:<UTC date>` in the
  site's Redis, which already runs with persistence off. It's minted with
  `SET NX EX`, so both web replicas agree, and it expires shortly after its
  day ends.
- **What the database holds:** only the 16-byte digest, never the IP, the
  user-agent or the salt. Once the salt expires, nobody can recompute or link
  that day's identities.
- **The daily reset:** a new day means a new salt and so a new identity.
  Unlike Tastatur there is no "previous" salt, because a quota has no
  sessions to carry across midnight.
- **Fail closed:** if Redis is unreachable, requests get a 503. They never
  fall back to an unsalted hash, which is recoverable. The existing map-flag
  reporter hash is `sha256("mapflag:" + ip)` with no secret, so anyone holding
  it can recover the IPv4 address by brute force. Moving it to this identity
  would be a small follow-up.

**Two limits, in one transaction.** `mapgen_quota` gives each identity
`MAPGEN_DAILY_PER_IDENTITY` maps (default 2). `mapgen_budget` gives the site
`MAPGEN_DAILY_BUDGET` (default 40; 0 switches requests off). Each is a single
conditional upsert (`ON CONFLICT DO UPDATE ... WHERE used < limit
RETURNING`) that returns no row at the limit, so the two replicas cannot
over-grant. The per-identity limit is a courtesy: like Tastatur's visitor
count, it treats one IP plus one browser as one person, so a new browser or
network gets a new quota, and a shared IP with the same browser shares one.
The site budget is the cost ceiling that no requester can get around.

**Queue: a table, polled.** The same shape as the rest of the site: no broker,
and atomic claims in Postgres. `mapgen_job` rows carry a random 32-hex
`token`, the only handle ever handed out, so descriptions cannot be read by
walking ids. The `mapgen` compose service (profile `mapgen`, needs
`ANTHROPIC_API_KEY`) runs `worker.py`:

1. It claims with `FOR UPDATE SKIP LOCKED` and plans with Claude.
2. It gives the map a unique name, `gen_<model's name>_<token[:6]>`.
3. It builds, writes `./data/mapgen/<token>/`, and leaves the job at `review`.
4. A failed build refunds the requester's map, because that one's our bug. A
   failed plan does not, because the model call is the cost being bounded.

**The page** (`/mapgen`, footer "Make a map") keeps no state: no cookie and no
localStorage. It asks `/api/mapgen/mine`, and the same person on the same day
computes the same identity. It polls every 5 s while a job is running and shows
each built map's plan preview. All `/api/mapgen/*` responses are `no-store`:
they depend on who is asking, so no cache may keep them.

**Publishing: pre-blocked, then unblocked by a moderator.** Maps reach the
servers as pk3s in `server/maps/`. The entrypoint symlinks them in at boot, and
`/api/game/blocked-maps` removes blocked ones. That gives a safe publish path
with no new mechanism:

1. **Approve** (moderator): copy the pk3 into `server/maps/` and insert its
   name into the block list *first*. It is installed but not votable.
2. **Load**: a new pk3 is only seen at server boot (`scripts/setup.sh:191`).
   The daily restart (`systemd/racesow-restart.timer`, 05:00) picks it up with
   no extra downtime. "Publish now" can reuse the existing restart flag
   (`/api/game/ops`).
3. **Unblock** (moderator, `/admin/maps/:id/unblock`): `hrace/blockedmaps.as`
   re-fetches every 30 s, so the map becomes votable live.
4. **US box**: it has its own `server/maps` and no map sync. It should pull
   approved generated pk3s from EU over HTTPS, the way it already reaches every
   `rs_api_*_url`, before its own restart. That is a small script beside
   `fetch-maps.sh`, which already does atomic, zip-checked, ClamAV-scanned
   installs.

Adding a generated map to `server/configs/mappool.txt` stays a manual,
curated decision. Being installed and unblocked makes a map votable; it does
not put it in the automatic rotation.

## Phases

| phase | what | status |
| --- | --- | --- |
| 1 | strafe-only greybox: spec, layout, compile, static checks, CLI, Docker, CI boot | **built** |
| 2 | headless pmove bot; proof-run demo in the replay viewer | design |
| 3 | public form with daily identity quota → `mapgen_job` table → worker | **built** (publish step: design) |
| 4a | strafe-only vocabulary: slalom, beam, split lanes, overpasses | **built** |
| 4b | vocabulary growth gated on phase 2: jump pads, walljump walls, themed texture sets | idea |

## Decisions and why

- **q3map2 from netradiant-custom, pinned by commit.** It is the only
  maintained q3map2 with a `qfusion` game that writes FBSP v1. The tree needs
  GCC 14, which is why the image is Ubuntu 24.04 rather than the server's
  18.04.
- **Assets ship inside every pk3, under a versioned name (`mapgen_v1`).** A
  generated map depends on nothing in `basewsw`, and a client that downloads
  it gets its textures. (It should also load on the Warfork servers, which
  read the same FBSP format, but only Warsow is exercised in CI.) Changing the look
  means creating `mapgen_v2`, never editing v1, because two installed maps
  that disagree about `mapgen_v1/floor` would be resolved by load order.
- **Deterministic output.** Pinned zip times, single-threaded light (the
  multi-threaded light grid differs between runs), and q3map2's compile-time
  banner blanked. So "did the generator change this map?" is a byte compare.
- **`gen_` prefix.** Generated maps are recognisable in the pool, in votes and
  on the site. They can be filtered, blocked or retired as a class.
- **Claude Opus 5 with adaptive thinking, structured output and server-side
  refusal fallback.** Structured output fixes the JSON shape. The repair loop
  (at most 4 attempts) fixes the sense.

## Open risks

- **The live model call is untested.** The repair loop is tested against a
  fake client, but no real description has been run through
  `describe.plan` yet (no API key in the environment it was built in). Expect
  prompt tuning once real descriptions flow.
- **"Fun" is not checked.** Everything above proves a course *can* be raced.
  Whether it is worth racing is a human call, which is why phase 3 puts a
  review step before anything reaches the rotation.
- **A new bsp name is an empty board.** Every generated map starts with no
  records. That is fine for new maps, but a bug-fix rebuild of a published map
  must keep its name, or its records strand (see `tools/mapfix/README.md`).
- **Client rendering is checked by hand, not in CI.** CI proves the server
  loads the map. `tools/mapgen/screenshots.py` renders it in the real Warsow
  client (Xvfb + software GL), and that is how the textures and lighting were
  tuned. But it needs the ~465 MB client and is not part of any CI lane yet.
  It is the natural source of the review page's previews in phase 3.
