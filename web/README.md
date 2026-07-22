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

On startup the server applies any pending schema migrations (see
[Schema migrations](#schema-migrations)) and builds `UNLOGGED` aggregate tables
(standings, per-map world records) — ~1s for the full ~237k-row database.

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
| `BACKUP_DIR`    | `/data/backups`                                  | where the `db-backup` sidecar publishes the [public backup](#public-database-backup) this server serves |
| `ADMIN_COOKIE_INSECURE` | *(unset)*                                | Set to `1` to drop the `Secure` flag on the admin session cookie for plain-HTTP local dev. Never set in production (the edge terminates TLS, so `req.secure` already adds `Secure`). |

## Schema migrations

The schema is managed by [node-pg-migrate](https://github.com/salsita/node-pg-migrate).
Versioned SQL files live in [`migrations/`](migrations); the runner records what
it has applied in a `pgmigrations` table.

Migrations run **automatically at startup** (`db.js` → `runSchemaMigrations`),
so a normal `npm start` / `docker compose up` needs no extra step. The runner
takes a Postgres advisory lock, so the two production web replicas booting
together can't race the schema. The baseline migration is idempotent
(`CREATE ... IF NOT EXISTS`), which is how it adopted the existing production
database without recreating anything.

Author a new change (never edit an applied migration — add a new one):

```bash
cd web
npm run migrate:create -- add_some_column     # writes migrations/<utc>_add-some-column.sql
# edit the file: fill in the -- Up Migration and -- Down Migration sections
```

Manual runs (the app does this for you at boot) use `DATABASE_URL`:

```bash
DATABASE_URL=postgres://racesow:racesow@127.0.0.1:5432/racesow npm run migrate -- up
DATABASE_URL=postgres://racesow:racesow@127.0.0.1:5432/racesow npm run migrate -- down    # roll back one
```

## Testing

`npm test` spins up an ephemeral throwaway database per test (each one is
migrated from scratch by `openDatabase`), so point `TEST_PG_URL` at any Postgres
owner connection (default `postgres://racesow:racesow@127.0.0.1:5433/racesow`).

## REST API

All responses are JSON. List endpoints accept `q`, `sort`, `order`
(`asc`/`desc`), `limit` and `offset`.

| Method & path            | Description                                                      |
|--------------------------|------------------------------------------------------------------|
| `GET /api/overview`      | Totals, per-version run counts, hall of fame.                    |
| `GET /api/maps`          | Maps with race count + world-record holder. Sort: `name`, `races`, `wr_time`. Filter with `q`. |
| `GET /api/maps/:id`      | Map detail: world record + split times, full leaderboard.        |
| `GET /api/players`       | Player standings. Sort: `points`, `wr`, `podium`, `maps`, `rank`, `name`, `active` (last raced). Filter with `q`. |
| `GET /api/players/:id`   | Player detail: standing + every map record (with per-map attempts/finishes). Sort: `map`, `time`, `rank`, `attempts`. |
| `GET /api/search?q=`     | Combined quick search across maps and players (typo-tolerant trigram). |
| `GET /api/live`          | Who is playing now, per enrolled server with a query address.    |
| `GET /api/records`       | New records after `after_id` (the Discord announcer's feed).     |
| `GET /api/game/topscores?map=` | A map's top-50 in the exact topscores file format the game reads. |
| `GET /api/health`        | Liveness check.                                                  |
| `GET /api/backup`        | Metadata for the latest [public database backup](#public-database-backup): filename, size, sha256, generated time, row counts, include/exclude lists. 404 until the first backup exists. |
| `POST /api/maps/:id/flag`| Public "flag this map for review". Body `{reason, note?}` where `reason` ∈ `broken`, `offensive`, `wrong_name`, `duplicate`, `other`. Anonymous, tightly rate-limited, and deduped per reporter (a salted hash of the IP, never stored raw); a repeat report returns `{ok:true, duplicate:true}`. Reviewed in the [admin area](#map-flags--admin-area). |
| `GET /api/maps/blocked` | Maps a moderator has blocked from play (JSON `{maps:[{id,name,reason,blockedAt,blockedBy}]}`). |
| `GET /api/game/blocked-maps` | Same, as plain text (one lowercased map name per line) — `server/entrypoint.sh` GETs this to drop blocked maps from `g_maplist` (vote pool + cycle). |
| `POST /api/game/flag`    | In-game `/flag` target. `Authorization: Bearer <per-server token>`; body `{map, reason?, player?, login?}`. Flags the map by name, deduped per player; stores the reporter's (colour-stripped) name. |
| `POST /api/ingest`       | Record ingest. `Authorization: Bearer <per-server token>`; body `{version, map, source, records:[{name, login, time, attempts, checkpoints}], attempts:[{name, login, count}]}`. Upserts best time per player/map/version, tallies finishes/attempts, recomputes the map's ranks, refreshes aggregates (debounced). |

Example:

```bash
curl 'http://localhost:8080/api/maps?q=aurora&sort=wr_time&order=asc&limit=10'
curl 'http://localhost:8080/api/players/47'
```

## Map flags & admin area

Visitors can **flag a map for review** (broken, offensive, wrong metadata,
duplicate, …) from the map page — a small form that POSTs to
`/api/maps/:id/flag`. Reports are anonymous, rate-limited, and deduped per
reporter, so the moderation queue reflects distinct people, not refresh-spam.

Moderators triage flags in a small **admin area at `/admin`**. It is
deliberately **not linked anywhere** on the public site and carries a
`noindex` header — you reach it by knowing the URL and having an account. Every
page is a plain server-rendered form (the production CSP forbids inline
scripts), gated by a DB-backed cookie session (`admin_session`: the browser
holds only an opaque random value, the DB stores its SHA-256, an absolute
expiry, and a per-session CSRF token). Passwords are `scrypt` hashes.

Accounts are created out-of-band with the CLI (there is no public sign-up):

```bash
cd web
# create an admin; prints a random password ONCE (or pass your own as a 2nd arg)
DATABASE_URL=$DATABASE_URL node admin.js admin-add elchupa
# in production, run it inside the web container so it uses the live DATABASE_URL:
#   docker compose exec web node admin.js admin-add elchupa

node admin.js admin-list                 # accounts + last login
node admin.js admin-passwd <user> [pw]   # reset a password (revokes sessions)
node admin.js admin-remove <user>        # delete an account (revokes sessions)
```

The moderator then signs in at `/admin/login` and can change their password at
`/admin/account`. Flags can also be reviewed entirely from the CLI:

```bash
node admin.js flags                 # open flags, grouped by map
node admin.js flags all             # full history
node admin.js resolve <flagId>      # close one flag   (resolve-map <mapId> for all)
node admin.js dismiss <flagId>      # dismiss one flag (dismiss-map <mapId> for all)
node admin.js block-map <mapId> [reason]   # pull a map from the vote pool + cycle (closes its flags)
node admin.js unblock-map <mapId>          # return it to rotation
node admin.js blocked                      # list blocked maps
```

**Blocking a map** removes it from the game servers' vote pool and map cycle:
`server/entrypoint.sh` fetches `GET /api/game/blocked-maps` when it builds
`g_maplist`, so a blocked map drops out on each game server's next restart.
Blocking is always an explicit moderator action (a single public flag never
auto-removes a map).

**Players can flag in-game** with `/flag <reason>` (reason optional). The
gametype's `Cmd_Flag` (`server/racemod/.../commands.as`) pulls the player's
name + MM login from their client and POSTs to `/api/game/flag` via the
`RS_ApiFlag` engine native — so the report shows up in the same queue, tagged
with who reported it.

## Operator console

The admin area also drives the enrolled game servers over **RCON**. Auth is
**per server** and lives in the DB (`server.rcon_password`), stored in
plaintext because the rcon protocol is cleartext anyway — only the admin routes
and CLI ever read it, never any public API. Register a server's password with:

```bash
node admin.js rcon <id> <password|->    # '-' clears it
```

**`/admin/servers`** lists every enrolled server with its live status and
whether RCON is configured. From here you can:

- Toggle **maintenance mode** — a persistent switch. While it is on the web app
  re-broadcasts the notice to all servers every few minutes and flips
  `GET /api/live`'s `maintenance` field to
  `{active:true, message, since}` (which raises the public banner on the Live
  page); turning it off sends an all-clear and returns `{active:false}`. The
  message may carry Warsow `^`-colour codes.
- Send a one-off **broadcast** message to all servers.

**`/admin/servers/<id>/rcon`** is a free-form RCON console: pick a command and
see the server's reply. Disruptive commands (`quit`, `killserver`, `exec`,
`rcon_password`, …) require ticking a confirm box first. Every command is
audit-logged.

**`/admin/logs`** is a newest-first tail of the operator log stream, with
filters by server, by source, and line count, and an auto-refresh (via
`meta`-refresh). Sources are `console` (the shipped game-server stdout),
`event` (the web app's own per-server activity: ingests, `/flag`, …), `rcon`,
and `maintenance`. Game servers ship their console to `POST /api/ingest/log`
(same per-server bearer token as `/ingest`); this is enabled by `LOG_SHIP=1`
(the default) when `INGEST_URL`+`INGEST_TOKEN` are set — see
[`../server/README.md`](../server/README.md).

As with flags, all of this can be driven from the CLI:

```bash
node admin.js rcon <id> <password|->     # set/clear a server's RCON password
node admin.js broadcast "<msg>"          # one-off broadcast to all servers
node admin.js maintenance <on|off> [msg] # toggle maintenance mode (with a notice)
node admin.js logs [serverId|all] [n]    # tail the operator log stream
```

Like the admin pages, these routes and commands are the only readers of
`server.rcon_password`.

Two env vars tune this on the web side: `MAINT_REBROADCAST_SECS` (default `180`)
is how often maintenance mode re-broadcasts its notice while active, and
`LOG_KEEP` (default `20000`) caps how many `server_log` rows are retained (older
rows are pruned). The game-side shipping cadence (`LOG_SHIP`, `LOG_FLUSH_SECS`,
`LOG_BATCH_LINES`) lives in [`../server/README.md`](../server/README.md).

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

## Public database backup

A weekly, publicly downloadable snapshot of the race records so anyone can run
their own instance or analyse the data:

| URL | Purpose |
| --- | --- |
| `GET /backup/racesow-db-latest.zip` | download the latest backup (plain-SQL PostgreSQL dump, zipped) |
| `GET /api/backup` | its metadata (size, sha256, generated time, row counts) |

It is produced by the `db-backup` sidecar (`../backup/`, wired in the top-level
`docker-compose.yml`) — a self-scheduling container that dumps into
`./data/backups`, which this server serves via `BACKUP_DIR` (default
`/data/backups`). The dump includes races, checkpoints, run tallies, players,
maps, versions, replay metadata, and game-server **names**, but **excludes**
admin accounts/sessions, ingest API tokens (`server.token_hash`), game-server
IPs (`server.address`), and moderation data (`map_flag`, `map_block`). Mesh keys
and `INGEST_TOKEN` live in env/config and are never in the database. See
[`../backup/README.md`](../backup/README.md) for restore steps.

## Files

- `server.js` — Express app: API routes + static hosting + SPA fallback + OG cards.
- `db.js` — PostgreSQL data layer: runs migrations at startup, builds aggregate
  tables, trigram search, ingest, all query logic.
- `migrations/` — versioned node-pg-migrate schema files (`<utc>_<name>.sql`).
- `migrate-sqlite-to-pg.js` — one-time SQLite → PostgreSQL data copy.
- `admin.js` — CLI: enroll/list/revoke servers, set Live addresses, rebuild
  canonical player groups, manage moderator accounts (`admin-add`/`-list`/
  `-passwd`/`-remove`) and review map flags (`flags`/`resolve`/`dismiss`).
- `seed-topscores.js` — write the game server's topscores files from the DB.
- `public/` — the frontend (`index.html`, `assets/css`, `assets/js`).
