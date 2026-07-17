# Design: live video streaming (warsow-tv → website)

Status: **proposed** — Phase 0 (feasibility spike) is the gate; nothing downstream
is built until the spike passes.

## Goal

Let people **watch live races on the website**. Each game server renders and
encodes its own gameplay video and publishes an HLS stream; the site's **Live**
page lists the streamable servers and plays whichever one the viewer picks.

## Decisions (locked with the user)

| Decision | Choice | Consequence |
|---|---|---|
| Delivery to browser | **Real video** (not a data-driven in-browser ghost view) | Needs the un-stripped `wswtv_server` relay + `warsow.x86_64` GL client + Xvfb + ffmpeg |
| Encode placement | **Co-located, per server** (each game box encodes its own) | No central encoder; CPU contention with the game loop is the top risk |
| Viewer model | **Per-server streams** (viewer connects to each individually) | N encoders + N streams; no cross-server "featured"/directed aggregation |
| GPU | **CPU-only, no GPU** | Software Mesa `llvmpipe` render **and** software `libx264` encode — heavy; **Phase 0 spike is mandatory** |
| Protocol | **Classic HLS** (fMP4/CMAF) | ffmpeg → segments on disk → nginx → `hls.js`/native Safari; ~6–15 s latency, lowest ops |
| Access | **Public**, monitor egress | HLS served on `:80` outside the mTLS gate (or grey-clouded subdomain); watch Cloudflare egress |

The relay's built-in broadcast delay means ultra-low latency is pointless anyway,
so classic HLS is the right call.

> **Rejected alternative (recorded for posterity):** a data-driven in-browser
> spectator — stream the mesh's existing ~10 Hz per-player positions
> (`mirror.as` `RS_MirrorBegin/Player/End`) into the existing three.js viewer
> (`replay.js`). Near-zero CPU/egress, sub-second latency, no Cloudflare video
> exposure — but an abstract ghost view, not real footage. The user chose real
> video. Keep this in the back pocket if the Phase 0 spike fails on CPU-only.

## Architecture

Everything below runs **once per game box**, self-contained:

```
 wsw_server (game, UDP 44400)
     │  snapshots
     ▼
 warsow-tv  (wswtv_server relay, UDP 44440)      ← "warsow-tv client connected to the server"
     │  connect <gameserver:44400> [pw] [name] [delay]
     ▼
 tv-capture (warsow.x86_64 GL client under Xvfb :99 + Mesa llvmpipe)
     │  auto-spectate + chasecam driven by the auto-director
     ▼
 ffmpeg  -f x11grab :99  →  libx264 veryfast zerolatency  →  HLS fMP4
     │  segments on tmpfs /hls/<stream_id>/
     ▼
 nginx  location /hls/  (:80, OUTSIDE the :443 mTLS gate)
     │
     ▼
 Cloudflare (grey-cloud stream subdomain OR explicit /hls cache rule)
     │
     ▼
 browser: vendored hls.js (MSE) / native Safari  →  <video> on the Live page
```

Side channels:
- **Registry:** the encoder POSTs a heartbeat → `stream` table → `GET /api/streams`
  → the Live page lists live servers.
- **Director:** in-mod `GT_ThinkRules` picks the POV and sets `chaseActive`/
  `chaseTarget` on the capture client's spectator; publishes `current_pov` to the
  registry for a "now watching X" caption.

### Components

| Component | Role | Where |
|---|---|---|
| `warsow-tv` (relay) | QTV-style relay; connects **outward** to the local game server as a TV client, exposes it as a channel on `:44440`. Renders nothing. | New Dockerfile stage that stops `rm -f wswtv_server` (`server/Dockerfile:203`). New service in `server/docker-compose.yml` (EU) + `docker-compose.agent.yml` (US). |
| `tv-capture` | `warsow.x86_64` under `Xvfb` + Mesa `llvmpipe` (`LIBGL_ALWAYS_SOFTWARE=1`), auto-connected downstream as spectator; `ffmpeg x11grab` → HLS. **Turns the relay into pixels.** | New image bundling the un-stripped client (`server/Dockerfile:202`) + `xvfb` + `libgl1-mesa-glx` + `ffmpeg`/`libx264`. New per-box service. |
| ffmpeg encoder | `-f x11grab -framerate 30 -video_size 1280x720 -i :99 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -f hls -hls_time 4 -hls_list_size 6 -hls_flags delete_segments -hls_segment_type fmp4` | Process inside `tv-capture`, writing to a **tmpfs** `/hls` volume. |
| HLS nginx | Serves `/hls/*.m3u8` + `*.m4s` on `:80`, outside the mTLS block. | `deploy/nginx/racesow.conf` new `location /hls/` (EU) / the `nginx:alpine` pakserver pattern (US). |
| stream registry | `stream` table + `upsertStream`/`queryActiveStreams`. | `web/db.js` + new `web/migrations/…_streams.sql` (node-pg-migrate, `map_block.sql` format). |
| stream API | `GET /api/streams` (public), `POST /api/streams/:id/health` (per-server token, like `/api/ingest`). Redis-cached list. | `web/server.js` on the existing `/api` router (`server.js:856`); `web/cache.js`. |
| auto-director | Race-aware POV picker (fastest/near-PB runner). | In-mod `hrace` `GT_ThinkRules`, reusing `/watch` `chaseActive`/`chaseTarget` (`mirror.as:834`). |
| hls.js player | Browser HLS playback. **Vendored** (CSP blocks CDNs). | `web/public/assets/vendor/hls/` + a live-stream view in the existing `#/live` route. |
| CSP change | Allow MSE blobs + the stream origin. | Single CSP line at `deploy/nginx/racesow.conf:173` — add `media-src 'self' blob:` (+ stream host in `connect-src`/`media-src`). |

## Phased plan

### Phase 0 — render feasibility spike (**GO/NO-GO gate; do this first**)
The whole architecture rests on one unknown: **can a headless `warsow.x86_64`
under Xvfb + Mesa `llvmpipe` render Warsow at a usable resolution/fps in real
time, on a CPU-only box, without starving the co-located game loop?**

- Throwaway image: un-stripped client + `xvfb` + `libgl1-mesa-glx` + `ffmpeg`.
- Launch: `Xvfb :99 -screen 0 1280x720x24 +extension GLX +render`; then
  `DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe warsow.x86_64
  +set vid_fullscreen 0 +set vid_width 1280 +set vid_height 720
  +set in_grabinput 0 +set s_module 0 +set cl_maxfps 30 +connect <server>`.
- Measure sustained render fps + cores at **720p and 480p**, high vs low `r_*`.
- Run `ffmpeg x11grab → libx264 veryfast` alongside; measure **combined** cores.
- **On a real game box:** confirm the game server's snapshot/tick rate is
  unaffected while the capture runs (this is the co-location risk made concrete).

**Validation:** a short HLS clip that plays in a browser **and** a `top`/`iostat`
capture showing render+encode fit within the box's spare cores with the game loop
still clean. If it can't clear ~24–30 fps at any acceptable resolution without
degrading the game, that's a **NO-GO** for co-located software render → we drop
resolution/fps further, reconsider placement, or fall back to the data spectator.

Est: **1–2 days.**

### Phase 1 — one manual stream, end-to-end (no director yet)
Un-strip the binaries; add `warsow-tv` + `tv-capture` services; ffmpeg → HLS on
tmpfs; `/hls` nginx on `:80`; `stream` table + migration + `db.js` methods;
`GET /api/streams` + heartbeat POST on the `/api` router; vendor `hls.js`; add the
player to the Live route; CSP edits. Capture client follows a **fixed** player.

**Validation:** watch a manually-followed player on the Live page in Chrome **and**
Safari; `curl` the HLS host and confirm it's reachable without a Cloudflare client
cert (not HTTP 400) with sane `Cache-Control`. Est: **4–6 days.**

### Phase 2 — race-aware auto-director
In-mod `GT_ThinkRules` ranks `inRace` players by progress/`maxSpeed`/near-PB
(`player.as` signals), reuses `chaseActive`/`chaseTarget` (`mirror.as:834`), applies
the **`MOVETYPE_NOCLIP` freeze-fix** (`mirror.as:531`), adds hysteresis (min ~3–5 s
per POV) and a fallback (`chasenext`/spec) when nobody's racing. Publishes
`current_pov` to the registry.

**Validation:** on a populated server the POV switches to the leader/near-record run
within a few seconds, never `PM_FREEZE`s, never thrashes, falls back when empty.
Est: **3–5 days.**

### Phase 3 — multi-server rollout + hardening + ops
Roll the pattern to both boxes; `cpuset`-pin capture+encoder off the game cores;
`systemd racesow-tv-capture.service` (`Restart=always`) + `hls-health-check.sh`
(lag < 60 s, dropped < 1 %); Cloudflare grey-cloud/cache-rule + egress monitoring;
`delete_segments` + orphan-dir sweeper; `rolling-deploy.sh` drains the encoder
before web redeploys; admin-console stream/lag panels.

**Validation:** kill the encoder → systemd restarts it, site marks the stream
stale→live; load test shows the game tick unaffected and CF egress within budget.
Est: **3–5 days.**

**Total for the full video path: ~2.5–3.5 weeks**, contingent on Phase 0.

## Web integration specifics

- **CSP** (`deploy/nginx/racesow.conf:173`): `media-src` is currently unset → falls
  back to `default-src 'self'`, which **forbids the `blob:` URLs** MSE/hls.js need.
  Add `media-src 'self' blob:` (+ `worker-src blob:` if hls.js uses a worker, +
  the stream host in `connect-src`/`media-src` if on a subdomain). `hls.js` is a
  **vendored** file under `script-src 'self'` — no CDN.
- **Migration**: new `web/migrations/<ts>_streams.sql`, copy the
  `CREATE TABLE … / -- Down Migration` format from
  `20260716130000000_map_block.sql`; node-pg-migrate applies it at boot under the
  advisory lock.
- **Dockerfile COPY discipline** (per project memory): `web/Dockerfile` COPYs
  `public/` wholesale (`:22`), so vendored `hls.js` + the player JS ship fine — but
  any **new top-level web `.js` server module** must be hand-added to the explicit
  COPY line at `web/Dockerfile:19` or the image ships without it.
- **Heartbeat auth**: `POST /api/streams/:id/health` uses the per-server token like
  `/api/ingest`, so a random client can't spoof a stream. `GET /api/streams` is
  public read, Redis-cached (`web/cache.js`).

## Open risks

- **CRITICAL — no GPU (spike first).** Both render (`llvmpipe`, a CPU rasterizer)
  and encode (`libx264`) are software. `llvmpipe` hits ~30 fps only for light loads;
  Warsow is a heavier modern GLSL FPS, so **720p30 is marginal**. Phase 0 decides
  GO/NO-GO empirically.
- **CPU starvation on the game box.** Co-location (the user's choice) puts software
  render + encode next to the single-threaded game loop (and, on the EU box, a
  Postgres tuned for 12 parallel workers). Mitigations: `cpuset`-pin the encoder
  off the game cores; cap resolution/fps; watch the game snapshot rate under load.
- **Cloudflare video TOS + caching.** Serving/caching non-Cloudflare-Stream HLS is
  restricted on Free/Pro/Business; uncached `.m4s` hits origin egress. Mitigation:
  grey-cloud a DNS-only stream subdomain **or** an explicit `/hls` cache rule;
  monitor egress; serve on `:80` outside the mTLS gate.
- **mTLS gate blocks HLS if mis-placed.** The `:443` vhost enforces Authenticated
  Origin Pulls → a non-CF client gets HTTP 400. HLS must be on `:80` / a
  grey-clouded host, **not** behind the `:443` block.
- **`wswtv` source lineage.** Upstream qfusion master removed `source/tv_server`;
  this works only because the `warsow-2.1.2` tarball still ships the `wswtv_server`
  **binary** — the Dockerfile just deletes it (`:203`). Confirm the binary is
  present before building the relay.
- **Auto-director is real work, not config.** Built-in `chase auto/score/carriers`
  are frag/flag/powerup based and **don't** track the fastest runner. Must build a
  race-aware director + the `MOVETYPE_NOCLIP` freeze-fix + hysteresis.
- **`demoavi` trap.** The engine's built-in capture is an **offline** demo→frames
  dumper (decouples game clock from wallclock, disables the fps cap) — **not** live.
  Live path is `x11grab` only.
- **Headless client fragility.** Audio-device init / input probing are crash points
  (force `s_module 0` / SDL dummy audio, `in_grabinput 0`); this engine has a
  history of static-thread/clean-exit crashes → needs supervision + auto-restart.
- **Egress + disk.** 720p30 ≈ 2.5–3.5 Mbps/viewer (the dominant recurring cost, and
  exactly what Cloudflare won't cheaply cache); segments must use `delete_segments`
  on tmpfs (~34 GB/day/stream uncapped). Per-server streams multiply both by N.
- **Each relay consumes a player slot** on its game server (counts against
  `sv_maxclients`, forced spectator; pass `sv_password` if set).
