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
| `RCON_PASSWORD` | *(empty)*                     | Enables remote console when set                 |
| `SV_UPLOADS_BASEURL` | *(empty)*                | HTTP pak mirror for client downloads (see below)|
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
- **Seeding records** — `docker compose --profile seed run --rm seed-topscores`
  (repo root) exports each map's top-50 from `data/db.sqlite` into
  `./topscores/race/`, so the in-game `top` list matches the central site.
  Merge-only and idempotent; restart the game server afterwards.
- **`racemod/`** — our fork of the hrace racemod (upstream `DenMSC/wsw-race`,
  branch `racemod`; provenance in `racemod/UPSTREAM`). Local addition:
  `source/progs/gametypes/hrace/racelog.as` appends one tab-separated line per
  finished (non-practice) race to `racelog/events.log`, which the stats
  collector (`../collector`) ships to the central database. Edit the source
  and `docker compose up -d --build` to deploy mod changes.
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
