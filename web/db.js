// Data-access layer for the race database.
//
// Opens the livesow SQLite file and, at startup, builds a handful of in-memory
// (TEMP) aggregate tables so the API can answer flexible map / player queries
// (search, sort, paginate) without re-scanning 240k race rows on every call.
//
// Times are milliseconds. Player names carry ^0-^9 Warsow colour codes; both
// the raw name and a colour-stripped `simplified` form are returned so the
// client can render colours and the API can search plain text.
import Database from "better-sqlite3";

// Points a player scores for their best rank on a map (top-15 scoring). Kept in
// sync with the CASE expression used to build the standings table.
export const POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

const POINTS_CASE = `CASE rank
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

export function openDatabase(dbPath) {
  let db;
  try {
    db = new Database(dbPath); // read-write so we can add helpful indexes once
  } catch (err) {
    console.warn(`Falling back to readonly open: ${err.message}`);
    db = new Database(dbPath, { readonly: true });
  }
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  } catch {
    // read-only mount: journal pragmas aren't allowed, and aren't needed.
  }

  const t0 = Date.now();
  // --- Persistent indexes (best effort; skipped on a read-only DB) ----------
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_race_map    ON race(map_id);
      CREATE INDEX IF NOT EXISTS idx_race_player ON race(player_id);
      CREATE INDEX IF NOT EXISTS idx_cp_race     ON checkpoint(race_id);
    `);
  } catch (err) {
    console.warn(`Could not create indexes (read-only DB?): ${err.message}`);
  }

  buildAggregates(db);
  console.log(`Database ready in ${Date.now() - t0}ms`);
  return new RaceDB(db);
}

function buildAggregates(db) {
  // A player counts once per map: their best (lowest) global rank across every
  // game version. This is the basis for both standings and per-map boards.
  db.exec(`
    CREATE TEMP TABLE best AS
      SELECT player_id, map_id, MIN(global_rank) AS rank, MIN(time) AS time
      FROM race GROUP BY player_id, map_id;
    CREATE INDEX temp.idx_best_map    ON best(map_id);
    CREATE INDEX temp.idx_best_player ON best(player_id);
  `);

  // Player standings with a dense overall rank by points.
  db.exec(`
    CREATE TEMP TABLE standings AS
      SELECT s.*, ROW_NUMBER() OVER (ORDER BY points DESC, wr DESC, player_id) AS rank
      FROM (
        SELECT player_id,
               COUNT(*)                             AS maps,
               SUM(CASE WHEN rank=1 THEN 1 ELSE 0 END) AS wr,
               SUM(CASE WHEN rank<=3 THEN 1 ELSE 0 END) AS podium,
               SUM(${POINTS_CASE})                  AS points
        FROM best GROUP BY player_id
      ) s;
    CREATE INDEX temp.idx_standings_player ON standings(player_id);
    CREATE INDEX temp.idx_standings_points ON standings(points DESC);
  `);

  // One row per map with race count and the world-record holder.
  db.exec(`
    CREATE TEMP TABLE map_index AS
      SELECT m.id AS map_id, m.name AS name,
             COALESCE(rc.races, 0) AS races,
             wr.wr_time, wr.wr_pid, wr.wr_version, wr.wr_race_id
      FROM map m
      LEFT JOIN (SELECT map_id, COUNT(*) races FROM race GROUP BY map_id) rc
             ON rc.map_id = m.id
      LEFT JOIN (
        SELECT r.map_id,
               r.time       AS wr_time,
               r.player_id  AS wr_pid,
               r.version_id AS wr_version,
               r.id         AS wr_race_id
        FROM race r
        JOIN (SELECT map_id, MIN(time) mt FROM race GROUP BY map_id) b
          ON b.map_id = r.map_id AND b.mt = r.time
        GROUP BY r.map_id
      ) wr ON wr.map_id = m.id;
    CREATE INDEX temp.idx_mapidx_name  ON map_index(name);
    CREATE INDEX temp.idx_mapidx_races ON map_index(races DESC);
    CREATE INDEX temp.idx_mapidx_wr    ON map_index(wr_time);
  `);
}

// Whitelisted sort columns keep user-supplied `sort` params injection-safe.
const MAP_SORTS = {
  name: "mi.name COLLATE NOCASE",
  races: "mi.races",
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
  constructor(db) {
    this.db = db;
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
      rankedPlayers: db.prepare("SELECT COUNT(*) c FROM standings").get().c,
      races: db.prepare("SELECT COUNT(*) c FROM race").get().c,
      checkpoints: db.prepare("SELECT COUNT(*) c FROM checkpoint").get().c,
      worldRecords: db.prepare("SELECT COUNT(*) c FROM map_index WHERE wr_time IS NOT NULL").get().c,
    };
    const versions = db
      .prepare("SELECT version_id id, COUNT(*) races FROM race GROUP BY version_id ORDER BY races DESC")
      .all()
      .map((r) => ({ id: r.id, name: this.versions[r.id] || String(r.id), races: r.races }));
    const topMaps = db
      .prepare("SELECT map_id id, name, races FROM map_index ORDER BY races DESC LIMIT 15")
      .all();
    const hallOfFame = db
      .prepare(
        `SELECT s.rank, s.player_id id, p.name, p.simplified, s.points, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ORDER BY s.rank LIMIT 15`
      )
      .all();
    const lastUpdate = db.prepare("SELECT value FROM config WHERE key='last_update'").get();
    return {
      lastUpdate: lastUpdate ? parseInt(lastUpdate.value, 10) : null,
      totals,
      versions,
      topMaps,
      hallOfFame,
    };
  }

  maps({ q = "", sort = "races", order, limit, offset } = {}) {
    const col = MAP_SORTS[sort] || MAP_SORTS.races;
    const direction = dir(order, sort === "name" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    const where = q ? "WHERE mi.name LIKE ?" : "";
    const args = q ? [`%${q}%`] : [];
    const total = this.db.prepare(`SELECT COUNT(*) c FROM map_index mi ${where}`).get(...args).c;
    const rows = this.db
      .prepare(
        `SELECT mi.map_id AS id, mi.name, mi.races, mi.wr_time,
                mi.wr_pid, mi.wr_version, p.name AS wr_name, p.simplified AS wr_simplified
         FROM map_index mi
         LEFT JOIN player p ON p.id = mi.wr_pid
         ${where}
         ORDER BY ${col} ${direction} NULLS LAST, mi.name COLLATE NOCASE ASC
         LIMIT ? OFFSET ?`
      )
      .all(...args, lim, off)
      .map((r) => ({ ...r, wr_version_name: this.versions[r.wr_version] || null }));
    return { total, limit: lim, offset: off, rows };
  }

  mapDetail(id, { limit } = {}) {
    const map = this.db.prepare("SELECT id, name FROM map WHERE id = ?").get(id);
    if (!map) return null;
    const idx = this.db.prepare("SELECT * FROM map_index WHERE map_id = ?").get(id);
    const lim = clampLimit(limit, 50, 500);

    // Leaderboard: best time per player on this map, fastest first.
    const leaderboard = this.db
      .prepare(
        `SELECT b.player_id, b.time, b.rank AS global_rank,
                p.name, p.simplified,
                (SELECT version_id FROM race r
                   WHERE r.map_id = b.map_id AND r.player_id = b.player_id
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
    let splits = [];
    let wr = null;
    if (idx && idx.wr_race_id != null) {
      splits = this.db
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
      races: idx ? idx.races : 0,
      players: leaderboard.length,
      wr,
      leaderboard,
    };
  }

  players({ q = "", sort = "points", order, limit, offset } = {}) {
    const col = PLAYER_SORTS[sort] || PLAYER_SORTS.points;
    const direction = dir(order, sort === "name" || sort === "rank" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    const where = q ? "WHERE p.name LIKE ? OR p.simplified LIKE ? OR p.trimmed LIKE ?" : "";
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
    const player = this.db.prepare("SELECT id, name, simplified, login FROM player WHERE id = ?").get(id);
    if (!player) return null;
    const standing = this.db.prepare("SELECT rank, points, wr, podium, maps FROM standings WHERE player_id = ?").get(id) || {
      rank: null,
      points: 0,
      wr: 0,
      podium: 0,
      maps: 0,
    };

    const col = RECORD_SORTS[sort] || RECORD_SORTS.time;
    const direction = dir(order, sort === "map" ? "ASC" : "ASC");
    const lim = clampLimit(limit, 50, 500);
    const off = toOffset(offset);
    const total = this.db.prepare("SELECT COUNT(*) c FROM best WHERE player_id = ?").get(id).c;
    const records = this.db
      .prepare(
        `SELECT b.map_id, m.name AS map_name, b.time, b.rank
         FROM best b JOIN map m ON m.id = b.map_id
         WHERE b.player_id = ?
         ORDER BY ${col} ${direction}, b.time ASC
         LIMIT ? OFFSET ?`
      )
      .all(id, lim, off);
    return {
      id: player.id,
      name: player.name,
      simplified: player.simplified,
      login: player.login,
      standing,
      records: { total, limit: lim, offset: off, rows: records },
    };
  }

  search(q, { limit = 8 } = {}) {
    if (!q) return { maps: [], players: [] };
    const like = `%${q}%`;
    const maps = this.db
      .prepare("SELECT map_id id, name, races FROM map_index WHERE name LIKE ? ORDER BY races DESC LIMIT ?")
      .all(like, limit);
    const players = this.db
      .prepare(
        `SELECT s.player_id id, p.name, p.simplified, s.rank, s.points
         FROM standings s JOIN player p ON p.id = s.player_id
         WHERE p.name LIKE ? OR p.simplified LIKE ? OR p.trimmed LIKE ?
         ORDER BY s.points DESC LIMIT ?`
      )
      .all(like, like, like, limit);
    return { maps, players };
  }
}
