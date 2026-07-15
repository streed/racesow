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

// Points a player scores for their best rank on a map (top-15 scoring). Kept in
// sync with the CASE expression used to build the standings table.
export const POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

const POINTS_CASE = `CASE rank
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

// Postgres schema epoch. Versions 1-4 were the SQLite era (see git history);
// a fresh Postgres database is created directly at the current shape and the
// one-time migrate-sqlite-to-pg.js copies data from a fully-migrated SQLite
// file. Future migrations append here and bump this number.
const SCHEMA_VERSION = 5;

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
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
  await bootstrapSchema(pool);
  await runMigrations(pool);

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
  console.log(`Database ready in ${Date.now() - t0}ms (schema v${await schemaVersion(pool)})`);
  return race;
}

async function schemaVersion(pool) {
  const r = await pool.query("SELECT value FROM config WHERE key = 'schema_version'");
  return r.rows.length ? parseInt(r.rows[0].value, 10) : 0;
}

// Base schema at the current shape. Idempotent; a fresh database gets
// everything, an existing one no-ops. Ids are app-visible and preserved by
// the data migration, so identity columns use BY DEFAULT (explicit ids OK).
async function bootstrapSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS version (
      id   BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS map (
      id   BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS player (
      id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name         TEXT NOT NULL,
      simplified   TEXT NOT NULL,
      trimmed      TEXT NOT NULL,
      login        TEXT NOT NULL,
      canonical_id BIGINT,
      UNIQUE( name, login )
    );
    CREATE TABLE IF NOT EXISTS canonical (
      key       TEXT PRIMARY KEY,
      player_id BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server (
      id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      name         TEXT NOT NULL,
      token_hash   TEXT UNIQUE,
      status       TEXT NOT NULL DEFAULT 'trusted',  -- trusted|quarantined|revoked
      created_at   BIGINT NOT NULL,
      last_seen_at BIGINT,
      records      BIGINT NOT NULL DEFAULT 0,
      address      TEXT
    );
    CREATE TABLE IF NOT EXISTS race (
      id           BIGINT PRIMARY KEY,  -- app-allocated monotonic counter
      version_id   BIGINT NOT NULL,
      player_id    BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
      map_id       BIGINT NOT NULL REFERENCES map(id) ON DELETE CASCADE ON UPDATE CASCADE,
      time         INTEGER NOT NULL,
      version_rank INTEGER NOT NULL DEFAULT 99999,
      global_rank  INTEGER NOT NULL DEFAULT 99999,
      server_id    BIGINT,
      created_at   BIGINT,
      UNIQUE( player_id, map_id, version_id )
    );
    CREATE TABLE IF NOT EXISTS checkpoint (
      id      BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      race_id BIGINT NOT NULL REFERENCES race(id) ON DELETE CASCADE ON UPDATE CASCADE,
      number  INTEGER NOT NULL,
      time    INTEGER NOT NULL,
      UNIQUE( race_id, number )
    );
    CREATE TABLE IF NOT EXISTS run_tally (
      player_id   BIGINT NOT NULL,
      map_id      BIGINT NOT NULL,
      version_id  BIGINT NOT NULL,
      finishes    BIGINT NOT NULL DEFAULT 0,
      attempts    BIGINT NOT NULL DEFAULT 0,
      last_finish BIGINT,
      PRIMARY KEY (player_id, map_id, version_id)
    );

    CREATE INDEX IF NOT EXISTS idx_race_map       ON race(map_id);
    CREATE INDEX IF NOT EXISTS idx_race_player    ON race(player_id);
    CREATE INDEX IF NOT EXISTS idx_race_map_time  ON race(map_id, time);
    CREATE INDEX IF NOT EXISTS idx_race_created   ON race(created_at DESC) WHERE created_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cp_race        ON checkpoint(race_id);
    CREATE INDEX IF NOT EXISTS idx_tally_map      ON run_tally(map_id);
    CREATE INDEX IF NOT EXISTS idx_player_canonical ON player(canonical_id);

    -- Search: trigram GIN indexes make ILIKE '%q%' and % (similarity) fast
    -- and typo-tolerant, replacing the SQLite layer's full-table LIKE scans.
    CREATE INDEX IF NOT EXISTS idx_player_simplified_trgm ON player USING gin (simplified gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_player_name_trgm       ON player USING gin (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_player_trimmed_trgm    ON player USING gin (trimmed gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_map_name_trgm          ON map USING gin (name gin_trgm_ops);

    INSERT INTO config (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT (key) DO NOTHING;
    INSERT INTO config (key, value) VALUES ('next_race_id', '1')
      ON CONFLICT (key) DO NOTHING;
  `);
}

// Versioned, idempotent migration steps for FUTURE schema changes; runs once,
// in order, inside a transaction, for a database below that version.
const MIGRATIONS = {
  // 6: async (client) => { ... }
};

async function runMigrations(pool) {
  const from = await schemaVersion(pool);
  if (from >= SCHEMA_VERSION) return;
  console.log(`Migrating schema ${from} -> ${SCHEMA_VERSION} ...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      if (MIGRATIONS[v]) await MIGRATIONS[v](client);
      await client.query("UPDATE config SET value = $1 WHERE key = 'schema_version'", [String(v)]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  console.log("Migration complete.");
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
        playerId: num(idx.wr_pid),
        name: holder ? holder.name : "?",
        simplified: holder ? holder.simplified : "?",
        version: num(idx.wr_version),
        versionName: this.versions[num(idx.wr_version)] || null,
        splits,
      };
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
  async perfectRun(mapId, wr) {
    const cached = this._perfectRunCache.get(mapId);
    if (cached !== undefined) return cached;
    const result = await this._computePerfectRun(mapId, wr);
    if (this._perfectRunCache.size >= 2048) this._perfectRunCache.clear();
    this._perfectRunCache.set(mapId, result);
    return result;
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
  async refreshAggregates() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
