-- Per-map weapon inventory, derived by scanning each installed map's .bsp entity
-- lump for weapon_* spawn entities (see web/scan-map-weapons.js). It powers
-- randmap-by-weapon voting in-game (GET /api/game/map-weapons -> the gametype's
-- RS_ApiFetchMapWeapons native) and the weapon/strafe filter on the website maps
-- page.
--
-- Keyed by map NAME (not map.id) on purpose: randmap picks from every map
-- installed on the box, and most of those have never been raced, so they have no
-- row in the `map` table. The scanner covers the whole pk3 pool, so this table
-- is a superset of `map`.
--
-- A map with no weapons (or only a gunblade, which every player spawns holding)
-- is a strafe map: is_strafe = true. `weapons` still records every code found,
-- including gb, so `randmap gb` works.

-- Up Migration
CREATE TABLE IF NOT EXISTS map_weapon (
  name       TEXT PRIMARY KEY,                    -- lowercased in-game map name (bsp basename)
  weapons    TEXT[] NOT NULL DEFAULT '{}',        -- sorted 2-char codes: rl, pg, gl, ...
  is_strafe  BOOLEAN NOT NULL DEFAULT false,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Filter the website maps page to "maps that contain weapon X": weapons @> ARRAY['rl'].
CREATE INDEX IF NOT EXISTS map_weapon_weapons_idx ON map_weapon USING GIN (weapons);
CREATE INDEX IF NOT EXISTS map_weapon_strafe_idx ON map_weapon (is_strafe);

-- Down Migration
DROP TABLE IF EXISTS map_weapon CASCADE;
