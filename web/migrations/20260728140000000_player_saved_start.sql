-- Per-player saved START position for a map: where a player wants to spawn
-- ("prerace" spot) so that when they come back to the server they begin exactly
-- where they left off. Set in-game with /savestart (hrace/savedstarts.as ->
-- RS_ApiSaveStart native -> POST /api/ingest/saved-start) and restored on rejoin
-- (GET /api/game/saved-starts -> RS_ApiFetchSavedStarts, looked up per player by
-- clean nick like the ranks board).
--
-- Two logical slots per player per map, one per race direction: mode = 'race'
-- (the normal start line) and mode = 'reverse' (the /reverse start). Keyed by the
-- CANONICAL player id (aliases collapse to one person, same as records/replays)
-- so a returning player matches by their colour-stripped nick.
--
-- Only the geometry that a prerace spawn needs is stored: origin (loc_*) and view
-- angles (ang_*). A prerace spawn zeroes velocity and grants the standard loadout,
-- so nothing else needs persisting.

-- Up Migration
CREATE TABLE IF NOT EXISTS player_saved_start (
  player_id  BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  map_id     BIGINT NOT NULL REFERENCES map(id) ON DELETE CASCADE,
  mode       TEXT   NOT NULL,          -- 'race' | 'reverse'
  loc_x      REAL   NOT NULL,
  loc_y      REAL   NOT NULL,
  loc_z      REAL   NOT NULL,
  ang_x      REAL   NOT NULL,
  ang_y      REAL   NOT NULL,
  ang_z      REAL   NOT NULL,
  server_id  BIGINT,                    -- provenance (which server stored it), may be NULL
  updated_at BIGINT NOT NULL,           -- epoch seconds
  PRIMARY KEY (player_id, map_id, mode)
);

-- The game fetches every saved start for the current map at once (ranks-style),
-- then looks each connected player up by nick, so the hot query is by map_id.
CREATE INDEX IF NOT EXISTS player_saved_start_map_idx ON player_saved_start (map_id);

-- Down Migration
DROP TABLE IF EXISTS player_saved_start CASCADE;
