-- Track the last time a player *attempted* a race, alongside the existing
-- last_finish. run_tally already records last_finish (set on every finish);
-- this adds the attempt-side timestamp so "last active" = the most recent of
-- the two. Every finish is also counted as an attempt (see _ingestTx), so a
-- finish bumps both columns — last_attempt is therefore always >= last_finish
-- for rows written after this migration.
--
-- The player list (standings) sorts by a per-player "last_active" derived from
-- these columns in buildAggregates(), so players can be ordered by recency.

-- Up Migration
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS last_attempt BIGINT;

-- Backfill: pre-existing rows only ever recorded finishes, so their last
-- finish is the best estimate of their last activity. Leaves rows with no
-- finish timestamp (topscores-sourced tallies) NULL — they sort as "never".
UPDATE run_tally
   SET last_attempt = last_finish
 WHERE last_attempt IS NULL AND last_finish IS NOT NULL;

-- Down Migration
ALTER TABLE run_tally DROP COLUMN IF EXISTS last_attempt;
