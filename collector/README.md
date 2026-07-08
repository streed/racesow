# Racesow Stats Collector

Ships race results from the game server into the central stats database, so
the website and Discord announcer see new records live.

## How records flow

```
player finishes race
  └─ racemod fork (server/racemod) appends a line to  server/racelog/events.log
       └─ collector tails the log, batches per map
            └─ POST /api/ingest on the web service (Bearer INGEST_TOKEN)
                 └─ upsert into data/db.sqlite (map / player / race / checkpoint)
                    + per-map global_rank / version_rank recompute
                      └─ website aggregates refresh (debounced ~3s)
                      └─ Discord announcer sees the new race id on its next poll
```

Two input feeds, both pushed through the same idempotent endpoint:

1. **`racelog/events.log`** — appended by our racemod fork on every finished,
   non-practice race (`hrace/racelog.as`). Tailed by byte offset (persisted in
   `/state/collector.json`), so restarts never drop or duplicate work. Format:
   `R1 <map> <timeMs> <login> <cp1,cp2,...> <playerName>` (tab-separated).
2. **`topscores/race/*.txt`** — the mod's own record files (top 50 per map),
   re-scanned on mtime change every `TOPSCORES_RESCAN` seconds as a backfill.

The ingest endpoint keeps only the **best time per player/map/version**. An
improved time is delete+reinserted so it gets a fresh, higher race id — that
is what makes the Discord announcer notice it.

## Configuration

| Variable           | Default                        | Meaning                          |
|--------------------|--------------------------------|----------------------------------|
| `INGEST_URL`       | `http://web:8080/api/ingest`   | Ingest endpoint (**https** across WAN) |
| `INGEST_TOKEN`     | *(empty)*                      | Per-server token (or legacy shared secret) |
| `SERVER_NAME`      | *(empty)*                      | This server's name, sent with each batch |
| `VERSION_NAME`     | `wsw 2.1`                      | Game version rows are filed under|
| `RACELOG_FILE`     | `/racelog/events.log`          | Event log to tail                |
| `TOPSCORES_DIR`    | `/topscores/race`              | Topscores dir to re-scan         |
| `STATE_PATH`       | `/state/collector.json`        | Offset/inode/mtime state file    |
| `POLL_INTERVAL`    | `3`                            | Racelog poll seconds             |
| `TOPSCORES_RESCAN` | `300`                          | Topscores re-scan seconds        |
| `BATCH_SIZE`       | `500`                          | Max records per POST (chunked)   |
| `MAX_BACKOFF`      | `60`                           | Cap on retry backoff (seconds)   |

The racelog feed is tagged `source=racelog` (each line is one genuine finish →
it drives the attempt/run tally); the topscores backfill is tagged
`source=topscores` (a best-state snapshot re-sent on change → best-time upsert
only, no tally). Batches are chunked and 4xx-rejected chunks are dropped-and-
logged (never retried forever); only 5xx/network errors trigger backoff.

## Multiple game servers

Run one collector next to each game server and point them all at the same
`INGEST_URL` (expose the web service publicly or over a private network).
The endpoint is idempotent and best-time-only, so overlapping feeds merge
cleanly into one leaderboard.
