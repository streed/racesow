# Racesow Agent — feed a central stats site from your own server

Run a Warsow race server that contributes records to a shared Racesow stats
site. Two tiers, depending on how much you want to run.

```
   your box                                central stats box
 ┌───────────────────────────┐          ┌───────────────────────────┐
 │ warsow-race (hrace fork)   │  HTTPS   │ web (/api/ingest)         │
 │   └─ POSTs each finish ────┼─────────▶│   └─ PostgreSQL            │
 │      (RS_ApiReportRace)    │  token   │ discord announcer          │
 └───────────────────────────┘          └───────────────────────────┘
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

Best data: every finished run is POSTed to the central `/api/ingest` within
seconds, straight from the game module (`RS_ApiReportRace` native on a
background thread — no sidecar, no log scraping). This powers the attempt/run
counts and the "recent records" feed.

```bash
git clone <this repo> racesow && cd racesow
cp .env.example .env         # set INGEST_URL, INGEST_TOKEN, SERVER_NAME
docker compose -f docker-compose.agent.yml up -d --build
```

This builds the game server (downloads Warsow 2.1.2 once, ~465 MB) with the
forked `hrace` mod and the patched engine/game module. No database, no
Git-LFS pull, no collector needed on your side. A local
`racelog/events.log` audit trail is still written alongside the API reports.

To run a real competitive map pool, drop `.pk3` map packs into `server/maps/`
and list them in `server/configs/mappool.txt` (see `server/README.md`).

Running **several regional servers**? They can also form a peer-to-peer
**mesh** so players on one see and chat with players on the others (ghosts on
the same map, cross-server chat, `/who`, `/watch`). This is independent of the
stats feed above — see **Cross-server player mirroring** in `server/README.md`.

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
| `INGEST_URL`    | *(empty; required)*      | Central ingest endpoint (**https** across WAN)    |
| `INGEST_TOKEN`  | *(empty; required)*      | Your per-server token                             |
| `SERVER_NAME`   | `unnamed`                | Shown on the stats site                           |
| `VERSION_NAME`  | `wsw 2.1`                | Game version records file under                   |

(`POLL_INTERVAL`, `TOPSCORES_RESCAN` and `NODE_EXTRA_CA_CERTS` only apply to
the standalone collector of the basic tier below.)

## Testing

Layers, all runnable on a dev box (node ≥ 18, g++, libcurl headers, and a
throwaway PostgreSQL — see `web/README.md` — reachable via `TEST_PG_URL`):

```bash
cd web && npm test                    # DB semantics + HTTP API (throwaway pg database per test)
sh server/test/entrypoint.test.sh     # env vars -> env.cfg -> launch-args contract
sh e2e/run.sh                         # the REAL g_rs_api.cpp -> live server.js -> API
sh e2e/mirror_fuzz_run.sh             # mesh parser vs ~300k hostile datagrams (ASan+UBSan)
```

The e2e compiles `server/enginepatches/g_rs_api.cpp` into a harness that calls
`RS_ApiReportRace` exactly like `racelog.as` does, so the bytes on the wire are
the game module's. It covers: every finish counted as an attempt, PR upserts,
leaderboard for all players, WR splits, the perfect-run (sum of best splits)
computation, and delivery via the retry queue across a server restart.

## Notes

- **HTTPS.** The token authenticates every push; put the central site behind a
  TLS reverse proxy (Caddy/Traefik/nginx) and use an `https://` `INGEST_URL` for
  any cross-host deployment. Node's `fetch` uses the system CA store; for a
  private CA set `NODE_EXTRA_CA_CERTS`.
- **Time comparability.** Records are compared globally, so run standard race
  settings (see `server/configs/server.cfg`); non-standard movement cvars make
  your times incomparable. The central admin may quarantine or revoke feeds.
- **Idempotent.** Reports can be retried, repeated, or overlap with a
  topscores backfill freely — the endpoint only keeps best times and de-dupes.
  The game module retries failed POSTs a few times in the background and
  drops them after that; the local `racelog/events.log` keeps the audit trail.
