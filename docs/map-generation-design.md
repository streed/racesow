# Map generation

A player describes a map in words: "a fast flowing course, two big drops,
finish on a long straight." The system builds it, proves it can be raced, and
puts it in the rotation. No mapper is involved.

Status (2026-09-27): **phase 1 is built** as `tools/mapgen` (CLI + Docker
image + CI). Phases 2-4 below are design only.

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
| `gap` | length, drop | ≤ `max_gap(drop)`; needs 192 units of run-up; must land on a straight or turn |
| `checkpoint` | — | `trigger_multiple` → `target_checkpoint` |

The start room, spawn, start timer, stop timer, finish room, sky shell and pit
kill volume are implicit: every course has exactly one of each, so the model
cannot forget them. The timers use the racemod's defrag-style entities
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

The pieces a form needs mostly exist already. The one that does not is **who
is asking**.

**Identity is the open decision.** The site has no player login. The only
accounts are staff (`admin_user`, created with `node admin.js admin-add`,
roles admin/moderator, gated by `requireRole` in `web/server.js`). A player's
name on a record comes from the game unverified. The options:

| option | cost | abuse surface |
| --- | --- | --- |
| **A. staff-only form** at `/admin/mapgen`, behind `requireAuth` | none: reuses sessions + CSRF | none |
| B. public form, per-IP rate limit, every result held for review | small | model spend per request; needs a hard daily budget |
| C. public form tied to an in-game identity (`/mapgen <code>` links a browser to a player) | a new identity feature | bounded per player |

Recommendation: **ship A first.** Moderators already review public map flags
(`/admin/flags`), so "a player asked in Discord, a moderator typed it in" is a
workflow the site already has. B or C can follow once real generation costs
and quality are known. The worker, queue and publish path below are the same
for all three; only the form's gate changes.

**Queue: a table, polled.** This matches how the site already coordinates
work. There is no message broker. The two web replicas use atomic claims in
Postgres (`claimServerRestart`), and the `heatmaps` sidecar is a self-looping
container that polls the DB and writes into a shared volume. So:

- A migration `web/migrations/<ts>_mapgen_job.sql` (auto-applied on web boot)
  adds `mapgen_job` (id, description, requested_by, status
  `queued|planning|building|review|published|rejected|failed`, spec jsonb,
  report jsonb, error, timestamps).
- A `mapgen` compose service runs the `racesow-mapgen` image in a loop:
  1. claim the oldest `queued` row (`UPDATE … WHERE status='queued' …
     RETURNING`, the same atomic-claim shape);
  2. run `plan` then `build`;
  3. write the `.pk3`, `.svg` and `.map` to `./data/mapgen/<job>/`;
  4. set `status=review`.
  It needs `ANTHROPIC_API_KEY` and nothing else from web.
- The form page shows the plan SVG as soon as `plan` finishes, and a 3D view
  once built (`tools/bsp2gltf` into the existing replay viewer). In phase 2 it
  also shows the bot's proof run.

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
| 3 | staff form → `mapgen_job` table → worker → pre-blocked publish → moderator unblock | design |
| 4 | vocabulary growth gated on phase 2: jump pads, walljump walls, themed texture sets | idea |

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
