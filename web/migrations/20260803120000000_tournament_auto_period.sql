-- The Monthly Cup: one durable decision row per (series, month).
--
-- The automatic monthly series (see docs/monthly-cup-design.md) has to answer
-- one question every sweep — "has this month been decided yet?" — and this table
-- IS that answer. It does two jobs at once, and both are load-bearing.
--
-- JOB ONE: the exactly-once claim across both web replicas. The primary key
-- collision is the mutex. The generator INSERTs this row FIRST inside its
-- transaction and branches on rowCount, so the replica that loses the race
-- never reaches the tournament INSERT at all. That ordering is not incidental:
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING` raises NOTHING and returns zero
-- rows, so a loser that only watched for an exception would sail straight on and
-- create a second edition.
--
-- JOB TWO: the durable audit trail. This CANNOT be recordEvent/server_log —
-- that is a 20,000-row ring buffer (LOG_KEEP, web/server.js) shared with four
-- game servers' shipped stdout, so a once-a-month line is pruned long before
-- anyone thinks to look. A month that was skipped and a scheduler that crashed
-- must never look identical from the outside, and a row is the only thing that
-- survives long enough to tell them apart.
--
-- WHY A TABLE RATHER THAN CANCELLED TOURNAMENT ROWS. Recording skips as
-- status='cancelled' tournaments was the obvious cheaper option and it fails on
-- evidence: the public list query gates only on drafts (db.js tournaments() /
-- tournamentBySlug), so every skipped month would appear on the PUBLIC
-- /tournaments calendar with its own page — silently answering "should players
-- see skips?" the wrong way. The reason would also be a prose `description`
-- instead of queryable JSONB, and the admin delete button erases a decision in
-- one click.
--
-- TERMINAL vs RE-DECIDABLE is the whole recovery story:
--   scheduled        terminal      the edition exists; nothing more to do
--   skipped_overlap  terminal      a fact about a CLOSED month's data; never changes
--   skipped_thin     terminal      likewise
--   cancelled        terminal      an edition WAS created for this month and an
--                                  operator called it off. The cancel is the
--                                  decision, so the generator must stop trying:
--                                  without this it would find its own cancelled
--                                  row still holding the UNIQUE slug (the slug is
--                                  unique regardless of status, while the calendar
--                                  constraint ignores cancelled rows) and retry
--                                  every five minutes for the rest of the day.
--   blocked          RE-DECIDABLE  something else holds the calendar slot. Retried
--                                  every sweep until the window opens, so cancelling
--                                  the blocker heals the month with NO operator
--                                  action. The row still exists so the block is
--                                  visible; the sweep logs only when the decision
--                                  CHANGES, or a week-long block would emit ~2000
--                                  identical warnings.
--   forced           RE-DECIDABLE  operator override; re-decides while bypassing
--                                  ONLY the overlap rule, never the calendar rule.
--
-- Note there is deliberately NO "skipped_late" state. Once the window has opened
-- the generator writes nothing at all: a month it could not reach in time was
-- never a decision, and recording it as a skip is exactly the confusion this
-- table exists to prevent. It is also what keeps the deploy day quiet — the
-- month in progress when this ships produces no row and no alarm.
--
-- All timestamps are epoch SECONDS (house style). `period` is the UTC month the
-- edition would COVER, as 'YYYY-MM' — the month whose first week is the window,
-- not the month the pool is measured over.

-- Up Migration
CREATE TABLE IF NOT EXISTS tournament_auto_period (
  series_key    TEXT   NOT NULL,
  period        TEXT   NOT NULL,
  decision      TEXT   NOT NULL
                CHECK (decision IN ('scheduled','skipped_overlap','skipped_thin','cancelled','blocked','forced')),
  -- The edition this decision produced, when it produced one. ON DELETE SET
  -- NULL rather than CASCADE is deliberate: deleting a tournament must not
  -- erase the record that the month was decided and what it picked.
  tournament_id BIGINT REFERENCES tournament(id) ON DELETE SET NULL,
  -- Why. Shape depends on the decision: the ranked candidate list for
  -- skipped_thin, the colliding maps for skipped_overlap, the blocker's
  -- slug/name/window/status for blocked, the chosen pool for scheduled.
  -- JSONB rather than prose so "which map keeps colliding" is a query.
  detail        JSONB  NOT NULL DEFAULT '{}'::jsonb,
  decided_at    BIGINT NOT NULL,
  PRIMARY KEY (series_key, period)
);

-- The admin panel reads the last handful of decisions across all series.
CREATE INDEX IF NOT EXISTS idx_tauto_recent ON tournament_auto_period (decided_at DESC);

-- Down Migration
DROP TABLE IF EXISTS tournament_auto_period CASCADE;
