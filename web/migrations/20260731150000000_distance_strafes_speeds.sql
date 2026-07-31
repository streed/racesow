-- Movement metrics v2: distance raced + strafe count (additive run_tally
-- counters, same model as wall_jumps/dashes) and per-run speed snapshots
-- (finish columns, same model as strafe_quality).
--
-- distance: whole game units travelled while racing (inRace frames only;
-- teleporter hops are excluded game-side by an implied-speed guard),
-- accumulated per flush period and summed here. BIGINT: lifetime totals pass
-- INT4 range within weeks at racing speeds (~3.6M units/hour at 1000 ups).
--
-- strafes: discrete air-strafe segments counted by the same sampler that
-- scores strafe quality (600+ ups, forward + side key, mouse turning into it);
-- a direction flip or a >400ms gap ends one segment and starts the next.
--
-- max_speed / start_speed: per-RUN snapshots in ups on the finish row.
-- Nullable — finishes recorded before this column existed, or by servers
-- without the updated report native, are NULL and contribute nothing (a fake 0
-- would drag MAX/AVG reads).

-- Up Migration
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS distance BIGINT NOT NULL DEFAULT 0;
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS strafes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE finish ADD COLUMN IF NOT EXISTS max_speed INTEGER;
ALTER TABLE finish ADD COLUMN IF NOT EXISTS start_speed INTEGER;

-- Down Migration
ALTER TABLE finish DROP COLUMN IF EXISTS start_speed;
ALTER TABLE finish DROP COLUMN IF EXISTS max_speed;
ALTER TABLE run_tally DROP COLUMN IF EXISTS strafes;
ALTER TABLE run_tally DROP COLUMN IF EXISTS distance;
