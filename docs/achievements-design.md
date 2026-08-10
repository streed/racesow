# Design: player achievements & rewards

Status: **Phase 1 DEPLOYED** (2026-07-31, eb4bca2 — schema, rule catalog in
web/achievements.js, evaluator, /admin/achievements, profile panel, public
/achievements directory), plus a 66-definition seed set verified against
production data (a71633e, 78dde2c, a7c8312) and retroactively awarded.
**Phase 2 BUILT** (2026-08-01, e6c2cf1): per-player awards poll — see
"Phase 2 as built" notes inline below (the endpoint grew a ?seed=1 variant and
a row-id cursor; payload header is "//awards", not RSAWD, matching the other
per-slot fetches).
**Phase 3 PARTIALLY BUILT** (2026-07-31): distance raced + strafe count
(run_tally counters, accumulated in player.as sampleDistance / the sampleStrafe
segment counter) and max/starting speed (finish snapshots) now ride four new
trailing ints on RS_ApiReportRace + two on RS_ApiReportAttempts; profile tiles,
movement_total metrics and a max_speed_run achievement kind consume them;
Warsow boot-test passed. Still open from the Phase 3 table: playtime, jumps,
deaths, per-checkpoint speeds. Design survey was 2026-07-31.

## Goal

Let an **admin or moderator define achievements** ("played 100 new maps this
month", "hit 50% strafe quality", "beat weirdmap under 40s") from the admin
area without a deploy, have the site **evaluate and award** them automatically
as players play, **show** them on the website (profile badges + a public
achievements directory), and **announce** them in-game.

There is no existing badge/award/title concept anywhere in the codebase — this
is greenfield (verified by broad grep; the only "badge" hits are CSS pill
classes).

## Decisions (proposed)

| Decision | Choice | Why |
|---|---|---|
| Rule model | **Parameterized rule catalog** (kind + params JSONB), not free-form SQL/DSL | Admins compose from vetted, indexed queries; no injection/perf footgun; new kinds are small code additions |
| Where evaluated | **Web-side only**; game servers stay dumb reporters | All the data already flows to the web via `/api/ingest`; game boxes keep zero achievement logic |
| Evaluation triggers | **Post-ingest (per affected player) + once-per-UTC-day sweep** | Mirrors the existing `refreshAggregates` debounce and the `snapshotSrHistory` daily advisory-lock pattern |
| Award identity | **Canonical player id** | Aliases collapse by nick (`player.canonical_id`); every existing per-player read resolves canonical first — awards must too |
| Award durability | **Logged, forward-accruing, never deleted by rule edits** | Same property as `sr_history`: deactivating/editing a definition keeps already-earned rows |
| In-game announce | **Per-player poll** (playerrecord/savedstart pattern), `client.addAward()` banner | Fire-and-forget ingest can't carry a response; per-slot fetch is the established per-player channel |
| Admin access | **`requireAuth`** (admin *and* moderator), like the flag queue | The stated requirement is "admin or moderator" |

## Phasing

- **Phase 1 — web only, ships standalone value.** Schema, rule catalog over
  *existing* data, evaluator, admin CRUD + dry-run preview, profile badges,
  public directory with rarity. No game-server changes, no new natives.
- **Phase 2 — in-game announce.** Per-player awards poll + `addAward` pop +
  mesh `~RSACT~` broadcast so other servers see "X unlocked Y".
- **Phase 3 — new metrics.** Report max speed / starting speed / playtime /
  jumps, then unlock the achievement kinds that need them.

---

## Phase 1

### Schema (two tables, one migration)

```sql
CREATE TABLE achievement (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,          -- stable key, used in URLs/CSS
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'bronze'
              CHECK (tier IN ('bronze','silver','gold','legend')),
  rule        JSONB NOT NULL,                -- { "kind": ..., params... }
  window     TEXT NOT NULL DEFAULT 'lifetime'
              CHECK (window IN ('lifetime','month','day','rolling30')),
  repeatable  BOOLEAN NOT NULL DEFAULT FALSE, -- re-earnable per window period
  hidden      BOOLEAN NOT NULL DEFAULT FALSE, -- shown only once earned
  active      BOOLEAN NOT NULL DEFAULT FALSE, -- created inactive; activate after preview
  created_at  BIGINT NOT NULL,               -- epoch seconds (house style)
  created_by  TEXT,
  updated_at  BIGINT,
  updated_by  TEXT
);

CREATE TABLE player_achievement (
  achievement_id BIGINT NOT NULL REFERENCES achievement(id),
  player_id      BIGINT NOT NULL REFERENCES player(id),  -- canonical id
  period         TEXT NOT NULL DEFAULT '',  -- '' lifetime; '2026-07' monthly; '2026-07-31' daily
  awarded_at     BIGINT NOT NULL,           -- epoch seconds
  finish_id      BIGINT,                    -- triggering finish, when event-scoped
  detail         JSONB,                     -- snapshot: the value that qualified
  PRIMARY KEY (achievement_id, player_id, period)
);
CREATE INDEX idx_pach_player  ON player_achievement (player_id, awarded_at DESC);
CREATE INDEX idx_pach_awarded ON player_achievement (awarded_at DESC);
```

The PK makes awarding **idempotent** (`INSERT … ON CONFLICT DO NOTHING`), so
double-evaluation across the two web replicas is harmless — same trick as the
sr_history day gate. `period` is `''` for one-shot achievements; for
`repeatable` ones it's the UTC period key, so "100 new maps this month" can be
earned every month as a distinct row.

Precedent honored: definitions are config-like but get a real table (not
`site_setting`) because they're relational, queried per-row, and joined against
awards. Awards follow the `finish`/`sr_history` precedent: append-only log.

### Rule catalog (v1 kinds — all computable from existing tables)

Each kind is one vetted SQL evaluator in a new `web/achievements.js`. Params
live in `achievement.rule`. Everything below needs **zero new data**:

| kind | params | window support | Backing data |
|---|---|---|---|
| `distinct_maps_finished` | `count`, `newOnly` (first-ever finish falls in window) | lifetime/month/rolling30 | `finish` (log since 2026-07-22) |
| `finishes` | `count` | all | `finish` / `run_tally.finishes` for lifetime |
| `attempts` | `count` | lifetime | `run_tally.attempts` |
| `strafe_quality_run` | `minPct` — a single finish at/above threshold | event | `finish.strafe_quality` (basis points) |
| `strafe_quality_avg` | `minPct`, `minRuns` | lifetime/rolling30 | `finish.strafe_quality` |
| `skill_rating` | `min` | current | `standings.sr` |
| `world_records` | `count` | current | `standings.wr` |
| `podiums` | `count` | current | `standings.podium` |
| `points` | `min` | current | `standings.points` |
| `map_time` | `map`, `maxMs` — beat a named map under a time | event | `finish` |
| `map_rank` | `maxRank` (e.g. top-10 on any map), optional `map` | current | `race.global_rank` / `best.rank` |
| `movement_total` | `metric` ∈ wall_jumps\|dashes\|restarts, `count` | lifetime | `run_tally` |
| `play_streak` | `days` — finished on N consecutive UTC days | rolling | `finish.created_at` |
| `dedication` | `days` — distinct active days in window | month/rolling30 | `finish.created_at` |

Notes:
- "current"-window kinds read the UNLOGGED `standings`/`best`/`race`
  aggregates, so they must run **after** `refreshAggregates` completes, and
  tolerate the tables being mid-swap (they're read in the same pool, the
  atomic rename makes that safe).
- The `finish` log only exists since **2026-07-22**; window kinds are honest
  from then on, lifetime counts should prefer `run_tally` (which predates it).
- `finish.created_at` is **epoch seconds** (repeat: seconds, not ms).
- Strafe-quality thresholds: the working tree has an uncommitted sampler
  recalibration (`STRAFE_MIN_SPEED` 100→600 ups + mouse-turn gate). Values
  produced before/after it ship are **not comparable** — don't activate
  strafe achievements until that lands and a little data accrues under the
  new gate.

### Evaluator

New module `web/achievements.js` (⚠ must be added to the explicit `COPY` list
in `web/Dockerfile` or the container crashes on import), exposing:

- `evaluateForPlayers(client, playerIds)` — event-scoped + cheap kinds, run
  for just the canonical ids touched by an ingest batch. Hooked at the tail of
  the existing debounced refresh path (`scheduleAggregateRefresh` →
  `refreshAggregates` in `web/server.js:697` / `web/db.js:2485`), so
  standings-based rules see fresh SR/WR/podium numbers. Ingest already knows
  which players it touched.
- `dailySweep(client)` — window/streak kinds + full-field catch-up, hung off
  the tail of `refreshAggregates` exactly like `snapshotSrHistory`
  (`web/db.js:2519`): once per UTC day, in-memory day memo → cheap existence
  probe → `pg_advisory_xact_lock` (new lock id, e.g. 727411003) → re-check →
  work. Best-effort try/catch that never fails the parent refresh.
  The daily sweep also gives **retroactive awarding for free**: activate a
  lifetime achievement and every already-qualifying player earns it within a
  day (or immediately via the admin "run now" button).

Both paths end in the idempotent insert. A `finish_id`+`detail` snapshot is
recorded when the trigger was a specific run.

### Admin UI — `/admin/achievements`

Server-rendered, `requireAuth` (moderators included), cloned from the
announcements page template (`web/server.js:2048/2105`): list page with
active/inactive split → create/edit form:

- title, slug (auto from title), description, tier, hidden, repeatable
- **rule kind dropdown** → the form shows only that kind's param fields
  (small inline `<script>`, same no-template-literal idiom as the
  announcements live preview)
- window dropdown (kinds declare which windows they support)
- **Dry-run preview** button — "who would earn this right now?": runs the
  evaluator read-only, shows qualifying-player count + first 20 names. This
  is the safety valve: definitions are created `active = FALSE` and only
  activated after the admin has seen the blast radius (avoids "oops, 9k
  players just earned Bronze Finisher and the game announces all of them").
- Award management: revoke a single player's award (moderator-visible audit
  of who created/edited what via `created_by`/`updated_by`).

CSRF via `checkCsrf`, 303-redirect-with-`?ok=1`, nav link added to
`adminShell` — all existing idioms.

### Website display

- **Profile** (`web/public/assets/js/app.js`, `viewPlayer` at ~1017): an
  achievements card slotted **after the `grid-2` SR/strafe block
  (~app.js:1081)**, before Recent Finishes. Earned badges as tier-colored
  pills; a collapsed `<details>` with lazy `GET /api/players/:id/achievements`
  for the full list **including progress toward unearned visible ones**
  ("73/100 maps this month") — clone of the SR-breakdown lazy pattern
  (`app.js:448/526`, `server.js:389`). Progress is computed on read by the
  same rule evaluators in "measure" mode — no progress table needed.
  Follow the strafe-card precedent of always rendering with an empty state.
- **Public directory** `/achievements` (SPA route): every visible definition,
  grouped by tier, with **rarity** ("earned by 3.2% of active players") and
  recent earners. Rarity is one grouped count over `player_achievement`
  vs. active-player count, cached 300s. Hidden achievements show as "???"
  until earned.
- API: `GET /api/achievements` (directory, cached), lazy
  `GET /api/players/:id/achievements` (cached 60s, `edge: true`). Both go
  through the `db.js` choke point so **name censoring** applies to earner
  names like everywhere else.

---

## Phase 2 — in-game announce

> **As built (e6c2cf1):** endpoint is `GET /api/game/awards?name=` with
> `&seed=1` (join: newest row only, sets the mark silently) or `&after=<rowId>`
> (rows above the mark, oldest first, capped at 20 — bursts page out across
> polls). Header is `//awards` (not RSAWD) so the native's standard `//` gate
> applies; lines are `<rowId>\t<tier>\t<title>\t<description>` (tabs because
> titles carry spaces; the tier rides second so the free-text fields are last).
> `player_achievement` gained an identity cursor column (awarded_at seconds
> can't order a batch insert). Game side lives in hrace/awards.as: 75s per-slot
> cadence, max 5 popups per poll + an "...and N more" summary, mesh kind "ach"
> with the map field carrying "<tier> <title...>". A map change resets the
> per-slot state and re-seeds, so an award landing exactly during the switch is
> site-only — accepted (best-effort flair, not the record).
>
> **Per-player opt-out (added later):** the client cvar
> `cg_raceShowAchievements` (`CVAR_ARCHIVE|CVAR_USERINFO`, default 1, a Race
> Options checkbox in the UI pak — bumped to `v8` for it) silences the feed for
> one viewer. It is a pure display filter applied at print time
> (`RACE_AwardsWantedBy`): polling, the high-water mark and the mesh broadcast
> are untouched, so re-enabling shows what lands next instead of a backlog, and
> an opted-out player's unlocks still reach everyone else. The server-wide line
> can't use `G_PrintMsg( null, ... )` any more — `RACE_AwardsBroadcast` walks
> the clients so each viewer's choice is honoured, including for the mesh's
> `"ach"` lines.

Most awards will trigger from a finish that happened seconds earlier on that
very server, but evaluation is web-side, so announcement is a poll with ~60s
worst-case lag. Acceptable.

- **Endpoint**: `GET /api/game/awards?name=<clean>&after=<awardRowId>` —
  public plain-text like every game GET, magic header line (`RSAWD\n`),
  then `id<TAB>title<TAB>tier` per row, newest last. Stateless: the *game*
  tracks the high-water id per slot; no server-side "notified" marking
  (public GETs must stay side-effect-free — they're cacheable and spoofable).
- **Game side**: clone the per-player-slot fetch pattern from
  `playerrecord.as`/`savedstarts.as` (the only two per-slot fetches — in-flight
  state keyed on `playerNum`). Fetch on `enterGame` seeded with
  `after=<latest>` (join-time fetch just sets the high-water mark, no
  announce spam), then re-poll each slot every ~60–120s from the existing
  per-client loop in `GT_ThinkRules` (`hrace.as:726-835`, the drop-in slot at
  783-790), using the `realTime` idiom. New rows →
  `client.addAward("Achievement unlocked: <title>")` +
  `client.printMessage` with the description, and a broadcast
  `G_PrintMsg` line so the server sees it.
- **Cross-server flair**: ride the existing mesh activity feed —
  `RACE_MirrorBroadcastActivity` (`mirror.as:159`) with a new kind `"ach"`
  next to `"rec"`/`"fin"`. No new native.
- Needs one new fetch/poll/text native triple (`RS_ApiFetchAwards` /
  `RS_ApiPollAwards(playerNum)` / `RS_AwardsText(playerNum)`) in
  `g_rs_api.cpp` + `patch-api-natives.py`, plus a `rs_api_awards_url` cvar in
  `entrypoint.sh`. Remember: `.as` compiles at server **boot**; Warsow's
  AngelScript is stricter than Warfork's — boot-test Warsow first.

## Phase 3 — new metrics worth collecting

The extension convention is established (`g_rs_api.cpp:1179-1212`): **one more
trailing `int` on `RS_ApiReportRace`, negative = omitted**, then a nullable
column + sanitizer web-side. Per-run snapshots → `finish` column; monotonic
counters → `run_tally` via `RS_ApiReportAttempts`. Ranked by value/effort:

| Metric | Effort | Where it comes from | Unlocks |
|---|---|---|---|
| **Max speed per finish** | trivial | `Player.maxSpeed` already computed every frame (`player.as:2144`) — just report it | "Hit 2000 ups", profile speed stat, per-map speed boards |
| **Starting speed** | trivial | already computed *and printed* at `timers.as:104-106`, never stored | prejump-skill achievements, start-consistency stat |
| **Playtime** | small | nothing exists today (confirmed gap); accumulate seconds-in-race/practice per flush period in `racelog.as`'s pending arrays, ride `RS_ApiReportAttempts` → `run_tally.play_seconds` | "10 hours this week", honest `last_active`, dedication achievements |
| **Jumps per run** | small | the prejump engine hooks already count jumps in gs_pmove (`RS_QueryPjState` family); expose the counter, or detect rising-edge like dashes | jump-economy achievements ("finish X with ≤ N jumps") |
| **Deaths/suicides** | small | `"kill"` score event already handled (`hrace.as:351`) — count like `restarts` | persistence achievements |
| **Per-checkpoint speed** | medium | `Checkpoint.speed`/`maxSpeed` already in memory (`checkpoint.as:7`), only times are reported — add a parallel CSV | sector-speed achievements, richer replay analytics |
| Teleport crossings / weapon usage | larger | **no hook exists** (entities only indexed for `/position find`) | skip until wanted |

Also sitting unused: the ghost input trace (`ghostKeys` — full `pressedKeys`
bitmask per 20ms frame) already reaches the web inside ghost payloads; future
offline analysis (key-timing stats) could mine it with zero game changes.

## Gotchas carried in from the survey

- `web/Dockerfile` explicit COPY list — add `achievements.js` by hand.
- Migrations via `npm run migrate:create <name>`; auto-applied at boot under
  the advisory lock.
- Award reads must resolve `canonical_id` (alias groups collapse by nick).
- The two SR implementations (`db.js:418-465` aggregate + `db.js:2179-2245`
  breakdown) must agree — if an achievement kind re-derives SR, use the
  exported constants, don't fork the formula a third time.
- The `finish` log starts 2026-07-22; `strafe_quality` starts 2026-07-30 and
  gets recalibrated by the in-flight 600-ups sampler change.
- Concurrent-session web edits are a live hazard (two uncommitted features in
  the tree right now) — `git status` before any prod commit.
- Rolling deploy for web (`rolling-deploy.sh`, never bare `up -d`); game-side
  Phase 2 needs the full 4-node rebuild path from the deploy skill.
