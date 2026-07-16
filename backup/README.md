# `db-backup` — weekly public database backup

A small sidecar that publishes a **public, downloadable snapshot of the race
records** so anyone can run their own racesow instance or analyse the data. It
runs alongside Postgres from the top-level `docker-compose.yml`.

```
docker compose up -d db-backup
```

## What it does

`entrypoint.sh` is a self-scheduling loop (no host cron needed): on boot it
writes a fresh backup if the current one is missing or older than a week, then
re-checks daily. `backup.sh` does the actual dump and zips it into the
`./data/backups` volume, which the web service serves at:

| URL | Purpose |
| --- | --- |
| `GET /backup/racesow-db-latest.zip` | download the latest backup |
| `GET /api/backup` | JSON metadata (size, sha256, generated time, row counts) |

Each zip contains a plain-SQL PostgreSQL dump (`racesow-db-YYYYMMDD.sql`), a
`README.txt` with restore steps, and a `manifest.json`.

## What is included / excluded

**Included** — the public race record: `race`, `checkpoint`, `run_tally`,
`player`, `map`, `version`, `canonical`, per-player replay metadata
(`player_demo`, `player_ghost`), and game-server **names** (`server`), plus the
`config` counter and `pgmigrations` bookkeeping (so a restore boots without
re-running migrations).

**Excluded** — anything private:

| Excluded | Why |
| --- | --- |
| `admin_user`, `admin_session` | moderator logins + sessions |
| `map_flag` | abuse reports + salted reporter-IP hashes |
| `server.token_hash` | ingest API tokens |
| `server.address` | game-server IP addresses |
| mesh keys, `INGEST_TOKEN` | live in env/config, never stored in the DB |

The `server` table's data is dumped through a sanitized `SELECT` (id, name,
status, timestamps, record count) — `token_hash` and `address` are never
written out. Everything else on the exclude list is simply never selected by
`pg_dump`.

## Restore

```sh
createdb racesow
unzip racesow-db-latest.zip
psql racesow < racesow-db-YYYYMMDD.sql
```

Then point a fresh racesow web instance at the restored database.

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | source database connection string |
| `OUT_DIR` | `/backups` | where the zip + `*-latest.*` pointers are written |
| `BACKUP_INTERVAL_SECONDS` | `604800` | how old a backup may get before a new one is made (weekly) |
| `BACKUP_CHECK_SECONDS` | `86400` | how often the loop re-evaluates (daily) |
| `BACKUP_KEEP` | `8` | dated archives retained before pruning |

### Run one on demand

```sh
docker compose exec db-backup /usr/local/bin/backup.sh
```
