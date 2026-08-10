# The Monthly Cup

An automatic tournament series covering the **first week of every month**, whose
map pool is **the four most-finished maps of the previous calendar month**, and
which **skips the month entirely** if that pool shares any map with the previous
edition.

> **Status: BUILT, NOT YET DEPLOYED** (branch `monthly-cup`). 251 web tests
> pass, 20 of them new. The feature is **off until `MONTHLY_CUP=1`** is set on
> the web service, so merging and deploying it changes nothing by itself.
> Web-only, EU box only — no engine rebuild, no game downtime.
>
> Companion to [tournaments-design.md](tournaments-design.md), which describes
> the tournament system this rides on. Read that first: everything below assumes
> **a tournament owns no runs**.

## The four settled questions

These were product calls rather than technical ones. All four are now decided
and implemented as named constants in `web/tournaments.js`, so changing any of
them is a one-line edit and a deploy.

| # | Question | Decision |
|---|---|---|
| 1 | Should the popularity count **subtract finishes made inside a tournament's own window on its own pool maps**? | **Yes.** Without it the pool is a fixed point (see [The feedback loop](#the-feedback-loop)). Measured on real August data it removed `gvn4s10` entirely, taking the eligible list from 5 maps to exactly 4. |
| 2 | After how many consecutive skips should the series **force itself to run**? | **2** (`MONTHLY_MAX_SKIP_STREAK`), so the worst case is a tournament every third month rather than never. `0` disables forcing and keeps the skip rule absolutely literal. |
| 3 | When fewer than 4 maps qualify, **skip or run a short pool**? | **Skip** (`MONTHLY_MIN_POOL = 4`), recorded with the full ranked candidate list. "The 4 most popular maps" is the product; a 2-map tournament is a different one. |
| 4 | `points` or `time_sum` scoring? | **`points`** (`MONTHLY_SCORING`). Under `time_sum` only players who finish *every* pool map rank at all — with ~23 distinct finishers network-wide that could produce two ranked entries, or zero. Deliberately diverges from `august-sprint`, which used `time_sum`. |

## Why the existing series machinery cannot do this

`tournament` already carries `repeat_every_days`, `repeat_gap_days`, `series_key`
and `edition`, and `scheduleNextEdition` already rolls a series forward. None of
it fits, and the reasons are worth writing down because they are not obvious from
the column names.

**`repeat_every_days` is not a period.** Placement is
`prev.ends_at + repeat_gap_days * 86400` (`web/db.js:4546`); `repeat_every_days`
is only a catch-up *stride*, used by the roll-forward `while` at `:4549` when the
computed window is already entirely in the past — which at finalize time, where
`now ≈ prev.ends_at`, never fires. The effective cadence is therefore
`duration + gap`. A 7-day edition with the admin form's defaults (30 / 1) repeats
**every 8 days** — four editions in September. The form's label actively
misstates this.

**No fixed day count can express "the first week of every month"** anyway, and
there is nowhere to vary it: the successor inherits the parent's
`repeat_gap_days` verbatim (`web/db.js:4574`). Hand-tuning `gap=23` gives an
exact 30-day period that walks backwards through the calendar: Sep 1, Oct 1,
Oct 31, Nov 30, Dec 30.

**The trigger is wrong in principle.** A successor is only created from a
**finalized** predecessor (`web/db.js:4631`). Month M+1 must materialise even
when month M was *skipped* and left no predecessor row at all.

**And the chain is fragile in ways a monthly series hits within a year.**
Cancelling one edition kills the series permanently: the orphan query treats a
cancelled successor as absent (`web/db.js:4636`), re-nominates the same
predecessor, recomputes the same `prev.edition + 1` (`:4543`), and collides on
the UNIQUE slug forever — `23505` swallowed silently at `:4589`, retried every
five minutes, zero log lines. "Cancel this month's cup" is an obvious operator
action.

So: **a second, calendar-anchored reconciliation pass**, not a `repeat_mode` on
the chain scheduler. Auto editions carry `repeat_every_days = 0`, which is
precisely what keeps the old scheduler's hands off them — the orphan query gates
on `t.repeat_every_days > 0`.

## Cadence

Calendar arithmetic in UTC, never seconds. The primitive already exists in this
codebase (`web/achievements.js:39,50`); it just was never wired to tournaments.

```
window(period) = [Date.UTC(y, m, 1, 18), Date.UTC(y, m, 8, 18))
```

Every such window is exactly 604800s across 2026–2030, leap years included, and
`Date.UTC(2027, -1, 1)` correctly normalises to 2026-12-01. Half-open like every
other window here, so back-to-back editions can share a boundary second.

**Why 18:00 UTC and not midnight.** Two reasons, and the honest one is not
"letting the data settle": `finish.created_at` is the *ingest* clock
(`web/db.js:4761-4766`), so live traffic cannot backdate into a closed month —
the only backdating source is the manual `web/import-demo.mjs`. The real reasons
are that 20:00 CEST / 14:00 EDT is a sensible evening start (`august-sprint`
started 20:15Z), and that computing at ~00:05 for an 18:00 start leaves **~18
hours of slack** for a deploy blip or an outage before the window opens.

Functions take the **period string** (`'YYYY-MM'`) or `now` end to end, never a
bare `(y, m)` pair. That is not fussiness: `monthPeriodKey` emits 1-based
`'YYYY-MM'` while `Date.UTC` takes a 0-based month, so deriving `(y, m)` via
`period.split('-')` shifts the window a month forward *and* makes the look-back
read the current, still-incomplete month — a silent wrong-data bug that no
obvious test catches.

## Popularity

The metric is **raw `COUNT(*)` over the `finish` log, windowed to the previous
UTC calendar month**. Not distinct players, not attempts.

`finish` is the only table that can answer the question at all: `run_tally` is a
history-less cumulative counter (`finishes`, `attempts`, plus a single MAX
timestamp), and `race` holds PBs only, so a windowed `race` count would mean "new
personal bests set", not "played".

A **minimum-distinct-finishers floor** (default 2) is the one guard on the
metric. Raw finish count at this site's scale is not merely gameable, it is
gameable *by accident* — the whole network had 23 distinct finishers in July, and
one regular practising for a WR outvotes everyone. On real August data the floor
correctly drops `r7-smally1` (22 finishes, **one** player). Set it to 1 to
disable.

```sql
-- $1 previous-month start (epoch s, UTC, inclusive)   Date.UTC(y, m-1, 1)/1000
-- $2 previous-month end   (epoch s, UTC, exclusive)   Date.UTC(y, m,   1)/1000
-- $3 minimum distinct canonical finishers (2; 1 disables the floor)
-- $4 candidate fetch size — a FIXED 40, not poolSize*3: the JS censor pass runs
--    after this, and a short list would fake a `skipped_thin`.
SELECT m.id                                                   AS map_id,
       m.name                                                 AS map_name,
       COUNT(*)::int                                          AS finishes,
       COUNT(DISTINCT COALESCE(pl.canonical_id, pl.id))::int  AS finishers
  FROM finish f
  JOIN player pl ON pl.id = f.player_id
  JOIN map    m  ON m.id  = f.map_id
 WHERE f.created_at >= $1
   AND f.created_at <  $2
   -- A reverse run is its own map row "<map>-reversed". No pk3 contains that
   -- .bsp, so `callvote tourneymap` can never reach it: it would score and be
   -- unplayable.
   AND m.name NOT LIKE '%-reversed'
   -- Canonical case only. The pool is inserted BY MAP ID, but setTournamentMaps
   -- lowercases and get-or-creates BY NAME (web/db.js:4113, :4136-4139), so a
   -- mixed-case pool map would round-trip into a different, empty map row on any
   -- admin re-save — and because standingsQuery resolves the pool at READ time,
   -- every point already scored on it would vanish with no error.
   AND m.name = lower(m.name)
   -- Blocked maps are stripped from every in-game vote path, so a blocked pool
   -- map is another unreachable entry.
   AND NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = m.id)
   --
   -- status IN ('published','finalized') is load-bearing: `<> 'cancelled'`
   -- would count a forgotten 90-day DRAFT, which concentrates no play at all
   -- and would silently subtract a quarter's worth of popularity data.
   -- Switchable via the excludeTournamentWindows option.
   AND NOT EXISTS (
     SELECT 1 FROM tournament t
       JOIN tournament_map tm ON tm.tournament_id = t.id AND tm.map_id = m.id
      WHERE t.status IN ('published','finalized')
        AND f.created_at >= t.starts_at
        AND f.created_at <  t.ends_at
   )
 GROUP BY m.id, m.name
HAVING COUNT(DISTINCT COALESCE(pl.canonical_id, pl.id)) >= $3
 ORDER BY finishes DESC, finishers DESC, m.name COLLATE "C" ASC
 LIMIT $4
```

**Tie-breaking is `finishes DESC, finishers DESC, name COLLATE "C" ASC`.** On the
real August three-way tie at 15 finishes this resolves on the *second* key
(`aurora-friday` at 4 finishers vs 2), so the name key is a backstop rather than
the usual decider. `map.name` is UNIQUE, so the order is total; `COLLATE "C"`
makes it byte-stable regardless of server locale. Rejected: `map_id ASC` (stable
but meaningless — it silently favours whichever map was raced first in 2007) and
`MAX(created_at)` (not stable under backdated demo imports).

**Censoring happens in JS, not SQL**, over a fixed 40-row over-fetch. The word
matcher is an in-memory matcher refreshed on a 60s timer with no SQL form, and
the game feed necessarily sends map names raw — so a censored map would be
announced uncensored in-game while showing starred on the site.

## The skip rule

If the computed pool shares **any** map with the previous edition's pool, the
month is skipped. Three sub-decisions make it well-defined:

- **"Previous edition" is the last edition that actually RAN**, never a
  hypothetical pool for a month that was itself skipped. Otherwise the first skip
  leaves nothing to compare against and the series deadlocks.
- **Overlap of ≥1 map triggers it** — not a threshold, and not "drop the
  duplicate and take #5".
- **Every skip is durably recorded**, with the computed pool and the colliding
  map. A skip and a crashed scheduler must never look identical from outside.

The comparand is bounded by **the window being decided, not by `now`**:

```sql
series_key = 'monthly-cup' AND status IN ('published','finalized')
  AND starts_at < <windowStart>
ORDER BY starts_at DESC, id DESC LIMIT 1
```

With `starts_at <= now`, re-deciding a month whose edition already exists returns
*that month's own edition* as the comparand — whose pool is byte-identical to the
one just recomputed from the same data — so it intersects 4-of-4 and records
`skipped_overlap` for a tournament that is live and scoring. Reachable via the
force button, a DB restore, or a manual row delete. Restricting to the series
also matters concretely: `august-sprint` (id 1, no `series_key`) must not become
September's comparand.

### The feedback loop

A tournament scores nothing but ordinary `finish` rows — the very rows the
popularity query counts — and `callvote tourneymap` actively moves servers onto
pool maps. Week 1 is ~23% of a month in which ~23 people finish anything. So the
tournament is the single strongest concentrator of play on its own pool, and
**without a correction the September pool = the August pool = forever**.

The skip rule breaks that fixed point. But it has a consequence worth stating
plainly, because it is easy to get wrong:

> **The series does not alternate run/skip.** C3's comparand only advances when
> an edition *runs*, so a single durably popular map skips **every** subsequent
> month, indefinitely. `aurora-speed1` was July's #1 (75 finishes) and is still
> in August's three-way tie at 15.

That is what decisions #1 and #2 address — the tournament-window subtraction
stops the feature feeding its own skip rule, and the force-after-2 escalation
bounds the worst case at one edition every third month.

## Late binding

**The row is not created until its pool is known.** This is the load-bearing
structural choice, and it is what makes a whole family of failure modes
*unreachable* rather than *guarded*.

The alternative — reserve the calendar slot early as a draft, bind the pool
later — is superficially attractive and fails on evidence:

- A **draft still occupies the exclusive calendar slot** (the EXCLUDE predicate
  is `status <> 'cancelled'`), so a draft whose publish step is missed holds a
  week hostage forever.
- The orphan reconciliation **accepts a draft successor** as "healed", so the
  series stops with nothing watching.
- A published row that reaches its window with an **empty pool** is
  unrecoverable and self-reassuring: it broadcasts "0 maps" in-game and latches
  every player as already-notified; `finalizeTournament` freezes an empty result
  and flips status with no anomaly logged; `scheduleNextEdition` then copies the
  empty pool forward forever while reconciliation reports the series healthy.

Because the row is materialised with its pool in one transaction, none of that
can happen. Empty pools, stale drafts, copied-forward pools and mid-flight
re-scores are states that cannot exist here.

## The decision record

One table, `tournament_auto_period`, doing two jobs at once:

```sql
CREATE TABLE IF NOT EXISTS tournament_auto_period (
  series_key    TEXT   NOT NULL,
  period        TEXT   NOT NULL,          -- 'YYYY-MM'
  decision      TEXT   NOT NULL CHECK (decision IN
                  ('scheduled','skipped_overlap','skipped_thin','cancelled','blocked','forced')),
  tournament_id BIGINT REFERENCES tournament(id) ON DELETE SET NULL,
  detail        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  decided_at    BIGINT NOT NULL,
  PRIMARY KEY (series_key, period)
);
```

**Job one is the exactly-once claim** across both web replicas — the PK collision
*is* the mutex. **Job two is the durable audit trail**, and it has to be a row
because `recordEvent` writes to `server_log`, a 20,000-row ring buffer shared
with four game servers' shipped stdout: a once-a-month line is pruned long before
anyone looks. That is the [db-backup sidecar](../backup/README.md) failure shape
repeating.

`ON DELETE SET NULL`, not CASCADE — deleting a tournament must not erase the
record that it was scheduled.

**Terminal vs re-decidable is the whole recovery story:**

| decision | terminal? | why |
|---|---|---|
| `scheduled` | yes | it ran |
| `skipped_overlap` | yes | a fact about a closed month's data; will never change |
| `skipped_thin` | yes | same |
| `cancelled` | yes | an edition existed and an operator called it off. The cancel *is* the decision — and it must be terminal, because a cancelled row is invisible to the calendar constraint yet still owns the UNIQUE slug, so the generator would otherwise retry the same doomed insert every five minutes |
| `blocked` | **no** | retried every sweep until the window opens, so cancelling the blocker heals the month with no operator action |
| `forced` | **no** | operator one-shot; re-decides while bypassing only the C3 check |

Rejected: recording skips as `status='cancelled'` **tournament** rows. The public
list query gates only on drafts (`web/db.js:3800`, `:3823`), so every skip would
appear on the *public* `/tournaments` calendar with its own page — silently
answering "should players see skips?" the wrong way. The reason would also be a
prose `description` instead of queryable JSONB, and the admin delete button
erases a decision in one click.

## Exactly once across two replicas

The period-claim INSERT goes **first** inside the transaction, and the code
branches on `rowCount === 0` → ROLLBACK → `{decision:'already-decided',
wrote:false}`.

This is subtle and the obvious version is wrong. `INSERT … ON CONFLICT DO NOTHING
RETURNING` **raises nothing and returns zero rows**, so "the losing replica
aborts on the PK" is simply false — the loser sails on into the tournament
INSERT. And with both the slug and the window colliding, Postgres raises
`23505 tournament_slug_key`, **never** `23P01`: a leftover row named
`monthly-cup-2026-09` (a restore, a rolled-back experiment, an admin) produces
the identical `23505` that a naive handler reads as "the other replica won",
looping silently forever with zero decision rows written. So the handler
discriminates on `e.constraint`:

- `tournament_auto_period_pkey` → peer won, silent.
- `tournament_slug_key` → operator-actionable; warn once per period.

In practice the slug case is detected *before* the insert: the generator looks up
whoever holds `monthly-cup-<period>` and asks whether it is **its own** edition
(same series, same window — adopt it and rebuild a lost decision row) or a
**squatter** (anything else — report `slug-taken` and stop trying). Depending on
which constraint Postgres happened to raise was the fragile part; asking the
question directly is not. A squatted slug writes no decision row, so its warning
is de-duplicated per period in the sweep rather than by the table.

Rejected: a `pg_advisory_xact_lock` day-claim in the `achievementsDailySweep`
shape. That pattern writes its claim *before* the work because achievement awards
are idempotent with a continuous backstop; neither is true here, so a crash
between claim and commit loses the **month**.

## Precedence against hand-booked tournaments

One tournament at a time is a hard rule, enforced by `tournament_no_overlap`. The
automatic series does **not** get priority: **first come, first served.** An
admin one-off straddling day 1 blocks that month's edition, recorded as `blocked`
naming the blocker.

The block check runs **before** the popularity aggregate — it is one indexed
range scan, it is far cheaper, and it is the *actionable* condition, so running
it second would mean a month that was both collided and blocked recorded
`skipped_overlap` and never named the blocker.

There is a compounding dynamic worth naming: a skipped month leaves the first
week free, an admin books there, that booking blocks the *next* edition — and
each booking looks locally reasonable while the series quietly stops running.
That is why the warning belongs on the **admin form**, where the decision is
actually made, not only on a panel that reports afterwards.

Rejected: auto-cancelling the blocker (destroys deliberate operator intent), and
draft-reserving a month ahead to win the race (reserves an exclusive week for
something with maybe a 50% chance of running).

## Things that will bite you

- **`recordEvent` is not an audit trail.** 20,000-row ring buffer, shared with
  four game servers' stdout. Durable facts go in a row.
- **The sweep logs successes only.** `web/server.js:1039` is a bare
  `console.error` — not `recordEvent`, not Sentry (`instrument.mjs` configures no
  console integration). Every `scheduleNextEdition` failure path returns bare
  `null`. Fix this or the generator fails invisibly.
- **`finalizeDueTournaments`' loop has no per-item try/catch**, so a throw
  anywhere in it takes finalization, trophies and reconciliation down together.
  That is why the generator is called from `sweepTournaments`, not from inside
  it.
- **Never write a decision row on a thrown error** — a transient fault would
  permanently decide the month.
- **A new `tournament` COLUMN is silently dropped from the public backup.**
  `backup/backup.sh:206` is a hand-written 16-column list and the test only
  asserts a *prefix* regex, so both backup tests still pass. A new TABLE is
  excluded entirely unless added to `TABLES` at `backup.sh:76` — which
  `tournament_auto_period` must be, or a restore lands with editions present and
  no decision rows and re-decides months that already ran.
- **Config is an env var (`MONTHLY_CUP=1`), not `site_setting`.** `site_setting`
  is dumped wholesale in the public backup (no key filter), so an `enabled:true`
  would ship publicly *and* a restored mirror would inherit an **armed**
  generator — precisely the failure the adjacent `maintenance_*` filter exists to
  prevent, twelve lines away in the same file.
- **Saving any field on a tournament rewrites the whole pool from the form
  textarea.** `setTournamentMaps` is DELETE-then-INSERT, and `standingsQuery`
  resolves the pool at read time, so swapping map #4 on day 3 silently erases
  every point earned on the removed one. The edit route logs *nothing* today —
  create and status-flip both log, edit does not.
- **DB-backed tests do not run at all unless `TEST_PG_URL` is set**
  (`web/test/pg-util.js:12` defaults to :5433; this box's Postgres is on
  **:5461**). Easy to lose an hour to tests that pass by not existing.

## What this does not touch

**Web-only, EU box only.** `gameTourneyText` emits the same one-T/one-S/N-M
payload regardless of who created the tournament, and `RACE_ParseTourney` skips
unknown line kinds and resets all state at the top of every parse — so a skipped
month sends a bare `RSTOURNEY` header and the game correctly falls silent, with
no stale pitch. All six tournament natives are already registered.

Nothing here touches `server/enginepatches`, `server/racemod`,
`server/entrypoint.sh` or `server/Dockerfile` — the four paths that trigger a
game rebuild. **No engine rebuild, no AngelScript change, no 20–30 min double
image build, no 2–5 min game downtime, and us.east is not touched at all.**

Advertising the series uses the **existing** rotating in-game announcements (one
admin edit, zero code). A new feed line would be safely ignored by current
servers, but doing anything *useful* with it needs a racemod change — which is
exactly what would stop this being web-only.

## Bootstrap: September 2026

The `finish` log effectively begins **2026-07-22**. June 2026 has zero rows;
July has 859 (109 maps, 23 players); August is the **first complete month**. So
the first properly-fed edition is **2026-09-01 18:00 → 09-08 18:00 UTC**,
computed from August at ~00:05 on the 1st.

There is no predecessor and that is fine — `august-sprint` has no `series_key`,
so it is not the comparand, and "no previous edition" decides `scheduled`.

`tournament_auto_period` being **empty** immediately after deploy is the correct
state: the generator writes nothing for 2026-08 because `now >= startsAt` for
that period. A month the generator could not reach in time is not a skip, and
recording it as one is the exact confusion the skip rule exists to prevent.

**Run the popularity query against prod before building.** With the
tournament-window exclusion on, a fixture matching real August data left exactly
four eligible maps — no headroom above the minimum.

## Files

| Path | What |
|---|---|
| `web/migrations/20260803120000000_tournament_auto_period.sql` | the decision record + its rationale |
| `web/tournaments.js` | constants, calendar helpers, the pure `decideMonthlyPool` |
| `web/db.js` | popularity query, comparand, period helpers, `scheduleMonthlyEdition` |
| `web/server.js` | sweep wiring, failure visibility, admin panel + force button, form warning |
| `backup/backup.sh` | `TABLES` allow-list + both `included` manifest arrays |
| `web/test/tournaments.test.js` | 20 new tests: calendar, exclusions, skip rule, two-replica claim |
| `web/test/backup.test.js` | full-column assertion + the `forcedBy` secret |
| `docs/tournaments-design.md` | corrected the `repeat_every_days` cadence claim |

## Turning it on

The generator is inert until `MONTHLY_CUP=1` is set on the web service. Because
it only ever acts while `now < startsAt`, arming it mid-month writes no row and
raises no alarm for the month already in progress — the first month it can act
on is the next one.

Emergency stop is `MONTHLY_CUP=0` plus one rolling deploy (~60s); that halts the
generator without touching any edition it has already created. Cancelling a
created edition is the separate, and usually correct, operator action.
