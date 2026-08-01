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

It is a **full public mirror** of the gameplay data, not just current records.

**Included** — every personal-best record (`race`) **and** the complete
finish-log history (`finish`), all their checkpoint splits (`checkpoint`,
`finish_checkpoint`), `run_tally`, `player`, `map`, `version`, `canonical`,
per-player replay metadata (`player_demo`, `player_ghost`), saved practice
starts (`player_saved_start`), daily Skill-Rating history (`sr_history`), the
per-map weapon index (`map_weapon`), achievement definitions (`achievement`) and
every award earned (`player_achievement`), tournaments with their map pools,
final standings and trophies (`tournament`, `tournament_map`,
`tournament_standing`, `tournament_trophy`), the message of the day
(`site_setting`) and game-server **names** (`server`), plus the `config`
counter and `pgmigrations` bookkeeping (so a restore boots without re-running
migrations).

**Excluded** — anything private:

| Excluded | Why |
| --- | --- |
| `admin_user`, `admin_session` | moderator logins + sessions |
| `map_flag` | abuse reports + salted reporter-IP hashes |
| `map_block` | moderation block decisions (admin usernames) |
| `server_log` | rcon / ops audit trail |
| `censor_term`, `player_censor`, `map_censor` | moderation word list + per-player/per-map overrides |
| `tournament_entrant` | **live entry codes** that redeem a tournament slot in-game |
| `server.token_hash` | ingest API tokens |
| `server.address` | game-server IP addresses |
| `site_setting.updated_by` | admin username on the MOTD |
| `achievement.created_by/updated_by`, `tournament.created_by/updated_by` | admin usernames on admin-authored definitions |
| `config.maintenance_*` | maintenance-mode state + the admin who toggled it |
| mesh keys, `INGEST_TOKEN` | live in env/config, never stored in the DB |

`config`, `server`, `site_setting`, `achievement` and `tournament` have their
**data** dumped through a sanitized `SELECT` (config: every key except
`maintenance_*`, so the `next_race_id` bootstrap counter survives; server: id,
name, status, timestamps, record count; site_setting: key, value, timestamp;
achievement + tournament: every column except the `created_by`/`updated_by`
admin usernames) — `token_hash`, `address`, `updated_by` and the
`maintenance_*` keys are never written out. Everything else on the exclude list
is simply never selected by `pg_dump`.

Also absent by design: `best`, `standings` and `map_index`. Those are derived
leaderboard rollups that `openDatabase()` rebuilds from the race data on every
boot (`db.js` `refreshAggregates`), so a restored instance regenerates them.

> **Adding a table?** `TABLES` in `backup.sh` is an allow-list, so a new table is
> excluded until you name it — a new moderation or secret table can never
> silently leak. When you add a race-record table, add it there too; if it
> carries an admin username or any other operator-only column, give it a
> sanitized `\copy` in step 3 rather than dumping its data wholesale. The
> sanitized parent rows are emitted between pg_dump's `data` and `post-data`
> sections so foreign keys still validate on restore.

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
