# Map generation

A player describes a map in words: "a fast flowing course, two big drops,
finish on a long straight." The system builds it, proves it can be raced, and
puts it in the rotation. No mapper is involved.

Status (2026-09-28): **phase 1 is built** as `tools/mapgen` (CLI + Docker
image + CI), and so is phase 3's request path: the `/mapgen` page, the
daily-identity quota, the worker, automatic publishing into the shared map
store, and a per-request page that follows each map onto the servers. Phase 2
is design only.

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
| dash speed | 451 | `gs_public.h:74` |
| dash upward speed | 174 × 850/800 = 184.9 | `gs_pmove.c:110` |
| wall-jump upward speed | 330 × 850/800 = 350.6 | `gs_pmove.c:117` |
| wall-jump bounce | 0.3 | `gs_pmove.c:119` |

These give a flat-gap limit of 168 units and a ledge limit of 36 units, both
with the 0.8 margin applied. Ramps are capped at 30°.

## The segment vocabulary (phase 1)

| segment | fields | rule beyond ranges |
| --- | --- | --- |
| `straight` | length | counts toward run-up |
| `turn` | direction, angle ∈ {45, 90, 135, 180}, radius | radius ≥ width/2 + 64 |
| `ramp` | length, rise | ≤ 30°; resets run-up |
| `gap` | length, drop | ≤ `max_gap(drop)`; needs 192 units of run-up; must land on a straight, turn, slalom, split or wallclimb |
| `checkpoint` | — | `trigger_multiple` → `target_checkpoint`; optional, since the generator fills any stretch over 2,560 units without one |
| `turn` + `shortcut` | a 180 with straights ≥ 320 either side | stepping stones at 92% of `max_gap(0)` across the U |
| `slalom` | length, count 2–12 | fins leave 160-unit gates; ≥ 256 between fins; width ≥ 224 |
| `beam` | length, beam_width | 48 ≤ beam ≤ width − 128; walls reach 160 below it |
| `split` | length, direction, count 1–6 | lanes ≥ 176; fast-lane holes at 85% of `max_gap(0)`, each after 192 of run-up; safe lane weaves 96-unit gates |
| `wallclimb` | length ≥ 384, rise 72–94, direction | a step-up halfway along with a kick wall on `direction`; 384 of level floor before the ledge |
| `wallgap` | length 64–270…302, drop −94…−72, direction | a gap up onto a ledge, kick wall along `direction`; 384 of level run-up; lands like a gap |
| `dash` | length, drop 384–1,024 | a 192-unit open pad, then a gap longer than any run-speed jump and within a dash |
| any straight, turn, ramp, gap + `open` | `open: true` | no side walls; the floor edges are painted |

### Special moves: what "required" means

The special key dashes on the ground and wall-jumps in the air
(`PM_CheckDash`, `PM_CheckWallJump`). The three special pieces are sized so
the move is needed, and the claim is only as strong as the physics behind it:

- **Wall climbs and wall-kick gaps need the wall jump from everyone.** Their
  ledge is 72–94 up. A jump reaches 46 plus the 18-unit step (64); a jump
  plus a wall jump reaches 118 (0.8 margin: 94). Strafing adds speed, never
  height, so no run-up gets a player onto the ledge without the kick. The one
  way round it, a jump off an upward ramp (the jump speed is added to the
  ramp's), is closed by requiring 384 units of level floor first; by then
  that arc is back down below the ledge.
- **Dash drops need the dash at run speed.** A dash is 451 ups but low, so it
  out-reaches a 320-ups jump only on a long drop: at 512 down a perfect jump
  reaches 472 and a dash 542 (0.9 margin, since a dash sets its speed exactly).
  A player carrying strafe speed can jump them instead. That is the same
  promise every other gap makes: finishable at run speed, faster with skill.
- **No low-ceiling dash slot.** It looks like a way to force a dash (a jump
  would bonk its head), but crouching works in the air and lowers the head 24
  units, while a dash blocks crouching for 400 ms. A crouch-jump fits under
  any ceiling a dash does.
- **No distance-only wall-kick gap.** Built first, and the in-game test below
  caught it: holding forward and strafe into the wall is air strafing, and it
  crossed a flat 290-unit gap with a plain jump.

These were checked in the real Warsow 2.1.2 client, not only on paper. A
script compiled a test map per piece, joined a dm warmup, held the keys with
real timing (xdotool) and read the player's position back with `viewpos`,
with the move and without:

| piece | with the move | without |
| --- | --- | --- |
| wall climb, 80 up | 5 of 7 on the ledge; peak 109–125 | 0 of 7; peak 48–49, stopped at the ledge face |
| wall-kick gap, 220 across and 80 up | 2 of 2 on the ledge; peak 118 | 0 of 2; peak 49–50, hit the face and fell |
| dash drop, 488 across and 512 down | 2 of 2 across; peak 18–19 | 0 of 2; fell ~60 short |

Both wall-climb misses were the script jumping early (it triggers off a
polled position): the player peaked at 112 before the ledge and dropped back.
The height was there; the timing was not, which is the move working as a
timed move.

The "without" runs on the wall pieces held forward and strafe into the wall
(the strafe that crossed the flat gap) and still could not gain the height.

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
`MAPGEN_DAILY_PER_IDENTITY` maps (default 1). `mapgen_budget` gives the site
`MAPGEN_DAILY_BUDGET` (default 40; 0 switches requests off). Each is a single
conditional upsert (`ON CONFLICT DO UPDATE ... WHERE used < limit
RETURNING`) that returns no row at the limit, so the two replicas cannot
over-grant. The per-identity limit is a courtesy: like Tastatur's visitor
count, it treats one IP plus one browser as one person, so a new browser or
network gets a new quota, and a shared IP with the same browser shares one.
The site budget is the cost ceiling that no requester can get around.

**Admins have no limit.** An admin requests maps from `/admin/mapgen`, where
the admin session lives (its cookie is scoped to `/admin`, so the public
`/api/mapgen` never sees it, and that stays so). An admin request skips both
the per-person quota and the site budget, has no identity to refund, and
records the admin's username in `mapgen_job.requested_by`. Otherwise it is an
ordinary job: same description cleaning, same queue, same job page. Its cost
still shows in `llm_usage` like any other.

**Queue: a table, polled.** The same shape as the rest of the site: no broker,
and atomic claims in Postgres. `mapgen_job` rows carry a random 32-hex
`token`, the only handle ever handed out, so descriptions cannot be read by
walking ids. The `mapgen` compose service (profile `mapgen`, needs
`ANTHROPIC_API_KEY`) runs `worker.py`:

1. It claims with `FOR UPDATE SKIP LOCKED` and plans with Claude.
2. It gives the map a unique name, `gen_<model's name>_<token[:6]>`.
3. It builds and checks the map in `./data/mapgen/<token>/`.
4. It publishes it: every map that passes every automated check goes to the
   servers, with no human step (see Publishing below).
5. A failed build or publish refunds the requester's map, because that one's
   our fault. A failed plan does not, because the model call is the cost being
   bounded.

**What each map cost: `mapgen_job.llm_usage`.** After planning, successful or
not, the worker stores the job's Claude usage and logs one line
(`job 12: Claude usage: 2 call(s), ... tokens, ~$0.31`). The JSON has the
totals (`calls`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`), the models that answered, a list-price estimate
`est_usd` (`describe.PRICES`; null for a model it has no price for), and
`per_call`, one record per API call with its stop reason. When the server-side
fallback answers a declined request, that call's record says `fallback: true`
and keeps the API's `usage.iterations`, one entry per attempt. The web never
serves this column. The estimate is for spotting trends; the Anthropic
Console's billing is the real figure. To read it:

```sql
-- Spend per day, and what a finished map costs on average.
SELECT to_timestamp(created_at)::date AS day, count(*) AS jobs,
       count(*) FILTER (WHERE status IN ('publishing', 'published')) AS maps,
       sum((llm_usage->>'output_tokens')::bigint) AS output_tokens,
       round(sum((llm_usage->>'est_usd')::numeric), 2) AS est_usd,
       round(sum((llm_usage->>'est_usd')::numeric)
             / nullif(count(*) FILTER (WHERE status IN ('publishing', 'published')), 0), 3)
         AS usd_per_map
  FROM mapgen_job WHERE llm_usage IS NOT NULL
 GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- The most expensive jobs, with how many calls (repair turns) they took.
SELECT id, status, (llm_usage->>'calls')::int AS calls,
       llm_usage->>'est_usd' AS est_usd, left(description, 60) AS description
  FROM mapgen_job WHERE llm_usage IS NOT NULL
 ORDER BY (llm_usage->>'est_usd')::numeric DESC NULLS LAST LIMIT 20;
```

`mapgen.py plan` prints the same one-line summary on stderr.

**The pages.** Submitting on `/mapgen` (footer "Make a map") returns the job's
token and opens `/mapgen/<token>`, the job's own page and the link to share.
It shows five steps with their times: queued (with the place in line),
planning, building and checking, publishing, on the servers. Once built it
shows the map's facts and plan, and each active game server as it confirms
the map. It polls every 3 s (5 s while queued) until every active server has
the map or the job failed. `/mapgen` itself keeps no state, no cookie and no
localStorage: it lists today's requests from `/api/mapgen/mine`, each linking
to its page. All `/api/mapgen/*` responses are `no-store`.

**Publishing: automatic once every check passes.** The checks are the spec
ranges, the layout rules (clearable gaps, no self-collision, run-up), the
compile, `tools/mapfix` and the race-entity checks on the compiled bsp. Then:

1. **Publish** (`worker.py publish`): copy the pk3 into the shared map store
   (`MAPGEN_STORE`, EU's `server/maps`, docs/shared-maps.md). It refuses a
   directory without the store's sentinel and never rewrites an existing pack.
   The copy lands under a dot-name the engine does not scan and is renamed in
   one step. Status `publishing`.
2. **Load**: every game server reads the store directly (`fs_cdpath`, US over
   NFS) and `sv_mapscan` loads new packs within a minute, with no restart.
3. **Confirm**: `hrace/blockedmaps.as` polls `GET /api/game/map-sync` every
   30 s with the server's own token. The reply is the blocklist plus a
   `?<map>` line per recently published map the server has not confirmed. The
   next poll's `?have=` lists the ones the engine's map list now holds. The
   first confirmation sets the job `published` (`live_at`), and each server's
   is kept in `mapgen_seen` for the page. A server counts as active if it
   polled in the last 5 minutes. If a sync poll fails for good, that map's
   remaining polls use the public blocklist URL, so blocking never depends on
   the sync.
4. **Pulling a map**: a moderator blocks it (`/admin`), and the blocklist hides
   it from every vote path within 30 s. Removing the pack follows the store's
   rules.

Adding a generated map to `server/configs/mappool.txt` stays a manual,
curated decision. A published map is votable; it is not in the automatic
rotation.

## Untrusted input, bounded output

**Prompt injection.** The description is typed by anyone on the internet, so
nothing it says is trusted, and neither is the model output it steered.

- **Web** (`POST /api/mapgen`): control characters and invisible formatting
  characters, including bidi overrides, are stripped, whitespace is
  collapsed, and the text is capped at 10-500 characters. The page always
  escapes it.
- **Model input** (`describe.user_message`): the text is cleaned again, its
  angle brackets are swapped for look-alikes, and it is fenced in
  `<description>` tags it cannot close. The system prompt says the fenced
  text is a course description only: it cannot change the rules or the
  format, and any instructions in it are ignored.
- **Model output**: structured output fixes the JSON shape, and
  `spec.validate` then rejects anything out of range; a rejection goes back
  as a repair turn. The one free-text field is the title, which lands in the
  compiled map and on the site. `spec.TITLE_RE` holds it to letters, digits,
  single spaces and `' & ! ? , : -` (no quotes, braces, backslashes,
  newlines, `^` colour codes, `.`, `/`, `@` or `#`). The name is
  `NAME_RE`-checked and rebuilt by the worker.
- **Map writer**: `mapfile._kv` refuses any key or value containing `"`, a
  newline, `\`, `{` or `}`, so even a title that got past validation could
  not close the worldspawn entity and add one of its own.

**Size limits.** Every limit is checked before the map reaches the store.
The examples use a fraction of each (at most ~31,600 units of route, ~11,400
across, 419 brushes, a 6.1 MB bsp in a 0.36 MB pack).

| limit | where | value |
| --- | --- | --- |
| segments | `spec.MAX_SEGMENTS` | 64 |
| route length | `spec.ROUTE_MAX` | 40,000 units (~125 s par) |
| footprint | `layout.EXTENT_MAX_XY` / `_Z` | 16,384 across each way, 8,192 tall |
| brushes | `layout.BRUSH_MAX` | 1,500 |
| q3map2 time | `build.STAGE_TIMEOUT` | 300 s bsp, 300 s vis, 600 s light |
| compiled bsp | `build.BSP_MAX_BYTES` | 16 MiB |
| pack | `build.PK3_MAX_BYTES`, checked again in `worker.publish` | 4 MiB |
| maps per day | `MAPGEN_DAILY_BUDGET` (site), 2 per identity | 40 |

The planner is told the limits, so a plan that breaks one comes back as a
repair turn, not a failed request.

## Phases

| phase | what | status |
| --- | --- | --- |
| 1 | strafe-only greybox: spec, layout, compile, static checks, CLI, Docker, CI boot | **built** |
| 2 | headless pmove bot; proof-run demo in the replay viewer | design |
| 3 | public form with daily identity quota → `mapgen_job` table → worker → automatic publish → per-job page with server confirmations | **built** |
| 4a | strafe-only vocabulary: slalom, beam, split lanes, overpasses | **built** |
| 4b | special moves: wall climbs, wall-kick gaps, dash drops, open track (checked in the real client) | **built** |
| 4c | vocabulary growth gated on phase 2: jump pads, themed texture sets | idea |

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
- **Generated maps stay out of ratings until an admin says otherwise.** One
  site-wide flag, `/admin/mapgen` (admins only; stored as `site_setting`
  `mapgen_rated`), decides whether `gen_*` maps count toward Points, Skill
  Rating and the maps / WR / podium totals. It is off by default: a generated
  map is new and unvetted, and a handful of them could otherwise hand out
  cheap WRs. When off, the standings rebuild (`buildAggregates`) and the
  profile's SR breakdown both skip `gen_*` PBs, so the two always agree; the
  maps' records, leaderboards and pages are untouched, and the map page says
  its records don't count yet. Saving the flag rebuilds the standings at once.
- **Claude Opus 5 with adaptive thinking, structured output and server-side
  refusal fallback.** Structured output fixes the JSON shape. The repair loop
  (at most 4 attempts) fixes the sense.

## Open risks

- **The live model call is untested.** The repair loop is tested against a
  fake client, but no real description has been run through
  `describe.plan` yet (no API key in the environment it was built in). Expect
  prompt tuning once real descriptions flow.
- **"Fun" is not checked.** Everything above proves a course *can* be raced.
  Whether it is worth racing is a human call. Generated maps publish without
  one (a published map is votable, not in the rotation), so the check is
  after the fact: a moderator blocks a bad one and it leaves every vote path
  within 30 s.
- **A new bsp name is an empty board.** Every generated map starts with no
  records. That is fine for new maps, but a bug-fix rebuild of a published map
  must keep its name, or its records strand (see `tools/mapfix/README.md`).
- **Client rendering is checked by hand, not in CI.** CI proves the server
  loads the map. `tools/mapgen/screenshots.py` renders it in the real Warsow
  client (Xvfb + software GL), and that is how the textures and lighting were
  tuned. But it needs the ~465 MB client and is not part of any CI lane yet.
  It is the natural source of previews for each request's page.
