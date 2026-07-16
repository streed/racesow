-- Per-player-per-map replays: generalize the WR-only replay tables to one demo
-- + one ghost per (player, map) — that player's fastest recorded run. The map
-- WR is now derived (the fastest row per map, via the (map_id, time) index),
-- not a dedicated row. See docs/per-player-replays-design.md.
--
-- The ghost trajectory bytes on disk move from GHOST_DIR/<mapId>.json.gz to
-- GHOST_DIR/<mapId>/<playerId>.json.gz — web/db.js relocates any legacy file at
-- boot using the migrated player_ghost row (idempotent), so this migration only
-- moves the metadata.

-- Up Migration

CREATE TABLE IF NOT EXISTS player_demo (
  map_id      BIGINT  NOT NULL REFERENCES map(id)    ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT  NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT  NOT NULL,
  time        INTEGER NOT NULL,          -- finish time ms; matches the .wd filename suffix
  demo_path   TEXT    NOT NULL,          -- <map>/<map>_<player>_<MM-SS-mmm>.wdz20 (relative to demos/)
  bytes       BIGINT,                    -- optional; the web can't stat the game host's file
  server_id   BIGINT,                    -- provenance (which server captured it)
  captured_at BIGINT  NOT NULL,
  PRIMARY KEY (map_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_player_demo_map_time ON player_demo(map_id, time);
CREATE INDEX IF NOT EXISTS idx_player_demo_player   ON player_demo(player_id);

CREATE TABLE IF NOT EXISTS player_ghost (
  map_id      BIGINT  NOT NULL REFERENCES map(id)    ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT  NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT  NOT NULL,
  time        INTEGER NOT NULL,
  hz          INTEGER NOT NULL,
  frames      INTEGER NOT NULL,
  bytes       BIGINT,
  server_id   BIGINT,
  captured_at BIGINT  NOT NULL,
  PRIMARY KEY (map_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_player_ghost_map_time ON player_ghost(map_id, time);
CREATE INDEX IF NOT EXISTS idx_player_ghost_player   ON player_ghost(player_id);

-- Backfill: every existing WR row is a valid (player, map) personal best.
INSERT INTO player_demo (map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at)
  SELECT map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at FROM wr_demo
  ON CONFLICT (map_id, player_id) DO NOTHING;

INSERT INTO player_ghost (map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at)
  SELECT map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at FROM ghost
  ON CONFLICT (map_id, player_id) DO NOTHING;

DROP TABLE IF EXISTS wr_demo;
DROP TABLE IF EXISTS ghost;

-- Down Migration

CREATE TABLE IF NOT EXISTS wr_demo (
  map_id      BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,
  demo_path   TEXT NOT NULL,
  bytes       BIGINT,
  server_id   BIGINT,
  captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wr_demo_player ON wr_demo(player_id);

CREATE TABLE IF NOT EXISTS ghost (
  map_id      BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  player_id   BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  version_id  BIGINT NOT NULL,
  time        INTEGER NOT NULL,
  hz          INTEGER NOT NULL,
  frames      INTEGER NOT NULL,
  bytes       BIGINT,
  server_id   BIGINT,
  captured_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ghost_player ON ghost(player_id);

-- Collapse back to the fastest row per map (DISTINCT ON).
INSERT INTO wr_demo (map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at)
  SELECT DISTINCT ON (map_id) map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at
    FROM player_demo ORDER BY map_id, time ASC
  ON CONFLICT (map_id) DO NOTHING;

INSERT INTO ghost (map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at)
  SELECT DISTINCT ON (map_id) map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at
    FROM player_ghost ORDER BY map_id, time ASC
  ON CONFLICT (map_id) DO NOTHING;

DROP TABLE IF EXISTS player_demo;
DROP TABLE IF EXISTS player_ghost;
