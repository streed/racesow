-- The map-scoped recent-finishes feed orders one map's rows by created_at,
-- which had no supporting index (only (map_id, time) and the global
-- (created_at)). finish is append-forever, so that plan degrades linearly with
-- total finishes across ALL maps; (map_id, created_at) makes it a bounded
-- index walk.

-- Up Migration
CREATE INDEX IF NOT EXISTS idx_finish_map_recent ON finish(map_id, created_at DESC);

-- Down Migration
DROP INDEX IF EXISTS idx_finish_map_recent;
