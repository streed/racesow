# Racesow — Warsow Race Server, Stats Site & Discord Announcer

Everything you need to run a **Warsow 2.1 race community** in Docker:

1. **`server/`** — a Dockerized **Warsow 2.1.2 dedicated race server** running
   our **fork of the `hrace` racemod** (vendored at `server/racemod/`), which
   logs every finished race to an event file.
2. **`collector/`** — a sidecar that tails the server's race event log and
   pushes results into the stats database via the web API, so records set on
   the server show up on the site and in Discord live.
3. **`web/`** — a **Node.js + SQLite** web server that hosts the race database
   behind a REST API (including the authenticated `/api/ingest` endpoint) and
   a retro-modern stats website (world records, maps, player rankings — all
   live-queried, searchable and sortable). A **Live tab** shows who is playing
   right now on every enrolled server with a query address (UDP `getstatus`,
   polled server-side; enable per server with `node admin.js address`), and
   player pages are shareable as `/player/<id>` with server-rendered Open
   Graph stats for Discord/social unfurls.
4. **`discord/`** — a small service that posts **new race records to a Discord
   webhook**.
5. **`data/db.sqlite`** — the race records database (seeded from the livesow
   snapshot, now grown by records set on our own server).

```
racesow/
├── docker-compose.yml     # web + discord + collector services
├── data/
│   └── db.sqlite          # race records database (maps, players, races, checkpoints)
├── server/                # Warsow dedicated race server (Docker)
│   ├── Dockerfile · entrypoint.sh · docker-compose.yml
│   ├── configs/           # server.cfg · mappool.txt
│   ├── racemod/           # vendored hrace mod fork (see racemod/UPSTREAM)
│   ├── topscores/         # ← mod-written records (bind mount, gitignored)
│   └── racelog/           # ← mod-written race-finish events (bind mount)
├── collector/             # racelog/topscores → /api/ingest shipper
├── web/                   # Node API + frontend
│   ├── server.js · db.js · Dockerfile
│   └── public/            # index.html · assets/{css,js,img}
└── discord/               # Discord record announcer
    └── announcer.js · Dockerfile
```

## How records reach the database

The game server itself never touches SQLite. Our racemod fork appends a line
to `server/racelog/events.log` for every finished (non-practice) race and
keeps writing its usual `server/topscores/race/<map>.txt` record files. The
**collector** tails both, and POSTs batches to the web service's
`/api/ingest` (shared `INGEST_TOKEN`), which upserts best times into
`data/db.sqlite`, recomputes per-map ranks, and refreshes the site's
aggregates. The Discord announcer then spots the new race ids on its next
poll. See [`collector/README.md`](collector/README.md) for the full flow.

## Quick start

> **Note:** `data/db.sqlite` (~66 MB) is stored in **Git LFS**. Install
> [git-lfs](https://git-lfs.com) before cloning (`git lfs install`), or run
> `git lfs pull` in an existing clone — otherwise `data/db.sqlite` is just a
> small pointer file and the website/announcer will fail to open it.

### Stats website + Discord announcer

```bash
docker compose up -d --build
# stats site:  http://localhost:8080
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
`systemctl status racesow-*`, and a nightly gzip'd database backup into
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

- **Express** server opens `data/db.sqlite` with `better-sqlite3`, runs an
  idempotent schema migration at startup, and builds in-memory aggregate tables
  (~1s) for fast queries.
- Flexible REST API — search, sort and paginate maps and players; drill into map
  leaderboards (with world-record split times) and player profiles; plus an
  authenticated `POST /api/ingest` and `GET /api/servers`.
- Vanilla-JS single-page frontend with a Warsow-inspired "going fast" theme;
  renders Warsow `^0`–`^9` colour-coded player names.

Beyond raw leaderboards it computes:

- **Perfect run** per map — the sum of the fastest recorded split for every
  segment (start→cp1→…→finish), stitched across players, shown against the WR.
- **Attempts vs records** — every finished run is counted (a *finish*), separate
  from the number of ranked best-times (*records*); the old "runs" count only
  ever meant the latter.
- **Canonical players** — colour/spelling/login variants of one person collapse
  to a single profile, displayed as the **last nick we've seen them use**, so
  leaderboards and standings aren't fragmented across `^1Foo`/`^2Foo`/`Foo(1)`/
  login `foo`. Identity normalises away colours, a trailing `(N)` collision
  suffix and punctuation; a login keys the account while distinct logins never
  merge under a shared default nick.

See [`web/README.md`](web/README.md) for the full API reference, and
[`AGENT.md`](AGENT.md) for running a game server that feeds a central site.

### 🔔 Discord announcer (`discord/`)

- Detects newly-inserted records by race id and posts rich embeds to a Discord
  webhook (world records by default; configurable to podiums/top-N).
- Baselines on first run so it never floods the channel with history.
- Can optionally pull a fresh DB snapshot from `livesow.net` before each poll.

See [`discord/README.md`](discord/README.md).

## The database

`data/db.sqlite` was seeded from the livesow race API
(`http://livesow.net/race/api/db.sqlite`) and now grows live from ingested
records. A startup migration (`PRAGMA user_version`) adds the columns/tables
below on top of the original livesow schema.

| Table        | Rows    | Notes                                                        |
|--------------|---------|-------------------------------------------------------------|
| `map`        | 4,757   | `id`, `name`                                                |
| `player`     | 11,656  | `name` carries `^0`–`^9` colour codes; `simplified` plain; `canonical_id` → representative row |
| `race`       | 239,603 | best time per player/map/version; `global_rank`, `version_rank`; `server_id`, `created_at` (ingested rows) |
| `checkpoint` | 799,695 | split times (absolute ms; `number` is a spatial index)      |
| `version`    | 4       | wsw 1.0 / 1.5 / 2.1 and warfork 2.1                          |
| `run_tally`  | —       | total finishes (attempts) per player/map/version            |
| `canonical`  | —       | name-group key → representative player id                   |
| `server`     | —       | enrolled game servers: name, token hash, status, last-seen  |

All times are **milliseconds**. `global_rank = 1` is a world record. Ingested
race ids come from a monotonic `config.next_race_id` counter so improved records
always get a strictly higher id (how the announcer detects them).

## Notes

- Warsow was discontinued; `warsow.net` and the livesow snapshot are
  community-hosted and may change. The game server works fine for LAN /
  direct-connect regardless of master-server availability.
- `data/db.sqlite` was seeded from the static livesow snapshot; records set on
  our own server are added to it live by the collector → `/api/ingest` path.
  Set a real `INGEST_TOKEN` (env or `.env`) before exposing port 8080 —
  the default compose value is a well-known placeholder.

## Credits

Warsow by the Warsow team · racemod by **hettoo** & **DenMSC** · race database &
infrastructure by the **livesow** / **Racenet** community.
