# Design: per-player-per-map demos & replays

Status: **implemented** (layers 1–4 complete + tested; layer 5 partial — see below).

## Implementation status (2026-07-16)

- ✅ **Schema/migration** (`20260716000000000_per_player_replays.sql`): per-player
  tables, backfill, old tables dropped, reversible down.
- ✅ **db.js**: `upsertPlayerDemo`/`upsertPlayerGhost` (canonical-player keyed,
  faster-only per player-map), per-player ghost files + idempotent boot relayout,
  `ghostGzip(mapId, playerId?)`, leaderboard/player-profile joins, WR = fastest.
- ✅ **server.js**: per-player ingest, `/api/maps/:id/ghost?player=`.
- ✅ **Frontend**: replay/demo links on every leaderboard row + player-profile
  finished-map row; replay view keyed `#/replay/:mapId/:playerId`.
- ✅ **Game module** (`player.as`): demo+ghost upload on every personal best;
  only PB demos are kept (non-PB runs canceled).
- ⚠️ **Layer 5 (engine demo retention) — PARTIAL.** The base engine still caps how
  many demos it keeps per map, so a *downloadable demo* is guaranteed only for the
  fastest few per map. Browser-replay **ghosts work for every player** (web-stored).
  Full per-rank demo retention (and deleting a player's superseded PB demo on
  improvement) needs a base-engine patch or a prune/cleanup job — see Open risks.
- Tests: web suite 40/40 (incl. per-player cases). Game-module + frontend need a
  live game-server rebuild + manual verification on deploy.

---

Original proposal below.

## Goal

Today the replay feature stores exactly **one demo + one ghost per map** (the
world record). We want:

1. The **top record demo per map** (unchanged capability), plus
2. The **fastest run per player per map** — a demo *and* a browser-replay ghost
   for every (player, map) the player has finished,
3. surfaced in the **map leaderboard** (a replay/demo link on each player row)
   and on each **player profile** (demo + replay links for every map they've
   finished).

Retention: **keep every player's PB** (one per (player, map), unbounded) — the
map WR is simply the fastest of them.

## Data model

Replace the map-keyed tables with **(map_id, player_id)-keyed** tables; the map
WR becomes a query (`MIN(time)` per map), not a separate row.

```sql
CREATE TABLE player_demo (
  map_id      BIGINT NOT NULL REFERENCES map(id)    ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,           -- finish time ms; == the .wd filename suffix
  demo_path   TEXT    NOT NULL,           -- "<map>/<map>_<player>_<MM-SS-mmm>.wdz20" (2 segments)
  bytes       BIGINT,
  server_id   BIGINT,
  captured_at BIGINT  NOT NULL,
  PRIMARY KEY (map_id, player_id)
);
CREATE INDEX idx_player_demo_map_time ON player_demo(map_id, time);  -- WR + leaderboard join
CREATE INDEX idx_player_demo_player   ON player_demo(player_id);     -- player profile

CREATE TABLE player_ghost (
  map_id      BIGINT NOT NULL REFERENCES map(id)    ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,
  hz          INTEGER NOT NULL,
  frames      INTEGER NOT NULL,
  bytes       BIGINT,
  server_id   BIGINT,
  captured_at BIGINT  NOT NULL,
  PRIMARY KEY (map_id, player_id)
);
CREATE INDEX idx_player_ghost_map_time ON player_ghost(map_id, time);
CREATE INDEX idx_player_ghost_player   ON player_ghost(player_id);
```

**Ghost bytes on disk** move from one-per-map to per-player:
`GHOST_DIR/<mapId>.json.gz` → `GHOST_DIR/<mapId>/<playerId>.json.gz`.

### Migration (`web/migrations/…_per_player_replays.sql`)

1. Create `player_demo`, `player_ghost` (+ indexes).
2. Backfill from the existing WR tables:
   `INSERT INTO player_demo SELECT map_id, player_id, … FROM wr_demo;` (same for
   ghost). Every existing WR row is a valid (map, player) PB.
3. `DROP TABLE wr_demo, ghost;` (all code moves to the new tables).
4. Ghost files: a one-time boot step in `openDatabase` moves any legacy
   `GHOST_DIR/<mapId>.json.gz` to `GHOST_DIR/<mapId>/<playerId>.json.gz` using
   the migrated `player_ghost` row (idempotent; skip if already moved).

Down migration recreates `wr_demo`/`ghost` from the fastest row per map.

## Web API (`web/db.js`, `web/server.js`)

- **Ingest** (`POST /api/ingest` `source:"wr_demo"` and `POST /api/ingest/ghost`)
  keep the *same wire payload* (they already carry player name+login) but upsert
  per **(map_id, player_id)**, faster-only:
  - `upsertPlayerDemo` → `ON CONFLICT (map_id, player_id) DO UPDATE … WHERE EXCLUDED.time <= player_demo.time`.
  - `upsertPlayerGhost` → same guard; writes `GHOST_DIR/<mapId>/<playerId>.json.gz`;
    on a faster replacement, unlinks the old file (path is deterministic).
  - Keep the source name `wr_demo` for wire back-compat, or rename to
    `player_demo`; the game module sends whichever we choose (see below).
- **Map detail** (`GET /api/maps/:id`): the leaderboard rows already come from a
  ranked query; LEFT JOIN `player_demo` + `player_ghost` on (map_id, player_id)
  so each row carries `{ demo: {url,bytes}?, ghost: {time,frames}? }`. The
  rank‑1 row is the map WR (keeps the prominent buttons).
- **Player detail** (`GET /api/players/:id`): the per-map records list LEFT JOINs
  the two tables on (player_id) so each finished map carries its demo/ghost
  links.
- **Replay data**: generalize the browser-viewer route to a player:
  `GET /api/maps/:mapId/ghost?player=:playerId` (default = the map WR player when
  omitted, preserving old links). `ghostGzip(mapId, playerId)` reads the
  per-player file.
- **In-game WR ghost** (`GET /api/game/ghost?map=`): unchanged behavior — serve
  the **fastest** ghost for the map (`MIN(time)` via `idx_player_ghost_map_time`).

## Game server (`server/racemod/…`) + engine

- **Upload trigger** (`player.as`): today demo+ghost upload is gated on
  `pos == 0` (local #1 ≈ WR). Move `RACE_ReportWrDemo` + `RACE_UploadWrGhost`
  into the **personal-best** block (`!best.isFinished() || finishTime < best`,
  line ~889) so every PB uploads. The web's faster-only guard makes duplicate/
  stale reports safe. Rename to `RACE_ReportPlayerDemo` / `RACE_UploadPlayerGhost`
  for clarity (same `RS_*` natives; payload already per-player).
- **Demo retention (the hard part — enginepatch):** the engine's `demoStop`
  currently keeps "the fastest few demos per map." For per-player PBs we need
  **one retained demo per (player, map) = that player's PB**:
  - On a **PB finish** → `demoStop` (keep, named `…_<player>_<time>.wdz20`) and
    **delete the player's previous PB demo** for this map (superseded file), so
    each (player,map) keeps exactly one file, not one per improvement.
  - On a **non-PB finish** → `demoCancel` (discard).
  - This requires changing the engine's demo-pruning from "fastest few per map"
    to "keep per-player PB" (server/enginepatches). **Highest-risk item** —
    needs a read of the demo subsystem in the patched module before we commit an
    approach; fallback is keep-all + a periodic prune job keyed off `player_demo`.

## Frontend (`web/public/assets/js/app.js`, `replay.js`)

- **Map leaderboard**: on each player row, render `▶ replay`
  (→ `#/replay/:mapId/:playerId`) when a ghost exists and `⬇ demo` when a demo
  exists. The WR row keeps the large buttons.
- **Player profile**: each finished-map row gets `▶ replay` + `⬇ demo` links.
- **Replay view**: route `#/replay/:mapId/:playerId`; fetch
  `/api/maps/:mapId/ghost?player=:playerId`. Old `#/replay/:mapId` links resolve
  to the map WR player.

## Storage / ops

- **Ghosts** (web `/data/ghosts/<mapId>/<playerId>.json.gz`) and **demos**
  (game host `demos/…`, exported to the pak mirror) both grow unbounded — one
  per (player, map). Budget: ~tens of KB (ghost) + ~tens–hundreds of KB (demo)
  per pair. Document the growth; both live on box volumes, not in git.
- **Backfill is forward-only**: existing WR demos/ghosts migrate; historical
  *non-WR* PBs were never captured, so they populate as players set PBs from
  here on. The UI must treat "no demo/ghost yet" as the common case.

## Rollout order (single feature, but staged commits)

1. Schema migration + `db.js` methods + ghost-file relayout (backfill).
2. API: ingest per-player, map/player detail joins, per-player replay route.
3. Frontend: leaderboard + profile links, per-player replay view.
4. Game module: upload on every PB.
5. Enginepatch: per-player demo retention (or the keep-all + prune fallback).

Steps 1–3 are testable immediately against migrated WR data; 4–5 make new
per-player data flow in.

## Open risks

- **Enginepatch demo retention** is the riskiest change; needs the demo
  subsystem read first. Keep-all + prune-job is the safe fallback.
- **Unbounded disk** on both the web `/data` volume and the game host — needs
  monitoring; a future cap/prune (top-N) can be layered on `idx_*_map_time`.
- Demo files for a deleted/renamed player: `ON DELETE CASCADE` drops the rows,
  but the on-disk demo/ghost files need a matching cleanup (unlink on delete).
