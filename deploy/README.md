# Production deployment — central stats box (Cloudflare-fronted)

How the central stats site (`web/`, `discord/`, Postgres) runs in production on
`eu.frankfurt.racesow.org`, and everything a redeploy or a fresh box must
reproduce. The game server (`server/`) and agent servers are covered in the
top-level `README.md` and `AGENT.md`; this file is the **central web/API box**.

> **The origin only accepts Cloudflare.** Requests must come *through*
> Cloudflare — the origin enforces Cloudflare's client certificate (mTLS /
> Authenticated Origin Pulls). A direct hit to `https://<origin>/` returns
> **HTTP 400**. If you stand up a new origin, or redeploy nginx, the mTLS +
> Cloudflare pieces below are **not optional** — miss them and the site is
> either down (400 for everyone) or unprotected.

## Architecture

```
browser ─► Cloudflare (proxied, TLS) ─► host nginx :443 ─► web replicas :8080/:8081 ─► Postgres
                                            │                     └► Redis (response cache)
                                            └► :80 /racemod/, /demos/ ─► pakserver (game pak + WR demo downloads, plain HTTP)
game servers ──(POST /api/ingest via https://racesow.org)──► Cloudflare ─► origin
```

- **Read-heavy** web/API, fronted by a Redis response cache (`web/cache.js`).
- **Two stateless web replicas** behind an nginx upstream for zero-downtime
  rolling deploys (`scripts/rolling-deploy.sh`); all state is in Postgres.
- Game clients download map paks (and WR demo `.wd` files) over **plain HTTP on
  port 80** (`/racemod/`, `/demos/`) — the 2018 engine can't do TLS. Port 80 is
  therefore *not* behind mTLS.

## Cloudflare dashboard (required — cannot be done from the box)

For the `racesow.org` zone, under **SSL/TLS**:

1. **DNS**: `racesow.org` **proxied** (orange cloud) → origin IP. Keep
   `eu.frankfurt.racesow.org` **unproxied** (grey) → same origin — it's the
   path for ACME renewals and game-client pak/demo downloads on port 80.
2. **Overview → encryption mode: Full (Strict)** (safe: the origin has a valid
   Let's Encrypt cert for `racesow.org`).
3. **Origin Server → Authenticated Origin Pulls: ON** (the zone-level toggle).
   **This is the origin's security gate** — it makes Cloudflare present its
   client cert to the origin. It is **not** the "Client Certificates" page
   (that's API Shield, end-user→Cloudflare mTLS — a different, unrelated
   feature). It is **not** an "Origin Certificate" either (you don't need one;
   the LE cert already covers Full Strict).
4. Recommended: **WAF** managed rules, a **Rate Limiting** rule, and **Bot Fight
   Mode** — the L7 protections that live at the edge.

## Origin nginx  (`deploy/nginx/racesow.conf` → `/etc/nginx/sites-available/racesow`)

The versioned config is `deploy/nginx/racesow.conf`; deploy it with
backup → `sudo nginx -t` → `sudo systemctl reload nginx` (restore the backup if
the test fails). It provides:

- **Real client IP** from `CF-Connecting-IP` (`set_real_ip_from` for every
  Cloudflare range + `real_ip_header CF-Connecting-IP`). Refresh the ranges from
  <https://www.cloudflare.com/ips-v4> and `ips-v6` (they change rarely).
- **X-Forwarded-For is overwritten** with the real IP (`$remote_addr`), not
  appended — so a client can't forge it to bypass the app rate limiter.
- **Rate limits** (`racesow_api`, `racesow_render`, `racesow_demo`), a **per-IP
  connection cap**, and **anti-slowloris timeouts** on the 443 vhost.
- **`keepalive_timeout 3600s`** on the 443 vhost — Cloudflare reuses idle origin
  connections for up to ~900s; nginx's 75s default would close them first and
  cause **intermittent client-side timeouts** (a hard refresh "fixes" it). Must
  exceed Cloudflare's window. Paired with **`worker_shutdown_timeout 30s`** in
  `/etc/nginx/nginx.conf` so a reload doesn't strand old workers holding those
  long-lived connections.
- **mTLS**: `ssl_client_certificate /etc/nginx/cloudflare-origin-pull-ca.pem;`
  + `ssl_verify_client on;`. **The CA file must exist on the box** — fetch it
  (public, not a secret):
  ```
  curl -fsS https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem \
    | sudo tee /etc/nginx/cloudflare-origin-pull-ca.pem >/dev/null
  ```
- **Server cert**: Let's Encrypt at
  `/etc/letsencrypt/live/eu.frankfurt.racesow.org/`, SANs
  `eu.frankfurt.racesow.org` **and** `racesow.org`.

### Enabling mTLS in the right order (avoid a self-inflicted outage)

`ssl_verify_client on` rejects any connection without Cloudflare's cert, so the
first time you enable it, sequence it:

1. Install the origin-pull CA (above).
2. nginx: `ssl_verify_client optional;` (non-breaking — accepts certless too).
   Reload.
3. Cloudflare dashboard: enable **Authenticated Origin Pulls**.
4. Verify Cloudflare is presenting the cert: temporarily add
   `add_header X-CF-Client-Verify $ssl_client_verify always;`, reload, and
   `curl -sI https://racesow.org/` **through Cloudflare** — expect
   `x-cf-client-verify: SUCCESS` consistently.
5. Flip to `ssl_verify_client on;`, remove the diagnostic header, reload.

## Firewall (UFW)

- **443 open to all** — mTLS is the gate. Do **not** re-introduce a
  Cloudflare-IP allowlist as the origin lock: it breaks whenever Cloudflare adds
  ranges, and mTLS already rejects non-Cloudflare traffic (400) regardless of
  source IP.
- **80 open** (pak/demo downloads + ACME). **22 limited** (+ fail2ban). Game
  **UDP 44400/44450 open**.

## TLS cert issuance / renewal

```
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  -d eu.frankfurt.racesow.org -d racesow.org \
  --cert-name eu.frankfurt.racesow.org --expand \
  --deploy-hook "systemctl reload nginx"
```

HTTP-01 validation runs over **port 80** (no mTLS there), so it works for both
names — `racesow.org` through Cloudflare, `eu.frankfurt` direct. Renewals are
automatic and reload nginx via the deploy hook.

## Services (`docker-compose.yml` + `docker-compose.override.yml`)

- **postgres** — tuned for the 32GB/12-core/NVMe box in the compose `command`
  args (`shared_buffers=8GB`, `effective_cache_size=24GB`, `work_mem=32MB`,
  `maintenance_work_mem=2GB`, parallelism=12, `random_page_cost=1.1`) plus
  `shm_size: 1gb` (parallel-query workers need more than Docker's 64MB
  `/dev/shm`). Changing these needs a container recreate.
- **redis** — response cache (`redis:7-alpine`, 256MB `allkeys-lru`, no
  persistence). `REDIS_URL` on both web replicas. The app degrades gracefully if
  Redis is down, but keep it running.
- **web / web2** — two replicas. `web2` and the deploy-specific bits
  (`PUBLIC_ORIGIN`, `REDIS_URL`, loopback port binds, discord `SITE_URL`) live in
  **`docker-compose.override.yml`**, which compose auto-merges over the base.
- **discord** — record announcer; polls the API (no DB access).

## Deploy procedure

The box is updated by **file-overlay**, not `git pull` (its working tree is
diverged). Overlay the changed files, then:

```
docker compose up -d redis          # rolling-deploy uses --no-deps, so start redis first
scripts/rolling-deploy.sh           # rebuilds the web image, recreates web then web2
                                    # one at a time; DB migrations run at boot (advisory-locked)
```

For nginx changes: overlay `deploy/nginx/racesow.conf`, back up the live file,
`sudo nginx -t`, reload only on success.

## Admin / direct access

Because mTLS rejects non-Cloudflare traffic, you **cannot** hit
`https://<origin>/` directly for debugging. Instead SSH to the box and curl the
loopback (`curl http://127.0.0.1:8080/api/health`) or the internal `:443`, or
use an SSH tunnel.

## Secrets — never commit, never paste into shared tools

- **`.env` and `server/.env`** (`POSTGRES_PASSWORD`, `INGEST_TOKEN`,
  `MIRROR_SECRET`, `RCON_PASSWORD`, `DISCORD_WEBHOOK_URL`) are **gitignored** —
  keep them that way. `.env.example` holds only placeholders.
- **TLS private keys** live only on the box under `/etc/letsencrypt/`. Never
  copy a private key through chat, tickets, or any shared channel — if one is
  exposed, revoke/reissue it.
- The **origin-pull CA** (`/etc/nginx/cloudflare-origin-pull-ca.pem`) is a
  **public** certificate (fetched from Cloudflare), safe to reference but not
  worth committing — fetch it at deploy time.
- The bundled `data/db.sqlite` is a **Git LFS** seed snapshot (public historical
  livesow data) for the one-time Postgres seed — intentionally tracked. It holds
  a `token_hash` that is a **sha256 of a 256-bit random token (non-reversible)**,
  not a usable secret. Do **not** commit the *live* DB, private keys, or `.env`.
