# Racesow — Warsow Race Server, Stats Site & Discord Announcer

Everything you need to run a **Warsow 2.1 race community** in Docker:

1. **`server/`** — a Dockerized **Warsow 2.1.2 dedicated race server** running the
   `hrace` racemod.
2. **`web/`** — a **Node.js + SQLite** web server that hosts the livesow race
   database behind a REST API and a retro-modern stats website (world records,
   maps, player rankings — all live-queried, searchable and sortable).
3. **`discord/`** — a small service that posts **new race records to a Discord
   webhook**.
4. **`data/db.sqlite`** — the livesow race records database (≈54 MB), shared by
   the website and the announcer.

```
racesow/
├── docker-compose.yml     # web + discord services
├── data/
│   └── db.sqlite          # race records database (maps, players, races, checkpoints)
├── server/                # Warsow dedicated race server (Docker)
│   ├── Dockerfile · entrypoint.sh · docker-compose.yml
│   └── configs/           # server.cfg · mappool.txt
├── web/                   # Node API + frontend
│   ├── server.js · db.js · Dockerfile
│   └── public/            # index.html · assets/{css,js,img}
└── discord/               # Discord record announcer
    └── announcer.js · Dockerfile
```

## Quick start

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
- `git clone`s the **racemod** (`DenMSC/wsw-race`, gametype `hrace`) and zips its
  `source/` tree into a `.pk3` — Warsow's AngelScript VM compiles it at runtime,
  so there is no separate build step.
- Env-driven config (hostname, slots, public/private, rotation) and a restart
  loop mirroring the community `start.sh`.

See [`server/README.md`](server/README.md). The racemod is based on the work of
**hettoo** and **DenMSC** ([hettoo/wsw-race](https://github.com/hettoo/wsw-race/tree/racemod),
[DenMSC/wsw-race](https://github.com/DenMSC/wsw-race/tree/racemod)).

### 📊 Stats website (`web/`)

- **Express** server opens `data/db.sqlite` with `better-sqlite3` and builds
  in-memory aggregate tables at startup (~1s) for fast queries.
- Flexible REST API — search, sort and paginate maps and players; drill into map
  leaderboards (with world-record split times) and player profiles.
- Vanilla-JS single-page frontend with a Warsow-inspired "going fast" theme;
  renders Warsow `^0`–`^9` colour-coded player names.

See [`web/README.md`](web/README.md) for the full API reference.

### 🔔 Discord announcer (`discord/`)

- Detects newly-inserted records by race id and posts rich embeds to a Discord
  webhook (world records by default; configurable to podiums/top-N).
- Baselines on first run so it never floods the channel with history.
- Can optionally pull a fresh DB snapshot from `livesow.net` before each poll.

See [`discord/README.md`](discord/README.md).

## The database

`data/db.sqlite` comes from the livesow race API (`http://livesow.net/race/api/db.sqlite`).

| Table        | Rows    | Notes                                                        |
|--------------|---------|-------------------------------------------------------------|
| `map`        | 4,757   | `id`, `name`                                                |
| `player`     | 11,656  | `name` carries `^0`–`^9` colour codes; `simplified` is plain |
| `race`       | 239,603 | best time per player/map/version; `global_rank`, `version_rank` |
| `checkpoint` | 799,695 | split times (absolute ms; `number` is a spatial index)      |
| `version`    | 4       | wsw 1.0 / 1.5 / 2.1 and warfork 2.1                          |

All times are **milliseconds**. `global_rank = 1` is a world record.

## Notes

- Warsow was discontinued; `warsow.net` and the livesow snapshot are
  community-hosted and may change. The game server works fine for LAN /
  direct-connect regardless of master-server availability.
- The `data/db.sqlite` snapshot in this repo is static — see the announcer
  README for how to wire up a live-updating feed.

## Credits

Warsow by the Warsow team · racemod by **hettoo** & **DenMSC** · race database &
infrastructure by the **livesow** / **Racenet** community.
