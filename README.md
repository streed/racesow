# Racesow — Warsow Race Server, Stats Site & Discord Announcer

Everything you need to run a **Warsow 2.1 race community** in Docker:

1. **`server/`** — a Dockerized **Warsow 2.1.2 dedicated race server** running
   our **fork of the `hrace` racemod** (vendored at `server/racemod/`), which
   POSTs every finished race straight to the stats API from the game module.
2. **`web/`** — a **Node.js + PostgreSQL** web server that hosts the race
   database behind a REST API (including the authenticated `/api/ingest`
   endpoint) and a retro-modern stats website (world records, maps, player
   rankings — all live-queried, searchable and sortable, with typo-tolerant
   trigram search). A **Live tab** shows who is playing right now on every
   enrolled server with a query address (UDP `getstatus`, polled server-side;
   enable per server with `node admin.js address`), and player pages are
   shareable as `/player/<id>` with server-rendered Open Graph stats for
   Discord/social unfurls.
3. **`discord/`** — a small service that posts **new race records to a Discord
   webhook** (it polls the stats API — no database access of its own).
4. **`postgres`** (compose service, `pgdata` volume) — the race database. The
   legacy `data/db.sqlite` remains only as the one-time migration source and a
   rollback artifact (see *The database* below).

```
racesow/
├── docker-compose.yml     # postgres + web + discord services
├── data/
│   └── db.sqlite          # LEGACY: migration source / rollback artifact only
├── server/                # Warsow dedicated race server (Docker)
│   ├── Dockerfile · entrypoint.sh · docker-compose.yml
│   ├── configs/           # server.cfg · mappool.txt
│   ├── racemod/           # vendored hrace mod fork (see racemod/UPSTREAM)
│   ├── topscores/         # ← mod-written records (bind mount, gitignored)
│   └── racelog/           # ← mod-written race-finish events (bind mount)
├── collector/             # legacy: /api/ingest shipper for stock (unmodified) servers
├── web/                   # Node API + frontend
│   ├── server.js · db.js · migrate-sqlite-to-pg.js · Dockerfile
│   └── public/            # index.html · assets/{css,js,img}
└── discord/               # Discord record announcer
    └── announcer.js · Dockerfile
```

## How records reach the database

Our racemod fork reports every finished (non-practice) race straight from the
game module (`racelog.as` → the `RS_ApiReportRace` native, on a background
thread) to the web service's `/api/ingest` (per-server bearer token), which
upserts best times into PostgreSQL, recomputes per-map ranks, and refreshes
the site's aggregates. A local `server/racelog/events.log` audit trail is
still written alongside. The Discord announcer then spots the new race ids on
its next poll of `/api/records`. (The standalone **`collector/`** — which
tails `racelog`/`topscores` files and ships them to `/api/ingest` — remains
only for feeding the site from a *stock, unmodified* race server; see
[`AGENT.md`](AGENT.md).)

## Quick start

> **Note:** the live datastore is **PostgreSQL** (the `postgres` compose
> service). A fresh deploy starts with an empty database; to seed it from the
> historical **livesow** snapshot, migrate the bundled `data/db.sqlite` once
> (see *The database*). That file (~66 MB) is stored in **Git LFS** — install
> [git-lfs](https://git-lfs.com) and `git lfs pull` before migrating, or it is
> just a small pointer file.

### Stats website + Discord announcer

Set a Postgres password first (compose requires it):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose up -d --build
# stats site:  http://localhost:8080

# one-time: seed Postgres from the bundled livesow snapshot (optional)
docker compose run --rm web node migrate-sqlite-to-pg.js /data/db.sqlite
```

Set your Discord webhook to enable announcements:

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/…" docker compose up -d
```

(Without a webhook the announcer runs in harmless dry-run/log mode.)

### Guided install

`scripts/setup.sh` walks through either deployment shape — it checks/installs
Docker, asks the right questions, and wires everything up:

```bash
scripts/setup.sh agent   # game server only, pushing records to a remote
                         # stats site (asks for the ingest URL + token)
scripts/setup.sh full    # website + Discord announcer + game server on one
                         # box, enrolled against each other automatically
```

For production boxes, `systemd/install.sh [full|agent]` then installs systemd
units on top: explicit boot ordering (web stack before game server),
`systemctl status racesow-*`, and a nightly `pg_dump` backup into
`backups/db/` (`racesow-db-backup.timer`, 14-day retention).

### Game server

The Warsow server is a separate, heavier image (it downloads the ~465 MB
official distribution and builds the racemod):

```bash
cd server
docker compose up -d --build
# connect a Warsow 2.1 client to <host>:44400
```

## The pieces

### 🎮 Game server (`server/`)

- Base **Ubuntu 18.04** (matches the 2018 Warsow build's glibc).
- Downloads **Warsow 2.1.2** from `warsow.net`, strips non-Linux/client files.
- Builds the **vendored racemod fork** (`server/racemod/`, gametype `hrace`,
  forked from `DenMSC/wsw-race` — see `server/racemod/UPSTREAM`) by zipping
  its `source/` tree into a `.pk3` — Warsow's AngelScript VM compiles it at
  runtime, so there is no separate build step. Our fork adds
  `hrace/racelog.as`, which appends every finished race to
  `racelog/events.log` for the collector.
- Env-driven config (hostname, slots, public/private, rotation) and a restart
  loop mirroring the community `start.sh`.

See [`server/README.md`](server/README.md). The racemod is based on the work of
**hettoo** and **DenMSC** ([hettoo/wsw-race](https://github.com/hettoo/wsw-race/tree/racemod),
[DenMSC/wsw-race](https://github.com/DenMSC/wsw-race/tree/racemod)).

### 📊 Stats website (`web/`)

- **Express** server backed by **PostgreSQL** (`DATABASE_URL`); it bootstraps
  and migrates the schema at startup and builds `UNLOGGED` aggregate tables
  (~1s), rebuilt after each ingest, for fast queries.
- Flexible REST API — search, sort and paginate maps and players; drill into map
  leaderboards (with world-record split times) and player profiles; plus an
  authenticated `POST /api/ingest`, `GET /api/servers`, and `GET /api/records`
  (the announcer's feed). Search is `pg_trgm` trigram-indexed, so substring
  matches are fast and typo-tolerant (`elchpa` finds `ELchupa`).
- Vanilla-JS single-page frontend with a Warsow-inspired "going fast" theme;
  renders Warsow `^0`–`^9` colour-coded player names.

Beyond raw leaderboards it computes:

- **Perfect run** per map — the sum of the fastest recorded split for every
  segment (start→cp1→…→finish), stitched across players, shown against the WR.
- **Attempts vs records** — every race START is counted (an *attempt*) and
  every finished run (a *finish*), both separate from the number of ranked
  best-times (*records*).
- **Canonical players** — variants of one person collapse to a single profile,
  displayed as the **last nick we've seen them use**, so leaderboards aren't
  fragmented across `^1Foo`/`^2Foo`/`Foo(1)`. Grouping is exact after stripping
  colour codes, lowercasing, and dropping a trailing `(N)` collision suffix —
  and nothing else, so nicks that differ by spacing or punctuation stay
  separate. A non-empty login keys the account instead of the nick; distinct
  logins never merge.

See [`web/README.md`](web/README.md) for the full API reference, and
[`AGENT.md`](AGENT.md) for running a game server that feeds a central site.

### 🔔 Discord announcer (`discord/`)

- Polls the stats API (`GET /api/records`) — it needs no database access of its
  own — and posts rich embeds to a Discord webhook (world records by default;
  configurable to podiums/top-N).
- Detects new records by race id and baselines on first run, so it never floods
  the channel with history.

See [`discord/README.md`](discord/README.md).

## The database

The live store is **PostgreSQL** (the `postgres` compose service, `pgdata`
volume). Historical data was seeded from the livesow race API
(`http://livesow.net/race/api/db.sqlite`) via a **one-time migration** of the
bundled `data/db.sqlite`:

```bash
docker compose run --rm web node migrate-sqlite-to-pg.js /data/db.sqlite
```

The web service bootstraps and versions the schema on connect; the tables are:

| Table        | Rows    | Notes                                                        |
|--------------|---------|-------------------------------------------------------------|
| `map`        | 4,757   | `id`, `name`                                                |
| `player`     | ~12,000 | `name` carries `^0`–`^9` colour codes; `simplified` plain; `canonical_id` → representative row |
| `race`       | ~237,000| best time per player/map/version; `global_rank`, `version_rank`; `server_id`, `created_at` (ingested rows) |
| `checkpoint` | ~789,000| split times (absolute ms; `number` is a spatial index)      |
| `version`    | 4       | wsw 1.0 / 1.5 / 2.1 and warfork 2.1                          |
| `run_tally`  | —       | finishes and attempts per player/map/version                |
| `canonical`  | —       | name-group key → representative player id                   |
| `server`     | —       | enrolled game servers: name, token hash, status, last-seen  |

All times are **milliseconds**. `global_rank = 1` is a world record. Ingested
race ids come from a monotonic `config.next_race_id` counter so improved records
always get a strictly higher id (how the announcer detects them).

**Backups:** `scripts/backup-db.sh` runs `pg_dump` (custom format, gzipped)
into `backups/db/`; restore with `pg_restore` (see the script header).

## Notes

- Warsow was discontinued; `warsow.net` and the livesow snapshot are
  community-hosted and may change. The game server works fine for LAN /
  direct-connect regardless of master-server availability.
- Set `POSTGRES_PASSWORD` (in `.env`) before `docker compose up`; compose
  requires it. Use per-server ingest tokens (`node admin.js enroll`) — the
  optional shared `INGEST_TOKEN` default is a well-known placeholder, so set a
  real one or leave it empty before exposing port 8080.

## Credits

Warsow by the Warsow team · racemod by **hettoo** & **DenMSC** · race database &
infrastructure by the **livesow** / **Racenet** community.
