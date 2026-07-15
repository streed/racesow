// One-time data migration: SQLite race database -> PostgreSQL.
//
//   DATABASE_URL=postgres://... node migrate-sqlite-to-pg.js /data/db.sqlite
//
// Copies every table with ids preserved (race ids are the announcer's
// monotonic contract; player/map ids are in shared URLs), then fixes the
// identity sequences. Refuses to run against a Postgres that already has
// race rows unless --force is given. The SQLite file must be fully migrated
// (schema v4 — attempts column); open it once with the old layer if unsure.
import Database from "better-sqlite3";
import pg from "pg";

const sqlitePath = process.argv[2];
const force = process.argv.includes("--force");
if (!sqlitePath) {
  console.error("usage: DATABASE_URL=postgres://... node migrate-sqlite-to-pg.js <db.sqlite> [--force]");
  process.exit(2);
}
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";

const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

// The web service bootstraps the schema; make sure it exists here too so the
// tool works against a virgin database.
const { openDatabase } = await import("./db.js");
const race = await openDatabase(DATABASE_URL);
await race.close();

const client = await pool.connect();

const existing = Number((await client.query("SELECT COUNT(*) c FROM race")).rows[0].c);
if (existing > 0 && !force) {
  console.error(`target already has ${existing} race rows — pass --force to migrate anyway (rows are upserted by id)`);
  process.exit(1);
}

// Target column lists per table; ids are copied verbatim. Some columns only
// exist in later SQLite schema versions (address v3, attempts v4) — we keep
// only the ones the source file actually has, and synthesize the rest below.
const TABLES = [
  { name: "version", cols: ["id", "name"] },
  { name: "map", cols: ["id", "name"] },
  { name: "player", cols: ["id", "name", "simplified", "trimmed", "login", "canonical_id"] },
  { name: "canonical", cols: ["key", "player_id"] },
  { name: "server", cols: ["id", "name", "token_hash", "status", "created_at", "last_seen_at", "records", "address"] },
  { name: "race", cols: ["id", "version_id", "player_id", "map_id", "time", "version_rank", "global_rank", "server_id", "created_at"] },
  { name: "checkpoint", cols: ["id", "race_id", "number", "time"] },
  { name: "run_tally", cols: ["player_id", "map_id", "version_id", "finishes", "attempts", "last_finish"] },
];
const BATCH = 500;

// Which target columns the source SQLite table actually has.
function sourceColumns(table) {
  return new Set(src.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function conflictClause(t) {
  // idempotent re-runs: primary-key conflicts are replaced wholesale
  if (t.name === "canonical") return "ON CONFLICT (key) DO UPDATE SET player_id = EXCLUDED.player_id";
  if (t.name === "run_tally")
    return `ON CONFLICT (player_id, map_id, version_id) DO UPDATE SET
            finishes = EXCLUDED.finishes, attempts = EXCLUDED.attempts, last_finish = EXCLUDED.last_finish`;
  return "ON CONFLICT (id) DO NOTHING";
}

try {
  await client.query("BEGIN");
  // FK order is honoured by the TABLES order; disable just the per-row
  // triggers we can't order around (checkpoint -> race is fine as listed).
  for (const t of TABLES) {
    const have = sourceColumns(t.name);
    // Only SELECT columns the source has; the rest are synthesized per row.
    const srcCols = t.cols.filter((c) => have.has(c));
    const rows = src.prepare(`SELECT ${srcCols.join(", ")} FROM ${t.name}`).all();
    // run_tally.attempts is absent in pre-v4 SQLite: seed it from finishes
    // (every historical finish was at least one attempt) — the same rule the
    // in-place v4 migration used.
    const synth = (row, c) => {
      if (c === "attempts" && !have.has("attempts")) return row.finishes ?? 0;
      return row[c] ?? null;
    };
    let copied = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const params = [];
      const tuples = batch.map((row, ri) => {
        const ph = t.cols.map((_, ci) => `$${ri * t.cols.length + ci + 1}`);
        for (const c of t.cols) params.push(synth(row, c));
        return `(${ph.join(",")})`;
      });
      await client.query(
        `INSERT INTO ${t.name} (${t.cols.join(",")}) VALUES ${tuples.join(",")} ${conflictClause(t)}`,
        params
      );
      copied += batch.length;
    }
    console.log(`${t.name}: ${copied} rows${have.has("attempts") || t.name !== "run_tally" ? "" : " (attempts seeded from finishes)"}`);
  }

  // config: copy the counters, keep the Postgres schema_version.
  for (const row of src.prepare("SELECT key, value FROM config WHERE key <> 'schema_version'").all()) {
    await client.query(
      "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [row.key, row.value]
    );
  }

  // Identity sequences must start after the copied ids.
  for (const t of ["version", "map", "player", "server", "checkpoint"]) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`
    );
  }

  await client.query("COMMIT");
  console.log("migration committed; building aggregates ...");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

// Fresh aggregate tables + a sanity readback.
const race2 = await openDatabase(DATABASE_URL);
const ov = await race2.overview();
console.log(
  `sanity: ${ov.totals.records} records, ${ov.totals.checkpoints} checkpoints, ` +
    `${ov.totals.players} players, ${ov.totals.maps} maps, ${ov.totals.finishes} finishes`
);
await race2.close();
await pool.end();
src.close();
console.log("done");
