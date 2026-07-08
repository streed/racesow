# Racesow Agent — feed a central stats site from your own server

Run a Warsow race server that contributes records to a shared Racesow stats
site. Two tiers, depending on how much you want to run.

```
   your box                                central stats box
 ┌───────────────────────────┐          ┌───────────────────────────┐
 │ warsow-race (hrace fork)   │          │ web (/api/ingest)         │
 │   └─ racelog + topscores   │  HTTPS   │   └─ data/db.sqlite        │
 │ collector ─────────────────┼─────────▶│ discord announcer          │
 └───────────────────────────┘  token   └───────────────────────────┘
```

Records are keyed to your server via a **per-server token**, so the central
admin can attribute, monitor, or revoke your feed without affecting anyone else.

## 1. Get enrolled

Ask the central site's admin to enroll your server. They run:

```bash
docker compose exec web node admin.js enroll "Your Server Name"
# -> INGEST_TOKEN=<64 hex chars>   (shown once)
```

They give you the token and the ingest URL (e.g. `https://stats.example.com/api/ingest`).

## 2. Full tier — our racemod fork (every finish, low latency)

Best data: every finished run is reported within seconds, which powers the
attempt/run counts and the "recent records" feed.

```bash
git clone <this repo> racesow && cd racesow
cp .env.example .env         # set INGEST_URL, INGEST_TOKEN, SERVER_NAME
docker compose -f docker-compose.agent.yml up -d --build
```

This builds the game server (downloads Warsow 2.1.2 once, ~465 MB) with the
forked `hrace` mod that writes `racelog/events.log`, plus the collector. No
database, no Git-LFS pull needed on your side.

To run a real competitive map pool, drop `.pk3` map packs into `server/maps/`
and list them in `server/configs/mappool.txt` (see `server/README.md`).

## 3. Basic tier — a stock, unmodified racemod server (no fork)

Already running a normal Warsow race server (DenMSC or hettoo `hrace`)? You can
feed the site from its existing `topscores` files without changing your server —
you only lose sub-top-50 finishes and the per-run attempt counts.

Run just the collector, pointed at your server's topscores dir (with
`fs_usehomedir 1` that's usually `~/.local/share/warsow-2.1/racemod/topscores`):

```bash
docker run -d --name racesow-collector --restart unless-stopped \
  -e INGEST_URL="https://stats.example.com/api/ingest" \
  -e INGEST_TOKEN="<your token>" \
  -e SERVER_NAME="Your Server" \
  -v /path/to/racemod/topscores:/topscores:ro \
  -v racesow-collector-state:/state \
  racesow-collector:latest
```

Leave `RACELOG_FILE` unset — the collector skips the racelog feed when the file
is absent and runs topscores-only.

> The **racesow** mod family (racesow.net, MySQL-backed) uses a different record
> pipeline and is not supported by this collector.

## Configuration

| Variable        | Default                  | Meaning                                           |
|-----------------|--------------------------|---------------------------------------------------|
| `INGEST_URL`    | `http://web:8080/api/ingest` | Central ingest endpoint (**https** across WAN) |
| `INGEST_TOKEN`  | *(empty)*                | Your per-server token                             |
| `SERVER_NAME`   | `unnamed`                | Shown on the stats site                           |
| `VERSION_NAME`  | `wsw 2.1`                | Game version records file under                   |
| `POLL_INTERVAL` | `3`                      | Racelog tail interval (seconds)                   |
| `TOPSCORES_RESCAN` | `300`                 | Topscores re-scan interval (seconds)             |
| `NODE_EXTRA_CA_CERTS` | *(unset)*          | Path to a CA bundle for a private central cert    |

## Notes

- **HTTPS.** The token authenticates every push; put the central site behind a
  TLS reverse proxy (Caddy/Traefik/nginx) and use an `https://` `INGEST_URL` for
  any cross-host deployment. Node's `fetch` uses the system CA store; for a
  private CA set `NODE_EXTRA_CA_CERTS`.
- **Time comparability.** Records are compared globally, so run standard race
  settings (see `server/configs/server.cfg`); non-standard movement cvars make
  your times incomparable. The central admin may quarantine or revoke feeds.
- **Idempotent.** The collector can restart, re-read, or overlap with the
  topscores backfill freely — the endpoint only keeps best times and de-dupes.
