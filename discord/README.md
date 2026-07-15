# Racesow Discord Announcer

A tiny Node.js service that polls the stats API and posts a rich embed to a
**Discord webhook** whenever a new record is set. It has **no database access
of its own** — it reads `GET /api/records` from the web service (which computes
the margin-to-#2 and version name for it).

New records are detected by race `id` (every new run gets a higher id), so the
service just remembers the highest id it has already handled. **On first run it
records the current maximum as a baseline and announces nothing**, so it never
floods a channel with the entire back catalogue.

## What it posts

For each new qualifying record it sends an embed with:

- 🏆 **New World Record!** (gold) for a global rank #1, otherwise 🏁 a top-N record.
- Player (Warsow colour codes stripped), map, time (as a race clock), rank.
- For world records, how far **ahead of #2** the run is.
- Game version, and an optional link back to the stats site's map page.

## Configuration (environment variables)

| Variable               | Default              | Meaning                                                        |
|------------------------|----------------------|----------------------------------------------------------------|
| `DISCORD_WEBHOOK_URL`  | *(empty)*            | Discord webhook URL. **If unset, runs in dry-run (log-only).** |
| `API_URL`              | `http://web:8080`   | Base URL of the stats API (polls `<API_URL>/api/records`).     |
| `STATE_PATH`           | `/state/announcer.json` | Where the last-seen id is persisted (use a volume).        |
| `POLL_INTERVAL`        | `300`               | Seconds between checks (min 15).                                |
| `ANNOUNCE_MAX_RANK`    | `1`                 | Announce records with global rank ≤ this (`1`=WRs, `3`=podiums).|
| `MAX_PER_POLL`         | `10`                | Max embeds posted per poll (flood guard).                      |
| `SITE_URL`             | *(empty)*           | Base URL of the stats site, for map links in embeds.           |
| `WEBHOOK_USERNAME`     | `Racesow`           | Display name for the webhook messages.                         |

## Run locally (dry run)

Point it at a running web service (see `web/README.md`):

```bash
cd discord
npm install
API_URL=http://127.0.0.1:8080 STATE_PATH=./announcer.json node announcer.js
# no webhook set -> it logs the embeds it *would* post
```

## Run with Docker

```bash
docker compose up -d --build discord
```

Set `DISCORD_WEBHOOK_URL` in `docker-compose.yml` (or an `.env` file) first.
The compose service already points `API_URL` at the co-located `web` service,
so new records appear as soon as the game servers report them.
