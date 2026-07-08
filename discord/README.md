# Racesow Discord Announcer

A tiny Node.js service that watches the race database and posts a rich embed to
a **Discord webhook** whenever a new record is set.

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
| `DB_PATH`              | `/data/db.sqlite`   | Path to the race database.                                      |
| `STATE_PATH`           | `/state/announcer.json` | Where the last-seen id is persisted (use a volume).        |
| `POLL_INTERVAL`        | `300`               | Seconds between checks (min 15).                                |
| `ANNOUNCE_MAX_RANK`    | `1`                 | Announce records with global rank ≤ this (`1`=WRs, `3`=podiums).|
| `MAX_PER_POLL`         | `10`                | Max embeds posted per poll (flood guard).                      |
| `REMOTE_DB_URL`        | *(empty)*           | If set, download a fresh DB from here before each poll.        |
| `SITE_URL`             | *(empty)*           | Base URL of the stats site, for map links in embeds.           |
| `WEBHOOK_USERNAME`     | `Racesow`           | Display name for the webhook messages.                         |

## Run locally (dry run)

```bash
cd discord
npm install
DB_PATH=../data/db.sqlite STATE_PATH=./announcer.json node announcer.js
# no webhook set -> it logs the embeds it *would* post
```

## Run with Docker

```bash
docker compose up -d --build discord
```

Set `DISCORD_WEBHOOK_URL` in `docker-compose.yml` (or an `.env` file) first.

## How "new records" appear in a static snapshot

The bundled `data/db.sqlite` is a point-in-time snapshot, so on its own it never
gains new rows. Two ways to get a live feed:

1. Set `REMOTE_DB_URL=http://livesow.net/race/api/db.sqlite` so the announcer
   pulls a fresh snapshot before each poll and diffs it against the last one.
2. Have your own race server / import pipeline update `data/db.sqlite`; the
   announcer (and the website) pick up the changes automatically.
