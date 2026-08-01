-- Monotonic row id on the award log for the in-game announcements poll
-- (/api/game/awards -> hrace/awards.as). The game keeps a per-player-slot
-- high-water mark and asks for rows above it; awarded_at (epoch SECONDS) can't
-- be that cursor because one evaluator pass batch-inserts many rows in the
-- same second. The composite PK stays — this is purely an append-order cursor
-- (identity values are assigned in insert order).

-- Up Migration
ALTER TABLE player_achievement ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX idx_pach_row_id ON player_achievement (id);

-- Down Migration
DROP INDEX IF EXISTS idx_pach_row_id;
ALTER TABLE player_achievement DROP COLUMN IF EXISTS id;
