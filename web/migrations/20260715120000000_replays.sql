-- Replay feature: world-record demo + ghost metadata.
--
-- Both tables are keyed by map_id (one WR replay per map — scope is top-1
-- only), NOT by race_id: the game server that uploads a replay does not know
-- the web's app-allocated race id, but it does know the map. `time` is stored
-- so a replay left over from a since-beaten record can be hidden on read
-- (mapDetail only surfaces a replay whose time equals the current WR time).
--
-- The heavy ghost trajectory bytes live on disk (GHOST_DIR/<mapId>.json.gz,
-- see web/db.js); the `ghost` row is metadata only. wr_demo stores only a
-- relative path to the .wd file the game host serves over HTTP (nginx
-- pak-mirror pattern) — the web never stores the demo bytes.

-- Up Migration
CREATE TABLE IF NOT EXISTS wr_demo (
  map_id      BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,          -- finish time ms; matches the .wd filename suffix
  demo_path   TEXT NOT NULL,             -- <map>/<map>_<player>_<MM-SS-mmm>.wdz20 (relative to demos/)
  bytes       BIGINT,                    -- optional; the web can't stat the game host's file
  server_id   BIGINT,                    -- provenance (which server captured it)
  captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wr_demo_player ON wr_demo(player_id);

CREATE TABLE IF NOT EXISTS ghost (
  map_id      BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,          -- finish time ms of the captured run
  hz          INTEGER NOT NULL,          -- fixed sample rate; frame i is at t = i/hz seconds
  frames      INTEGER NOT NULL,          -- number of trajectory frames on disk
  bytes       BIGINT,                    -- gzipped size on disk
  server_id   BIGINT,
  captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ghost_player ON ghost(player_id);

-- Down Migration
DROP TABLE IF EXISTS ghost CASCADE;
DROP TABLE IF EXISTS wr_demo CASCADE;
