# Warsow 2.1.2 Dockerized Race Server

A self-contained Docker image that runs a **Warsow 2.1.2 dedicated race
server** with the **`hrace` racemod** (the enhanced race gametype by
hettoo / DenMSC: checkpoints, practice mode, prejumps, more stored records).

The image downloads the official Warsow 2.1.2 Linux distribution and compiles
the racemod at build time — nothing but Docker is required on the host.

## Quick start

```bash
cd server
docker compose up -d --build
```

The first build downloads the ~465 MB Warsow distribution, so give it a few
minutes. Once up, the server listens on **UDP 44400**. Point a Warsow 2.1
client at `connect <host>:44400` or, with `SV_PUBLIC=1`, find it in the
in-game server browser.

Plain Docker (no compose):

```bash
docker build -t warsow-race:2.1.2 server
docker run -d --name warsow-race -p 44400:44400/udp \
    -e SV_HOSTNAME="My Race Server" -e SV_PUBLIC=1 \
    warsow-race:2.1.2
```

## Configuration

Everything is driven by environment variables (see `docker-compose.yml`):

| Variable        | Default                       | Meaning                                        |
|-----------------|-------------------------------|------------------------------------------------|
| `SV_HOSTNAME`   | `Dockerized Warsow Race`      | Server name in the browser                      |
| `SV_MAXCLIENTS` | `16`                          | Player + spectator slots                        |
| `SV_PUBLIC`     | `0`                           | `1` advertises to the Warsow master servers     |
| `SV_PORT`       | `44400`                       | UDP port (also map the container port to match) |
| `G_GAMETYPE`    | `hrace`                       | Gametype to load                                |
| `MAP_ROTATION`  | `2`                           | `0` none, `1` sequential, `2` random            |
| `RCON_PASSWORD` | *(empty)*                     | Enables remote console when set. Register it on the stats site (`node admin.js rcon <id> <pw>`) to drive the admin panel's broadcast / maintenance / console |
| `LOG_SHIP`      | `1`                           | Ship the game console to the stats site's admin log view (needs `INGEST_URL`+`INGEST_TOKEN`); `0` disables |
| `LOG_FLUSH_SECS`| `5`                           | Max seconds a console line waits before it is POSTed |
| `LOG_BATCH_LINES`| `100`                        | POST early once this many console lines have queued |
| `SV_UPLOADS_BASEURL` | *(empty)*                | HTTP pak mirror for client downloads (see below)|
| `MIRROR_PEERS`  | *(empty)*                     | Space-separated `host:port` mesh peers (see below); empty = mirroring off |
| `MIRROR_TAG`    | *(empty)*                     | Short id (≤16 chars) shown as `[TAG]` in mirrored chat |
| `MIRROR_SECRET` | *(empty)*                     | Shared HMAC key across all peers; empty = source-IP allowlist (LAN only) |
| `MIRROR_PORT`   | `44450`                       | UDP port this server binds for mesh traffic     |
| `EXTRA_ARGS`    | *(empty)*                     | Extra `+set ...` args appended verbatim         |

Race gameplay tuning (no fall/self damage, bunnyhop, voting, flood protection)
lives in `configs/server.cfg` and is `+exec`'d at launch. Secrets like
`RCON_PASSWORD` belong in `server/.env` (gitignored), never in the compose file.

## Client downloads (the UI pak, custom maps)

Connecting clients automatically download `racemod_ui_v4_local.pk3` (and any
pure-referenced content they lack). Two transports:

- **UDP (default).** Chunks flow over the game port itself — nothing extra to
  expose. Requires the patched engine this image builds (stock Warsow's UDP
  pak path was broken; see `enginepatches/`). Fine for small paks; slow for
  multi-MB map packs.
- **HTTP (optional, faster).** Start the bundled nginx pak mirror and point
  clients at it:

  ```bash
  docker compose --profile httpdl up -d
  # in server/.env:
  SV_UPLOADS_BASEURL=http://your-host-or-ip:44445
  ```

  The entrypoint exports the mod dir's pk3s into the shared `pakshare` volume
  that nginx serves. **The URL must be reachable by every game client** — when
  a base URL is set the engine does not fall back to UDP after a failed web
  download, so an unreachable mirror breaks downloads entirely.

Either way, clients first try the hardcoded official mirror
(`update.warsow.gg`, long dead) and log one `Web download failed` before using
our transport — harmless.

## Maps

A fresh image only contains the maps that ship in the base Warsow install, so
by default the server rotates through those. To run the real competitive pool:

1. Download the community map pack (≈11 GB, 4263 maps):
   `http://msocalpug.site.nfoservers.com/warsow/warsow_maps_pack_livesow_1.20.26.zip`
2. Put the `.pk3` files in `server/maps/` (bind-mounted at `/warsow/maps_extra`).
   They are symlinked into the mod dir and loaded on start.
3. List the maps you want in `configs/mappool.txt` (one per line). Maps that
   are not installed are skipped automatically; an empty pool means "rotate
   through everything installed".

`scripts/fetch-maps.sh` mirrors the packs from livesow into `server/maps/` and
restarts the game server to load them.

### Antivirus scanning of pk3 packs

pk3 packs are untrusted, community-redistributed ZIP archives that the pakserver
hands to every connecting client, so we scan them with **ClamAV**. A `.pk3` is a
ZIP; ClamAV unpacks it and scans the contents.

- **Install** (per game box): `sudo apt install clamav clamav-freshclam`. The
  `clamav-freshclam` service keeps the signature database current automatically.
- **On-demand / full scan:** `scripts/scan-paks.sh [dir ...]` (default:
  `server/maps`). It scans with the size caps raised well above the biggest pack
  (~140 MB) so nothing is skipped, **moves any infected pack to a quarantine dir**
  (`./quarantine`, out of the served set), logs to `pak-scan.log`, and exits
  non-zero on a detection.
- **Weekly scheduled scan:** `systemd/racesow-pakscan.{service,timer}` (installed
  + enabled by `systemd/install.sh` for both tiers) runs the scan every Sunday
  off-peak. Trigger manually with `sudo systemctl start racesow-pakscan`.
- **On fetch:** `scripts/fetch-maps.sh` scans just the newly-downloaded packs
  with ClamAV **before** the server loads them (skip with `--no-scan`; it also
  runs without clamav installed, just without the scan).
- **If a pack is flagged:** it is moved to `./quarantine` and dropped from
  `server/maps/`. Also delete it from the pakserver volume
  (`server_pakshare/.../racemod/<pack>.pk3`) and restart the game server so the
  infected copy is no longer served.

## Cross-server player mirroring (the mesh)

Run several regional servers (so players pick the one with the best ping) that
still feel like one community: players on any server see the others as
translucent **ghosts** running the same map, **chat** relays across all of
them, and spectators can **`/watch`** a racer on another server to study their
route. Servers form a **bidirectional UDP mesh** — every server broadcasts its
*own* live players and chat to every peer, and never re-forwards what it
receives (hop limit 1: a player on A shows as `[A]` on B and C, but B and C
never propagate it further).

```
        ┌──────────┐   players + chat (UDP, ~10Hz)   ┌──────────┐
        │ Server A │◀───────────────────────────────▶│ Server B │
        │  [A] EU  │◀──┐                          ┌──▶│  [B] US  │
        └──────────┘   │                          │   └──────────┘
              ▲        └──────┐          ┌─────────┘        ▲
              │               ▼          ▼                  │
              └──────────▶┌──────────┐◀──────────────────────┘
                          │ Server C │
                          │  [C] AU  │
                          └──────────┘
```

The mesh is **fire-and-forget and low priority**: lost packets are never
retransmitted (positions self-correct on the next tick), and if a peer is down
its ghosts/roster simply age out in ~3 s. All socket I/O runs on a background
thread, so mesh traffic never affects the game frame. It is entirely
independent of the stats pipeline (`INGEST_URL`) — you can run either, both, or
neither.

### Setup

On **every** server in the mesh, set four env vars in `server/.env`:

```sh
MIRROR_TAG=EU                              # this server's short id, unique per peer
MIRROR_PORT=44450                          # UDP port to bind (default 44450)
MIRROR_PEERS="us.example.com:44450 au.example.com:44450"   # every OTHER peer
MIRROR_SECRET=<shared key>                 # SAME value on all peers
```

- **`MIRROR_PEERS`** lists the *other* peers only (don't list yourself). Each
  entry is `host:port`; use each peer's public host/IP and its `MIRROR_PORT`.
  Because it's a full mesh, server EU lists `[US, AU]`, US lists `[EU, AU]`,
  AU lists `[EU, US]`.
- **`MIRROR_SECRET`** must be **identical on every peer** and kept secret. It
  authenticates every datagram (HMAC-SHA256). Generate one and share it out of
  band: `openssl rand -hex 24`. A value with `"`, `;` or a newline is rejected
  at startup (it would corrupt the generated config line).
- **`MIRROR_TAG`** is what players see (`[EU] name: hi`) and how peers are
  keyed, so make each one distinct (≤16 chars, `A-Za-z0-9_-`).

Then open the mesh port so peers can reach each other and (re)deploy:

```bash
# docker-compose.yml: uncomment the mirror port publish
#   ports:
#     - "44450:44450/udp"
docker compose up -d --build          # on each server
```

If you run behind a firewall/security group, allow **inbound UDP 44450** from
each peer's IP. Same-host containers on a shared Docker network don't need the
port published (they reach each other by service name) — that's how the local
test mesh works.

### Verify

Each server logs its mesh health to the container log:

```bash
docker compose logs -f warsow-race | grep rs_mirror
# rs_mirror: configured tag=EU port=44450 peers=2 (secret: yes)
# rs_mirror: stats tx=580 rx=1150 drop=0 heard=[US(coldrun 0.1s) AU(coldrun 0.0s)]
```

`heard=[...]` lists every peer you're receiving from, its current map, and how
long since its last packet; `tx`/`rx` are datagrams sent/received and `drop`
counts rejected (unauthenticated/malformed) datagrams — a healthy mesh shows
all peers with sub-second freshness and `drop=0`. Set `EXTRA_ARGS="+set
rs_mirror_debug 1"` (or `rcon <pw> set rs_mirror_debug 1`) to also log each
received chat/join/leave event and a per-server roster summary.

In-game, players use **`/who`** to list every peer's roster and
**`/watch <player>`** (as a spectator) to follow a remote racer's route.

### Behavior notes

- **Ghosts only render when two servers are on the same map**; chat, join/leave
  notices, and `/who` work regardless of map. When maps differ you still see
  `[US] name: msg` chat and the roster, just no in-world ghost.
- **The WR ghost racer stays in sync across the mesh.** The in-game world-record
  ghost is the canonical `MIN(time)` recording served by the stats site
  (`/api/game/ghost`), so every server that feeds the same site already plays the
  same record. When peers are meshed and on the same map, a new WR set on one
  server is picked up by the others within seconds — the peer's finish time
  (already synced over the mesh) triggers an immediate re-pull of the fresh
  canonical ghost, which hot-swaps in place. Without a mesh, a periodic re-poll
  still converges every server to the current WR within ~a minute. This needs the
  stats feed (`INGEST_URL`); a mesh with no shared site has no WR ghost to share.
- **Tuning cvars** (rarely needed, set via `EXTRA_ARGS`): `rs_mirror_maxghosts`
  (default 32) caps ghost entities; `rs_mirror_debug` toggles verbose logging;
  `rs_wr_ghost_mesh_sync` (default 1) toggles the cross-server WR-ghost re-pull;
  `rs_wr_ghost_smooth` (default 0.35) tunes ghost-playback easing — lower is
  smoother/laggier, higher snappier, `0` disables easing (raw interpolation).

### Security posture

The mesh binds an internet-facing UDP port, so its parser and auth were built
and audited to withstand hostile input:

- **Authentication.** Every datagram carries an HMAC-SHA256 (truncated to 128
  bits) over its contents, verified with a constant-time compare before any of
  its fields are trusted. Wrong-length/forged MACs are rejected for free (no
  hashing). Empty-secret mode falls back to a source-IP allowlist and is
  **LAN/testing only** — never expose it to the internet (the server warns).
- **Bounded by construction.** Datagrams over ~1400 bytes are dropped; remote
  state is hard-capped (≤16 peers, ≤32 players each, ≤64 queued events), and
  the receive path never emits a datagram in response to one — so the port
  can't be used as a reflector/amplifier. Worst case under a flood is a
  generic line-rate UDP flood with bounded per-packet CPU, not an asymmetric
  one-packet kill.
- **Audited + fuzzed.** The parser was reviewed adversarially (no confirmed
  overflow/DoS) and fuzzed with ~1M malformed/boundary/hostile datagrams under
  AddressSanitizer + UBSan with zero memory-safety violations. Re-run it any
  time: `sh e2e/mirror_fuzz_run.sh`.
- **Defense in depth — firewall the port to your peers.** The HMAC already
  gates content, but you should still restrict inbound UDP on `MIRROR_PORT` to
  the known peer IPs at the OS/security-group level, e.g.

  ```bash
  # allow only the two peers, drop everything else on the mesh port
  ufw allow from <peer-B-ip> to any port 44450 proto udp
  ufw allow from <peer-C-ip> to any port 44450 proto udp
  ufw deny 44450/udp
  ```

  This shrinks the attack surface to your mesh and blunts any UDP flood before
  it reaches the process.
- **Trust model / known limits.** The shared secret is trusted mesh-wide: any
  holder can speak as any tag, so treat it like an admin credential and only
  mesh servers you control. There is no datagram-level replay protection within
  the ±60 s timestamp window (impact is display-only under hop-limit-1).
  Per-peer keys and replay protection are documented as future hardening.

### Test the mesh locally first

`docker-compose.mirror-test.yml` runs a 3-node mesh (tags A/B/C) on one host
for development — see the header of that file. It pins a shared map so ghosts
are visible and enables `rs_mirror_debug`:

```bash
# put one race map in server/mirror-test-maps/, then:
docker compose -f docker-compose.mirror-test.yml up --build
# clients: localhost:44403 (A), :44401 (B), :44402 (C)
```

`e2e/mirror_wire_check.py` speaks the wire protocol for headless checks —
`fakeplayer` streams a synthetic racer into the mesh, `garbage` fires an
unauthenticated datagram (must bump `drop`), and `listen` prints received
datagram headers. `e2e/mirror_harness.cpp` drives the real `g_rs_mirror.cpp`
so two harness processes form a genuine two-node mesh off-engine.

## How it works

- **`Dockerfile`** — two stages. Stage 1 compiles, from DenMSC's `racemod_2.1`
  fork of the warsow_21_sdk against the official AngelScript 2.29.2:
  - a **patched game module** (`libgame_x86_64.so`) — the hrace gametype calls
    racesow natives (`RS_QueryPjState`, `RS_ResetPjState`,
    `G_RemoveProjectiles(Entity@)`) that stock Warsow lacks; without it the
    gametype script fails to compile and no race logic runs;
  - a **patched dedicated server** (`wsw_server.x86_64`) — fixes the stock
    engine's broken UDP pak-download filename handling (see
    `enginepatches/patch-udp-download.py`; the stock binary is kept in the
    image as `wsw_server.x86_64.stock`).
  Stage 2 is the Ubuntu 18.04 runtime (matches the 2018 build's glibc):
  downloads Warsow 2.1.2, strips non-Linux/32-bit/client files, `zip`s the
  vendored racemod's `source/` tree into `racemod/hrace.pk3`, packages the
  patched module as `racemod/modules_racesow_21.pk3`, swaps in the patched
  server binary, and builds the client UI pak (below). Warsow's AngelScript VM
  compiles the gametype at runtime — there is no separate script-compile step.
- **`clientdata/`** — the racemod client menu + HUD (vendored from
  `DenMSC/racemod_data`, see `clientdata/UPSTREAM`), packaged as
  `racemod/racemod_ui_v4_local_21pure.pk3`. The `*21pure` name puts it on the
  `sv_pure` list so connecting clients download it automatically; it powers the
  in-game **"Race" options** menu (`gametypemenu` → `menu_open racemod_main`).
- **Pure setup** — `sv_pure 1` with `sv_pure_forcemodulepk3
  "basewsw/modules_21.pk3"`: clients verify against the *stock* modules pak
  they already have, while the server's patched module pak is deliberately
  non-pure-named (clients refuse to download pk3s containing `.so`) yet still
  wins the module search because the mod dir is searched before `basewsw`.
- **Seeding records** — `scripts/seed-server.sh` (repo root) exports each
  map's top-50 from `data/db.sqlite` into `./topscores/race/`, so the in-game
  `top` list matches the central site. It archives the current files into
  `backups/`, runs the merge-only/idempotent seeder, sanity-checks the output
  and restarts the game server. `--wipe` clears the directory first for a
  true initial seed; `--no-restart` skips the reload.
- **`racemod/`** — our fork of the hrace racemod (upstream `DenMSC/wsw-race`,
  branch `racemod`; provenance in `racemod/UPSTREAM`). Local addition:
  `source/progs/gametypes/hrace/racelog.as` appends one tab-separated line per
  finished (non-practice) race to `racelog/events.log`, which the stats
  collector (`../collector`) ships to the central database. Edit the source
  and `docker compose up -d --build` to deploy mod changes.
- **Cross-server mirroring** — `enginepatches/g_rs_mirror.cpp` adds the
  `RS_Mirror*` AngelScript natives (a UDP mesh on a background thread; wired in
  by `enginepatches/patch-mirror-natives.py`, which also hooks `Cmd_Say_f` to
  relay chat), and `racemod/source/progs/gametypes/hrace/mirror.as` drives them
  (publish local players at 10 Hz, render remote ghosts, `/who`, `/watch`).
  `entrypoint.sh` turns the `MIRROR_*` env vars into `rs_mirror_*` cvars. See
  the mirroring section above.
- **`entrypoint.sh`** — resolves the map pool against the maps that are
  actually installed, assembles the `+set` launch arguments from the
  environment, and runs `wsw_server.x86_64` in a restart loop (mirroring the
  community `start.sh`).
- **`configs/server.cfg`** — race gameplay cvars.
- **`configs/mappool.txt`** — the rotation list.

### Record files

With `fs_usehomedir 0` the mod writes everything under `/warsow/racemod`;
two of those paths are bind-mounted to the host so records survive image
rebuilds and feed the stats pipeline:

- `./topscores` ⇢ `topscores/race/<map>.txt` — the mod's top-50 record list
  per map (written on every record and at match end).
- `./racelog` ⇢ `racelog/events.log` — our fork's per-finish event log.

Both host dirs must stay writable by the container user (uid 999); they are
created world-writable and gitignored.

## Notes & caveats

- The Warsow master server / auth infrastructure is community-run and may be
  offline; `SV_PUBLIC=0` (LAN/direct-connect) always works regardless.
- This image serves the **game server** only. The stats website, collector
  and Discord announcer live in the repo root compose file.
- The original livesow record integration relied on an external MySQL/HTTP
  auth service (Racenet) that no longer exists. This deployment replaces it
  with the racelog → collector → `/api/ingest` pipeline; player identity is
  by name only since the auth (`login`) servers are gone.
