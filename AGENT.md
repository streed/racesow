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

Or let `scripts/setup.sh` do it interactively (it installs Docker if needed,
asks for the ingest URL + token and the optional server mesh, fetches the map
mirror, and brings the stack up):

```bash
scripts/setup.sh agent
```

**Fresh cloud VM, hands-off.** To provision a new box entirely from its
provider's *user-data*, use the cloud-init path: paste
[`systemd/cloud-config.yaml`](systemd/cloud-config.yaml) (fill in your token,
and the mesh settings if you're networking servers) and first boot installs
Docker, creates the `racesow` service user, clones the repo, builds the server,
and enables the systemd units — no SSH-in required. See *Zero-touch install
(cloud-init)* in the main [`README.md`](README.md#zero-touch-install-cloud-init).

This builds the game server (downloads Warsow 2.1.2 once, ~465 MB) with the
forked `hrace` mod and the patched engine/game module. No database, no
Git-LFS pull, no collector needed on your side. A local
`racelog/events.log` audit trail is still written alongside the API reports.

### Maps

Out of the box the server rotates only the handful of maps that ship with
Warsow. To run the community map pool — **and so every server in a network
rotates the same maps** — mirror the full livesow pack collection into
`server/maps/`:

```bash
scripts/fetch-maps.sh --jobs 8      # ~4300 packs / ~12.5 GB from livesow.net
```

It is safe to re-run (idempotent, resumable), makes each `.pk3`
world-readable so the container's non-root user can load it, and restarts the
game server when new packs land. The rotation itself is
`server/configs/mappool.txt` (curated, most-raced maps) intersected with what
is installed — so with the full mirror in place, `mappool.txt` alone
determines the cycle, identically on every box that shares it. `docker logs
warsow-race | grep "map pool"` shows the resulting rotation.

> Running multiple servers that should feel like one network? Give them the
> **same `server/configs/mappool.txt` and the same fetched maps** so their
> `map pool` lines match exactly.

**Fast local map downloads.** By default clients pull unknown `.pk3`s from the
game server over UDP, which is slow for big packs — and painfully slow across
regions. Run the bundled plain-HTTP pak mirror so clients download from *your*
box instead:

```bash
# in .env: point clients at a URL THEY can reach (open the port to everyone)
SV_UPLOADS_BASEURL=http://your-host:44445
PAK_HTTP_PORT=44445
docker compose -f docker-compose.agent.yml --profile httpdl up -d --build
```

Only set `SV_UPLOADS_BASEURL` if the port is reachable by every player — the
engine does not fall back to UDP after a failed web download.

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

Two lanes cover the whole mod — website, game/engine/hrace, and clients
connecting. See `e2e/README.md` for the full map.

**Fast lane** (`.github/workflows/ci.yml`, no Docker; node ≥ 18, g++, libcurl
headers, and a throwaway PostgreSQL — see `web/README.md` — via `TEST_PG_URL`):

```bash
cd web && npm test                    # DB semantics + HTTP API (throwaway pg database per test)
sh server/test/entrypoint.test.sh     # env vars -> env.cfg -> launch-args contract
sh e2e/run.sh                         # the REAL g_rs_api.cpp -> live server.js -> API
sh e2e/mirror_fuzz_run.sh             # mesh parser vs ~300k hostile datagrams (ASan+UBSan)
node --test server/test/demoname.test.mjs   # WR-demo filename: engine C vs .as, byte-for-byte
```

`e2e/run.sh` compiles `server/enginepatches/g_rs_api.cpp` into a harness that
calls `RS_ApiReportRace` exactly like `racelog.as` does, so the bytes on the
wire are the game module's. It covers: every finish counted as an attempt, PR
upserts, leaderboard for all players, WR splits, the perfect-run (sum of best
splits) computation, and delivery via the retry queue across a server restart.

**Heavy lane** (`.github/workflows/e2e.yml`, needs Docker; builds the real
server image once — the engine compile is ~20-30 min — then reuses it):

```bash
sh e2e/gameserver_smoke.sh            # boot the server: hrace gametype compiles,
                                      #   then a REAL client connect handshake
                                      #   (getchallenge -> getinfo -> connect ->
                                      #   client_connect); see client_connect_probe.py
sh e2e/fullstack_run.sh               # postgres + web + game together: site healthy
                                      #   + homepage, client connects, and the live
                                      #   game ships console logs to the web over HTTP
sh server/test/verify-mesh.sh --boot-only   # 3-node mesh: every gametype compiles + peers configure
```

These are the parts only a live server can prove: the AngelScript gametype
compiles at *boot* (never at Docker-build time), and a client can actually
establish a connection. The full mesh regression (`e2e/mesh_regression.py`,
`verify-mesh.sh` without `--boot-only`) stays a local/manual gate — it needs a
~2 min mesh warm-up that is too timing-sensitive for a per-push CI signal.

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
