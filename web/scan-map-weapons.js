// Scan installed map .pk3 packs and store what each map PLAYS like in the
// map_weapon table: its weapon inventory, and how slick (icy) its floor is. This
// is the data source for randmap-by-weapon / randmap slick voting in-game and
// the weapon/strafe/slick filter + "Slick NN%" tag on the website.
//
//   node scan-map-weapons.js [mapsDir]      # default: $MAPS_DIR or /maps
//
// Reads every maps/<name>.bsp inside every pk3 (see bsp.js extractMapEntities),
// which returns both the lump-0 entity text and the parseSlick measurement from
// ONE inflate of each pack. From the entities it records which canonical weapons
// appear (weapons.js); a map with no weapons other than the gunblade is a strafe
// map. Idempotent — safe to re-run after fetch-maps.sh pulls new packs. Keyed by
// the in-game map name (bsp basename), so it covers the whole pool, not just
// maps that have been raced.
//
// Runs against the same racesow-web image as the heatmaps sidecar, which already
// mounts ./server/maps read-only and has DATABASE_URL, e.g.:
//   docker compose run --rm heatmaps node scan-map-weapons.js
//
// Note: only the bsp entity lump is read; a rare map that overrides its entities
// with an external maps/<name>.ent file is scanned from the bsp, not the .ent.
import fs from "node:fs";
import path from "node:path";
import { extractMapEntities } from "./bsp.js";
import { openDatabase } from "./db.js";
import { ALL_CODES, isStrafe, isSlick, codesFromEntities } from "./weapons.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";
const MAPS_DIR = process.argv[2] || process.env.MAPS_DIR || "/maps";

async function main() {
  let pk3s;
  try {
    pk3s = fs.readdirSync(MAPS_DIR).filter((f) => f.toLowerCase().endsWith(".pk3"));
  } catch (e) {
    console.error(`cannot read maps dir ${MAPS_DIR}: ${e.message}`);
    process.exit(1);
  }
  console.log(`scanning ${pk3s.length} pk3 packs in ${MAPS_DIR} ...`);

  // map name -> { codes, slick, hadEntities }. A map name can live in more than
  // one pack; a scan that actually read entities beats an empty (corrupt) one.
  const byMap = new Map();
  let packs = 0, corruptBsp = 0;
  for (const f of pk3s) {
    packs++;
    for (const { name, entities, slick } of extractMapEntities(path.join(MAPS_DIR, f))) {
      if (!entities) corruptBsp++;
      const key = name.toLowerCase();
      const prev = byMap.get(key);
      if (prev && prev.hadEntities && !entities) continue;
      byMap.set(key, {
        codes: codesFromEntities(entities),
        // parseSlick returns null only for a bsp we couldn't read at all, which
        // is the same case as empty entities — record it as "no slick found".
        slickFrac: slick ? slick.frac : 0,
        slickBrushes: slick ? slick.brushes : 0,
        hadEntities: !!entities,
      });
    }
    if (packs % 500 === 0) console.log(`  ${packs}/${pk3s.length} packs ...`);
  }
  console.log(`parsed ${byMap.size} unique maps (${corruptBsp} unreadable bsp entries skipped)`);
  if (byMap.size === 0) {
    console.error("no maps found — nothing to write");
    process.exit(1);
  }

  const race = await openDatabase(DATABASE_URL);
  try {
    const client = await race.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [name, { codes, slickFrac, slickBrushes }] of byMap) {
        await client.query(
          `INSERT INTO map_weapon (name, weapons, is_strafe, slick_frac, slick_brushes, scanned_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (name) DO UPDATE
             SET weapons = EXCLUDED.weapons, is_strafe = EXCLUDED.is_strafe,
                 slick_frac = EXCLUDED.slick_frac, slick_brushes = EXCLUDED.slick_brushes,
                 scanned_at = now()`,
          [name, codes, isStrafe(codes), slickFrac, slickBrushes]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }

    let strafe = 0, slick = 0, anySlick = 0;
    const perWeapon = Object.fromEntries(ALL_CODES.map((c) => [c, 0]));
    for (const { codes, slickFrac } of byMap.values()) {
      if (isStrafe(codes)) strafe++;
      if (slickFrac > 0) anySlick++;
      if (isSlick(slickFrac)) slick++;
      for (const c of codes) perWeapon[c]++;
    }
    console.log(`upserted ${byMap.size} maps: ${strafe} strafe, ${slick} slick (${anySlick} with any slick at all)`);
    console.log("per-weapon counts: " + ALL_CODES.map((c) => `${c}=${perWeapon[c]}`).join("  "));
  } finally {
    await race.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
