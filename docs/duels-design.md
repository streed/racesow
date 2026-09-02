# Duels

1v1 head-to-heads, agreed and raced in game, resulting in one row on two
profiles.

## The one idea worth remembering

**A duel owns no runs, and a live duel exists only in one game server's memory.**

Nothing about how a finish is recorded changes. A duel is a *bracket* the game
server holds around a stretch of ordinary racing: it watches the finishes two
players are already producing, keeps each one's best, and when it ends it POSTs
a single summary. The runs themselves went to `/api/ingest` exactly as they
always did and count for the leaderboard exactly as they always did.

Two consequences fall straight out of that:

- **A duel cannot corrupt anything.** The worst a bug in `duel.as` can do is
  produce a wrong `duel` row or none at all. Records, ranks, SR and points are
  reached by a code path duels never touch.
- **There is no "live duel" on the website, and that is deliberate.** A duel
  that is still running has no result, cannot outlive the map it is on, and is
  visible to the two people racing it. Publishing it would mean keeping a web
  row in step with a game server that may vanish mid-map, in exchange for
  showing an unfinished thing. So the web hears about a duel exactly once:
  when it is over.

## The rules, as the players experience them

```
/duel <player>     challenge someone on the map you are both on
/accept /decline   answer a challenge (60s to do it)
/duel              your score, or the challenges waiting for you
/forfeit           concede
```

A duel starts when the challenge is accepted, and from that moment **every
non-practice finish either player records on that map counts**. Your fastest is
your time; the faster time leads. The lead can change hands as often as they can
beat each other.

It ends on whichever comes first:

| Trigger | Result |
| --- | --- |
| The map changes | Faster time wins (`map_change`) |
| Someone `/forfeit`s | The forfeiter loses, **however fast they were** (`forfeit`) |
| Someone leaves and stays gone `rs_duel_grace` seconds (default 300) | Faster time wins (`disconnect`) |

If a player reconnects inside the grace period the duel simply carries on with
the times they had already set. If neither player ever finished, nothing is
recorded — two people stood on a map and the map changed.

### Only the two of them see any of it

Every message a duel produces is printed to the two duellists. Not the server.
A duel is a private arrangement between two players, and on a full server the
alternative is a wall of somebody else's splits.

## The three decisions that shape the code

**1. A duellist is a clean NAME, not a client slot.**

The grace period is the reason. A player who drops and reconnects lands in
whatever slot is free, so a slot number stops meaning them the instant they
leave. Identity is therefore the colour-stripped lowercase name — the same key
saved starts, awards and player records already use to survive a reconnect.

The name→slot binding is rebuilt from scratch in the think sweep rather than
patched from the connect/disconnect events, so exactly one piece of code decides
who is present and it cannot drift out of step with reality.

**2. The game decides the winner; the web stores the verdict.**

It is tempting to send two times and let the web work out who won. That breaks
on forfeits: a player who concedes loses however fast they were, and only the
game knows a forfeit happened. So `winner` is on the wire, and the API validates
that it is one of `a` / `b` / draw rather than recomputing it.

**3. Direction is part of the duel.**

`/reverse` is a different leaderboard (`<map>-reversed`), so a reversed run
cannot be compared against a forward one. The duel fixes its direction at accept
time from the challenger's, counts only finishes in that direction, and tells a
player *once* when a run did not count — repeating it every lap of a reverse
practice session would be worse than saying nothing. The stored row carries the
reversed map name, exactly like a reversed finish, so nothing needs a separate
direction flag.

## Where the pieces live

| Piece | File |
| --- | --- |
| Challenge, live scoring, grace, conclusion | `server/racemod/source/progs/gametypes/hrace/duel.as` |
| Scoring hook (one call from the finish path) | `hrace/player.as` `completeRace()` |
| Command dispatch + registration, think, map-end | `hrace.as` |
| The report native | `server/enginepatches/g_rs_api.cpp` `RS_ApiReportDuel` |
| Its AngelScript registration | `server/enginepatches/patch-api-natives.py` |
| The endpoint URL cvar | `server/entrypoint.sh`, `warfork/entrypoint.sh` (`rs_api_duel_url`) |
| Ingest endpoint | `web/server.js` `POST /api/game/duel` |
| Storage + read model | `web/db.js` `recordDuel` / `playerDuels` |
| Schema | `web/migrations/20260902120000000_duels.sql` |
| Profile card | `web/public/assets/js/app.js` `duelsCard` |

## The wire format

`RS_ApiReportDuel` POSTs once, fire-and-forget, under the server's ingest token:

```json
{
  "version": "wsw 2.1",
  "map": "coldrun",
  "winner": "a",
  "reason": "map_change",
  "duration": 842,
  "a": { "player": "^2reed",  "login": "", "time": 34109, "finishes": 12 },
  "b": { "player": "tudduf",  "login": "", "time": 34812, "finishes": 9 }
}
```

`time` is `null`, never `0`, for a player who never finished — a real and common
outcome, and a `0` would sort as the fastest run ever recorded. The report rides
the same queue as finish reports (`REQ_POST_REPORT`), so it is retried and never
evicted to make room for something else.

## Storage notes

`duel.player_a` / `player_b` / `winner_id` are **canonical representative ids**
at insert time, the same convention as `tournament_entrant`. Reads map stored
ids through `canonical_id` in both directions, because a canonical rebuild can
pick a new representative for an alias group and the stored id then no longer
equals what the nick resolves to — comparing raw would hide a player's own
history from them.

`winner_id IS NULL` means a draw. Two nicks that resolve to the same person are
refused rather than stored: whatever happened in game, a player against
themselves is not a match-up.

## What is deliberately not here

- **No duel leaderboard or duel rating.** The profile shows a W–L–D record and
  the recent match-ups. A separate ranking is a different feature with its own
  fairness questions (who can duck whom, what a win against a beginner is
  worth), and it can be built on this table later without changing anything.
- **No cross-server duels.** A duel needs both players finishing the same map
  under one clock. The mesh mirrors *presence*, not finishes, so a mesh bot is
  explicitly refused as an opponent.
- **No spectator view.** See "only the two of them see any of it".
