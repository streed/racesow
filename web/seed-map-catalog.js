// Give every INSTALLED map a row in the `map` table, so a map is findable on the
// website before anyone has raced it.
//
//   node seed-map-catalog.js [mapsDir] [--dry-run] [--no-refresh]
//
// Why this is needed: a `map` row was only ever minted on the ingest path — the
// first time somebody finished a run there (db.js ensureMapByName). So a map
// could sit in the pool on all four servers, be votable in game, and still be
// invisible on /maps and unsearchable, because nothing had happened on it yet.
// That is backwards for a site people use to DECIDE what to play: the maps with
// no records are exactly the ones worth advertising.
//
// The fix is only an INSERT. map_index — what /maps and the search actually read
// — is built `FROM map m` with LEFT JOINs (db.js refreshAggregates), so a fresh
// row needs no other backfill: it simply reads as 0 records, 0 players, no WR,
// and sorts to the bottom of the default records-descending order.
//
// Names come from maps/<name>.bsp inside the pk3s in the server's own maps
// directory, via mapindex.js — which reads ONLY each zip's central directory, so
// cataloguing ~4,600 packs costs seconds and no decompression. That is the same
// source the engine builds its vote pool from, which is what makes these names
// trustworthy enough to mint (see ensureMapsByName in db.js).
//
// Idempotent: existing maps are left exactly as they are (ON CONFLICT DO
// NOTHING), so this is safe to re-run after every fetch-maps.sh / new map drop.
// Nothing here un-blocks a map — a moderator's map_block still hides it.
//
// Runs in the same image as the heatmaps sidecar, which already mounts
// ./server/maps at /maps and carries DATABASE_URL:
//   docker compose run --rm heatmaps node seed-map-catalog.js --dry-run
//   docker compose run --rm heatmaps node seed-map-catalog.js
import { buildMapIndex } from "./mapindex.js";
import { openDatabase } from "./db.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_REFRESH = args.includes("--no-refresh");
const MAPS_DIR = args.find((a) => !a.startsWith("--")) || process.env.MAPS_DIR || "/maps";

async function main() {
  console.log(`cataloguing installed maps in ${MAPS_DIR} ...`);
  const index = buildMapIndex(MAPS_DIR); // Map<name, pk3[]>, already lowercased + charset-checked
  const installed = [...index.keys()];
  if (!installed.length) {
    console.error(`no maps found in ${MAPS_DIR} — is the maps volume mounted?`);
    process.exit(1);
  }
  console.log(`found ${installed.length} installed map(s) across the pool`);

  const race = await openDatabase(DATABASE_URL);
  try {
    if (DRY_RUN) {
      // Ask the DB which of these it already knows, rather than minting
      // anything. Same set difference the insert would do.
      const known = new Set(
        (await race.all("SELECT name FROM map WHERE name = ANY($1::text[])", [installed]))
          .map((r) => r.name)
      );
      const missing = installed.filter((n) => !known.has(n));
      console.log(`dry run: ${missing.length} map(s) would be added, ${known.size} already present`);
      for (const n of missing.slice(0, 40)) console.log(`   + ${n}`);
      if (missing.length > 40) console.log(`   ... and ${missing.length - 40} more`);
      return;
    }

    const { considered, created } = await race.ensureMapsByName(installed);
    console.log(`catalogued ${considered} installed map(s): ${created.length} new row(s)`);
    for (const n of created.slice(0, 40)) console.log(`   + ${n}`);
    if (created.length > 40) console.log(`   ... and ${created.length - 40} more`);

    // map_index is a derived table rebuilt wholesale, so the new rows are
    // invisible to /maps until it is rebuilt. Skipping the refresh leaves the
    // insert correct but unpublished — which is why it is on by default.
    if (created.length && !NO_REFRESH) {
      console.log("refreshing aggregates so the new maps appear on /maps ...");
      await race.refreshAggregates();
      const n = await race.one("SELECT COUNT(*) c FROM map_index");
      console.log(`map_index now holds ${n.c} map(s)`);
    } else if (!created.length) {
      console.log("nothing new — every installed map already has a row");
    }
  } finally {
    await race.close();
  }
}

main().catch((e) => {
  console.error("seed-map-catalog failed:", e);
  process.exit(1);
});
