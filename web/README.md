# Racesow Stats — Web Server

A small **Node.js + Express** server backed by **PostgreSQL** that hosts the
race database behind a REST API and serves a retro-modern single-page frontend
for browsing world records, maps and player rankings.

The database is queried **live** (nothing is pre-baked into static files).

## Run locally

Needs a reachable PostgreSQL (`DATABASE_URL`). The quickest throwaway one:

```bash
docker run -d --name racesow-pg -p 5432:5432 \
  -e POSTGRES_USER=racesow -e POSTGRES_PASSWORD=racesow -e POSTGRES_DB=racesow \
  postgres:16-alpine

cd web
npm install
DATABASE_URL=postgres://racesow:racesow@127.0.0.1:5432/racesow npm start
# open http://localhost:8080

# optional: seed from the bundled livesow snapshot
DATABASE_URL=postgres://racesow:racesow@127.0.0.1:5432/racesow \
  node migrate-sqlite-to-pg.js ../data/db.sqlite
```

On startup the server bootstraps/migrates the schema and builds `UNLOGGED`
aggregate tables (standings, per-map world records) — ~1s for the full
~237k-row database.

## Run with Docker

From the repository root (compose brings up `postgres` + `web` + `discord`):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d --build
# open http://localhost:8080
```

## Configuration

| Env var         | Default                                          | Meaning                     |
|-----------------|--------------------------------------------------|-----------------------------|
| `PORT`          | `8080`                                           | HTTP listen port            |
| `DATABASE_URL`  | `postgres://racesow:racesow@127.0.0.1:5432/racesow` | PostgreSQL connection    |
| `PG_POOL_SIZE`  | `10`                                             | pg connection pool size     |

## Testing

`npm test` spins up an ephemeral throwaway database per test, so point
`TEST_PG_URL` at any Postgres owner connection (default
`postgres://racesow:racesow@127.0.0.1:5433/racesow`).

## REST API

All responses are JSON. List endpoints accept `q`, `sort`, `order`
(`asc`/`desc`), `limit` and `offset`.

| Method & path            | Description                                                      |
|--------------------------|------------------------------------------------------------------|
| `GET /api/overview`      | Totals, per-version run counts, top maps, hall of fame.          |
| `GET /api/maps`          | Maps with race count + world-record holder. Sort: `name`, `races`, `wr_time`. Filter with `q`. |
| `GET /api/maps/:id`      | Map detail: world record + split times, full leaderboard.        |
| `GET /api/players`       | Player standings. Sort: `points`, `wr`, `podium`, `maps`, `rank`, `name`. Filter with `q`. |
| `GET /api/players/:id`   | Player detail: standing + every map record (with per-map attempts/finishes). Sort: `map`, `time`, `rank`, `attempts`. |
| `GET /api/search?q=`     | Combined quick search across maps and players (typo-tolerant trigram). |
| `GET /api/live`          | Who is playing now, per enrolled server with a query address.    |
| `GET /api/records`       | New records after `after_id` (the Discord announcer's feed).     |
| `GET /api/game/topscores?map=` | A map's top-50 in the exact topscores file format the game reads. |
| `GET /api/health`        | Liveness check.                                                  |
| `POST /api/ingest`       | Record ingest. `Authorization: Bearer <per-server token>`; body `{version, map, source, records:[{name, login, time, attempts, checkpoints}], attempts:[{name, login, count}]}`. Upserts best time per player/map/version, tallies finishes/attempts, recomputes the map's ranks, refreshes aggregates (debounced). |

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

- `server.js` — Express app: API routes + static hosting + SPA fallback + OG cards.
- `db.js` — PostgreSQL data layer: schema bootstrap/migrations, aggregate
  tables, trigram search, ingest, all query logic.
- `migrate-sqlite-to-pg.js` — one-time SQLite → PostgreSQL data copy.
- `admin.js` — enroll/list/revoke servers, set Live addresses, rebuild
  canonical player groups.
- `seed-topscores.js` — write the game server's topscores files from the DB.
- `public/` — the frontend (`index.html`, `assets/css`, `assets/js`).
