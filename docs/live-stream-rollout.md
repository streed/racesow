# Live-stream production rollout runbook

Status: **HELD** — do not execute until the two gates below are met. This is the
turnkey procedure for when they are. Architecture + decisions: `live-stream-design.md`.

## Gates (must both be true before ANY prod step)

1. **hettoo integration finalized + verified.** The live-stream feature is
   entangled with the in-progress hettoo work: the game module compiles from the
   *whole* `server/racemod/source` tree (all the hettoo `.as` files + my
   `hrace.as` director), and the web image bundles `db.js` + the
   `canonical_group_by_nick` migration. A game/web rebuild ships **both**. So we
   deploy them **together**, only once hettoo is green on the boxes.
2. **SSH access** to `eu.frankfurt.racesow.org` and `us.east.racesow.org` (user
   to provision).

Then: commit + push the branch to `origin` (`git@github.com:streed/racesow.git`).
Exclude the stray `2026-07-17-*_hyprshot.png`.

## Decisions locked
- **EU first**, then US. Encoder **cpuset-pinned off the game cores**, **capped
  resolution/fps**, and **monitored** before rolling wider.
- Both features are **OFF by default** — `STREAM_URLS` unset ⇒ no stream UI;
  `rs_tv_name` empty ⇒ director disabled. So Phase A is safe to ship ahead of the
  risky capture step.

## One open decision — how HLS reaches the browser (pick before Phase B)
- **A (simplest, recommended to start):** same-origin over Cloudflare —
  `https://racesow.org/hls/<box>/index.m3u8`. Browser fetches go *through* CF (which
  presents the mTLS client cert), so the `:443` origin gate is satisfied; game
  clients still use plain `:80` for paks. CSP needs only `media-src 'self' blob:`
  (`connect-src 'self'` already covers same-origin). Add a CF **Cache Rule** for
  `/hls/*.(m4s|ts)` and **monitor egress + the video-TOS** on non-Enterprise plans.
- **B (CF-bypass fallback if flagged):** grey-cloud `stream.racesow.org` (DNS-only)
  → origin `:443` with its own cert and **no** mTLS on that vhost. CSP adds
  `https://stream.racesow.org` to `connect-src` + `media-src`. All egress hits the
  origin directly (no CF video caching concern), at the cost of origin bandwidth.

---

## Phase A — web + game module (SAFE; both features off)  · EU then US
Run on the box, repo root, after `git pull`.

1. **Web** (rebuild + rolling, runs the migration under advisory lock):
   ```
   scripts/rolling-deploy.sh
   curl -fsS https://racesow.org/api/health && echo ok
   ```
   Verify the site loads and hettoo's web changes (canonical-by-nick leaderboards) look right.
   `STREAM_URLS` is unset ⇒ no stream UI yet.
2. **Game module** (ships hrace.as director + all hettoo `.as`):
   ```
   cd server && docker compose build warsow-race && docker compose up -d warsow-race
   docker logs warsow-race 2>&1 | grep -E "Gametype 'Race' initialized|error"   # must init, no AS errors
   ```
   **Verify hettoo game features here** (this is where they go live). `rs_tv_name`
   unset ⇒ director dormant.
3. **nginx CSP + /hls location** (`deploy/nginx/racesow.conf`), then
   `sudo nginx -t && sudo systemctl reload nginx` (restore backup if `-t` fails):
   - CSP (line ~173): insert `media-src 'self' blob:;` (option B also adds the
     stream host to `connect-src`/`media-src`):
     ```
     ... img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://cloudflareinsights.com; ...
     ```
   - New `location` in the **`:443`** `racesow.org` server block (option A), serving
     the capture's tmpfs, cached briefly, CORS not needed (same-origin):
     ```
     location /hls/ {
         alias /dev/shm/wtv-hls/;
         add_header Cache-Control "no-cache, no-store" always;   # override for .m3u8 below
         location ~* \.m3u8$ { alias /dev/shm/wtv-hls/; add_header Cache-Control "no-cache, no-store" always; }
         location ~* \.(m4s|ts)$ { alias /dev/shm/wtv-hls/; add_header Cache-Control "public, max-age=10" always; }
     }
     ```
     (No streams exist yet ⇒ harmless until Phase B.)

**Phase A rollback:** `HEALTH_TIMEOUT=… scripts/rolling-deploy.sh` on the previous
image; `docker compose up -d warsow-race` on the prior `warsow-race` image tag
(keep `docker tag warsow-race:2.1.2 warsow-race:pre-tv` before building).

---

## Phase B — capture stack on EU (the risky co-located part)  · MONITOR

4. **Enable the director** on the game server (spectator name it will drive):
   ```
   # add to warsow-race env / EXTRA_ARGS, then recreate:
   #   EXTRA_ARGS="+set rs_tv_name RACESOW-TV"
   ```
   Harmless until a client named `RACESOW-TV` connects.
5. **Configure + start capture** via compose (`server/docker-compose.tv.yml`).
   The service is cpuset-pinned OFF the game cores, writes HLS to RAM, and builds
   the image from THIS box's game image so the HUD pak matches. Per-box + secret
   values live in `server/tv/tv.env` (gitignored):
   ```
   cd server
   cp tv/tv.env.example tv/tv.env
   # edit tv/tv.env: STREAM_ID (eu|us), SERVER_ID, SERVER_NAME, HEARTBEAT_URL,
   #   HEARTBEAT_TOKEN (= this box's game INGEST_TOKEN)
   docker compose -f docker-compose.tv.yml up -d --build
   ```
   The old hand-typed `docker run` is retired — a script change (e.g.
   `tv/getstatus.sh`) redeploys with the SAME `up -d --build` one-liner, and the
   container's config now lives in `tv.env` rather than only inside the running
   container. To lighten a constrained box, set `WIDTH/HEIGHT/FPS/VBITRATE` (e.g.
   `854`/`480`/`30`/`1500k`) in `tv.env`.
6. **GO / NO-GO gate — watch for 10–15 min under real load:**
   - Game tick/snapshot rate steady (`sv_pps` honored; no stutter reports).
   - `mpstat -P ALL 2` — game cores NOT saturated by the encoder; capture stays on its cores.
   - `du -sh /dev/shm/hls` stays ~small (delete_segments working).
   - Stream reachable: `curl -I https://racesow.org/hls/eu/index.m3u8` (200, not 400).
   - **NO-GO** ⇒ lower WIDTH/HEIGHT/FPS/VBITRATE, tighten `--cpuset-cpus`, or
     `docker rm -f warsow-tv-capture` (stream stops; game untouched) and revisit
     placement (separate box / GPU VPS per the design).
7. **Surface it on the site:** set `STREAM_URLS` on the web service, e.g.
   `STREAM_URLS="<EU_SERVER_ID>=https://racesow.org/hls/eu/index.m3u8"`, then
   `scripts/rolling-deploy.sh`. The server page now shows the LIVE STREAM + the
   `connect <game addr>` chip; empty ⇒ the RACESOW top-3 card.
8. **Cloudflare:** apply the chosen delivery option (A cache-rule / B grey-cloud),
   confirm `CF-Cache-Status` and that segments load in a real browser; watch egress.

---

## Phase C — US box  (`us.east`, game run MANUALLY — no `racesow-agent.service`)
Repeat Phase B on us.east: its own `server/tv/tv.env` with `STREAM_ID=us`,
`SERVER_ID=<US_SERVER_ID>`, `SERVER_NAME="Racesow - US East"`,
`HEARTBEAT_URL=.../api/streams/<US_SERVER_ID>/health`, and
`HEARTBEAT_TOKEN` = the US box's game `INGEST_TOKEN` (US has no `server/.env`;
read it from the running container: `docker inspect warsow-race`). Then
`docker compose -f docker-compose.tv.yml up -d --build`, and add
`<US_SERVER_ID>=https://racesow.org/hls/us/index.m3u8` to `STREAM_URLS`. Same
GO/NO-GO gate.

---

## Supervision / limits (bake in during Phase B/C)
- **Restart policy:** the capture runs under compose (`server/docker-compose.tv.yml`,
  `restart: unless-stopped`), so it comes back after a daemon/box restart; capture-run.sh
  also self-heals a wedged encoder/director. Optionally add `scripts/hls-health-check.sh`
  (lag < 60 s, dropped < 1 %) on a timer.
- **rolling-deploy:** the capture is independent of the web replicas; no drain needed,
  but note it in the deploy checklist so a game-image rebuild recreates it cleanly.
- **Disk:** HLS is RAM (tmpfs) + `delete_segments` ⇒ bounded (~10 MB); wiped on restart.
- **Egress:** ~1.5–3.5 Mbps/viewer; monitor CF egress; per-server streams multiply by N.

## Fill-in before running (prod-specific)
- [ ] EU/US enrolled **server ids** + per-server **ingest tokens** (`node admin.js list`).
- [ ] EU/US **core layout** for `--cpuset-cpus` (game/Postgres cores vs spare).
- [ ] HLS delivery **option A vs B** + Cloudflare rule/subdomain.
- [ ] The game compose **network name** the capture joins.
- [ ] Keep pre-rollout image tags: `docker tag warsow-race:2.1.2 warsow-race:pre-tv`, `racesow-web:latest` digest noted.
