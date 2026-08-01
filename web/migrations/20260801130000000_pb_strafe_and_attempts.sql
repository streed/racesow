-- Two per-PB facts for the map leaderboard: how well the record run was
-- strafed, and how many tries it took to set it.
--
-- Both live on `race` (each player's PB per map+version) rather than being
-- derived at read time, because neither is derivable after the fact:
--
--   strafe_quality — the finish log DOES carry it (finish.strafe_quality, see
--     migration 20260730120000000), but `race` has no foreign key to the finish
--     that produced it, so a reader can only guess by matching
--     (player, map, version, time). Copying the value onto the race row at
--     insert makes the PB's own number exact and keeps the leaderboard read to
--     a single indexed lookup. Same units as the finish column: basis points
--     (0..10000 = 0.00%..100.00%), NULL when the server didn't report it.
--
--   attempts — run_tally.attempts is a running COUNTER with no history (the
--     game reports attempt counts, not per-attempt events; see migration
--     20260722140000000), so "attempts as of the moment this PB was set" is
--     unrecoverable once the counter moves on. Snapshotting it when the PB row
--     is written is the only way to keep it. Counts every attempt by the whole
--     canonical identity group across every game version on that map, up to and
--     including the run that set the PB — the same grouping the leaderboard row
--     itself uses. NULL when unknown (topscores-sourced PBs carry no attempt
--     data at all), never 0, so "no data" stays distinct from a real count.
--
-- A PB improvement deletes and re-inserts the race row, so both columns are
-- re-snapshotted for the new run and always describe the CURRENT PB.

-- Up Migration
ALTER TABLE race ADD COLUMN IF NOT EXISTS strafe_quality INTEGER;
ALTER TABLE race ADD COLUMN IF NOT EXISTS attempts BIGINT;

-- Backfill strafe_quality from the finish log. A PB's finish row is written in
-- the same transaction as the race row with identical (player, map, version,
-- time), so the match is exact; the EARLIEST such finish is the one that set
-- the PB (a later run with the identical millisecond time leaves the PB
-- unchanged — see _ingestTx). Driving off the finish side keeps the scan on the
-- small subset that actually has a measurement (the column only exists from
-- 2026-07-30 on) instead of every race row ever.
WITH sq AS (
  SELECT DISTINCT ON (player_id, map_id, version_id, time)
         player_id, map_id, version_id, time, strafe_quality
    FROM finish
   WHERE strafe_quality IS NOT NULL
   ORDER BY player_id, map_id, version_id, time, created_at ASC, id ASC
)
UPDATE race r
   SET strafe_quality = sq.strafe_quality
  FROM sq
 WHERE sq.player_id = r.player_id
   AND sq.map_id    = r.map_id
   AND sq.version_id = r.version_id
   AND sq.time      = r.time
   AND r.strafe_quality IS NULL;

-- Backfill attempts ONLY where the counter is still exactly what it was at PB
-- time — i.e. the player has not attempted the map since (last_attempt <= the
-- PB's created_at). Those rows get a true count; everyone else stays NULL and
-- fills in the next time they set a PB. Deliberately no estimate for the rest:
-- the current total over-counts by every attempt made after the PB, and a
-- number that looks precise but silently inflates is worse than a blank.
WITH t AS (
  SELECT pl.canonical_id AS canonical_id, rt.map_id,
         SUM(rt.attempts)                                AS attempts,
         MAX(COALESCE(rt.last_attempt, rt.last_finish))  AS last_attempt
    FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
   GROUP BY pl.canonical_id, rt.map_id
)
UPDATE race r
   SET attempts = t.attempts
  FROM t, player rp
 WHERE rp.id = r.player_id
   AND t.canonical_id = rp.canonical_id
   AND t.map_id = r.map_id
   AND r.attempts IS NULL
   AND r.created_at IS NOT NULL
   AND t.attempts > 0
   AND t.last_attempt IS NOT NULL
   AND t.last_attempt <= r.created_at;

-- Down Migration
ALTER TABLE race DROP COLUMN IF EXISTS strafe_quality;
ALTER TABLE race DROP COLUMN IF EXISTS attempts;
