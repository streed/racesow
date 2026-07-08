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
| `EXTRA_ARGS`    | *(empty)*                     | Extra `+set ...` args appended verbatim         |

Race gameplay tuning (no fall/self damage, bunnyhop, voting, flood protection)
lives in `configs/server.cfg` and is `+exec`'d at launch.

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

- **`Dockerfile`** — Ubuntu 18.04 base (matches the 2018 build's glibc),
  downloads Warsow 2.1.2, strips non-Linux/32-bit/client files, then
  `git clone`s the racemod and `zip`s its `source/` tree into
  `racemod/hrace.pk3`. Warsow's AngelScript VM compiles the gametype at
  runtime — there is no separate compile step.
- **`entrypoint.sh`** — resolves the map pool against the maps that are
  actually installed, assembles the `+set` launch arguments from the
  environment, and runs `wsw_server.x86_64` in a restart loop (mirroring the
  community `start.sh`).
- **`configs/server.cfg`** — race gameplay cvars.
- **`configs/mappool.txt`** — the rotation list.

### Choosing the racemod fork

Both forks build the `hrace` gametype. Switch via build args:

```bash
docker build -t warsow-race:2.1.2 \
  --build-arg RACEMOD_REPO=https://github.com/hettoo/wsw-race.git \
  --build-arg RACEMOD_BRANCH=racemod \
  server
```

- `DenMSC/wsw-race` (default) — the fork referenced by the community
  `racemod_2.1` deployment, a few extra features over upstream.
- `hettoo/wsw-race` — the original racemod.

## Notes & caveats

- The Warsow master server / auth infrastructure is community-run and may be
  offline; `SV_PUBLIC=0` (LAN/direct-connect) always works regardless.
- This image serves the **game server** only. The stats **website** in
  `../website` is a separate, static deliverable built from the race database.
- The record-database integration used by the original livesow servers relied
  on an external MySQL/HTTP auth service (Racenet). It is not wired up here;
  the server keeps local records via the racemod itself.
