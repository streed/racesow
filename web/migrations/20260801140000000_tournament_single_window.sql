-- One tournament at a time.
--
-- The original design allowed concurrent tournaments and left "don't overlap"
-- to an admin-form check with an explicit "allow this to overlap" override.
-- That override is gone, and this constraint is why: the in-game side can only
-- ever advertise ONE tournament. The game feed (`/api/game/tournament`) carries
-- a single T line, `/tournament join` enrols you in "whatever is on", and the
-- server now announces the live tournament to everyone on the box. With two
-- running at once, every one of those silently picks one and hides the other —
-- players would be told to join a tournament that was not the one their runs
-- were scoring for.
--
-- Enforced in the schema rather than only in the route because the calendar has
-- three writers: the admin form, the status flip (un-cancelling frees, then
-- re-takes, a slot), and the recurring-series scheduler in the background
-- sweep. A check that lives in one of them is a check the other two can walk
-- around.
--
-- Cancelled tournaments are excluded: cancelling is precisely how an admin
-- frees a slot that turned out to be wrong. Finalized ones are NOT excluded —
-- history keeps its place on the calendar, and a new tournament backdated over
-- a finished one would re-score runs that already paid out trophies.
--
-- Half-open [starts_at, ends_at), matching every other window comparison in
-- this codebase, so back-to-back editions sharing a boundary second are legal.
-- int8range's GiST support is in core Postgres; no btree_gist needed.

-- Up Migration
DO $$
BEGIN
  ALTER TABLE tournament
    ADD CONSTRAINT tournament_no_overlap
    EXCLUDE USING gist (int8range(starts_at, ends_at) WITH &&)
    WHERE (status <> 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already applied
END $$;

-- Down Migration
ALTER TABLE tournament DROP CONSTRAINT IF EXISTS tournament_no_overlap;
