-- Map editor jobs (/mapgen/editor).
--
-- A map can now be asked for two ways. 'describe' is the original: a player
-- describes it in words and the worker has Claude plan the spec. 'editor' is a
-- spec the player built by hand in the map editor: it arrives in the spec
-- column at submission, and the worker only checks and builds it (no model
-- call). Both go through the same queue, quota, checks and build.

-- Up Migration
ALTER TABLE mapgen_job ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'describe'
  CHECK (source IN ('describe', 'editor'));

-- Down Migration
ALTER TABLE mapgen_job DROP COLUMN IF EXISTS source;
