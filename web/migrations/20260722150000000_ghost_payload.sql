-- Durable ghost storage. The WR-ghost trajectory (frames) only ever lived in the
-- .json.gz FILE under GHOST_DIR; the DB row kept just metadata (time, frame
-- count, bytes). So a lost file — a container-local write before the shared
-- /data mount, or a volume reset — permanently lost the run's trajectory even
-- though the row survived (that is why ~69 of 111 ghosts had no file and no
-- heatmap contribution). Store the gzipped payload IN the row so the DB is the
-- source of truth and the file becomes a regenerable cache: upsertPlayerGhost
-- writes it, ghostGzip falls back to it, and syncGhostPayloads reconciles both
-- ways on startup (see web/db.js + web/heatmap.js).

-- Up Migration
ALTER TABLE player_ghost ADD COLUMN IF NOT EXISTS payload BYTEA;

-- Down Migration
ALTER TABLE player_ghost DROP COLUMN IF EXISTS payload;
