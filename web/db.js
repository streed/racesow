// Data-access layer for the race database.
//
// Opens the race SQLite file, runs idempotent schema migrations, and at startup
// builds a handful of in-memory (TEMP) aggregate tables so the API can answer
// flexible map / player queries (search, sort, paginate) without re-scanning
// 240k+ race rows on every call.
//
// Times are milliseconds. Player names carry ^0-^9 Warsow colour codes; both
// the raw name and a colour-stripped `simplified` form are returned so the
// client can render colours and the API can search plain text.
//
// Beyond the original livesow snapshot this layer adds:
//   * canonical players — many colour/spelling variants of one person collapse
//     to a single representative, displayed as the LAST nick we've seen them
//     use, so leaderboards and standings aren't fragmented (see
//     populateCanonical).
//   * run tally — total completed runs (attempts that reached the finish) per
//     player/map/version, since the `race` table only keeps each player's best.
//   * server provenance + timestamps on ingested records (multi-server).
import Database from "better-sqlite3";
import crypto from "node:crypto";

// Points a player scores for their best rank on a map (top-15 scoring). Kept in
// sync with the CASE expression used to build the standings table.
export const POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

const POINTS_CASE = `CASE rank
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

const SCHEMA_VERSION = 2;

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

// Aggressive identity normalisation for both nicks and logins: strip colour
// codes, lowercase, drop a trailing "(N)" collision suffix (the mod appends
// these when two players share a name), and keep only alphanumerics. So
// "^8EL^9chupa^7", "ELchupa(1)" and login "elchupa" all normalise to "elchupa".
export function normToken(s) {
  return String(s)
    .replace(/\^[0-9]/g, "")
    .toLowerCase()
    .replace(/\(\d+\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

// The grouping key for collapsing duplicate identities into one person. Login
// and nick share ONE namespace: a logged-in row keys on its (normalised) login,
// an anonymous row on its (normalised) nick. Because they normalise the same
// way, login "elchupa" merges with anonymous nick "ELchupa"; but distinct
// logins never merge even under a shared default nick (the many "player"s),
// because each keys on its own login. Empty key falls back to a sentinel.
export function canonKey(simplified, login) {
  return (login ? normToken(login) : normToken(simplified)) || "?empty?";
}

export function openDatabase(dbPath) {
  let db;
  let readonly = false;
  try {
    db = new Database(dbPath); // read-write for migrations, indexes and ingest
  } catch (err) {
    console.warn(`Falling back to readonly open: ${err.message}`);
    db = new Database(dbPath, { readonly: true });
    readonly = true;
  }
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  } catch {
    // read-only mount: journal pragmas aren't allowed, and aren't needed.
  }

  const t0 = Date.now();
  if (!readonly) {
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_race_map    ON race(map_id);
        CREATE INDEX IF NOT EXISTS idx_race_player ON race(player_id);
        CREATE INDEX IF NOT EXISTS idx_cp_race     ON checkpoint(race_id);
      `);
      runMigrations(db);
    } catch (err) {
      console.warn(`Schema setup skipped: ${err.message}`);
    }
  }

  const caps = {
    canonical: hasColumn(db, "player", "canonical_id"),
    runTally: hasTable(db, "run_tally"),
    server: hasTable(db, "server"),
    serverId: hasColumn(db, "race", "server_id"),
  };
  buildAggregates(db, caps);
  console.log(`Database ready in ${Date.now() - t0}ms (schema v${userVersion(db)})`);
  return new RaceDB(db, caps);
}

// --------------------------------------------------------------------------
// Migrations
// --------------------------------------------------------------------------
function userVersion(db) {
  return db.pragma("user_version", { simple: true });
}
function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}
function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// Versioned, idempotent migration steps. Each runs once, in order, for a DB
// below that version. Bumps user_version after each so an interrupted run
// resumes cleanly.
const MIGRATIONS = {
  1(db) {
    // --- Server provenance ------------------------------------------------
    if (!hasTable(db, "server")) {
      db.exec(`
        CREATE TABLE server (
          id           INTEGER PRIMARY KEY,
          name         TEXT NOT NULL,
          token_hash   TEXT UNIQUE,
          status       TEXT NOT NULL DEFAULT 'trusted',  -- trusted|quarantined|revoked
          created_at   INTEGER NOT NULL,
          last_seen_at INTEGER,
          records      INTEGER NOT NULL DEFAULT 0
        );
      `);
    }
    if (!hasColumn(db, "race", "server_id")) db.exec("ALTER TABLE race ADD COLUMN server_id INTEGER");
    if (!hasColumn(db, "race", "created_at")) db.exec("ALTER TABLE race ADD COLUMN created_at INTEGER");

    // --- Run tally (attempts that reached the finish) ---------------------
    // The race table keeps only each player's best time, so it cannot answer
    // "how many runs?". Seed one finish per existing best; the racelog feed
    // grows it from there.
    if (!hasTable(db, "run_tally")) {
      db.exec(`
        CREATE TABLE run_tally (
          player_id   INTEGER NOT NULL,
          map_id      INTEGER NOT NULL,
          version_id  INTEGER NOT NULL,
          finishes    INTEGER NOT NULL DEFAULT 0,
          last_finish INTEGER,
          PRIMARY KEY (player_id, map_id, version_id)
        );
        INSERT OR IGNORE INTO run_tally (player_id, map_id, version_id, finishes)
          SELECT player_id, map_id, version_id, 1 FROM race;
        CREATE INDEX idx_tally_map ON run_tally(map_id);
      `);
    }

    // --- Canonical players ------------------------------------------------
    if (!hasColumn(db, "player", "canonical_id")) {
      db.exec("ALTER TABLE player ADD COLUMN canonical_id INTEGER");
    }
    if (!hasTable(db, "canonical")) {
      db.exec(`CREATE TABLE canonical (key TEXT PRIMARY KEY, player_id INTEGER NOT NULL);`);
    }
    populateCanonical(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_player_canonical ON player(canonical_id);");

    // --- Monotonic race-id counter ---------------------------------------
    // Allocating ids from a never-decreasing counter (instead of MAX(id)+1
    // computed after a delete) guarantees improved records always get a
    // strictly higher id, which is how the Discord announcer detects them.
    db.prepare(
      `INSERT OR IGNORE INTO config (key, value)
       VALUES ('next_race_id', (SELECT COALESCE(MAX(id),0)+1 FROM race))`
    ).run();
  },
  // Recompute canonical grouping under the improved rule (unified login/nick
  // namespace, "(N)" suffix stripping, last-known-nick as the representative).
  2(db) {
    populateCanonical(db);
  },
};

function runMigrations(db) {
  const from = userVersion(db);
  if (from >= SCHEMA_VERSION) return;
  console.log(`Migrating schema ${from} -> ${SCHEMA_VERSION} ...`);
  const migrate = db.transaction(() => {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v}`);
    }
  });
  migrate();
  console.log("Migration complete.");
}

// Assign every player a canonical representative. Non-destructive: original
// rows are untouched except for the canonical_id pointer. The representative is
// the LAST nick we've seen the person use — approximated by the most recent race
// (race ids are monotonic, so higher = more recent), tie-broken by the
// later-created player row. Callable repeatedly; recomputes from scratch.
function populateCanonical(db) {
  const players = db.prepare("SELECT id, name, simplified, login FROM player").all();
  const latest = new Map(); // player_id -> newest race id
  for (const r of db.prepare("SELECT player_id, MAX(id) mx FROM race GROUP BY player_id").all()) {
    latest.set(r.player_id, r.mx);
  }
  const groups = new Map(); // key -> {repId, score}
  const rank = (p) => [latest.get(p.id) ?? -1, p.id]; // higher = more recent
  const better = (a, b) => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  };
  for (const p of players) {
    const key = canonKey(p.simplified, p.login);
    const score = rank(p);
    const cur = groups.get(key);
    if (!cur || better(score, cur.score)) groups.set(key, { repId: p.id, score });
  }
  const keyOf = new Map(players.map((p) => [p.id, canonKey(p.simplified, p.login)]));
  const setCanon = db.prepare("UPDATE player SET canonical_id = ? WHERE id = ?");
  const insCanon = db.prepare("INSERT OR REPLACE INTO canonical (key, player_id) VALUES (?, ?)");
  db.prepare("DELETE FROM canonical").run(); // recompute cleanly
  for (const p of players) setCanon.run(groups.get(keyOf.get(p.id)).repId, p.id);
  for (const [key, g] of groups) insCanon.run(key, g.repId);
}

// --------------------------------------------------------------------------
// Aggregate tables (rebuilt on refreshAggregates)
// --------------------------------------------------------------------------
function buildAggregates(db, caps) {
  // Column that identifies a player for aggregation: canonical rep if migrated,
  // else the raw player id (legacy / read-only fallback).
  const pid = caps.canonical ? "pl.canonical_id" : "r.player_id";
  const joinPlayer = caps.canonical ? "JOIN player pl ON pl.id = r.player_id" : "";

  // best: each canonical player's best rank + time per map, across versions.
  db.exec(`
    CREATE TEMP TABLE best AS
      SELECT ${pid} AS player_id, r.map_id,
             MIN(r.global_rank) AS rank, MIN(r.time) AS time
      FROM race r ${joinPlayer}
      GROUP BY ${pid}, r.map_id;
    CREATE INDEX temp.idx_best_map    ON best(map_id);
    CREATE INDEX temp.idx_best_player ON best(player_id);
  `);

  // standings: one row per canonical player with a dense overall points rank.
  db.exec(`
    CREATE TEMP TABLE standings AS
      SELECT s.*, ROW_NUMBER() OVER (ORDER BY points DESC, wr DESC, player_id) AS rank
      FROM (
        SELECT player_id,
               COUNT(*)                                AS maps,
               SUM(CASE WHEN rank=1 THEN 1 ELSE 0 END) AS wr,
               SUM(CASE WHEN rank<=3 THEN 1 ELSE 0 END) AS podium,
               SUM(${POINTS_CASE})                     AS points
        FROM best GROUP BY player_id
      ) s;
    CREATE INDEX temp.idx_standings_player ON standings(player_id);
    CREATE INDEX temp.idx_standings_points ON standings(points DESC);
  `);

  // map_index: per-map counts and the world-record holder (canonical).
  //   records  = ranked best-time rows (each player/version best) — the old
  //              "races" count; NOT the number of attempts.
  //   finishes = total completed runs (attempts that reached the finish).
  //   players  = distinct canonical players on the board.
  const wrPid = caps.canonical ? "wpl.canonical_id" : "r.player_id";
  const wrJoin = caps.canonical ? "JOIN player wpl ON wpl.id = r.player_id" : "";
  const finishesExpr = caps.runTally
    ? "COALESCE(ft.finishes, rc.records, 0)"
    : "COALESCE(rc.records, 0)";
  const finishesJoin = caps.runTally
    ? "LEFT JOIN (SELECT map_id, SUM(finishes) finishes FROM run_tally GROUP BY map_id) ft ON ft.map_id = m.id"
    : "";
  db.exec(`
    CREATE TEMP TABLE map_index AS
      SELECT m.id AS map_id, m.name AS name,
             COALESCE(rc.records, 0) AS records,
             ${finishesExpr}         AS finishes,
             COALESCE(pc.players, 0) AS players,
             wr.wr_time, wr.wr_pid, wr.wr_version, wr.wr_race_id
      FROM map m
      LEFT JOIN (SELECT map_id, COUNT(*) records FROM race GROUP BY map_id) rc
             ON rc.map_id = m.id
      ${finishesJoin}
      LEFT JOIN (SELECT map_id, COUNT(*) players FROM best GROUP BY map_id) pc
             ON pc.map_id = m.id
      LEFT JOIN (
        SELECT r.map_id,
               r.time       AS wr_time,
               ${wrPid}     AS wr_pid,
               r.version_id AS wr_version,
               r.id         AS wr_race_id
        FROM race r ${wrJoin}
        JOIN (SELECT map_id, MIN(time) mt FROM race GROUP BY map_id) b
          ON b.map_id = r.map_id AND b.mt = r.time
        GROUP BY r.map_id
      ) wr ON wr.map_id = m.id;
    CREATE INDEX temp.idx_mapidx_name    ON map_index(name);
    CREATE INDEX temp.idx_mapidx_records ON map_index(records DESC);
    CREATE INDEX temp.idx_mapidx_wr      ON map_index(wr_time);
  `);
}

// Whitelisted sort columns keep user-supplied `sort` params injection-safe.
const MAP_SORTS = {
  name: "mi.name COLLATE NOCASE",
  records: "mi.records",
  races: "mi.records", // legacy alias
  finishes: "mi.finishes",
  wr_time: "mi.wr_time",
};
const PLAYER_SORTS = {
  points: "points",
  wr: "wr",
  podium: "podium",
  maps: "maps",
  rank: "rank",
  name: "p.simplified COLLATE NOCASE",
};
const RECORD_SORTS = {
  map: "map_name COLLATE NOCASE",
  time: "time",
  rank: "rank",
};

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

class RaceDB {
  constructor(db, caps) {
    this.db = db;
    this.caps = caps;
    this.versions = {};
    for (const v of db.prepare("SELECT id, name FROM version").all()) {
      this.versions[v.id] = v.name;
    }
  }

  overview() {
    const db = this.db;
    const totals = {
      maps: db.prepare("SELECT COUNT(*) c FROM map").get().c,
      players: db.prepare("SELECT COUNT(*) c FROM player").get().c,
      canonicalPlayers: this.caps.canonical
        ? db.prepare("SELECT COUNT(DISTINCT canonical_id) c FROM player").get().c
        : db.prepare("SELECT COUNT(*) c FROM player").get().c,
      rankedPlayers: db.prepare("SELECT COUNT(*) c FROM standings").get().c,
      records: db.prepare("SELECT COUNT(*) c FROM race").get().c,
      finishes: this.caps.runTally
        ? db.prepare("SELECT COALESCE(SUM(finishes),0) c FROM run_tally").get().c
        : db.prepare("SELECT COUNT(*) c FROM race").get().c,
      checkpoints: db.prepare("SELECT COUNT(*) c FROM checkpoint").get().c,
      worldRecords: db.prepare("SELECT COUNT(*) c FROM map_index WHERE wr_time IS NOT NULL").get().c,
    };
    const versions = db
      .prepare("SELECT version_id id, COUNT(*) records FROM race GROUP BY version_id ORDER BY records DESC")
      .all()
      .map((r) => ({ id: r.id, name: this.versions[r.id] || String(r.id), records: r.records, races: r.records }));
    const topMaps = db
      .prepare("SELECT map_id id, name, records, finishes FROM map_index ORDER BY records DESC LIMIT 15")
      .all()
      .map((m) => ({ ...m, races: m.records }));
    const hallOfFame = db
      .prepare(
        `SELECT s.rank, s.player_id id, p.name, p.simplified, s.points, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ORDER BY s.rank LIMIT 15`
      )
      .all();
    const recent = this.recentRecords(8);
    const lastUpdate = db.prepare("SELECT value FROM config WHERE key='last_update'").get();
    return {
      lastUpdate: lastUpdate ? parseInt(lastUpdate.value, 10) : null,
      totals,
      versions,
      topMaps,
      hallOfFame,
      recent,
      servers: this.caps.server ? this.servers() : [],
    };
  }

  // Recently ingested records (needs created_at; empty for legacy-only data).
  recentRecords(limit = 8) {
    if (!this.caps.serverId) return [];
    const pj = this.caps.canonical ? "JOIN player pl ON pl.id = r.player_id" : "";
    const pid = this.caps.canonical ? "pl.canonical_id" : "r.player_id";
    return this.db
      .prepare(
        `SELECT r.id, r.time, r.global_rank, r.created_at, r.map_id, m.name AS map,
                ${pid} AS player_id, disp.name, disp.simplified,
                sv.name AS server
         FROM race r
         ${pj}
         JOIN map m ON m.id = r.map_id
         JOIN player disp ON disp.id = ${pid}
         LEFT JOIN server sv ON sv.id = r.server_id
         WHERE r.created_at IS NOT NULL
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ?`
      )
      .all(limit)
      .map((r) => ({ ...r, versionName: null }));
  }

  servers() {
    if (!this.caps.server) return [];
    return this.db
      .prepare(
        `SELECT id, name, status, created_at, last_seen_at, records
         FROM server ORDER BY last_seen_at DESC NULLS LAST, id`
      )
      .all();
  }

  maps({ q = "", sort = "records", order, limit, offset } = {}) {
    const col = MAP_SORTS[sort] || MAP_SORTS.records;
    const direction = dir(order, sort === "name" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    const where = q ? "WHERE mi.name LIKE ?" : "";
    const args = q ? [`%${q}%`] : [];
    const total = this.db.prepare(`SELECT COUNT(*) c FROM map_index mi ${where}`).get(...args).c;
    const rows = this.db
      .prepare(
        `SELECT mi.map_id AS id, mi.name, mi.records, mi.finishes, mi.players, mi.wr_time,
                mi.wr_pid, mi.wr_version, p.name AS wr_name, p.simplified AS wr_simplified
         FROM map_index mi
         LEFT JOIN player p ON p.id = mi.wr_pid
         ${where}
         ORDER BY ${col} ${direction} NULLS LAST, mi.name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?`
      )
      .all(...args, lim, off)
      .map((r) => ({ ...r, races: r.records, wr_version_name: this.versions[r.wr_version] || null }));
    return { total, limit: lim, offset: off, rows };
  }

  mapDetail(id, { limit } = {}) {
    const map = this.db.prepare("SELECT id, name FROM map WHERE id = ?").get(id);
    if (!map) return null;
    const idx = this.db.prepare("SELECT * FROM map_index WHERE map_id = ?").get(id);
    const lim = clampLimit(limit, 50, 500);

    // Leaderboard: best time per canonical player on this map, fastest first.
    const leaderboard = this.db
      .prepare(
        `SELECT b.player_id, b.time, b.rank AS global_rank,
                p.name, p.simplified,
                (SELECT r.version_id FROM race r
                   ${this.caps.canonical ? "JOIN player pv ON pv.id = r.player_id" : ""}
                   WHERE r.map_id = b.map_id
                     AND ${this.caps.canonical ? "pv.canonical_id" : "r.player_id"} = b.player_id
                   ORDER BY r.time LIMIT 1) AS version
         FROM best b JOIN player p ON p.id = b.player_id
         WHERE b.map_id = ?
         ORDER BY b.time ASC LIMIT ?`
      )
      .all(id, lim)
      .map((r, i) => ({
        pos: i + 1,
        playerId: r.player_id,
        name: r.name,
        simplified: r.simplified,
        time: r.time,
        globalRank: r.global_rank,
        version: r.version,
        versionName: this.versions[r.version] || null,
      }));

    // World-record split times (absolute, non-zero, ascending).
    let wr = null;
    if (idx && idx.wr_race_id != null) {
      const splits = this.db
        .prepare("SELECT time FROM checkpoint WHERE race_id = ? AND time > 0 ORDER BY time ASC")
        .all(idx.wr_race_id)
        .map((r) => r.time);
      const holder = this.db.prepare("SELECT name, simplified FROM player WHERE id = ?").get(idx.wr_pid);
      wr = {
        time: idx.wr_time,
        playerId: idx.wr_pid,
        name: holder ? holder.name : "?",
        simplified: holder ? holder.simplified : "?",
        version: idx.wr_version,
        versionName: this.versions[idx.wr_version] || null,
        splits,
      };
    }

    return {
      id: map.id,
      name: map.name,
      records: idx ? idx.records : 0,
      races: idx ? idx.records : 0, // legacy alias
      finishes: idx ? idx.finishes : 0,
      players: idx ? idx.players : leaderboard.length,
      wr,
      perfect: this.perfectRun(id, wr),
      leaderboard,
    };
  }

  // Theoretical-best run for a map: the sum of the fastest time anyone has
  // recorded for each segment (start->cp1, cp1->cp2, ..., last cp->finish),
  // stitched together with per-segment attribution. This is the classic
  // speedrun "sum of best splits". Bounded to one map's checkpoint rows.
  perfectRun(mapId, wr) {
    // finish time per race on this map
    const races = this.db
      .prepare("SELECT id, player_id, time FROM race WHERE map_id = ?")
      .all(mapId);
    if (!races.length) return null;
    const finishById = new Map(races.map((r) => [r.id, r]));

    const cps = this.db
      .prepare(
        `SELECT race_id, number, time FROM checkpoint
         WHERE race_id IN (SELECT id FROM race WHERE map_id = ?) AND time > 0
         ORDER BY race_id, number`
      )
      .all(mapId);
    // Group checkpoints per race.
    const perRace = new Map();
    let maxNum = -1;
    for (const c of cps) {
      if (!perRace.has(c.race_id)) perRace.set(c.race_id, []);
      perRace.get(c.race_id)[c.number] = c.time;
      if (c.number > maxNum) maxNum = c.number;
    }
    if (maxNum < 0) return null; // no checkpoint data (maps without CPs)

    // Segment i (0..maxNum) is between cp[i-1] (or start) and cp[i]. The final
    // segment (maxNum+1) is last cp -> finish.
    const segCount = maxNum + 2;
    const best = new Array(segCount).fill(null); // {delta, raceId}
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
      // final segment: finish - last present checkpoint
      if (prevOk && prev != null && race && race.time > prev) {
        const delta = race.time - prev;
        const fi = maxNum + 1;
        if (best[fi] == null || delta < best[fi].delta) best[fi] = { delta, raceId };
      }
    }

    // Attribute segments to canonical players.
    const involved = [...new Set(best.filter(Boolean).map((b) => b.raceId))];
    const owner = new Map();
    if (involved.length) {
      const pid = this.caps.canonical ? "pl.canonical_id" : "r.player_id";
      const pj = this.caps.canonical ? "JOIN player pl ON pl.id = r.player_id" : "";
      const rows = this.db
        .prepare(
          `SELECT r.id, disp.name, disp.simplified
           FROM race r ${pj}
           JOIN player disp ON disp.id = ${pid}
           WHERE r.id IN (${involved.map(() => "?").join(",")})`
        )
        .all(...involved);
      for (const r of rows) owner.set(r.id, { name: r.name, simplified: r.simplified });
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
      // How much the perfect run would save over the actual world record.
      savingVsWr: complete && wrTime != null ? wrTime - total : null,
    };
  }

  players({ q = "", sort = "points", order, limit, offset } = {}) {
    const col = PLAYER_SORTS[sort] || PLAYER_SORTS.points;
    const direction = dir(order, sort === "name" || sort === "rank" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    // Match a search against ANY name variant, then map to its canonical row.
    const variantMatch = this.caps.canonical
      ? "s.player_id IN (SELECT canonical_id FROM player WHERE name LIKE ? OR simplified LIKE ? OR trimmed LIKE ?)"
      : "(p.name LIKE ? OR p.simplified LIKE ? OR p.trimmed LIKE ?)";
    const where = q ? `WHERE ${variantMatch}` : "";
    const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    const total = this.db
      .prepare(`SELECT COUNT(*) c FROM standings s JOIN player p ON p.id = s.player_id ${where}`)
      .get(...args).c;
    const rows = this.db
      .prepare(
        `SELECT s.rank, s.player_id AS id, p.name, p.simplified, p.login,
                s.points, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ${where}
         ORDER BY ${col} ${direction}, s.rank ASC
         LIMIT ? OFFSET ?`
      )
      .all(...args, lim, off);
    return { total, limit: lim, offset: off, rows };
  }

  playerDetail(id, { sort = "time", order, limit, offset } = {}) {
    // Resolve any variant id to its canonical representative.
    let canonId = id;
    if (this.caps.canonical) {
      const c = this.db.prepare("SELECT canonical_id FROM player WHERE id = ?").get(id);
      if (c && c.canonical_id != null) canonId = c.canonical_id;
    }
    const player = this.db.prepare("SELECT id, name, simplified, login FROM player WHERE id = ?").get(canonId);
    if (!player) return null;

    // Alternate spellings collapsed into this profile.
    const aliases = this.caps.canonical
      ? this.db
          .prepare(
            "SELECT DISTINCT name, simplified FROM player WHERE canonical_id = ? AND id <> ? ORDER BY name"
          )
          .all(canonId, canonId)
      : [];

    const standing = this.db.prepare("SELECT rank, points, wr, podium, maps FROM standings WHERE player_id = ?").get(canonId) || {
      rank: null,
      points: 0,
      wr: 0,
      podium: 0,
      maps: 0,
    };
    const finishes = this.caps.runTally
      ? this.db
          .prepare(
            `SELECT COALESCE(SUM(finishes),0) c FROM run_tally
             WHERE player_id IN (SELECT id FROM player WHERE ${this.caps.canonical ? "canonical_id" : "id"} = ?)`
          )
          .get(canonId).c
      : null;

    const col = RECORD_SORTS[sort] || RECORD_SORTS.time;
    const direction = dir(order, "ASC");
    const lim = clampLimit(limit, 50, 500);
    const off = toOffset(offset);
    const total = this.db.prepare("SELECT COUNT(*) c FROM best WHERE player_id = ?").get(canonId).c;
    const records = this.db
      .prepare(
        `SELECT b.map_id, m.name AS map_name, b.time, b.rank
         FROM best b JOIN map m ON m.id = b.map_id
         WHERE b.player_id = ?
         ORDER BY ${col} ${direction}, b.time ASC
         LIMIT ? OFFSET ?`
      )
      .all(canonId, lim, off);
    return {
      id: canonId,
      name: player.name,
      simplified: player.simplified,
      login: player.login,
      aliases,
      standing,
      finishes,
      records: { total, limit: lim, offset: off, rows: records },
    };
  }

  search(q, { limit = 8 } = {}) {
    if (!q) return { maps: [], players: [] };
    const like = `%${q}%`;
    const maps = this.db
      .prepare("SELECT map_id id, name, records, finishes FROM map_index WHERE name LIKE ? ORDER BY records DESC LIMIT ?")
      .all(like, limit)
      .map((m) => ({ ...m, races: m.records }));
    const variantMatch = this.caps.canonical
      ? "s.player_id IN (SELECT canonical_id FROM player WHERE name LIKE ? OR simplified LIKE ? OR trimmed LIKE ?)"
      : "(p.name LIKE ? OR p.simplified LIKE ? OR p.trimmed LIKE ?)";
    const players = this.db
      .prepare(
        `SELECT s.player_id id, p.name, p.simplified, s.rank, s.points
         FROM standings s JOIN player p ON p.id = s.player_id
         WHERE ${variantMatch}
         ORDER BY s.points DESC LIMIT ?`
      )
      .all(like, like, like, limit);
    return { maps, players };
  }

  // Rebuild the in-memory aggregate tables after ingested rows change the
  // underlying data. Takes ~0.4-1s on the full DB, so callers should debounce.
  refreshAggregates() {
    this.db.exec(`
      DROP TABLE IF EXISTS temp.best;
      DROP TABLE IF EXISTS temp.standings;
      DROP TABLE IF EXISTS temp.map_index;
    `);
    buildAggregates(this.db, this.caps);
  }

  // ------------------------------------------------------------------------
  // Server enrollment / auth (multi-server)
  // ------------------------------------------------------------------------
  enrollServer(name, token) {
    const hash = sha256(token);
    const info = this.db
      .prepare("INSERT INTO server (name, token_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hash, Math.floor(Date.now() / 1000));
    return { id: info.lastInsertRowid, name };
  }
  serverByTokenHash(hash) {
    if (!this.caps.server) return null;
    return this.db.prepare("SELECT id, name, status FROM server WHERE token_hash = ?").get(hash);
  }
  touchServer(id, records = 0) {
    if (!this.caps.server) return;
    this.db
      .prepare("UPDATE server SET last_seen_at = ?, records = records + ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000), records, id);
  }

  // ------------------------------------------------------------------------
  // Ingest
  // ------------------------------------------------------------------------
  // Upsert a batch of race results for one map, from the collector. Keeps only
  // the best time per player/map/version (the schema's UNIQUE constraint). An
  // improved time is delete+reinserted with a fresh id from a monotonic counter
  // (so the id is always strictly greater — how the announcer detects records).
  //
  // opts.source: 'racelog' (each record is one genuine finish → run tally +1)
  //              'topscores' (a best-state snapshot re-sent periodically → no
  //              tally increment, only best-time upsert).
  // opts.serverId: provenance stamped on inserted/improved rows.
  // Returns { inserted, improved, unchanged }.
  ingest({ version, map, records, source = "topscores", serverId = null }) {
    const db = this.db;
    const S = this._stmts();
    const now = Math.floor(Date.now() / 1000);
    const tally = this.caps.runTally && source === "racelog";

    const run = db.transaction(() => {
      let versionRow = S.versionByName.get(version);
      if (!versionRow) {
        versionRow = { id: S.insertVersion.run(version).lastInsertRowid };
        this.versions[versionRow.id] = version;
      }
      let mapRow = S.mapByName.get(map);
      if (!mapRow) mapRow = { id: S.insertMap.run(map).lastInsertRowid };

      const counts = { inserted: 0, improved: 0, unchanged: 0 };
      for (const rec of records) {
        const playerId = this._resolvePlayer(rec, S, source);

        if (tally) {
          S.bumpTally.run(playerId, mapRow.id, versionRow.id, now, now);
        }

        const existing = S.raceByKey.get(playerId, mapRow.id, versionRow.id);
        if (existing && existing.time <= rec.time) {
          counts.unchanged++;
          continue;
        }
        if (existing) {
          S.deleteCheckpoints.run(existing.id);
          S.deleteRace.run(existing.id);
        }
        const raceId = this._nextRaceId(S);
        S.insertRace.run(raceId, versionRow.id, playerId, mapRow.id, rec.time, serverId, now);
        for (let i = 0; i < rec.checkpoints.length; i++) {
          S.insertCheckpoint.run(raceId, i, rec.checkpoints[i]);
        }
        counts[existing ? "improved" : "inserted"]++;
      }

      if (counts.inserted || counts.improved) {
        S.rerankMap.run(mapRow.id);
        S.touchLastUpdate.run(String(now));
      }
      return counts;
    });
    return run();
  }

  _nextRaceId(S) {
    const row = S.getCounter.get();
    const id = row ? parseInt(row.value, 10) : 1;
    S.setCounter.run(String(id + 1));
    return id;
  }

  // Resolve (and, if new, create) the player row, keeping canonical grouping
  // current. A live finish (source=racelog) means we just saw this person use
  // this nick, so it becomes the group's representative ("last nick we know
  // of"). Topscores is a periodic backfill of historical bests, so it joins the
  // group without disturbing the representative.
  _resolvePlayer(rec, S, source) {
    const simplified = simplifyName(rec.name);
    const row = S.playerByIdent.get(rec.name, rec.login);
    const id = row ? row.id : S.insertPlayer.run(rec.name, simplified, trimName(simplified), rec.login).lastInsertRowid;
    if (!this.caps.canonical) return id;

    const key = canonKey(simplified, rec.login);
    const rep = S.canonByKey.get(key);
    if (!rep) {
      // First of its kind: it is its own representative.
      S.setCanonical.run(id, id);
      S.insertCanon.run(key, id);
      return id;
    }
    if (rep.player_id === id) return id; // already the representative

    if (source === "racelog") {
      // Promote this nick to the group's display and move the group onto it.
      S.repointCanon.run(id, rep.player_id);
      S.setCanonical.run(id, id);
      S.insertCanon.run(key, id);
    } else {
      // Backfill: just join the existing group.
      S.setCanonical.run(rep.player_id, id);
    }
    return id;
  }

  _stmts() {
    if (this._prep) return this._prep;
    const db = this.db;
    this._prep = {
      versionByName: db.prepare("SELECT id FROM version WHERE name = ?"),
      insertVersion: db.prepare("INSERT INTO version (name) VALUES (?)"),
      mapByName: db.prepare("SELECT id FROM map WHERE name = ?"),
      insertMap: db.prepare("INSERT INTO map (name) VALUES (?)"),
      playerByIdent: db.prepare("SELECT id FROM player WHERE name = ? AND login = ?"),
      playerById: db.prepare("SELECT id, name FROM player WHERE id = ?"),
      insertPlayer: db.prepare("INSERT INTO player (name, simplified, trimmed, login) VALUES (?, ?, ?, ?)"),
      raceByKey: db.prepare("SELECT id, time FROM race WHERE player_id = ? AND map_id = ? AND version_id = ?"),
      getCounter: db.prepare("SELECT value FROM config WHERE key = 'next_race_id'"),
      setCounter: db.prepare(
        `INSERT INTO config (key, value) VALUES ('next_race_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ),
      insertRace: db.prepare(
        this.caps.serverId
          ? "INSERT INTO race (id, version_id, player_id, map_id, time, server_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          : "INSERT INTO race (id, version_id, player_id, map_id, time) VALUES (?, ?, ?, ?, ?)"
      ),
      deleteRace: db.prepare("DELETE FROM race WHERE id = ?"),
      deleteCheckpoints: db.prepare("DELETE FROM checkpoint WHERE race_id = ?"),
      insertCheckpoint: db.prepare("INSERT INTO checkpoint (race_id, number, time) VALUES (?, ?, ?)"),
      rerankMap: db.prepare(`
        UPDATE race SET global_rank = ranked.gr, version_rank = ranked.vr
        FROM (
          SELECT id,
                 RANK() OVER (ORDER BY time) AS gr,
                 RANK() OVER (PARTITION BY version_id ORDER BY time) AS vr
          FROM race WHERE map_id = ?
        ) AS ranked
        WHERE race.id = ranked.id
      `),
      touchLastUpdate: db.prepare(
        `INSERT INTO config (key, value) VALUES ('last_update', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ),
      bumpTally: db.prepare(
        `INSERT INTO run_tally (player_id, map_id, version_id, finishes, last_finish)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(player_id, map_id, version_id)
         DO UPDATE SET finishes = finishes + 1, last_finish = ?`
      ),
      canonByKey: db.prepare("SELECT player_id FROM canonical WHERE key = ?"),
      insertCanon: db.prepare("INSERT OR REPLACE INTO canonical (key, player_id) VALUES (?, ?)"),
      setCanonical: db.prepare("UPDATE player SET canonical_id = ? WHERE id = ?"),
      repointCanon: db.prepare("UPDATE player SET canonical_id = ? WHERE canonical_id = ?"),
    };
    return this._prep;
  }
}
