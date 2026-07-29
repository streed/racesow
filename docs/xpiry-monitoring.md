# Uptime / status-page monitoring with xpiry.dev

External monitoring + a public status page for Racesow, backed by
[xpiry.dev](https://xpiry.dev). Two moving parts:

1. **External checks xpiry runs itself** for the website — HTTP uptime, SSL cert
   expiry, domain-registration expiry, DNS + redirect watch. No code on our side.
2. **Push heartbeats** for the game servers and TV encoders — they're UDP on
   custom ports, invisible from outside, so each box probes its own servers
   locally and pings a heartbeat monitor.

Everything is provisioned once from your workstation and then runs itself.

## What's monitored

| Component            | How                                   | Monitor name    | Group        |
|----------------------|---------------------------------------|-----------------|--------------|
| Website `racesow.org`| xpiry HTTP check → `/api/health`      | (domain uptime) | Website      |
| SSL cert + domain    | xpiry SSL/expiry/DNS/redirect checks  | (domain)        | Website      |
| EU Warsow  `:44400`  | box heartbeat (UDP getstatus)         | `rs-eu-warsow`  | Game Servers |
| EU Warfork `:44410`  | box heartbeat (UDP getstatus)         | `rs-eu-warfork` | Game Servers |
| US Warsow  `:44400`  | box heartbeat (UDP getstatus)         | `rs-us-warsow`  | Game Servers |
| US Warfork `:44410`  | box heartbeat (UDP getstatus)         | `rs-us-warfork` | Game Servers |
| EU TV encoder        | box heartbeat (`warsow-tv-capture` up)| `rs-eu-tv`      | Live Streams |
| US TV encoder        | box heartbeat (`warsow-tv-capture` up)| `rs-us-tv`      | Live Streams |

**Health model for heartbeats:** on success the box pings the monitor's OK URL
(with the live player count as `?value=`). On failure it **stays silent** and
lets xpiry's grace period lapse — so the nightly 5am restart (a brief bounce,
well inside the grace window) never pages, while a real sustained outage still
trips once the grace period is exceeded. Grace is 600s for game servers, 300s
for TV. Set `XPIRY_PING_FAIL=1` in a box's `.env` to also send an explicit
`/fail` for faster (but restart-noisy) detection.

## Prerequisites

- An xpiry **Agency** plan. The REST API and status pages need Pro or Agency,
  but the six monitors here (4 game + 2 TV) exceed Pro's **5 monitors/domain**
  cap — Agency raises it to 20. (The account is on Agency.)
- An API key: xpiry dashboard → **Account settings** → generate key. It lives in
  `.env.production` locally as `XPIRY_API_KEY`.

> **Heads-up on ping auth:** on this account the heartbeat ping endpoint is *not*
> anonymous — an unauthenticated ping returns `401`. So the box heartbeat script
> sends `Authorization: Bearer $XPIRY_API_KEY`, and **each box's `.env` must
> carry `XPIRY_API_KEY`** in addition to its ping URLs. That key is broad
> (full account access), so treat it like any other box secret; if xpiry later
> exposes a public-ping toggle or a scoped ping key, prefer that here.

## 1. Provision (once, from your workstation)

Dry-run first to see exactly what it will do — no key needed, no writes:

```bash
XPIRY_DRY_RUN=1 ./scripts/xpiry-provision.sh
```

Then for real:

```bash
XPIRY_API_KEY=xxxxxxxx ./scripts/xpiry-provision.sh
```

It's idempotent — it finds the `racesow.org` domain and the six monitors by
name and only creates what's missing, so re-running is safe. It writes the
per-box heartbeat ping URLs to `scripts/xpiry-monitors.local.env` (gitignored).

Optional env:

| Var                            | Default            | Purpose                                        |
|--------------------------------|--------------------|------------------------------------------------|
| `XPIRY_UPTIME_PATH`            | `/api/health`      | Path the website HTTP check hits.              |
| `XPIRY_STATUS_CUSTOM_DOMAIN`   | (unset)            | e.g. `status.racesow.org` (see §4).            |
| `XPIRY_ALERT_DISCORD_WEBHOOK`  | (unset)            | Create a Discord alert channel.                |
| `XPIRY_ALERT_EMAIL`            | (unset)            | Create an email alert channel.                 |
| `XPIRY_VERBOSE=1`              | off                | Dump raw API responses (use if a ping URL comes out empty). |

> **First-run check:** the exact JSON field xpiry uses for a monitor's ping URL
> isn't fully pinned in the public docs, so the script tries several shapes
> (`.ping_url`, `.ping.url`, `.token` → `…/ping/<token>`, …). If any
> `XPIRY_PING_*` in the generated file is blank, re-run with `XPIRY_VERBOSE=1`,
> look at the monitor JSON, and adjust the `ping_url_of` extractor in
> `scripts/xpiry-provision.sh`.

## 2. Distribute the ping URLs to the boxes

`scripts/xpiry-monitors.local.env` has two blocks. Append the **EU** block to
`eu.frankfurt.racesow.org`'s repo-root `.env` and the **US** block to
`us.east.racesow.org`'s. Each box only carries its own three `XPIRY_PING_*`
lines — that's what selects which servers it heartbeats.

**Also add `XPIRY_API_KEY` to each box's `.env`** (the ping endpoint needs it —
see the auth heads-up above). Paste it over SSH; don't commit it. The generated
file and the runtime lock/log are gitignored.

## 3. Install the heartbeat timer on each box

The heartbeat service+timer are already in `systemd/install.sh` for both tiers,
so on each box after `git pull` + editing `.env`:

```bash
# eu.frankfurt (web + game)
systemd/install.sh full
# us.east (game only)
systemd/install.sh agent
```

That installs and enables `racesow-xpiry-heartbeat.timer` (fires every 60s).
Force one immediately and watch it:

```bash
systemctl start racesow-xpiry-heartbeat.service
journalctl -u racesow-xpiry-heartbeat.service -n 20 --no-pager
```

You should see lines like `warsow: up (3 players) -> ok`. Within a minute the
matching monitors go green in the xpiry dashboard.

## 4. Status page

`xpiry-provision.sh` enables the status page for the `racesow.org` domain, with
the monitors grouped **Website / Game Servers / Live Streams**. It's **already
live**:

- Custom domain: **https://status.racesow.org** (`status.racesow.org` CNAME →
  `status.xpiry.dev`, verified) 
- xpiry slug URL: `https://xpiry.dev/status/racesow-org-50fdd268`

Tweak title/logo/theme in the dashboard under the domain's **Status Page** tab.
The provisioner deliberately does **not** set a theme (xpiry validates it against
a fixed list — `"auto"` is rejected `422`), so it won't clobber the dashboard
choice (currently `ocean`).

**Custom domain**, if you ever need to re-point it: add `CNAME
status.racesow.org → status.xpiry.dev`, then set it via
`XPIRY_STATUS_CUSTOM_DOMAIN=status.racesow.org ./scripts/xpiry-provision.sh` (or
in the dashboard). xpiry issues the TLS cert once the CNAME resolves.

**Incidents** are posted from the dashboard (or the API — `POST
/domains/:id/incidents`) and appear on the status page automatically.

## 5. Alerts

Pass `XPIRY_ALERT_DISCORD_WEBHOOK` and/or `XPIRY_ALERT_EMAIL` to provisioning to
create notification channels, or manage them in the dashboard under **Alerts**.
Racesow already has a Discord webhook (see the security-audit notes) that can be
reused here.

## Files

| Path                                          | Role                                              |
|-----------------------------------------------|---------------------------------------------------|
| `scripts/xpiry-provision.sh`                  | One-shot API provisioner (run from your machine). |
| `scripts/xpiry-heartbeat.sh`                  | Per-box heartbeat pusher (UDP probe + TV check).  |
| `systemd/racesow-xpiry-heartbeat.service`     | One-shot unit that runs the pusher.               |
| `systemd/racesow-xpiry-heartbeat.timer`       | Fires the pusher every 60s.                        |
| `systemd/install.sh`                          | Installs the timer on both tiers.                 |
| `scripts/xpiry-monitors.local.env`            | Generated per-box ping URLs (gitignored).         |

## Troubleshooting

- **`403` from provisioning** — the key's plan has no API access. Upgrade to
  Pro/Agency.
- **A `XPIRY_PING_*` came out blank** — see the first-run check in §1.
- **Monitor stuck "late"/red but the server is up** — confirm the timer is
  active (`systemctl list-timers | grep xpiry`), that the box's `.env` has the
  right URL for *that* box, and that `scripts/xpiry-heartbeat.sh` can reach the
  server locally (`server/tv/getstatus.sh 127.0.0.1:44400`).
- **Nightly-restart false alarm** — raise `grace_period_seconds` in the
  `MONITORS` table in `scripts/xpiry-provision.sh` and re-run (or edit the
  monitor in the dashboard).
- **Website check flaps but the site is up** — Cloudflare/keepalive can cause
  transient timeouts; point the check at `/api/health` (default) rather than the
  SPA root, and widen the check's failure threshold in the dashboard.
