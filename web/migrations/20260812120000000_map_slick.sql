-- How slick (icy) each installed map is, measured from its .bsp alongside the
-- weapon inventory in the same scan (web/scan-map-weapons.js -> bsp.js
-- parseSlick). Powers the "Slick NN%" tag + filter on the website maps page and
-- `callvote randmap slick` in-game.
--
-- Lives on map_weapon rather than its own table because both columns come from
-- one pass over the same inflated .bsp: the pool is ~4,300 packs and inflating
-- it twice costs ~10 minutes of pure I/O for nothing. Same keying caveat as the
-- rest of the table — keyed by map NAME, a superset of the `map` table, because
-- randmap votes over every installed map and most have never been raced.
--
-- slick_frac is the share of the map's distinct walkable floor levels whose
-- surface is slick, in [0,1]. It is stored as the raw measurement, NOT as a
-- boolean, so the "is this a slick map" threshold (weapons.js SLICK_MIN_FRAC)
-- can be retuned without re-scanning 4,300 packs.

-- Up Migration
ALTER TABLE map_weapon
  ADD COLUMN IF NOT EXISTS slick_frac   REAL    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slick_brushes INTEGER NOT NULL DEFAULT 0;

-- Filter the maps page / randmap pool to slick maps: ORDER BY + threshold scans.
CREATE INDEX IF NOT EXISTS map_weapon_slick_idx ON map_weapon (slick_frac)
  WHERE slick_frac > 0;

-- Down Migration
DROP INDEX IF EXISTS map_weapon_slick_idx;
ALTER TABLE map_weapon
  DROP COLUMN IF EXISTS slick_frac,
  DROP COLUMN IF EXISTS slick_brushes;
