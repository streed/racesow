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

---

## 7. Deployment architecture — dual-game, both boxes, one unified mesh

**Agreed goal (2026-07-27):** on **each** box run a Warsow **and** a Warfork race
server; all four feed the same racesow.org stats (`/api/ingest`, **name-keyed**
for now — steamID later) and all four are joined in **one mesh** so players see
each other as ghosts and **chat crosses both games and both continents**.

### 7.1 Hard constraints (user)
1. **Leave the running Warsow servers alone** — Warfork ships as *additive*
   containers (new ports, own `fs_game`); no change to the Warsow binary/mod.
   The one necessary touch: expand each Warsow server's `MIRROR_PEERS` (env +
   rolling restart) to add the two Warfork nodes. Config-only, reversible.
2. **Shared map pool, no duplication** — both games read the *same* host maps
   directory (mounted read-only into both containers). Warsow & Warfork are the
   same qfusion 2.1 BSP generation, so the `.pk3` map packs should load in both;
   **must be verified** with a real racesow map on Warfork (§ plan step 5).
3. **Cross-game mesh** — the mesh (`g_rs_mirror.cpp`) is a self-contained raw-UDP
   worker thread speaking a text **"RSM1"** datagram protocol (HMAC-SHA256),
   touching ~no qfusion trap APIs. Porting the *same* C++ into Warfork keeps the
   wire format byte-identical → Warfork↔Warsow mesh works and **cannot break the
   live EU↔US Warsow mesh**. Multi-peer lists + per-tag dedup already supported.

### 7.2 Topology (4 nodes, full mesh)

| Box | Server | fs_game | game (udp) | http (tcp) | mirror (udp) | tag |
|---|---|---|---|---|---|---|
| eu.frankfurt | Warsow *(existing)* | `racemod` | 44400 | — | 44450 | `EU-WS` |
| eu.frankfurt | **Warfork** *(new)* | `racesow` | 44410 | 44411 | 44451 | `EU-WF` |
| us.east | Warsow *(existing)* | `racemod` | 44400 | — | 44450 | `US-WS` |
| us.east | **Warfork** *(new)* | `racesow` | 44410 | 44411 | 44451 | `US-WF` |

Chat prefixes therefore render as `[EU-WS]`/`[US-WS]` (Warsow) and
`[EU-WF]`/`[US-WF]` (Warfork). The mesh tag charset allows `-`
(`sanitizeTag`), so these are valid; max 16 chars. Retagging the existing
Warsow nodes `EU`→`EU-WS` / `US`→`US-WS` is a cosmetic `MIRROR_TAG` env change
bundled with the `MIRROR_PEERS` expansion (§7.1).

Each node lists the **other three** as `MIRROR_PEERS` (same-box peer via the box
IP/localhost, cross-box via public host), one shared `MIRROR_SECRET`. Hop limit
is 1 by construction, so a full mesh of 4 has no loops. New UFW openings per box:
`44410/udp`, `44411/tcp`, `44451/udp` (US already opened 44410/44411 for the spike).

### 7.3 Stats & maps
- **Stats:** Warfork's `RS_ApiReport*` POST finishes to the existing
  `/api/ingest` by **player name** (identical to Warsow) → one leaderboard with
  no schema change. steamID identity is a later upgrade (`clc_steamauth`).
- **Maps:** one host dir (e.g. the current `server/maps`) mounted RO into both
  containers' fs search path — zero duplication. Client-side delivery of custom
  racesow maps to Warfork clients (HTTP download, like the Warsow pakserver) is a
  later concern; server-side presence suffices for direct-connect testing.

## 8. Revised port plan (supersedes §4 ordering)

Native re-ports live *inside* the build (the module must carry the natives or the
gametype won't compile), so build + natives land together; the first verifiable
milestone is "boots our race gametype and the AngelScript compiles".

1. **Recon AS drift** — diff our `g_ascript.cpp` patch anchors against Warfork's
   `g_ascript.cpp` (it exists — good) + read Warfork's `race.as`; scope the
   re-anchor for each patch bundle.
2. **Build pipeline** — `warfork/Dockerfile` (multi-stage): builder = proven
   source build (`BUILD_STEAMLIB=0`) applying the **re-anchored** patches
   (api-natives, mirror-natives, wrghost-cull, quad-fix; **drop** udp-download,
   re-check motd-live); runtime = `wf_server` + `basewf` + our `racesow` fs_game
   (racemod scripts + paked libgame + configs).
3. **Racemod scripts** — layer `server/racemod/source` onto Warfork's `race.as`;
   resolve AngelScript API drift (compile-at-boot surfaces mismatches fast).
4. **Stats** — verify finishes reach `/api/ingest` (name-key) and the unified
   leaderboard shows Warfork runs beside Warsow.
5. **Shared maps** — mount the shared maps dir RO into both; verify a real
   racesow map pk3 loads on Warfork.
6. **Cross-game mesh** — bring up the 4-node mesh; verify Warfork↔Warsow ghosts +
   chat **both directions**; expand the existing Warsow `MIRROR_PEERS`.
7. **Client UI pak** + optional **public Steam listing** (`-DBUILD_STEAMLIB=1` +
   GSLT for appid 671610 — **Steam creds now available**).
8. **Additive deploy** to EU+US via the deploy-production skill; Warsow untouched
   beyond the mesh-peer env expansion.

## 9. AngelScript / native drift map (recon, 2026-07-27)

Diffed our racemod's required natives against Warfork's `g_ascript.cpp`. The port
is **more tractable than §3 feared** — Warfork keeps qfusion's `g_ascript.cpp`
binding structure (the design doc's "moved to `g_as_gametypes.cpp`" was wrong).

- **Binding anchors survive.** Warfork's `g_ascript.cpp` has the exact
  `static const asglobfuncs_t asGlobFuncs[] =` table our `patch-api-natives.py` /
  `patch-mirror-natives.py` insert wrappers before. Only the *entry* anchor —
  the DenMSC line `{ "bool RS_ResetPjState( int playerNum )", ... }` — is absent;
  re-point it to a stock qfusion entry (e.g. `G_SpawnEntity`).
- **Our two patch bundles supply most natives.** Re-porting `g_rs_api.cpp` +
  `g_rs_mirror.cpp`/`g_rs_mirrorbots.cpp` (with re-anchored `.py`) provides every
  `RS_Api*`, `RS_Ghost*`, `RS_Mirror*`, `RS_SetHideWrGhost`, `RS_*Text` native.
- **Shooters are script-side.** `RS_InitShooter*`, `RS_UseShooter`,
  `RS_shooter_{rocket,plasma,grenade}` are defined in `entities/shooters.as` — no
  native needed.
- **NEW native work — 3 DenMSC-SDK base natives Warfork lacks** (Warsow inherits
  these from DenMSC's fork; they are *not* in our patches):
  - `RS_QueryPjState` / `RS_ResetPjState` (**PRE-JUMP** state — "pj", not
    projectile: per-client jump/dash/walljump counters that `startRace()` gates
    every run on). Warfork has no equivalent. **They are useless without the
    `gs_pmove.c` counter hooks that feed them** — binding the natives alone makes
    `RS_QueryPjState` answer false forever and silently disables the prejump rule.
    (That is exactly what happened: hooks deferred at port time, prejump
    unenforced on both Warfork nodes until 2026-07-30 —
    `warfork/enginepatches/patch-pjcount-hooks.py`.)
  - `G_RemoveProjectiles( Entity@ )` (per-owner, called once at `hrace.as:507`).
    Warfork offers only global `G_RemoveAllProjectiles()` — different signature
    *and* semantics (all vs owner's).
  - Plan: port DenMSC's implementations into a small `g_rs_pjstate` patch bundle,
    **or** first-boot with registered stubs + map `G_RemoveProjectiles(ent)` →
    `G_RemoveAllProjectiles()` (acceptable on a solo race server) and port the
    real impls later. All three must at least be *registered* or the gametype
    won't compile at boot.
- **Residual script-API drift** (Entity/Client/Gametype method signatures between
  the DenMSC and Warfork AngelScript API) surfaces fast at compile-at-boot — that
  is Task #3's job, not resolvable purely by static diff.

## 10. Followup requirements (2026-07-27)

1. **Leaderboard "wf" tag — config-only (CORRECTED, decision D1).** Warfork
   finishes are marked via the EXISTING `rs_api_version` version dimension: set
   `VERSION_NAME="wf 2.16"` (entrypoint emits `set rs_api_version`), ingest
   auto-inserts the version row (`INSERT INTO version(name) ON CONFLICT`), records
   render a `[wf 2.16]` pill + own rank bucket. **No schema/ingest/UI change.**
   (An earlier draft proposed a new `game` column — unnecessary; that would be an
   optional fast-follow for a cleaner filter than the version string.) GOTCHA:
   `VERSION_NAME` MUST be set on Warfork or BOTH entrypoint and the native default
   fall back to `"wsw 2.1"` → finishes silently mislabel as Warsow.
2. **Mesh chat tags** `[EU-WS]/[US-WS]` + `[EU-WF]/[US-WF]` — see §7.2 (done in
   topology; requires retagging the two live Warsow nodes).
3. **hettoo feature focus.** The port must carry our hettoo/wsw-race integration —
   already vendored in `server/racemod/source` (see the hettoo-full-integration
   work: first-wave + BatchA + BatchB + /prerandmap done; /cps, /lastrecs,
   /topfull, noclip-UX pending). Porting our racemod source forward brings these
   automatically; treat hettoo parity as the acceptance bar for Task #3, and
   prioritize the most-recent hettoo changes.

## 11. Mesh wiring + US deploy runbook (base-independent)

These are stable regardless of the hettoo-vs-DenMSC codebase decision — the mesh
natives, ports, env-var contract (`SV_PORT`/`MIRROR_*`/`VERSION_NAME`/`INGEST_*`),
and shared-maps mount all port identically. Recorded now so deploy is ready the
moment the build lands.

### 11.1 Exact 4-node mesh wiring
`EUh = eu.frankfurt.racesow.org`, `USh = us.east.racesow.org`. Warsow mirror
port 44450, Warfork 44451. Each node lists the **other three**; one shared
`MIRROR_SECRET` across all four (already set on the two Warsow boxes; reuse it).

| Node | `MIRROR_TAG` | `MIRROR_PORT` | `MIRROR_PEERS` |
|---|---|---|---|
| EU-Warsow | `EU-WS` | 44450 | `EUh:44451 USh:44450 USh:44451` |
| EU-Warfork | `EU-WF` | 44451 | `EUh:44450 USh:44450 USh:44451` |
| US-Warsow | `US-WS` | 44450 | `USh:44451 EUh:44450 EUh:44451` |
| US-Warfork | `US-WF` | 44451 | `USh:44450 EUh:44450 EUh:44451` |

(substitute the real hostnames for `EUh`/`USh`). Same-box peers use the box's own
public hostname; published mirror ports on `0.0.0.0` hairpin fine — if a box's NAT
won't hairpin, fall back to the docker host-gateway IP for the same-box peer.

**The one touch to the live Warsow servers** (config-only, reversible): today each
Warsow node peers *only* the other box's Warsow and is tagged `EU`/`US`. Edit:
- EU-Warsow: `MIRROR_TAG` `EU`→`EU-WS`; add `EUh:44451 USh:44451` to `MIRROR_PEERS`.
- US-Warsow: `MIRROR_TAG` `US`→`US-WS`; add `USh:44451 EUh:44451` to `MIRROR_PEERS`.
- EU env = `server/.env`; US env = repo-root `.env` (agent compose). Rolling
  restart to apply. Warsow **code/image unchanged**.

### 11.2 New host ports (UFW) per box
`44410/udp` (WF game), `44411/tcp` (WF http/pak), `44451/udp` (WF mirror). US
already opened 44410/44411 for the spike; add 44451. EU needs all three.

### 11.3 Shared map pool
Warfork service mounts the **same** `./server/maps` dir the Warsow service already
uses (`:ro`), into Warfork's fs search path — no duplicate storage. (Load-compat of
Warsow `.pk3`s on Warfork is verified in Task #5.)

### 11.4 US deploy runbook (additive; Warsow untouched)
1. Land the `warfork/` build (Dockerfile + racemod, per the revised plan) and a
   `docker-compose.warfork.yml` service `warfork-race`: ports `44410:44410/udp`,
   `44411:44411/tcp`, `44451:44451/udp`; env `VERSION_NAME="wf <ver>"`,
   `G_GAMETYPE=race`, `INGEST_URL`/`INGEST_TOKEN` (new server token), `MIRROR_*`
   per §11.1 row US-Warfork; volume `./server/maps:<wf-maps-path>:ro`.
2. On US box: `git pull` (reconcile drift per deploy-production skill), open UFW
   `44451/udp`, `docker compose -f docker-compose.warfork.yml up -d --build`.
3. Expand US-Warsow `MIRROR_PEERS`/`MIRROR_TAG` (§11.1) + rolling restart.
4. Tear down the spike: `docker rm -f warfork-test`; remove `~/warfork-steam`,
   `~/warfork-test`; `ufw delete` any spike-only rules kept.
5. Verify: `warfork-race` boots race + compiles AS; a finish shows on
   racesow.org tagged `[wf <ver>]`; `docker logs warfork-race | grep 'rs_mirror: stats'`
   shows `heard=[...]` rx>0 drop=0 for the three peers; cross-game chat both ways.
6. EU repeats once US is green (EU also runs web+tv — treat as the more sensitive box).

[qfusion]: https://github.com/Qfusion/qfusion
[TeamForbiddenLLC/warfork-qfusion]: https://github.com/TeamForbiddenLLC/warfork-qfusion
