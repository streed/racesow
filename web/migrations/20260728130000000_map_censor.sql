-- Map-name censoring — the map analogue of player_censor (see the prior
-- migration 20260728120000000_name_censor). Offensive MAP names (e.g.
-- "pneumo-shit6", "assfag", "ok-cuntroll") are masked at DISPLAY time only,
-- reusing the SAME censor_term word list. The stored map.name is never touched:
-- it is a functional identifier (the game loads/votes by it, the site routes by
-- map id, external download links use it), so only the visible text is starred.
--
-- This is display-only and intentionally imperfect — a censored map stays fully
-- playable and linkable under its real name. To pull a genuinely offensive map
-- out of rotation entirely, use map_block instead.
--
-- player_censor and map_censor are separate override tables (a per-entity
-- allow/censor decision) but share one word list, so a term added for one
-- domain also applies to the other. If that ever bites, add a scope column to
-- censor_term; for now the seeded slurs are offensive in both.

-- Up Migration
CREATE TABLE IF NOT EXISTS map_censor (
  map_id BIGINT PRIMARY KEY REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('allow', 'censor')),  -- allow = whitelist a false positive; censor = force-mask a miss
  reason TEXT,
  set_at BIGINT NOT NULL,
  set_by TEXT
);

-- Down Migration
DROP TABLE IF EXISTS map_censor CASCADE;
