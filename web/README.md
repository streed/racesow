# Racesow Stats — Web Server

A small **Node.js + Express** server that hosts the livesow race SQLite
database behind a REST API and serves a retro-modern single-page frontend for
browsing world records, maps and player rankings.

The database is queried **live** (nothing is pre-baked into static files), so
the site always reflects the current `data/db.sqlite`.

## Run locally

```bash
cd web
npm install
DB_PATH=../data/db.sqlite npm start
# open http://localhost:8080
```

On startup the server adds a few indexes to the DB (if writable) and builds
in-memory aggregate tables (standings, per-map world records). This takes ~1s
for the full 240k-row database.

## Run with Docker

From the repository root:

```bash
docker compose up -d --build web
# open http://localhost:8080
```

The `data/` directory is mounted read-write at `/data` so the server can add
indexes. Set it read-only if you prefer — the server falls back gracefully and
just runs a little slower.

## Configuration

| Env var   | Default                 | Meaning                        |
|-----------|-------------------------|--------------------------------|
| `PORT`    | `8080`                  | HTTP listen port               |
| `DB_PATH` | `../data/db.sqlite`     | Path to the SQLite database    |

## REST API

All responses are JSON. List endpoints accept `q`, `sort`, `order`
(`asc`/`desc`), `limit` and `offset`.

| Method & path            | Description                                                      |
|--------------------------|------------------------------------------------------------------|
| `GET /api/overview`      | Totals, per-version run counts, top maps, hall of fame.          |
| `GET /api/maps`          | Maps with race count + world-record holder. Sort: `name`, `races`, `wr_time`. Filter with `q`. |
| `GET /api/maps/:id`      | Map detail: world record + split times, full leaderboard.        |
| `GET /api/players`       | Player standings. Sort: `points`, `wr`, `podium`, `maps`, `rank`, `name`. Filter with `q`. |
| `GET /api/players/:id`   | Player detail: standing + every map record. Sort: `map`, `time`, `rank`. |
| `GET /api/search?q=`     | Combined quick search across maps and players.                   |
| `GET /api/health`        | Liveness check.                                                  |

Example:

```bash
curl 'http://localhost:8080/api/maps?q=aurora&sort=wr_time&order=asc&limit=10'
curl 'http://localhost:8080/api/players/47'
```

## How the data is interpreted

- **Times** are milliseconds; the UI renders them as a race clock
  (`10.238`, `1:32.560`).
- **Player names** carry Warsow `^0`–`^9` colour codes. The API returns both
  the raw coloured name and a `simplified` (plain-text) form; the frontend
  renders the colours.
- **Points**: a player scores on each map by their best global rank
  (top-15 scoring, `100, 85, 75 … 32`). A player counts once per map (their
  best time across all game versions).
- **World-record splits** are the non-zero checkpoint times of the record run,
  sorted ascending (in this database `checkpoint.number` is a spatial index,
  not pass order, and many rows are zero-padding).

## Files

- `server.js` — Express app: API routes + static hosting + SPA fallback.
- `db.js` — opens the DB, builds aggregate tables, all query logic.
- `public/` — the frontend (`index.html`, `assets/css`, `assets/js`).
