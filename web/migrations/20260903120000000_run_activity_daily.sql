-- Daily attempt volume: the history run_tally.attempts cannot keep.
--
-- The /runs page charts two series over time — runs FINISHED and runs
-- ATTEMPTED. Only one of them was recoverable from the existing schema:
--
--   finished  — `finish` carries one row per completed run with its own
--     created_at (migration 20260722140000000), so the series is an exact
--     GROUP BY over real events, backdated demo imports included. Nothing to
--     add here, and deliberately NOT duplicated into this table: a second
--     source of truth for the same number is a drift bug waiting to happen.
--
--   attempted — run_tally.attempts is a running COUNTER with no history (see
--     migration 20260801130000000, which hit the same wall for attempts-at-PB
--     and solved it by snapshotting). The game reports attempt COUNTS per
--     flush, not per-attempt events, so there is no row to group by and no way
--     to reconstruct "how many attempts happened on 12 August" after the fact.
--
-- So this table is the missing half: the per-flush attempt DELTA that _ingestTx
-- already receives, bucketed as it arrives instead of being folded into the
-- counter and forgotten. It starts EMPTY and fills from deploy day forward —
-- there is no backfill because there is no history to backfill from, and an
-- estimate spread over past days would look precise while being invented. The
-- page reads the first recorded day back out (see db.runActivity) and says so
-- rather than drawing a zero line across the years before tracking began.
--
-- Buckets are UTC days. The day is fixed when the row is written, so it cannot
-- be re-cut into a viewer's zone later — which is why the page is UTC and says
-- so, rather than offering a ?tz= it would silently mis-bucket (the hour-of-week
-- page can offer one only because it groups raw per-row timestamps).
--
-- server_id mirrors finish.server_id: a plain BIGINT with no FK (a server row
-- outliving its finishes is not worth a cascade), except that a PRIMARY KEY
-- cannot span a NULL, so "not reported" is 0 here instead of NULL. It costs one
-- row per server per day (~4/day) and is the one dimension that cannot be added
-- retroactively — the region split the /stats page already draws needs it.

-- Up Migration
CREATE TABLE IF NOT EXISTS run_activity_daily (
  day       DATE   NOT NULL,
  server_id BIGINT NOT NULL DEFAULT 0,
  attempts  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, server_id)
);

-- The page always scans a window of days across all servers, so the PK's
-- leading column already serves it; no secondary index earns its keep.

-- Down Migration
DROP TABLE IF EXISTS run_activity_daily CASCADE;
