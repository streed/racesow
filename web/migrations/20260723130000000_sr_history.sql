-- Per-player daily Skill Rating history, so a profile can show whether a racer
-- is improving over time. One row per (canonical player, UTC day) holds that
-- day's SR read straight from the standings rebuild (db.js snapshotSrHistory,
-- called at the tail of refreshAggregates and doing real work at most once per
-- UTC day). Retention is a rolling 30-day window — rows outside it are pruned in
-- the same pass — so the table stays small and the profile shows a 30-day trend.
--
-- Unlike best/standings/map_index this is LOGGED and NOT rebuildable: past SR
-- depends on the whole field's PBs *as they stood on each past date*, which we do
-- not retain (`race` keeps only each player's current PB). So history can only
-- accrue forward from first deploy and must survive restarts.
--
-- Rows are written under whichever player id is the canonical representative on
-- the day of the snapshot (the same id standings uses). If the representative
-- later flips to a different nick variant, earlier rows stay under the old id;
-- the profile read spans the whole canonical group (player.canonical_id), so the
-- history stays continuous across such a flip rather than orphaning.

-- Up Migration
CREATE TABLE IF NOT EXISTS sr_history (
  player_id BIGINT  NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  day       DATE    NOT NULL,
  sr        INTEGER NOT NULL,
  PRIMARY KEY (player_id, day)
);
-- Powers the daily-prune sweep (DELETE ... WHERE day < cutoff).
CREATE INDEX IF NOT EXISTS idx_sr_history_day ON sr_history(day);

-- Down Migration
DROP TABLE IF EXISTS sr_history CASCADE;
