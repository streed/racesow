// Data-access layer for the race database — PostgreSQL edition.
//
// Connects to Postgres (DATABASE_URL), bootstraps/migrates the schema, and at
// startup builds a handful of UNLOGGED aggregate tables so the API can answer
// flexible map / player queries (search, sort, paginate) without re-scanning
// 240k+ race rows on every call. All methods are async (pg is); the method
// names, arguments and return shapes are IDENTICAL to the historical
// better-sqlite3 layer, so the HTTP API contract is unchanged.
//
// Times are milliseconds. Player names carry ^0-^9 Warsow colour codes; both
// the raw name and a colour-stripped `simplified` form are returned so the
// client can render colours and the API can search plain text.
//
// Search runs on pg_trgm GIN indexes: substring matches are index-backed
// instead of table scans, and results are tiered exact > prefix > substring >
// trigram-fuzzy, so "chupa", "elchpa" and "ELchupa" all find the same player.
//
// Beyond the original livesow snapshot this layer keeps:
//   * canonical players — many colour/spelling variants of one person collapse
//     to a single representative (see _resolvePlayer; new identities join a
//     group, they never seize its representative).
//   * run tally — finishes (runs that reached the finish) and attempts (race
//     starts) per player/map/version.
//   * server provenance + timestamps on ingested records (multi-server).
//   * the monotonic race-id counter (improved records get strictly higher
//     ids — the Discord announcer's detection contract).
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner as pgMigrateRunner } from "node-pg-migrate";

// Points a player scores for their best rank on a map (top-15 scoring). Kept in
// sync with the CASE expression used to build the standings table.
export const POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

const POINTS_CASE = `CASE rank
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

// Schema is managed by node-pg-migrate: versioned files in ./migrations run at
// startup (see openDatabase). The baseline (0001) reflects the former SQLite
// era's final shape and adopts the existing production DB idempotently; future
// changes are new numbered migration files, never edits to applied ones.
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

// Where WR ghost trajectory files live (gzipped JSON, one per map, keyed by
// map id). Metadata rows are in the `ghost` table; the bytes are on disk so
// the DB stays lean. Overridable for tests / container volumes.
const GHOST_DIR =
  process.env.GHOST_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "ghosts");

// Public base URL the game host serves .wd demo files from (nginx pak-mirror,
// plain HTTP). A wr_demo row stores only the relative path; the full download
// URL is base + "/demos/" + path. Unset in dev -> the download button is
// omitted client-side.
const DEMO_BASE_URL = (process.env.DEMO_BASE_URL || "").replace(/\/+$/, "");

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Valid map-flag reasons. Single source of truth: the HTTP endpoint, the admin
// CLI and the server-rendered admin page all validate against this list.
export const FLAG_REASONS = ["broken", "offensive", "wrong_name", "duplicate", "other"];

// Password hashing for admin accounts — scrypt from node:crypto, so there is no
// bcrypt/argon dependency (this codebase stays dep-light). Stored format is
// "scrypt$<saltHex>$<hashHex>". scryptSync is intentional: admin logins are
// rare and the deliberate CPU cost is the whole point of a KDF.
const SCRYPT_KEYLEN = 64;
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}
export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (!salt.length || !expected.length) return false;
  let dk;
  try {
    dk = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  // Constant-time compare (both buffers are the same length by construction).
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// Warsow ^0-^9 colour codes -> plain text, mirroring the livesow columns:
// `simplified` keeps punctuation, `trimmed` is lowercase alphanumerics only.
export function simplifyName(name) {
  return String(name).replace(/\^[0-9]/g, "");
}
export function trimName(simplified) {
  return normToken(simplified);
}

// Aggressive normalisation used only for the `trimmed` SEARCH column (so a
// query like "elchupa" finds "^8EL^9chupa^7"): strip colour codes, lowercase,
// drop a trailing "(N)" collision suffix, keep only alphanumerics. NOT used for
// identity grouping any more — see identKey.
export function normToken(s) {
  return String(s)
    .replace(/\^[0-9]/g, "")
    .toLowerCase()
    .replace(/\(\d+\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

// Identity-grouping normalisation: strip colour codes, lowercase, and drop a
// trailing "(N)" collision suffix (the mod appends these when two players use
// the same name) — but nothing else. Unlike normToken it KEEPS spaces and
// punctuation, so distinct nicks like "a b" / "ab" or "n.o.v.a" / "nova" stay
// separate instead of collapsing together, and symbol-only nicks no longer all
// normalise to "" (which used to merge every such player into one group). Two
// names group iff their colour-stripped, lowercased, suffix-trimmed forms are
// EXACTLY equal.
export function identKey(name) {
  return String(name)
    .replace(/\^[0-9]/g, "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();
}

// The grouping key for collapsing duplicate identities into one person. Login
// and nick share ONE namespace: a logged-in row keys on its login, an
// anonymous row on its identKey'd nick. `simplified` is already colour-stripped
// but identKey re-strips defensively. Empty key falls back to a sentinel.
export function canonKey(simplified, login) {
  return (login ? String(login).toLowerCase().trim() : identKey(simplified)) || "?empty?";
}

// Escape LIKE/ILIKE metacharacters in user-supplied search text so "50%" or
// "a_b" match literally (the historical SQLite layer had this hole).
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

export async function openDatabase(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: parseInt(process.env.PG_POOL_SIZE || "10", 10),
  });
  // Fail fast (and loudly) if the server is unreachable/misconfigured.
  const probe = await pool.connect();
  probe.release();

  const t0 = Date.now();
  await runSchemaMigrations(connectionString);

  // Kept for API-shape parity with the SQLite layer (which supported legacy /
  // read-only snapshots). A Postgres database is always fully migrated.
  const caps = {
    canonical: true,
    runTally: true,
    server: true,
    serverId: true,
    serverAddress: true,
    attempts: true,
  };

  const race = new RaceDB(pool, caps);
  await race._loadVersions();
  await race.refreshAggregates();
  await race._relayoutGhostFiles();
  console.log(`Database ready in ${Date.now() - t0}ms`);
  return race;
}

// Apply pending schema migrations with node-pg-migrate. The runner opens its
// OWN short-lived pg client from the connection string, takes a session-level
// advisory lock (PG_MIGRATE_LOCK_ID) so the two web replicas booting together
// can't race the schema, applies every pending ./migrations file inside one
// transaction, records them in `pgmigrations`, and disconnects. Idempotent:
// with nothing pending it is a quick no-op. Returns the migrations it ran.
async function runSchemaMigrations(connectionString) {
  const applied = await pgMigrateRunner({
    databaseUrl: connectionString,
    dir: MIGRATIONS_DIR,
    direction: "up",
    migrationsTable: "pgmigrations",
    // Quiet on the happy path; surface only warnings/errors. node-pg-migrate's
    // own "Migrating files" chatter is redundant with the summary below.
    logger: { debug() {}, info() {}, warn: console.warn, error: console.error },
  });
  if (applied.length) {
    console.log(
      `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(", ")}`,
    );
  }
  return applied;
}

// Assign every player a canonical representative, recomputed from scratch
// (offline maintenance / data-migration pass; ingest keeps groups current
// incrementally). The representative is the nick with the most recent race.
export async function rebuildCanonical(pool) {
  const players = (await pool.query("SELECT id, name, simplified, login FROM player")).rows;
  const latest = new Map();
  for (const r of (await pool.query("SELECT player_id, MAX(id) mx FROM race GROUP BY player_id")).rows) {
    latest.set(Number(r.player_id), Number(r.mx));
  }
  const groups = new Map();
  const rank = (p) => [latest.get(Number(p.id)) ?? -1, Number(p.id)];
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  for (const p of players) {
    const key = canonKey(p.simplified, p.login);
    const score = rank(p);
    const cur = groups.get(key);
    if (!cur || better(score, cur.score)) groups.set(key, { repId: Number(p.id), score });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM canonical");
    for (const p of players) {
      const key = canonKey(p.simplified, p.login);
      await client.query("UPDATE player SET canonical_id = $1 WHERE id = $2", [groups.get(key).repId, p.id]);
    }
    for (const [key, g] of groups) {
      await client.query(
        "INSERT INTO canonical (key, player_id) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET player_id = EXCLUDED.player_id",
        [key, g.repId]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --------------------------------------------------------------------------
// Aggregate tables (rebuilt on refreshAggregates)
// --------------------------------------------------------------------------
// UNLOGGED: they are derived data, rebuilt at startup and after ingests —
// crash-safety would only add WAL cost. The whole rebuild runs in ONE
// transaction, so readers see the old tables until the swap commits.
async function buildAggregates(client) {
  await client.query(`
    DROP TABLE IF EXISTS best_new, standings_new, map_index_new;

    CREATE UNLOGGED TABLE best_new AS
      SELECT pl.canonical_id AS player_id, r.map_id,
             MIN(r.global_rank) AS rank, MIN(r.time) AS time
      FROM race r JOIN player pl ON pl.id = r.player_id
      GROUP BY pl.canonical_id, r.map_id;
    CREATE INDEX ON best_new(map_id);
    CREATE INDEX ON best_new(player_id);

    CREATE UNLOGGED TABLE standings_new AS
      SELECT s.*, ROW_NUMBER() OVER (ORDER BY points DESC, wr DESC, player_id) AS rank
      FROM (
        SELECT player_id,
               COUNT(*)::int                                AS maps,
               SUM(CASE WHEN rank=1 THEN 1 ELSE 0 END)::int AS wr,
               SUM(CASE WHEN rank<=3 THEN 1 ELSE 0 END)::int AS podium,
               SUM(${POINTS_CASE})::int                     AS points
        FROM best_new GROUP BY player_id
      ) s;
    CREATE INDEX ON standings_new(player_id);
    CREATE INDEX ON standings_new(points DESC);
    CREATE INDEX ON standings_new(rank);

    CREATE UNLOGGED TABLE map_index_new AS
      SELECT m.id AS map_id, m.name AS name,
             COALESCE(rc.records, 0)::int AS records,
             COALESCE(ft.finishes, rc.records, 0)::int AS finishes,
             COALESCE(pc.players, 0)::int AS players,
             wr.wr_time, wr.wr_pid, wr.wr_version, wr.wr_race_id
      FROM map m
      LEFT JOIN (SELECT map_id, COUNT(*) records FROM race GROUP BY map_id) rc
             ON rc.map_id = m.id
      LEFT JOIN (SELECT map_id, SUM(finishes) finishes FROM run_tally GROUP BY map_id) ft
             ON ft.map_id = m.id
      LEFT JOIN (SELECT map_id, COUNT(*) players FROM best_new GROUP BY map_id) pc
             ON pc.map_id = m.id
      LEFT JOIN (
        SELECT DISTINCT ON (r.map_id)
               r.map_id,
               r.time        AS wr_time,
               wpl.canonical_id AS wr_pid,
               r.version_id  AS wr_version,
               r.id          AS wr_race_id
        FROM race r JOIN player wpl ON wpl.id = r.player_id
        ORDER BY r.map_id, r.time ASC, r.id ASC
      ) wr ON wr.map_id = m.id;
    CREATE INDEX ON map_index_new(name);
    CREATE INDEX ON map_index_new(records DESC);
    CREATE INDEX ON map_index_new(wr_time);
    CREATE INDEX ON map_index_new USING gin (name gin_trgm_ops);

    DROP TABLE IF EXISTS best, standings, map_index;
    ALTER TABLE best_new      RENAME TO best;
    ALTER TABLE standings_new RENAME TO standings;
    ALTER TABLE map_index_new RENAME TO map_index;
  `);
}

// Whitelisted sort columns keep user-supplied `sort` params injection-safe.
// Null-prototype so a query param like ?sort=constructor can't slip through.
const MAP_SORTS = Object.assign(Object.create(null), {
  name: "lower(mi.name)",
  records: "mi.records",
  races: "mi.records", // legacy alias
  finishes: "mi.finishes",
  wr_time: "mi.wr_time",
});
const PLAYER_SORTS = Object.assign(Object.create(null), {
  points: "points",
  wr: "wr",
  podium: "podium",
  maps: "maps",
  rank: "rank",
  name: "lower(p.simplified)",
});
const RECORD_SORTS = Object.assign(Object.create(null), {
  // Reference the underlying column, not the SELECT alias: Postgres allows a
  // BARE output alias in ORDER BY but not one wrapped in a function call
  // (lower(map_name) -> "column map_name does not exist").
  map: "lower(m.name)",
  time: "time",
  rank: "rank",
  attempts: "attempts",
});

function dir(order, fallback = "ASC") {
  return String(order).toLowerCase() === "desc" ? "DESC" : String(order).toLowerCase() === "asc" ? "ASC" : fallback;
}
function clampLimit(v, def = 50, max = 200) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}
function toOffset(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}
// pg returns BIGINT as strings; every id/count this API emits fits in a JS
// number (race ids are in the millions), so normalise at the edge.
const num = (v) => (v == null ? null : Number(v));

class RaceDB {
  constructor(pool, caps) {
    this.pool = pool;
    this.caps = caps;
    this.versions = {};
    // Memoized perfect-run per map (recomputed when an ingest touches the map).
    this._perfectRunCache = new Map();
  }

  async _loadVersions() {
    for (const v of (await this.pool.query("SELECT id, name FROM version")).rows) {
      this.versions[num(v.id)] = v.name;
    }
  }

  // Tiny query helpers so call sites read like the old synchronous layer.
  async all(sql, params = []) {
    return (await this.pool.query(sql, params)).rows;
  }
  async one(sql, params = []) {
    const r = await this.pool.query(sql, params);
    return r.rows[0];
  }

  async overview() {
    const one = (sql, p) => this.one(sql, p);
    const totals = {
      maps: num((await one("SELECT COUNT(*) c FROM map")).c),
      players: num((await one("SELECT COUNT(*) c FROM player")).c),
      canonicalPlayers: num((await one("SELECT COUNT(DISTINCT canonical_id) c FROM player")).c),
      rankedPlayers: num((await one("SELECT COUNT(*) c FROM standings")).c),
      records: num((await one("SELECT COUNT(*) c FROM race")).c),
      finishes: num((await one("SELECT COALESCE(SUM(finishes),0) c FROM run_tally")).c),
      checkpoints: num((await one("SELECT COUNT(*) c FROM checkpoint")).c),
      worldRecords: num((await one("SELECT COUNT(*) c FROM map_index WHERE wr_time IS NOT NULL")).c),
    };
    const versions = (
      await this.all("SELECT version_id id, COUNT(*) records FROM race GROUP BY version_id ORDER BY records DESC")
    ).map((r) => ({
      id: num(r.id),
      name: this.versions[num(r.id)] || String(r.id),
      records: num(r.records),
      races: num(r.records),
    }));
    const topMaps = (
      await this.all("SELECT map_id id, name, records, finishes FROM map_index ORDER BY records DESC LIMIT 15")
    ).map((m) => ({ id: num(m.id), name: m.name, records: m.records, finishes: m.finishes, races: m.records }));
    const hallOfFame = (
      await this.all(
        `SELECT s.rank, s.player_id id, p.name, p.simplified, s.points, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ORDER BY s.rank LIMIT 20`
      )
    ).map((r) => ({ ...r, rank: num(r.rank), id: num(r.id) }));
    const recent = await this.recentRecords(8);
    const lastUpdate = await this.one("SELECT value FROM config WHERE key='last_update'");
    return {
      lastUpdate: lastUpdate ? parseInt(lastUpdate.value, 10) : null,
      totals,
      versions,
      topMaps,
      hallOfFame,
      recent,
      servers: await this.servers(),
    };
  }

  // Recently ingested records (created_at is NULL on the seeded snapshot).
  async recentRecords(limit = 8) {
    return (
      await this.all(
        `SELECT r.id, r.time, r.global_rank, r.created_at, r.map_id, m.name AS map,
                pl.canonical_id AS player_id, disp.name, disp.simplified,
                sv.name AS server
         FROM race r
         JOIN player pl ON pl.id = r.player_id
         JOIN map m ON m.id = r.map_id
         JOIN player disp ON disp.id = pl.canonical_id
         LEFT JOIN server sv ON sv.id = r.server_id
         WHERE r.created_at IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT $1`,
        [limit]
      )
    ).map((r) => ({
      ...r,
      id: num(r.id),
      map_id: num(r.map_id),
      player_id: num(r.player_id),
      created_at: num(r.created_at),
      versionName: null,
    }));
  }

  // New records after a race id, for the Discord announcer (GET /api/records).
  // Includes the margin-to-#2 for world records and the version name, so the
  // announcer needs no database access at all.
  async recordsAfter({ afterId = 0, maxRank = 1, limit = 10 } = {}) {
    const rows = await this.all(
      `SELECT r.id, r.time, r.global_rank, r.version_rank, r.version_id,
              m.id AS map_id, m.name AS map,
              p.name AS raw_name, p.simplified AS player
       FROM race r
       JOIN map m ON m.id = r.map_id
       JOIN player p ON p.id = r.player_id
       WHERE r.id > $1 AND r.global_rank <= $2
       ORDER BY r.id ASC
       LIMIT $3`,
      [afterId, Math.max(1, Math.min(50, maxRank)), Math.max(1, Math.min(50, limit))]
    );
    const out = [];
    for (const r of rows) {
      let margin = null;
      if (r.global_rank === 1) {
        const m = await this.one(
          `SELECT MIN(t) AS t FROM (
             SELECT MIN(time) AS t FROM race WHERE map_id = $1 GROUP BY player_id
           ) x WHERE t > $2`,
          [r.map_id, r.time]
        );
        margin = m && m.t != null ? num(m.t) - r.time : null;
      }
      out.push({
        id: num(r.id),
        time: r.time,
        global_rank: r.global_rank,
        version_rank: r.version_rank,
        version: this.versions[num(r.version_id)] || String(r.version_id),
        map_id: num(r.map_id),
        map: r.map,
        raw_name: r.raw_name,
        player: r.player,
        margin,
      });
    }
    const maxRow = await this.one("SELECT COALESCE(MAX(id), 0) m FROM race");
    return { maxId: num(maxRow.m), records: out };
  }

  async servers() {
    return (
      await this.all(
        `SELECT id, name, status, created_at, last_seen_at, records, address
         FROM server ORDER BY last_seen_at DESC NULLS LAST, id`
      )
    ).map((s) => ({
      ...s,
      id: num(s.id),
      created_at: num(s.created_at),
      last_seen_at: num(s.last_seen_at),
      records: num(s.records),
    }));
  }

  async setServerAddress(id, address) {
    const r = await this.pool.query("UPDATE server SET address = $1 WHERE id = $2", [address || null, id]);
    return r.rowCount > 0;
  }

  // Set (or clear, with null) a server's RCON password. Stored plaintext because
  // the connectionless `rcon <pass> <cmd>` wire format is cleartext — see the
  // migration. Only the admin routes / CLI ever read it back (rconTargets,
  // serverById); it is deliberately absent from servers() and every public API.
  async setServerRcon(id, password) {
    const r = await this.pool.query("UPDATE server SET rcon_password = $1 WHERE id = $2", [
      password || null,
      id,
    ]);
    return r.rowCount > 0;
  }

  // One server's full admin row, including the RCON secret + address. Admin-only.
  async serverById(id) {
    const row = await this.one(
      "SELECT id, name, status, created_at, last_seen_at, records, address, rcon_password FROM server WHERE id = $1",
      [id]
    );
    if (!row) return null;
    return {
      ...row,
      id: num(row.id),
      created_at: num(row.created_at),
      last_seen_at: num(row.last_seen_at),
      records: num(row.records),
    };
  }

  // Like servers() but for the admin ops page: adds a boolean `rcon` (whether a
  // password is set) WITHOUT ever returning the secret itself.
  async serversAdmin() {
    return (
      await this.all(
        `SELECT id, name, status, created_at, last_seen_at, records, address,
                (rcon_password IS NOT NULL) AS rcon
         FROM server ORDER BY last_seen_at DESC NULLS LAST, id`
      )
    ).map((s) => ({
      ...s,
      id: num(s.id),
      created_at: num(s.created_at),
      last_seen_at: num(s.last_seen_at),
      records: num(s.records),
      rcon: !!s.rcon,
    }));
  }

  // Servers a broadcast/maintenance rcon can actually reach: trusted, with both
  // a query address and an rcon password. Returns the secret (admin/CLI use).
  async rconTargets() {
    return (
      await this.all(
        `SELECT id, name, address, rcon_password
         FROM server
         WHERE status <> 'revoked' AND address IS NOT NULL AND rcon_password IS NOT NULL
         ORDER BY id`
      )
    ).map((s) => ({ id: num(s.id), name: s.name, address: s.address, password: s.rcon_password }));
  }

  async mapIdByName(name) {
    const row = await this.one("SELECT id FROM map WHERE name = $1", [String(name).toLowerCase()]);
    return row ? num(row.id) : null;
  }

  // --------------------------------------------------------------------------
  // Live topscores for game servers (GET /api/game/topscores?map=) ------------
  // EXACT topscores file format contract — see the SQLite-era comment block,
  // web/seed-topscores.js and hrace/recordtime.as. Byte-format stability is
  // load-bearing: the game swaps this straight into its local records file.
  async gameTopscoresText(mapName) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return null;
    const map = await this.one("SELECT id FROM map WHERE name = $1", [name]);
    if (!map) return null;

    const top = await this.all(
      `WITH k AS (
         SELECT pl.canonical_id cid, r.id rid, r.time,
                ROW_NUMBER() OVER (PARTITION BY pl.canonical_id ORDER BY r.time, r.id) rn
         FROM race r JOIN player pl ON pl.id = r.player_id
         WHERE r.map_id = $1
       )
       SELECT k.rid, k.time, rep.name
       FROM k JOIN player rep ON rep.id = k.cid
       WHERE k.rn = 1 ORDER BY k.time, k.rid LIMIT 50`,
      [map.id]
    );
    const sanitize = (n) => String(n).replace(/["\r\n\t]/g, "").slice(0, 64);

    let body = `//${name} top scores\n\n`;
    for (const r of top) {
      const cleanName = sanitize(r.name);
      if (!cleanName) continue; // empty token would truncate the loader
      const sectors = (
        await this.all("SELECT time FROM checkpoint WHERE race_id = $1 ORDER BY number", [r.rid])
      ).map((c) => c.time | 0);
      let line = `"${r.time}" "${cleanName}" "${sectors.length}" `;
      for (const s of sectors) line += `"${s}" `;
      body += line + "\n";
    }
    return body;
  }

  // --------------------------------------------------------------------------
  // Replays: per-player demo metadata + ghost trajectories ------------------
  // One row per (player, map) = that player's fastest recorded run; the map WR
  // is the fastest of them. The demo is a pointer to a .wd on the game host;
  // the ghost's trajectory bytes are gzipped JSON on local disk, one file per
  // (map, player) at GHOST_DIR/<mapId>/<playerId>.json.gz.
  _ghostPath(mapId, playerId) {
    return path.join(GHOST_DIR, String(mapId), `${playerId}.json.gz`);
  }

  // Resolve version + map + player ids inside a transaction (reusing the same
  // atomic get-or-create the ingest path uses), then run `fn(client, ids)`.
  async _withReplayIds({ version, map, name, login = "" }, fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q1 = async (sql, params) => (await client.query(sql, params)).rows[0];
      const versionRow = await q1(
        `INSERT INTO version (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [version]
      );
      const mapRow = await q1(
        `INSERT INTO map (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [map]
      );
      // Replays are keyed per CANONICAL player (aliases are one person, and the
      // `best`/leaderboard tables key on the canonical id), so resolve the raw
      // (name, login) id to its representative before storing.
      const rawPlayerId = await this._resolvePlayer(client, { name, login });
      const cRow = (await client.query("SELECT canonical_id FROM player WHERE id = $1", [rawPlayerId])).rows[0];
      const playerId = cRow && cRow.canonical_id != null ? num(cRow.canonical_id) : rawPlayerId;
      const out = await fn(client, {
        versionId: num(versionRow.id),
        mapId: num(mapRow.id),
        playerId,
      });
      await client.query("COMMIT");
      this.versions[num(versionRow.id)] = version;
      return out;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Record (or replace) this player's downloadable demo for a map — one row per
  // (player, map). Only overwrites with an equal-or-faster time, so a stale or
  // duplicate report can't bump a genuine PB's demo.
  async upsertPlayerDemo({ version, map, name, login = "", time, demoPath, bytes = null, serverId = null }) {
    return this._withReplayIds({ version, map, name, login }, async (client, ids) => {
      await client.query(
        `INSERT INTO player_demo (map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (map_id, player_id) DO UPDATE SET
           version_id = EXCLUDED.version_id, time = EXCLUDED.time, demo_path = EXCLUDED.demo_path,
           bytes = EXCLUDED.bytes, server_id = EXCLUDED.server_id, captured_at = EXCLUDED.captured_at
         WHERE EXCLUDED.time <= player_demo.time`,
        [ids.mapId, ids.playerId, ids.versionId, time, demoPath, bytes, serverId, Math.floor(Date.now() / 1000)]
      );
      return true;
    });
  }

  // Store this player's ghost trajectory for a map (one per (player, map)): gzip
  // the canonical JSON to GHOST_DIR/<mapId>/<playerId>.json.gz and upsert the
  // metadata. Faster-only guard, the row locked FOR UPDATE so a concurrent
  // slower upload never overwrites a faster file; the file is written only when
  // we actually take the row.
  async upsertPlayerGhost({ version, map, name, login = "", time, hz, frames, cps = [], serverId = null }) {
    return this._withReplayIds({ version, map, name, login }, async (client, ids) => {
      const existing = (await client.query(
        "SELECT time FROM player_ghost WHERE map_id = $1 AND player_id = $2 FOR UPDATE",
        [ids.mapId, ids.playerId]
      )).rows[0];
      if (existing && existing.time <= time) return false;

      const payload = { v: 1, map, player: name, login, time, hz, cps, frames };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
      const file = this._ghostPath(ids.mapId, ids.playerId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, gz);

      await client.query(
        `INSERT INTO player_ghost (map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (map_id, player_id) DO UPDATE SET
           version_id = EXCLUDED.version_id, time = EXCLUDED.time, hz = EXCLUDED.hz,
           frames = EXCLUDED.frames, bytes = EXCLUDED.bytes, server_id = EXCLUDED.server_id,
           captured_at = EXCLUDED.captured_at`,
        [ids.mapId, ids.playerId, ids.versionId, time, hz, frames.length, gz.length, serverId, Math.floor(Date.now() / 1000)]
      );
      return true;
    });
  }

  // Raw gzipped ghost JSON for a (map, player), served with Content-Encoding:
  // gzip to the browser viewer. playerId omitted => the map's fastest recorded
  // ghost (the WR replay). null if there is no such ghost / the file is missing.
  async ghostGzip(mapId, playerId = null) {
    let pid = playerId;
    if (pid == null) {
      const row = await this.one(
        "SELECT player_id FROM player_ghost WHERE map_id = $1 ORDER BY time ASC LIMIT 1",
        [mapId]
      );
      if (!row) return null;
      pid = num(row.player_id);
    } else if (!(await this.one("SELECT 1 FROM player_ghost WHERE map_id = $1 AND player_id = $2", [mapId, pid]))) {
      return null;
    }
    try {
      return fs.readFileSync(this._ghostPath(mapId, pid));
    } catch {
      return null; // row without a file (e.g. volume reset): treat as absent
    }
  }

  // One-time, idempotent migration of legacy one-per-map ghost files
  // (GHOST_DIR/<mapId>.json.gz) to the per-player layout
  // (GHOST_DIR/<mapId>/<playerId>.json.gz). Cheap no-op once done: it early-outs
  // when no top-level legacy files remain. Each legacy file maps to the single
  // player_ghost row backfilled from the old `ghost` table (the map's fastest).
  async _relayoutGhostFiles() {
    let legacy;
    try {
      legacy = fs.readdirSync(GHOST_DIR).filter((f) => /^\d+\.json\.gz$/.test(f));
    } catch {
      return; // GHOST_DIR not created yet — nothing to move
    }
    if (!legacy.length) return;
    let moved = 0;
    for (const f of legacy) {
      const mapId = parseInt(f, 10);
      const src = path.join(GHOST_DIR, f);
      const row = await this.one(
        "SELECT player_id FROM player_ghost WHERE map_id = $1 ORDER BY time ASC LIMIT 1",
        [mapId]
      );
      if (!row) continue; // no metadata: leave the orphan in place
      const dest = this._ghostPath(mapId, num(row.player_id));
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(src);
        else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(src, dest);
          moved++;
        }
      } catch { /* best-effort */ }
    }
    if (moved) console.log(`Relaid out ${moved} legacy ghost file(s) to per-player paths`);
  }

  // Flat-text ghost for the game server's RS_ApiFetchGhost native (AngelScript
  // can't parse gzip+JSON). Layout, parsed by hrace/ghostbot.as:
  //   line 1: RSGHOST <v> <hz> <time> <frameCount>
  //   line 2: <holder name> (raw, may contain spaces / ^colour codes)
  //   line 3: <cp frame indices, space-separated, possibly empty>
  //   then one line per frame: x y z pitch yaw roll vx vy vz
  async gameGhostText(mapName) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return null;
    const map = await this.one("SELECT id FROM map WHERE name = $1", [name]);
    if (!map) return null;
    const buf = await this.ghostGzip(num(map.id));
    if (!buf) return null;
    let g;
    try {
      g = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
    } catch {
      return null;
    }
    const frames = Array.isArray(g.frames) ? g.frames : [];
    const cleanName = String(g.player || "").replace(/[\r\n\t]/g, "").slice(0, 64);
    let body = `RSGHOST 1 ${g.hz | 0} ${g.time | 0} ${frames.length}\n`;
    body += cleanName + "\n";
    body += (Array.isArray(g.cps) ? g.cps.map((n) => n | 0).join(" ") : "") + "\n";
    for (const f of frames) {
      // 9 numbers, fixed order; trailing-space-free, one frame per line.
      body += f.map((v) => (Math.round(Number(v) * 1000) / 1000)).join(" ") + "\n";
    }
    return body;
  }

  async maps({ q = "", sort = "records", order, limit, offset } = {}) {
    const col = MAP_SORTS[sort] || MAP_SORTS.records;
    const direction = dir(order, sort === "name" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    const where = q ? "WHERE mi.name ILIKE $1" : "";
    const args = q ? [`%${likeEscape(q)}%`] : [];
    const total = num((await this.one(`SELECT COUNT(*) c FROM map_index mi ${where}`, args)).c);
    const rows = (
      await this.all(
        `SELECT mi.map_id AS id, mi.name, mi.records, mi.finishes, mi.players, mi.wr_time,
                mi.wr_pid, mi.wr_version, p.name AS wr_name, p.simplified AS wr_simplified
         FROM map_index mi
         LEFT JOIN player p ON p.id = mi.wr_pid
         ${where}
         ORDER BY ${col} ${direction} NULLS LAST, lower(mi.name) ASC
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, lim, off]
      )
    ).map((r) => ({
      ...r,
      id: num(r.id),
      wr_pid: num(r.wr_pid),
      wr_version: num(r.wr_version),
      races: r.records,
      wr_version_name: this.versions[num(r.wr_version)] || null,
    }));
    return { total, limit: lim, offset: off, rows };
  }

  async mapDetail(id, { limit } = {}) {
    const map = await this.one("SELECT id, name FROM map WHERE id = $1", [id]);
    if (!map) return null;
    const idx = await this.one("SELECT * FROM map_index WHERE map_id = $1", [id]);
    const lim = clampLimit(limit, 50, 10000);

    const leaderboard = (
      await this.all(
        `SELECT b.player_id, b.time, b.rank AS global_rank,
                p.name, p.simplified,
                (SELECT r.version_id FROM race r
                   JOIN player pv ON pv.id = r.player_id
                   WHERE r.map_id = b.map_id AND pv.canonical_id = b.player_id
                   ORDER BY r.time LIMIT 1) AS version
         FROM best b JOIN player p ON p.id = b.player_id
         WHERE b.map_id = $1
         ORDER BY b.time ASC, b.player_id ASC LIMIT $2`,
        [id, lim]
      )
    ).map((r, i) => ({
      pos: i + 1,
      playerId: num(r.player_id),
      name: r.name,
      simplified: r.simplified,
      time: r.time,
      globalRank: r.global_rank,
      version: num(r.version),
      versionName: this.versions[num(r.version)] || null,
    }));

    // Per-player demo/ghost links for the leaderboard rows (one PB per player
    // per map). A row only gets links if that player has a captured replay.
    if (leaderboard.length) {
      const pids = leaderboard.map((r) => r.playerId);
      const demoByPid = new Map();
      for (const d of await this.all(
        "SELECT player_id, time, demo_path, bytes FROM player_demo WHERE map_id = $1 AND player_id = ANY($2)",
        [id, pids]
      )) demoByPid.set(num(d.player_id), d);
      const ghostByPid = new Map();
      for (const g of await this.all(
        "SELECT player_id, time, hz, frames FROM player_ghost WHERE map_id = $1 AND player_id = ANY($2)",
        [id, pids]
      )) ghostByPid.set(num(g.player_id), g);
      for (const row of leaderboard) {
        const d = demoByPid.get(row.playerId);
        if (d)
          row.demo = {
            url: DEMO_BASE_URL ? `${DEMO_BASE_URL}/demos/${d.demo_path}` : null,
            path: d.demo_path,
            bytes: num(d.bytes),
            time: d.time,
          };
        const g = ghostByPid.get(row.playerId);
        if (g) row.ghost = { url: `/api/maps/${id}/ghost?player=${row.playerId}`, hz: g.hz, frames: g.frames, time: g.time };
      }
    }

    let wr = null;
    if (idx && idx.wr_race_id != null) {
      const splits = (
        await this.all("SELECT time FROM checkpoint WHERE race_id = $1 AND time > 0 ORDER BY time ASC", [
          idx.wr_race_id,
        ])
      ).map((r) => r.time);
      const holder = await this.one("SELECT name, simplified FROM player WHERE id = $1", [idx.wr_pid]);
      wr = {
        time: idx.wr_time,
        raceId: num(idx.wr_race_id),
        playerId: num(idx.wr_pid),
        name: holder ? holder.name : "?",
        simplified: holder ? holder.simplified : "?",
        version: num(idx.wr_version),
        versionName: this.versions[num(idx.wr_version)] || null,
        splits,
      };

      // Best-captured replay for this map: the fastest recorded demo/ghost
      // across all players (one PB per player per map, faster-only upsert).
      // That run may pre-date or lag the absolute WR (e.g. the #1 was set before
      // the replay feature, or on a server that didn't capture it). Surface it
      // anyway — a replay of the fastest recorded run beats no replay — carrying
      // its OWN time/holder, with isWr telling the UI whether it's the outright
      // record so it can label a slower replay honestly.
      const demo = await this.one(
        `SELECT d.time, d.demo_path, d.bytes, p.name AS holder, p.simplified AS holder_s
         FROM player_demo d JOIN player p ON p.id = d.player_id
         WHERE d.map_id = $1 ORDER BY d.time ASC LIMIT 1`,
        [id]
      );
      if (demo) {
        wr.demo = {
          url: DEMO_BASE_URL ? `${DEMO_BASE_URL}/demos/${demo.demo_path}` : null,
          path: demo.demo_path,
          bytes: num(demo.bytes),
          time: demo.time,
          holder: demo.holder,
          holderSimplified: demo.holder_s,
          isWr: demo.time === idx.wr_time,
        };
      }
      const g = await this.one(
        `SELECT g.player_id, g.time, g.hz, g.frames, p.name AS holder, p.simplified AS holder_s
         FROM player_ghost g JOIN player p ON p.id = g.player_id
         WHERE g.map_id = $1 ORDER BY g.time ASC LIMIT 1`,
        [id]
      );
      if (g) {
        wr.ghost = {
          // No ?player => ghostGzip serves the fastest (this) ghost.
          url: `/api/maps/${num(map.id)}/ghost`,
          playerId: num(g.player_id),
          hz: g.hz,
          frames: g.frames,
          time: g.time,
          holder: g.holder,
          holderSimplified: g.holder_s,
          isWr: g.time === idx.wr_time,
        };
      }
    }

    return {
      id: num(map.id),
      name: map.name,
      records: idx ? idx.records : 0,
      races: idx ? idx.records : 0, // legacy alias
      finishes: idx ? idx.finishes : 0,
      players: idx ? idx.players : leaderboard.length,
      wr,
      perfect: await this.perfectRun(num(map.id), wr),
      leaderboard,
    };
  }

  // Sum-of-best-splits (see the SQLite-era comments). The heavy lifting stays
  // in JS for exact behavioural parity; bounded to the fastest 20000 races.
  // Cached per map with a TTL: the handling instance clears the entry on
  // ingest, but with multiple replicas the OTHERS only converge via this TTL
  // (a perfect run changes rarely, so a few minutes of staleness is fine).
  async perfectRun(mapId, wr) {
    const hit = this._perfectRunCache.get(mapId);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = await this._computePerfectRun(mapId, wr);
    if (this._perfectRunCache.size >= 2048) this._perfectRunCache.clear();
    this._perfectRunCache.set(mapId, { value, exp: Date.now() + 5 * 60 * 1000 });
    return value;
  }

  async _computePerfectRun(mapId, wr) {
    const races = await this.all(
      "SELECT id, player_id, time FROM race WHERE map_id = $1 ORDER BY time ASC LIMIT 20000",
      [mapId]
    );
    if (!races.length) return null;
    const finishById = new Map(races.map((r) => [num(r.id), { ...r, id: num(r.id) }]));

    const cps = await this.all(
      `SELECT race_id, number, time FROM checkpoint
       WHERE race_id IN (SELECT id FROM race WHERE map_id = $1 ORDER BY time ASC LIMIT 20000)
         AND time > 0
       ORDER BY race_id, number`,
      [mapId]
    );
    const perRace = new Map();
    let maxNum = -1;
    for (const c of cps) {
      const rid = num(c.race_id);
      if (!perRace.has(rid)) perRace.set(rid, []);
      perRace.get(rid)[c.number] = c.time;
      if (c.number > maxNum) maxNum = c.number;
    }
    if (maxNum < 0) return null;

    const segCount = maxNum + 2;
    const best = new Array(segCount).fill(null);
    for (const [raceId, arr] of perRace) {
      const race = finishById.get(raceId);
      let prev = 0;
      let prevOk = true;
      for (let n = 0; n <= maxNum; n++) {
        const t = arr[n];
        if (t == null || t <= 0) {
          prevOk = false;
          prev = null;
          continue;
        }
        if (prevOk && prev != null) {
          const delta = t - prev;
          if (delta > 0 && (best[n] == null || delta < best[n].delta)) best[n] = { delta, raceId };
        }
        prev = t;
        prevOk = true;
      }
      if (prevOk && prev != null && race && race.time > prev) {
        const delta = race.time - prev;
        const fi = maxNum + 1;
        if (best[fi] == null || delta < best[fi].delta) best[fi] = { delta, raceId };
      }
    }

    const involved = [...new Set(best.filter(Boolean).map((b) => b.raceId))];
    const owner = new Map();
    if (involved.length) {
      const rows = await this.all(
        `SELECT r.id, disp.name, disp.simplified
         FROM race r
         JOIN player pl ON pl.id = r.player_id
         JOIN player disp ON disp.id = pl.canonical_id
         WHERE r.id = ANY($1)`,
        [involved]
      );
      for (const r of rows) owner.set(num(r.id), { name: r.name, simplified: r.simplified });
    }

    let total = 0;
    let complete = true;
    let absolute = 0;
    const segments = best.map((b, i) => {
      if (!b) {
        complete = false;
        return { seg: i, delta: null, cumulative: null, name: null };
      }
      total += b.delta;
      absolute += b.delta;
      const o = owner.get(b.raceId) || {};
      return { seg: i, delta: b.delta, cumulative: absolute, name: o.name || null, simplified: o.simplified || null };
    });

    const wrTime = wr ? wr.time : null;
    return {
      time: complete ? total : null,
      complete,
      segments,
      savingVsWr: complete && wrTime != null ? wrTime - total : null,
    };
  }

  async players({ q = "", sort = "points", order, limit, offset } = {}) {
    const col = PLAYER_SORTS[sort] || PLAYER_SORTS.points;
    const direction = dir(order, sort === "name" || sort === "rank" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    // Match a search against ANY name variant (trgm-indexed), then map to its
    // canonical row.
    const where = q
      ? `WHERE s.player_id IN (
           SELECT canonical_id FROM player
           WHERE name ILIKE $1 OR simplified ILIKE $1 OR trimmed ILIKE $1
         )`
      : "";
    const args = q ? [`%${likeEscape(q)}%`] : [];
    const total = num(
      (await this.one(`SELECT COUNT(*) c FROM standings s JOIN player p ON p.id = s.player_id ${where}`, args)).c
    );
    const rows = (
      await this.all(
        `SELECT s.rank, s.player_id AS id, p.name, p.simplified, p.login,
                s.points, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ${where}
         ORDER BY ${col} ${direction}, s.rank ASC
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, lim, off]
      )
    ).map((r) => ({ ...r, rank: num(r.rank), id: num(r.id) }));
    return { total, limit: lim, offset: off, rows };
  }

  async playerDetail(id, { sort = "time", order, limit, offset } = {}) {
    // Resolve any variant id to its canonical representative.
    let canonId = id;
    const c = await this.one("SELECT canonical_id FROM player WHERE id = $1", [id]);
    if (c && c.canonical_id != null) canonId = num(c.canonical_id);
    const player = await this.one("SELECT id, name, simplified, login FROM player WHERE id = $1", [canonId]);
    if (!player) return null;

    const aliases = await this.all(
      "SELECT DISTINCT name, simplified FROM player WHERE canonical_id = $1 AND id <> $1 ORDER BY name",
      [canonId]
    );

    const standing = (await this.one(
      "SELECT rank, points, wr, podium, maps FROM standings WHERE player_id = $1",
      [canonId]
    )) || { rank: null, points: 0, wr: 0, podium: 0, maps: 0 };
    if (standing.rank != null) standing.rank = num(standing.rank);

    const groupWhere = "player_id IN (SELECT id FROM player WHERE canonical_id = $1)";
    const finishes = num(
      (await this.one(`SELECT COALESCE(SUM(finishes),0) c FROM run_tally WHERE ${groupWhere}`, [canonId])).c
    );
    // Read-time floor at the finish count (rows written before attempt
    // tracking undercount attempts).
    const attempts = Math.max(
      num((await this.one(`SELECT COALESCE(SUM(attempts),0) c FROM run_tally WHERE ${groupWhere}`, [canonId])).c),
      finishes || 0
    );

    const col = RECORD_SORTS[sort] || RECORD_SORTS.time;
    const direction = dir(order, "ASC");
    const lim = clampLimit(limit, 50, 500);
    const off = toOffset(offset);
    const total = num((await this.one("SELECT COUNT(*) c FROM best WHERE player_id = $1", [canonId])).c);
    const records = (
      await this.all(
        `SELECT b.map_id, m.name AS map_name, b.time, b.rank,
                GREATEST(COALESCE(t.attempts, 0), COALESCE(t.finishes, 0))::int AS attempts,
                COALESCE(t.finishes, 0)::int AS finishes
         FROM best b JOIN map m ON m.id = b.map_id
         LEFT JOIN (
           SELECT map_id, SUM(attempts) attempts, SUM(finishes) finishes
           FROM run_tally WHERE ${groupWhere} GROUP BY map_id
         ) t ON t.map_id = b.map_id
         WHERE b.player_id = $1
         ORDER BY ${col} ${direction}, b.time ASC, b.map_id ASC
         LIMIT $2 OFFSET $3`,
        [canonId, lim, off]
      )
    ).map((r) => ({ ...r, map_id: num(r.map_id) }));

    // This player's demo + browser-replay link per finished map (one PB each).
    if (records.length) {
      const mids = records.map((r) => r.map_id);
      const demoByMap = new Map();
      for (const d of await this.all(
        "SELECT map_id, time, demo_path, bytes FROM player_demo WHERE player_id = $1 AND map_id = ANY($2)",
        [canonId, mids]
      )) demoByMap.set(num(d.map_id), d);
      const ghostByMap = new Map();
      for (const g of await this.all(
        "SELECT map_id, time, hz, frames FROM player_ghost WHERE player_id = $1 AND map_id = ANY($2)",
        [canonId, mids]
      )) ghostByMap.set(num(g.map_id), g);
      for (const row of records) {
        const d = demoByMap.get(row.map_id);
        if (d)
          row.demo = {
            url: DEMO_BASE_URL ? `${DEMO_BASE_URL}/demos/${d.demo_path}` : null,
            path: d.demo_path,
            bytes: num(d.bytes),
            time: d.time,
          };
        const g = ghostByMap.get(row.map_id);
        if (g) row.ghost = { url: `/api/maps/${row.map_id}/ghost?player=${canonId}`, hz: g.hz, frames: g.frames, time: g.time };
      }
    }

    return {
      id: num(player.id),
      name: player.name,
      simplified: player.simplified,
      login: player.login,
      aliases,
      standing,
      finishes,
      attempts,
      records: { total, limit: lim, offset: off, rows: records },
    };
  }

  // Tiered, typo-tolerant search over maps and players (pg_trgm):
  // exact match > prefix > substring > trigram-similar, then popularity.
  async search(q, { limit = 8 } = {}) {
    if (!q) return { maps: [], players: [] };
    const esc = likeEscape(q);
    const maps = (
      await this.all(
        `SELECT map_id id, name, records, finishes,
                GREATEST(
                  CASE WHEN lower(name) = lower($1) THEN 1.0 ELSE 0 END,
                  CASE WHEN name ILIKE $2 || '%' THEN 0.8 ELSE 0 END,
                  CASE WHEN name ILIKE '%' || $2 || '%' THEN 0.55 ELSE 0 END,
                  similarity(name, $1)
                ) AS score
         FROM map_index
         WHERE name ILIKE '%' || $2 || '%' OR name % $1
         ORDER BY score DESC, records DESC
         LIMIT $3`,
        [q, esc, limit]
      )
    ).map((m) => ({ id: num(m.id), name: m.name, records: m.records, finishes: m.finishes, races: m.records }));

    const players = (
      await this.all(
        `WITH hits AS (
           SELECT p.canonical_id cid,
                  MAX(GREATEST(
                    CASE WHEN lower(p.simplified) = lower($1) OR lower(p.name) = lower($1) THEN 1.0 ELSE 0 END,
                    CASE WHEN p.simplified ILIKE $2 || '%' THEN 0.8 ELSE 0 END,
                    CASE WHEN p.name ILIKE '%' || $2 || '%'
                           OR p.simplified ILIKE '%' || $2 || '%'
                           OR p.trimmed ILIKE '%' || $2 || '%' THEN 0.55 ELSE 0 END,
                    similarity(p.simplified, $1),
                    similarity(p.trimmed, $1)
                  )) AS score
           FROM player p
           WHERE p.name ILIKE '%' || $2 || '%'
              OR p.simplified ILIKE '%' || $2 || '%'
              OR p.trimmed ILIKE '%' || $2 || '%'
              OR p.simplified % $1
              OR p.trimmed % $1
           GROUP BY p.canonical_id
         )
         SELECT s.player_id id, p.name, p.simplified, s.rank, s.points, h.score
         FROM hits h
         JOIN standings s ON s.player_id = h.cid
         JOIN player p ON p.id = s.player_id
         ORDER BY h.score DESC, s.points DESC
         LIMIT $3`,
        [q, esc, limit]
      )
    ).map((r) => ({ id: num(r.id), name: r.name, simplified: r.simplified, rank: num(r.rank), points: r.points }));
    return { maps, players };
  }

  // Rebuild the aggregate tables after ingested rows change the underlying
  // data. Runs in one transaction; readers keep the old tables until commit.
  //
  // The aggregate tables (best/standings/map_index) are SHARED Postgres
  // tables, so multiple web replicas (see the rolling-deploy setup) could try
  // to rebuild them at once — the DROP/RENAME swap would then conflict. A
  // transaction-scoped advisory lock serialises rebuilds across all replicas:
  // a second rebuilder waits for the first to commit, then runs on fresh
  // data. Readers are unaffected (they never take this lock).
  async refreshAggregates() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727411001)"); // arbitrary fixed key
      await buildAggregates(client);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------------
  // Server enrollment / auth (multi-server)
  // ------------------------------------------------------------------------
  async enrollServer(name, token) {
    const hash = sha256(token);
    const r = await this.one(
      "INSERT INTO server (name, token_hash, created_at) VALUES ($1, $2, $3) RETURNING id",
      [name, hash, Math.floor(Date.now() / 1000)]
    );
    return { id: num(r.id), name };
  }
  async serverByTokenHash(hash) {
    const row = await this.one("SELECT id, name, status FROM server WHERE token_hash = $1", [hash]);
    return row ? { ...row, id: num(row.id) } : undefined;
  }
  async touchServer(id, records = 0) {
    await this.pool.query("UPDATE server SET last_seen_at = $1, records = records + $2 WHERE id = $3", [
      Math.floor(Date.now() / 1000),
      records,
      id,
    ]);
  }

  // ------------------------------------------------------------------------
  // Key/value config (maintenance state, counters). The `config` table is a
  // plain string store; these wrap the read/upsert/delete so call sites don't
  // repeat the ON CONFLICT dance.
  // ------------------------------------------------------------------------
  async getConfig(key) {
    const row = await this.one("SELECT value FROM config WHERE key = $1", [key]);
    return row ? row.value : null;
  }
  async setConfig(key, value) {
    if (value == null) {
      await this.pool.query("DELETE FROM config WHERE key = $1", [key]);
      return;
    }
    await this.pool.query(
      "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, String(value)]
    );
  }

  // Maintenance-mode state (persisted in config so both web replicas agree and
  // it survives restarts). Returns a normalized snapshot.
  async maintenanceState() {
    const rows = await this.all(
      `SELECT key, value FROM config
       WHERE key IN ('maintenance_active','maintenance_since','maintenance_message','maintenance_by')`
    );
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    return {
      active: m.maintenance_active === "1",
      since: m.maintenance_since ? num(m.maintenance_since) : null,
      message: m.maintenance_message || null,
      by: m.maintenance_by || null,
    };
  }

  // Atomically claim the next maintenance re-broadcast so that, with multiple
  // web replicas running the same timer, exactly ONE of them sends each round.
  // Advances maintenance_rebroadcast_at to now+intervalSecs only if it is due;
  // returns true to the single caller whose UPDATE won the row.
  async claimMaintenanceRebroadcast(now, intervalSecs) {
    const r = await this.pool.query(
      `UPDATE config SET value = $1
         WHERE key = 'maintenance_rebroadcast_at'
           AND value ~ '^[0-9]+$'
           AND value::bigint <= $2`,
      [String(now + intervalSecs), now]
    );
    return r.rowCount > 0;
  }

  // ------------------------------------------------------------------------
  // Operator log stream (server_log) — see the migration. appendServerLog takes
  // pre-sanitized rows; the HTTP/console callers cap line length + batch size.
  // ------------------------------------------------------------------------
  async appendServerLog(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0;
    const now = Math.floor(Date.now() / 1000);
    const vals = [];
    const params = [];
    let i = 1;
    for (const e of entries) {
      const line = typeof e.line === "string" ? e.line : String(e.line ?? "");
      if (!line) continue;
      vals.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(
        e.serverId == null ? null : e.serverId,
        e.source || "system",
        e.level || null,
        line.slice(0, 2000),
        Number.isInteger(e.createdAt) ? e.createdAt : now
      );
    }
    if (!vals.length) return 0;
    await this.pool.query(
      `INSERT INTO server_log (server_id, source, level, line, created_at) VALUES ${vals.join(",")}`,
      params
    );
    return vals.length;
  }

  // Newest-first tail with optional server / source filters. `beforeId` pages
  // backwards through history (rows with id < beforeId).
  async recentServerLogs({ serverId = null, source = null, limit = 200, beforeId = null } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (serverId != null) {
      where.push(`server_id = $${i++}`);
      params.push(serverId);
    }
    if (source) {
      where.push(`source = $${i++}`);
      params.push(source);
    }
    if (beforeId != null) {
      where.push(`id < $${i++}`);
      params.push(beforeId);
    }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000);
    params.push(lim);
    const rows = await this.all(
      `SELECT l.id, l.server_id, l.source, l.level, l.line, l.created_at, s.name AS server_name
         FROM server_log l
         LEFT JOIN server s ON s.id = l.server_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY l.id DESC
         LIMIT $${i}`,
      params
    );
    return rows.map((r) => ({
      id: num(r.id),
      serverId: r.server_id == null ? null : num(r.server_id),
      serverName: r.server_name || null,
      source: r.source,
      level: r.level,
      line: r.line,
      createdAt: num(r.created_at),
    }));
  }

  // Keep only the newest `keep` rows. Cheap and index-backed; run occasionally
  // (server.js) rather than on every insert.
  async pruneServerLogs(keep = 20000) {
    // Delete everything up to and including the (keep+1)-th newest row: the row
    // at 0-indexed OFFSET keep is the newest one to drop, so `id <=` it removes
    // exactly the excess and keeps the newest `keep`. Fewer than keep rows ->
    // the subselect is NULL and nothing is deleted.
    const r = await this.pool.query(
      `DELETE FROM server_log
        WHERE id <= (SELECT id FROM server_log ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [keep]
    );
    return r.rowCount;
  }

  // --- Map review flags ------------------------------------------------------
  // A public "flag this map for review" report. Deduped per reporter via the
  // partial unique index (uq_map_flag_open): a repeat OPEN flag for the same
  // map+reason+reporter is a no-op. Returns whether a NEW row was created so the
  // API can answer "reported" vs "already reported" without leaking counts.
  async flagMap({ mapId, reason, note, reporterHash, reporterName, now = Math.floor(Date.now() / 1000) }) {
    // One atomic statement: the map_id foreign key IS the existence check, so a
    // 23503 (FK violation) means "no such map" — no separate SELECT (which would
    // be a TOCTOU race against a concurrent map delete, and an extra round-trip).
    try {
      const r = await this.pool.query(
        `INSERT INTO map_flag (map_id, reason, note, reporter_hash, reporter_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (map_id, reason, reporter_hash) WHERE status = 'open' DO NOTHING
         RETURNING id`,
        [mapId, reason, note || null, reporterHash || null, reporterName || null, now]
      );
      return { ok: true, created: r.rowCount > 0, duplicate: r.rowCount === 0 };
    } catch (e) {
      if (e && e.code === "23503") return { ok: false, error: "map not found" };
      throw e;
    }
  }

  // Open flags grouped by map for the admin queue: total open count, a
  // per-reason breakdown, the most recent note and the last report time. The
  // moderation queue is small, so a flat SELECT + JS grouping is clearer (and
  // plenty fast) versus a window/jsonb aggregate.
  async openFlagSummary() {
    const rows = await this.all(
      `SELECT f.map_id, m.name, f.reason, f.note, f.reporter_name, f.created_at
       FROM map_flag f JOIN map m ON m.id = f.map_id
       WHERE f.status = 'open'
       ORDER BY f.created_at DESC`
    );
    const byMap = new Map();
    for (const r of rows) {
      const id = num(r.map_id);
      let e = byMap.get(id);
      if (!e) {
        e = { mapId: id, name: r.name, openCount: 0, reasons: {}, latestNote: null, latestReporter: null, firstAt: r.created_at, lastAt: r.created_at };
        byMap.set(id, e);
      }
      e.openCount++;
      e.reasons[r.reason] = (e.reasons[r.reason] || 0) + 1;
      if (r.note && !e.latestNote) e.latestNote = r.note; // rows are newest-first
      if (r.reporter_name && !e.latestReporter) e.latestReporter = r.reporter_name;
      if (r.created_at > e.lastAt) e.lastAt = r.created_at;
      if (r.created_at < e.firstAt) e.firstAt = r.created_at;
    }
    return [...byMap.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  // All flags for one map (any status), newest first — the admin map detail.
  async flagsForMap(mapId) {
    return (
      await this.all(
        `SELECT id, reason, note, status, reporter_name, created_at, resolved_at, resolved_by
         FROM map_flag WHERE map_id = $1 ORDER BY created_at DESC`,
        [mapId]
      )
    ).map((r) => ({ ...r, id: num(r.id) }));
  }

  async flagById(id) {
    const r = await this.one(
      "SELECT id, map_id, reason, note, status, created_at, resolved_at, resolved_by FROM map_flag WHERE id = $1",
      [id]
    );
    return r ? { ...r, id: num(r.id), map_id: num(r.map_id) } : null;
  }

  // Flat list for the CLI / API, filtered by status ("open" | "resolved" |
  // "dismissed" | "all"). Bounded so a huge history can't be dumped at once.
  async listFlags({ status = "open", limit = 200 } = {}) {
    const lim = Math.max(1, Math.min(1000, parseInt(limit, 10) || 200));
    const base = `SELECT f.id, f.map_id, m.name, f.reason, f.note, f.status, f.reporter_name, f.created_at, f.resolved_at, f.resolved_by
                  FROM map_flag f JOIN map m ON m.id = f.map_id`;
    const rows =
      status === "all"
        ? await this.all(`${base} ORDER BY f.created_at DESC LIMIT $1`, [lim])
        : await this.all(`${base} WHERE f.status = $1 ORDER BY f.created_at DESC LIMIT $2`, [status, lim]);
    return rows.map((r) => ({ ...r, id: num(r.id), map_id: num(r.map_id) }));
  }

  // Close a single OPEN flag (status must be 'resolved' or 'dismissed'). The
  // status='open' guard makes this idempotent and keeps resolved_by/at truthful.
  async setFlagStatus(id, status, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      `UPDATE map_flag SET status = $1, resolved_at = $2, resolved_by = $3
       WHERE id = $4 AND status = 'open'`,
      [status, now, by || null, id]
    );
    return r.rowCount;
  }

  // Close ALL open flags on a map at once ("handled this map"). Returns count.
  async resolveMapFlags(mapId, status, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      `UPDATE map_flag SET status = $1, resolved_at = $2, resolved_by = $3
       WHERE map_id = $4 AND status = 'open'`,
      [status, now, by || null, mapId]
    );
    return r.rowCount;
  }

  // --- Map blocking (remove from play) ---------------------------------------
  // Pull a map from the game servers' vote pool + cycle. An explicit moderator
  // action (never automatic from a flag). Blocking also resolves the map's open
  // flags — the report has been actioned. Idempotent (re-block updates reason).
  // Returns { ok:false } if the map id doesn't exist (FK violation).
  async blockMap(mapId, reason, by, now = Math.floor(Date.now() / 1000)) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO map_block (map_id, reason, blocked_at, blocked_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (map_id) DO UPDATE SET reason = EXCLUDED.reason, blocked_at = EXCLUDED.blocked_at, blocked_by = EXCLUDED.blocked_by`,
        [mapId, reason || null, now, by || null]
      );
      const flags = await client.query(
        `UPDATE map_flag SET status = 'resolved', resolved_at = $1, resolved_by = $2
         WHERE map_id = $3 AND status = 'open'`,
        [now, by || null, mapId]
      );
      await client.query("COMMIT");
      return { ok: true, resolvedFlags: flags.rowCount };
    } catch (e) {
      await client.query("ROLLBACK");
      if (e && e.code === "23503") return { ok: false, error: "map not found" };
      throw e;
    } finally {
      client.release();
    }
  }
  async unblockMap(mapId) {
    const r = await this.pool.query("DELETE FROM map_block WHERE map_id = $1", [mapId]);
    return r.rowCount;
  }
  async isMapBlocked(mapId) {
    return !!(await this.one("SELECT 1 FROM map_block WHERE map_id = $1", [mapId]));
  }
  // Blocked maps with names, for the admin UI / CLI (newest block first).
  async blockedMaps() {
    return (
      await this.all(
        `SELECT b.map_id, m.name, b.reason, b.blocked_at, b.blocked_by
         FROM map_block b JOIN map m ON m.id = b.map_id
         ORDER BY b.blocked_at DESC`
      )
    ).map((r) => ({ ...r, map_id: num(r.map_id) }));
  }
  // Just the (lowercased) map names, for the game servers' plain-text endpoint
  // that server/entrypoint.sh consumes when building g_maplist.
  async blockedMapNames() {
    return (await this.all("SELECT m.name FROM map_block b JOIN map m ON m.id = b.map_id ORDER BY m.name")).map(
      (r) => String(r.name).toLowerCase()
    );
  }

  // --- Admin accounts + sessions ---------------------------------------------
  // Accounts are created out-of-band (admin.js admin-add); there is no public
  // sign-up. Returns null if the username is already taken.
  async createAdmin(username, passwordHash, now = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      `INSERT INTO admin_user (username, password_hash, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, passwordHash, now]
    );
    return r ? { id: num(r.id), username } : null;
  }
  async getAdminByUsername(username) {
    const r = await this.one(
      "SELECT id, username, password_hash, last_login_at FROM admin_user WHERE username = $1",
      [username]
    );
    return r ? { ...r, id: num(r.id) } : null;
  }
  async listAdmins() {
    return (
      await this.all("SELECT id, username, created_at, last_login_at FROM admin_user ORDER BY username ASC")
    ).map((r) => ({ ...r, id: num(r.id) }));
  }
  async countAdmins() {
    return num((await this.one("SELECT COUNT(*) c FROM admin_user")).c);
  }
  async removeAdmin(username) {
    const r = await this.pool.query("DELETE FROM admin_user WHERE username = $1", [username]);
    return r.rowCount; // admin_session rows cascade
  }
  async setAdminPassword(username, passwordHash) {
    const r = await this.pool.query("UPDATE admin_user SET password_hash = $1 WHERE username = $2", [
      passwordHash,
      username,
    ]);
    return r.rowCount;
  }
  async touchAdminLogin(id, now = Math.floor(Date.now() / 1000)) {
    await this.pool.query("UPDATE admin_user SET last_login_at = $1 WHERE id = $2", [now, id]);
  }

  async createSession({ tokenHash, adminId, csrf, expiresAt, ip, userAgent, now = Math.floor(Date.now() / 1000) }) {
    await this.pool.query(
      `INSERT INTO admin_session (token_hash, admin_id, csrf, created_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tokenHash, adminId, csrf, now, expiresAt, ip || null, userAgent ? String(userAgent).slice(0, 400) : null]
    );
  }
  // Live session by cookie-hash; an expired row is treated as absent AND deleted
  // so the table self-cleans on access. Returns { adminId, username, csrf } | null.
  async getSession(tokenHash, now = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      `SELECT s.admin_id, s.csrf, s.expires_at, a.username
       FROM admin_session s JOIN admin_user a ON a.id = s.admin_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    );
    if (!r) return null;
    if (num(r.expires_at) <= now) {
      await this.pool.query("DELETE FROM admin_session WHERE token_hash = $1", [tokenHash]);
      return null;
    }
    return { adminId: num(r.admin_id), username: r.username, csrf: r.csrf, expiresAt: num(r.expires_at) };
  }
  async deleteSession(tokenHash) {
    await this.pool.query("DELETE FROM admin_session WHERE token_hash = $1", [tokenHash]);
  }
  async deleteExpiredSessions(now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query("DELETE FROM admin_session WHERE expires_at <= $1", [now]);
    return r.rowCount;
  }

  // ------------------------------------------------------------------------
  // Ingest
  // ------------------------------------------------------------------------
  // Same contract as the SQLite layer (see git history for the long-form
  // comments): best-time upsert per player/map/version, improved records get
  // a strictly-higher id from the monotonic counter, racelog finishes bump
  // the run tally, rec.attempts / attempts[] bump the attempt tally. The
  // whole request runs in one transaction; the counter row is FOR UPDATE
  // locked, so concurrent ingests from many servers serialize only there.
  async ingest(opts) {
    // Retry the whole transaction on the conflicts that concurrent writers
    // from different servers can genuinely hit: unique violations (two
    // ingests racing to create the same new player/map/version, or to improve
    // the same PR) and serialization/deadlock failures. Each retry re-reads
    // committed state, so the loser of a race sees the winner's row on its
    // next pass instead of dropping the whole batch with a 500.
    const RETRYABLE = new Set(["23505", "40001", "40P01"]);
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      let retry = false;
      try {
        await client.query("BEGIN");
        const counts = await this._ingestTx(client, opts);
        await client.query("COMMIT");
        return counts;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
        if (RETRYABLE.has(e.code) && attempt < 5) retry = true;
        else throw e;
      } finally {
        client.release();
      }
      if (retry) await new Promise((r) => setTimeout(r, 10 * attempt));
    }
  }

  async _ingestTx(client, { version, map, records = [], attempts = [], source = "topscores", serverId = null }) {
    const tally = source === "racelog";
    const now = Math.floor(Date.now() / 1000);
    {
      const q1 = async (sql, params) => (await client.query(sql, params)).rows[0];

      // Atomic get-or-create: DO UPDATE (a no-op rewrite of the unique key)
      // forces RETURNING to yield the row even when a concurrent tx already
      // inserted it — a plain INSERT would raise a unique violation and abort.
      const versionRow = await q1(
        `INSERT INTO version (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [version]
      );
      this.versions[num(versionRow.id)] = version;
      const mapRow = await q1(
        `INSERT INTO map (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [map]
      );

      const counts = { inserted: 0, improved: 0, unchanged: 0 };

      const bumpAttempts = (playerId, count) =>
        client.query(
          `INSERT INTO run_tally (player_id, map_id, version_id, finishes, attempts)
           VALUES ($1, $2, $3, 0, $4)
           ON CONFLICT (player_id, map_id, version_id)
           DO UPDATE SET attempts = run_tally.attempts + EXCLUDED.attempts`,
          [playerId, mapRow.id, versionRow.id, count]
        );

      if (tally) {
        for (const a of attempts) {
          const playerId = await this._resolvePlayer(client, a);
          await bumpAttempts(playerId, a.count);
        }
      }

      for (const rec of records) {
        const playerId = await this._resolvePlayer(client, rec);

        if (tally) {
          await client.query(
            `INSERT INTO run_tally (player_id, map_id, version_id, finishes, last_finish)
             VALUES ($1, $2, $3, 1, $4)
             ON CONFLICT (player_id, map_id, version_id)
             DO UPDATE SET finishes = run_tally.finishes + 1, last_finish = $4`,
            [playerId, mapRow.id, versionRow.id, now]
          );
          await bumpAttempts(playerId, rec.attempts != null ? rec.attempts : 1);
        }

        const existing = await q1(
          "SELECT id, time FROM race WHERE player_id = $1 AND map_id = $2 AND version_id = $3",
          [playerId, mapRow.id, versionRow.id]
        );
        if (existing && existing.time <= rec.time) {
          counts.unchanged++;
          continue;
        }
        if (existing) {
          await client.query("DELETE FROM checkpoint WHERE race_id = $1", [existing.id]);
          await client.query("DELETE FROM race WHERE id = $1", [existing.id]);
        }
        const raceId = await this._nextRaceId(client);
        await client.query(
          `INSERT INTO race (id, version_id, player_id, map_id, time, server_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [raceId, versionRow.id, playerId, mapRow.id, rec.time, serverId, now]
        );
        for (let i = 0; i < rec.checkpoints.length; i++) {
          await client.query("INSERT INTO checkpoint (race_id, number, time) VALUES ($1, $2, $3)", [
            raceId,
            i,
            rec.checkpoints[i],
          ]);
        }
        counts[existing ? "improved" : "inserted"]++;
      }

      if (counts.inserted || counts.improved) {
        await client.query(
          `UPDATE race SET global_rank = ranked.gr, version_rank = ranked.vr
           FROM (
             SELECT id,
                    RANK() OVER (ORDER BY time) AS gr,
                    RANK() OVER (PARTITION BY version_id ORDER BY time) AS vr
             FROM race WHERE map_id = $1
           ) AS ranked
           WHERE race.id = ranked.id`,
          [mapRow.id]
        );
        await client.query(
          `INSERT INTO config (key, value) VALUES ('last_update', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(now)]
        );
        this._perfectRunCache.delete(num(mapRow.id));
      }

      return counts;
    }
  }

  // Monotonic race-id counter, serialized via a row lock on the counter row
  // (announcer contract: improved records always get strictly higher ids).
  async _nextRaceId(client) {
    const r = await client.query("SELECT value FROM config WHERE key = 'next_race_id' FOR UPDATE");
    const id = r.rows.length ? parseInt(r.rows[0].value, 10) : 1;
    await client.query(
      `INSERT INTO config (key, value) VALUES ('next_race_id', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(id + 1)]
    );
    return id;
  }

  // Resolve (and, if new, create) the player row, keeping canonical grouping
  // current. New identities JOIN the existing group; they never seize it —
  // names/logins in an ingest are attacker-chosen (see the SQLite-era comment
  // for the full threat model). Runs inside the ingest transaction.
  async _resolvePlayer(client, rec) {
    const simplified = simplifyName(rec.name);
    const q1 = async (sql, params) => (await client.query(sql, params)).rows[0];

    // Atomic get-or-create (see the version/map upsert): a plain
    // SELECT-then-INSERT lets two concurrent ingests of the same brand-new
    // (name, login) both miss the SELECT and collide on UNIQUE(name, login).
    const row = await q1(
      `INSERT INTO player (name, simplified, trimmed, login) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, login) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [rec.name, simplified, trimName(simplified), rec.login]
    );
    const id = num(row.id);

    const key = canonKey(simplified, rec.login);
    const rep = await q1("SELECT player_id FROM canonical WHERE key = $1", [key]);
    if (!rep) {
      // First of its kind: it is its own representative.
      await client.query("UPDATE player SET canonical_id = $1 WHERE id = $1", [id]);
      await client.query(
        "INSERT INTO canonical (key, player_id) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET player_id = EXCLUDED.player_id",
        [key, id]
      );
      return id;
    }
    if (num(rep.player_id) === id) return id; // already the representative
    // Join the existing group without disturbing its representative.
    await client.query("UPDATE player SET canonical_id = $1 WHERE id = $2", [num(rep.player_id), id]);
    return id;
  }

  async close() {
    await this.pool.end();
  }
}
