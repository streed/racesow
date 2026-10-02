-- Map editor jobs (/mapgen/editor), and the admin approval they wait for.
--
-- A map can now be asked for two ways. 'describe' is the original: a player
-- describes it in words and the worker has Claude plan the spec. 'editor' is a
-- spec the player built by hand in the map editor: it arrives in the spec
-- column at submission, and the worker only checks and builds it (no model
-- call). Both go through the same queue, quota, checks and build.
--
-- An editor job does not go straight to the queue: it starts in 'review',
-- which the worker never claims, until an admin approves it on /admin/mapgen
-- ('review' -> 'queued') or turns it down ('review' -> 'rejected', the
-- requester's map and the site budget given back, the admin's note shown on
-- the job page as its error). reviewed_at / reviewed_by record who decided.

-- Up Migration
ALTER TABLE mapgen_job ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'describe'
  CHECK (source IN ('describe', 'editor'));
ALTER TABLE mapgen_job ADD COLUMN IF NOT EXISTS reviewed_at BIGINT;
ALTER TABLE mapgen_job ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE mapgen_job DROP CONSTRAINT IF EXISTS mapgen_job_status_check;
ALTER TABLE mapgen_job ADD CONSTRAINT mapgen_job_status_check
  CHECK (status IN ('review', 'queued', 'planning', 'building', 'publishing', 'published', 'failed', 'rejected'));
-- The admin's approval queue, oldest first.
CREATE INDEX IF NOT EXISTS mapgen_job_review ON mapgen_job (id) WHERE status = 'review';

-- Down Migration
DROP INDEX IF EXISTS mapgen_job_review;
UPDATE mapgen_job SET status = 'failed' WHERE status IN ('review', 'rejected');
ALTER TABLE mapgen_job DROP CONSTRAINT IF EXISTS mapgen_job_status_check;
ALTER TABLE mapgen_job ADD CONSTRAINT mapgen_job_status_check
  CHECK (status IN ('queued', 'planning', 'building', 'publishing', 'published', 'failed'));
ALTER TABLE mapgen_job DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE mapgen_job DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE mapgen_job DROP COLUMN IF EXISTS source;
