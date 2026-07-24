# Warfork race server (spike)

Exploration of running a **Warfork** race server alongside the Warsow 2.1.2
servers, feeding the same stats site. Full findings + port plan:
[`../docs/warfork-port-design.md`](../docs/warfork-port-design.md).

## TL;DR

- **Build from source — works, no Steam needed.** `warfork-qfusion` is GPLv2 and
  builds `wf_server` + the `game` module with `-DBUILD_STEAMLIB=0`, mirroring our
  Warsow `server/Dockerfile`. This is the path.
- **Stock server via anonymous SteamCMD — currently broken.** appid `1136510`'s
  public build fails to commit (`Missing configuration`) and `beta` is gated to
  licensed accounts. The SteamCMD scaffold here is kept only as a fallback for
  when a licensed Steam account is available.

## Build & run from source (working)

```bash
./build-from-source.sh          # clone warfork-qfusion, build wf_server + game module
```
Outputs `~/warfork-build/warfork-qfusion/source/build/warfork-qfusion/`
(`wf_server.x86_64`, `basewf/libgame_x86_64.so`, packed paks incl. `wfrace1` map).

Boot the race gametype headless (validated 2026-07-24):
```bash
OUT=~/warfork-build/warfork-qfusion/source/build/warfork-qfusion
docker run --rm --entrypoint /bin/bash -v "$OUT:/server" -w /server warfork-builder \
  -c './wf_server.x86_64 +set fs_basepath /server +set fs_game basewf +set dedicated 1 \
       +set g_gametype race +map wfrace1'
# → "Gametype 'Race' initialized" / "Warfork Initialized" (UDP :44400, TCP :44444)
```

## Files

| File | Purpose |
|---|---|
| `build-from-source.sh` | **Working path** — build wf_server + game module from source |
| `Dockerfile`, `entrypoint.sh`, `configs/server.cfg`, `docker-compose.yml` | SteamCMD stock-server scaffold — **currently blocked** (see TL;DR); usable once a licensed Steam account is available |

## Ports

Game **UDP 44400**, HTTP/query **TCP 44444** (Warfork/LinuxGSM defaults).
