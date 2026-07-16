-- Map blocking: an admin decision that a map should be pulled from play — it is
-- removed from the game servers' vote pool and map cycle. This is deliberately
-- SEPARATE from map_flag (a public report): a single flag must never auto-remove
-- a map (abuse), so removal is an explicit moderator action. Blocking a map is
-- typically the resolution of a confirmed flag (see the admin flag review, which
-- can block + close a map's flags in one step).
--
-- The game servers consume GET /api/game/blocked-maps (plain text, one map name
-- per line) when they build g_maplist (server/entrypoint.sh), so a blocked map
-- drops out of rotation on their next restart.

-- Up Migration
CREATE TABLE IF NOT EXISTS map_block (
  map_id     BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  reason     TEXT,
  blocked_at BIGINT NOT NULL,
  blocked_by TEXT           -- admin username or "cli"
);

-- Down Migration
DROP TABLE IF EXISTS map_block CASCADE;
