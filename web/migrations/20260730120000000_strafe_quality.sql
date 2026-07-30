-- Per-run air-strafe quality. For each completed race the game module measures,
-- frame by frame, how close the player stayed to the ideal strafe angle: the
-- actual horizontal speed gained each airborne frame divided by the maximum gain a
-- perfect strafe angle would yield (the same 0..1 "accel efficiency" the in-game
-- green accel meter shows). It time-weight-averages that over the run and reports
-- it on the finish as basis points (0..10000 = 0.00%..100.00%).
--
-- Stored per finish (NOT summed into run_tally like the wall_jumps/dashes movement
-- counters) because it is a per-run SNAPSHOT, not an additive count. The profile
-- derives both a lifetime average and a by-day trend chart directly from these
-- dated finish rows (db.js playerDetail: AVG(strafe_quality) ... GROUP BY day), so
-- no snapshot table is needed and the history is rebuildable from the durable
-- finish log. Nullable: finishes recorded before this column existed, or by older
-- servers that don't report it, are NULL and contribute nothing to the averages.

-- Up Migration
ALTER TABLE finish ADD COLUMN IF NOT EXISTS strafe_quality INTEGER;

-- Down Migration
ALTER TABLE finish DROP COLUMN IF EXISTS strafe_quality;
