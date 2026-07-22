-- Movement / behaviour player metrics. The game module counts four events per
-- (player, map, version) during genuine races and flushes them to /api/ingest
-- riding on the same finish/attempt reports that already carry attempt counts:
--
--   wall_jumps       - +Special wall jumps performed during races
--   dashes           - +Special ground dashes performed during races
--   prejump_failures - race starts rejected because the player prejumped
--   restarts         - deliberate run resets (/kill, /racerestart)
--
-- They accumulate exactly like run_tally.attempts (see db.js _ingestTx) and are
-- summed per player into lifetime "player metrics" on the profile pages
-- (db.js playerDetail). Existing rows and older servers that omit the fields
-- default to 0, so the ingest stays backward-compatible.

-- Up Migration
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS wall_jumps       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS dashes           BIGINT NOT NULL DEFAULT 0;
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS prejump_failures BIGINT NOT NULL DEFAULT 0;
ALTER TABLE run_tally ADD COLUMN IF NOT EXISTS restarts         BIGINT NOT NULL DEFAULT 0;

-- Down Migration
ALTER TABLE run_tally DROP COLUMN IF EXISTS wall_jumps;
ALTER TABLE run_tally DROP COLUMN IF EXISTS dashes;
ALTER TABLE run_tally DROP COLUMN IF EXISTS prejump_failures;
ALTER TABLE run_tally DROP COLUMN IF EXISTS restarts;
