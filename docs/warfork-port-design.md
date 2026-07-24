# Warfork race server — feasibility & port plan

**Status:** Phase 0 spike complete (2026-07-24). Build-from-source path proven.
**Goal (agreed):** run a **Warfork** race server *alongside* the existing Warsow
2.1.2 EU/US servers, feeding the **same racesow stats site** with a **unified
leaderboard**. Warfork is the actively-maintained community successor to Warsow
(our current base is a dead upstream: warsow.net gone, `update.warsow.gg` parked,
master server flaky).

---

## 1. What Warfork is (and why it fits)

- **Warfork = a fork of Warsow 2.1** on the [qfusion] engine
  ([TeamForbiddenLLC/warfork-qfusion], GPLv2, active July 2026). Assets live under
  the `data*_21` / `basewf` generation — the *same* asset generation and
  AngelScript gametype architecture our racemod already targets.
- It **ships a first-class `race` gametype** (`assets/data0_21pure/progs/gametypes/race.as`
  + `race.gt`/`race.gtd` + `race.cfg`) and the official `warfork-server-deployment`
  tool has a `race` server type.
- It is a **Steam** title (client free, appid `671610`; dedicated server tool
  `1136510`), with a Rust Steam masterserver (`warmonger`) and **server-side
  Steam identity** built into the engine — `source/server/sv_main.c` has
  `clc_steamauth` and a per-client `steamid`. That is exactly the authenticated
  identity our name-only stats pipeline lacks.

### Platform payoff vs our dead Warsow base

| Pain today (Warsow 2.1.2) | Warfork |
|---|---|
| Dead master → unreliable browser | Live Steam / Warfork masters |
| Broken UDP pak DL, dead HTTP mirror (`patch-udp-download.py`) | Steam + Workshop delivery |
| **Identity is name-only** (auth servers gone) | **Authenticated steamIDs** |
| Players must find/install dead Warsow 2.1 | Free Warfork client on Steam |

---

## 2. Phase 0 spike results

### 2a. Stock server via SteamCMD is currently NOT viable (dead end)
- appid `1136510` **`Not for anonymous users` / `release state: No License`** on the
  install path; **public branch is stale** (buildid 16821933, Dec 2024) and fails
  to commit anonymously with **`Missing configuration`** *after* downloading the
  full ~40 MB depot; the current **`beta` branch is gated** (state 0x2, 0/0).
- `gelmo/warfork-docker` (the community base we evaluated) reproduces this — it is
  ~1 yr stale and its `+login anonymous +app_update 1136510` no longer commits.
- **Conclusion:** acquiring the *stock* binary needs a licensed Steam account
  (Warfork is free, so a throwaway account with it in library works) — deferred;
  we don't need it.

### 2b. Build-from-source WORKS with no Steam (this is the path)
Proven on the dev box. It **mirrors our existing Warsow build** (`server/Dockerfile`):

- Base: `registry.gitlab.steamos.cloud/steamrt/sniper/sdk` + `gcc-12-monolithic`
  (the repo's own `Dockerfile` / `linux-build.yml`).
- Submodules: all `source/extern/*` **except `crashpad`** (angelscript is vendored
  in-tree at `third-party/angelscript`, not a submodule).
- Configure: `cmake --preset workflow-linux-release -DBUILD_STEAMLIB=0 -DUSE_CRASHPAD=0`
  — **`BUILD_STEAMLIB` is off by default and the Steamworks SDK is not vendored**,
  so no Steam account / SDK is needed to build.
- Build target `wf_server` (pulls in `game` + `angelwrap` + `tracy`) + `make deploy`.
- Reproducible wrapper: **`warfork/build-from-source.sh`**.

**Artifacts** (`source/build/warfork-qfusion/`): `wf_server.x86_64` (3.3 MB),
`basewf/libgame_x86_64.so` (3.6 MB game module), packed paks incl.
`data0_21pure.pk3` (race gametype) and `data1_21pure.pk3` (ships `maps/wfrace1.bsp`).

**Headless boot on `g_gametype race +map wfrace1`:**
```
Initialization of angelwrap successful
SpawnServer: wfrace1
Initalizing 'race' gametype  →  race.gt → race.as → generic/*.as → legacy/quake1.as
Gametype 'Race' initialized
====== Warfork Initialized ======  (UDP *:44400, TCP *:44444)
```
`Steam initialization failed` is logged and **non-fatal** — the server runs fully
without Steam. `Warning: Game module not in pk3, disabling pure mode` appears only
because our `libgame` is loose; production paks it (as the Warsow image already does).

### 2c. Our racemod is already Warfork-shaped
`server/racemod/source/progs/gametypes/hrace.gt` uses the **same `.gt`/`.gtd`
manifest format** Warfork loads, and pulls in `generic/quickmenu.as`,
`generic/matchstates.as`, `legacy/quake{1,2,3}_items.as` — the exact files present
in Warfork's `data0_21pure/progs/gametypes/`. DenMSC's racemod fork was evidently
developed against this post-2.1 qfusion tree, so the AngelScript side is largely
pre-aligned.

---

## 3. Architecture deltas to reconcile (Warsow → Warfork)

| Area | Warsow 2.1.2 (ours) | Warfork | Work |
|---|---|---|---|
| Engine build | Warsow tarball + DenMSC SDK, AS 2.29.2 | warfork-qfusion source, vendored AS | New Docker stage (proven) |
| Native bindings | patched into `game/g_ascript.cpp` | bindings in `game/g_as_gametypes.cpp` | Re-anchor the `patch-*.py` scripts |
| Our natives | `RS_ApiReport*`, `RS_Mirror*`, wrghost cull, quad fix | absent | Re-port 4 bundles onto the new tree |
| Pak DL fix | `patch-udp-download.py` (mirror dead) | Steam/Workshop | **Drop** — unneeded |
| MOTD-live patch | `patch-motd-live.py` | TBD | Re-check vs new `sv_motd` |
| Identity | name only | steamID (`clc_steamauth`) | **Adopt** for unified leaderboard |
| Masterserver | Warsow master (flaky) | `sv_masterservers{,_steam,_warfork}` | Choose channel (see risks) |
| Client UI pak | `racemod_ui_v7` (stock Warsow client) | Warfork client UI/RML | Re-port; recheck stock-client render constraint |

---

## 4. Port plan (phased, after this spike)

1. **Build pipeline** — `warfork/Dockerfile` producing a `racesow` fs_game from the
   source build: pak `libgame_x86_64.so` into a non-pure module pak (as the Warsow
   image does), drop in our hrace scripts. *(build proven; packaging TODO)*
2. **Racemod scripts** — layer `server/racemod/source` onto Warfork's `race.as`
   base; resolve AngelScript API drift (compile-at-boot surfaces mismatches fast).
3. **Native re-ports** — `RS_ApiReport*` (stats → existing `/api/ingest`), then
   `RS_Mirror*` (mesh with the Warsow servers?), wrghost cull, quad fix. Re-anchor
   onto `g_as_gametypes.cpp` / current file layout.
4. **Identity & stats** — thread the engine `steamid` into finish reports; extend
   the web schema so Warfork finishes carry steamID while Warsow stays name-only;
   define the unified-leaderboard reconciliation (steamID ↔ legacy name).
5. **Client** — re-port the racemod UI pak to the Warfork client; validate the
   [[warsow-stock-client-render-constraint]] still holds (WR ghost, race UI).
6. **Public listing** — pick a masterserver channel and settle the open risk below.

---

## 5. Open risks (resolve before public launch)

1. **Public listing REQUIRES a Steam server identity — RESOLVED 2026-07-24.**
   Tested live on US (`warfork-test`, `--net=host`, `sv_public 1`): the server
   *does* publish — heartbeats leave from the correct `51.81.48.153:44410` to the
   forbidden.gg/icy.gg masters, which challenge back and the server answers (full
   handshake, tcpdump-verified). But it is **not listed**, because those masters run
   `warmonger` (Rust, Steam-based) which keys servers by steamid and rejects the
   advertise when `steamid == 0` (`main.rs`). A `BUILD_STEAMLIB=0` build sends
   `svs.steamid = 0`, so it is reachable by **direct connect only**
   (`connect us.east.racesow.org:44410`) and never appears in the browser.
   **To be listed:** build `-DBUILD_STEAMLIB=1` (Steamworks SDK 1.64 from Valve's
   partner site — CI vendors a private copy from `Warfork/sdk_internal`) so the
   dedicated server obtains a real Steam game-server steamid (anon game-server login
   or a GSLT for appid 671610). Custom-`libgame` acceptance by the client is a
   separate, still-untested question (direct-connect from a real client).
   Deploy gotchas found: must use `--net=host` (bridge NAT mangles the heartbeat
   source port); `sv_port6` defaults to 44400 independently of `sv_port`;
   `sv_public` is reset by `default.cfg` unless forced last; `HEARTBEAT_SECONDS=300`.
2. **AngelScript API drift** between the Warsow SDK and warfork-qfusion (native
   binding signatures; `g_ascript.cpp` → `g_as_gametypes.cpp`).
3. **Client-side racemod UI** on the stock Warfork client (RML/menu system may have
   diverged; per-entity render limits).

---

## 6. Reproduce the spike

```bash
warfork/build-from-source.sh          # clone + build wf_server + game module (no Steam)
# boot headless on the race gametype:
OUT=~/warfork-build/warfork-qfusion/source/build/warfork-qfusion
docker run --rm --entrypoint /bin/bash -v "$OUT:/server" -w /server warfork-builder \
  -c './wf_server.x86_64 +set fs_basepath /server +set fs_game basewf +set dedicated 1 \
       +set g_gametype race +map wfrace1'
```

[qfusion]: https://github.com/Qfusion/qfusion
[TeamForbiddenLLC/warfork-qfusion]: https://github.com/TeamForbiddenLLC/warfork-qfusion
