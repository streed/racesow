# Tournaments

Time-boxed, map-limited competitions layered over the normal leaderboard.

## The one idea worth remembering

**A tournament owns no runs.**

A finish is ingested exactly as it always was (`race` / `finish` / `run_tally`),
counts for the global leaderboard exactly as it always did, and a tournament is
nothing but a *filter* over the finish log:

```
finishes on tournament_map's maps
between tournament.starts_at and tournament.ends_at
by a player who redeemed an entry code
```

Everything else follows from that:

- **No ingest change.** The game does not tag runs, the wire format is
  untouched, and no game server needs to know a tournament exists in order for
  one to score. A node whose tournament cvars are unset still contributes.
- **Retroactive definition works.** A tournament can be created after the fact
  over a window that has already passed, and it scores correctly.
- **A mistake is never destructive.** A wrong map in a pool, a wrong window, a
  wrong scoring mode — fix the row and the board is right again. Nothing about
  the real records can be corrupted by a tournament definition.
- **History does not drift.** Standings are computed live while a tournament
  runs and **frozen** into `tournament_standing` when it ends, so a result that
  has already been awarded cannot move when the finish log, the map pool, or the
  canonical-alias grouping later shifts underneath it.

## Joining is deliberately two-sided

The site has no player accounts. Records, PBs and saved starts are all keyed by
nick alone. So the entry **code is the proof-of-nick**, and nothing else is:

1. The website mints an **unclaimed** `tournament_entrant` row with a random
   8-character code (`POST /api/tournaments/:slug/join`). This proves nothing
   and costs nothing — anyone can take a code.
2. The player types `/tournament <code>` in-game. The game server POSTs it to
   `/api/game/tournament/join` under its ingest token, and the web binds the
   entry to the canonical player behind the nick they are actually playing as.
   *That* is the moment an entry becomes real.

A player already in-game skips step 1 entirely with `/tournament join`, which
mints an already-claimed row for their current nick. The code is still minted
and shown to them, so a website signup and an in-game signup are the same shape.

**Entering late is not a penalty.** Every finish inside the window scores,
regardless of when the entrant redeemed. Signups stay open until the tournament
ends. Requiring register-first would punish exactly the people who heard about
it late, and there is no exploit to prevent — your times are your times.

## Scoring

Two modes, chosen per tournament:

| Mode | How it ranks |
|---|---|
| `points` (default) | On each pool map your best time is ranked against the other **entrants**, and the top 15 score 100 / 85 / 75 / … — the site's own points curve (`MAP_POINTS` in `web/tournaments.js`, locked to `POINTS` in `web/db.js` by a test). Your total is the sum across the pool. |
| `time_sum` | Your best time on each pool map, added up. Only players who finish **every** map are ranked; incomplete entries appear below the ranked field, greyed out. |

Ties share a place (1, 2, 2, 4). An exact-millisecond tie is common on short
maps, and the query's last tiebreak is `player_id` — arbitrary. `finalizeTournament`
therefore compares the whole scoring tuple and awards two identical trophies
rather than inventing a winner.

## Trophies

On finalize, `tournament_trophy` gets one row per scoring player: place 1/2/3
for the podium, place 0 for everyone else who scored at least one map. The
composite primary key is what makes minting idempotent — the same contract
`player_achievement` uses, and the reason the finalizer can run on both web
replicas without ever double-awarding.

Trophies ride the profile payload (`playerDetail.trophies`) rather than a lazy
endpoint: they are rare and usually an empty array, so a second fetch would cost
a round trip to render nothing.

## Scheduling and non-overlap

Tournaments are meant not to overlap, and that is enforced in three layers of
increasing firmness:

1. **The default is right.** `/admin/tournaments/new` pre-fills the start at
   `nextFreeTournamentSlot()` — the latest end among scheduled tournaments — so
   the obvious action produces a non-overlapping tournament with no thought.
2. **The form blocks it.** Saving a window that intersects another
   non-cancelled tournament is refused, naming the clash, unless the admin
   explicitly ticks *"Allow this to overlap"*.
3. **Series never overlap themselves.** A recurring tournament
   (`repeat_every_days > 0`) schedules its next edition `repeat_gap_days` after
   the previous one ends, so a series is structurally incapable of colliding
   with itself.

There is deliberately **no database exclusion constraint**, because the override
in (2) is a real requirement — sometimes you do want two at once. The residual
race (two admins saving overlapping windows in the same second) is visible
immediately on the calendar and fixable by editing a row. Note the consequence
if it happens: `liveTournament()` picks one (`ORDER BY starts_at DESC, id DESC`),
so the other is invisible to the game servers until the calendar is untangled.

Cancelled tournaments free their slot; drafts never occupy one.

## The finalizer

`db.finalizeDueTournaments()` runs on a plain interval (`TOURNAMENT_SWEEP_MS`,
default 5 min) on **both** web replicas, plus once ~20s after boot.

- **Freezing is safe to race.** `finalizeTournament` opens a transaction, takes
  `SELECT ... FOR UPDATE` on the tournament row, and re-checks that it is still
  a published, ended, un-finalized tournament *inside* that transaction. The
  loser of a race re-reads the committed row and no-ops. The inserts are
  `ON CONFLICT DO NOTHING` on top of that.
- **Series roll-forward is a reconciliation, not a follow-on step.** Scheduling
  the next edition cannot join the finalize transaction (it needs the finalized
  row committed to know the window it follows). If it were a follow-on step, a
  container recreate — which every deploy does — landing between the two would
  leave a weekly series permanently stuck with no next edition and nothing to
  notice. Instead the sweep asks the standing question *"does any finalized
  recurring tournament lack a successor?"* every pass, so the series heals
  itself no matter where it was interrupted.

## In-game

| Command | Effect |
|---|---|
| `/tournament` (`/tourney`) | What's on, its window, its pool, and how to enter |
| `/tournament <code>` | Redeem a website code — case and dashes don't matter |
| `/tournament join` | Enter right now as the nick you're playing under |
| `/tmaps` | Just the map pool |
| `callvote tourneymap [map]` | Move the server onto a pool map |

`hrace/tournament.as` polls `GET /api/game/tournament` every 60s through the
`RS_ApiFetchTourney` native and caches the parsed result, so the commands answer
from memory instead of blocking the frame. The payload is:

```
RSTOURNEY
T<TAB><id><TAB><slug><TAB><startsAt><TAB><endsAt><TAB><name>
M<TAB><mapname>
...
```

At most one `T` line — the tournament running *now*, or the next one due if none
is — followed by its pool. A bare header is the real "nothing scheduled" state.
Tab-delimited and line-walked with `RACE_LocateFrom`, because `getToken()` would
shred a multi-word tournament name.

`callvote tourneymap` resolves the pool against the engine's own installed-map
enumeration (`GetMapsByPattern`) before voting, so the server can never be voted
onto a map this box never downloaded — and then reuses `randmap`'s proven change
path (`randmap_passed` + `launchState(MATCH_STATE_POSTMATCH)`).

### The two new natives

`RS_ApiFetchTourney` / `RS_ApiPollTourney` / `RS_TourneyText` is the shared
lastmaps-shaped feed. `RS_ApiTourneyJoin` / `RS_ApiPollTourneyJoin` /
`RS_TourneyJoinText` is the odd one out: **the only POST in `g_rs_api.cpp` whose
reply is read**, because the player has to be told whether their code worked.
The response body is captured into their player slot and printed. It is never
retried — a reply landing minutes later would print to whoever holds the slot
then, and the player can simply type the command again.

The reply format is `RSTJOIN`, then `ok` or `err`, then one line per message.
The game colours by the status line and prints the text verbatim, so the web
owns the wording without AngelScript having to parse JSON.

## Things that will bite you

- **`finish` is only written for `source === 'racelog'`.** All tournament
  scoring reads the finish log, so a node whose racelog reporting breaks scores
  nothing for its players while the global leaderboard keeps updating via the
  topscores re-sync. Silent, per-node, no alarm.
- **The finish log starts 2026-07-22.** A tournament window earlier than that
  scores nothing.
- **Reverse runs are a different map.** A reverse race is recorded under
  `<map>-reversed` (`RACE_EffectiveMapName` in `hrace/racelog.as`), so a pool
  containing `coldrun` scores forward runs only. Add `coldrun-reversed` as its
  own pool entry to score the reverse direction.
- **Pool maps are created on demand.** `map` only holds maps somebody has
  raced, so requiring a pre-existing row would make "here are three brand-new
  maps, go" impossible. The admin form warns about pool maps nobody has ever
  finished, since that is more often a typo than a new map.
- **Admin times are UTC.** The form is labelled, `parseAdminTime` is UTC, and
  `toAdminTime` round-trips including seconds (the half-open
  `[starts_at, ends_at)` window lets back-to-back editions share a boundary
  second — truncating seconds on re-save would move it).
- **Deploy the web layer before the game layer.** `/api/game/tournament` and
  `/api/game/tournament/join` must answer before any node sets
  `rs_api_tourney_url`. The fail-open guard (empty cvar = feature off) is the
  only thing between players and a dead command otherwise.
- **Adding the natives forces a full engine rebuild** of both the Warsow and
  Warfork images (`server/Dockerfile:64` invalidation cascades into the
  `GAME_MODULES_ONLY=OFF` build). Budget ~20–30 min per image.

## Files

| Path | What |
|---|---|
| `web/migrations/20260801120000000_tournaments.sql` | schema + the model's rationale |
| `web/tournaments.js` | codes, scoring SQL, admin-form validation, the game payload |
| `web/db.js` (Tournaments section) | reads, writes, the finalizer, series scheduling |
| `web/server.js` | public API, game API, `/admin/tournaments`, the sweep timer, OG tags |
| `web/public/assets/js/app.js` | `/tournaments` calendar, `/tournaments/:slug`, profile trophy shelf |
| `server/racemod/source/progs/gametypes/hrace/tournament.as` | in-game commands + the vote |
| `server/enginepatches/g_rs_api.cpp` | the two native families |
| `web/test/tournaments.test.js` | 28 tests covering all of the above |
