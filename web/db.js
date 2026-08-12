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
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runner as pgMigrateRunner } from "node-pg-migrate";
import { tokenToCode, isSlick, SLICK_CODE, SLICK_MIN_FRAC } from "./weapons.js";
import { buildMatcher, censorName, normalizeTerm } from "./censor.js";
import { qualifyQuery, progressQuery, periodKey, targetOf, displayMeta } from "./achievements.js";
import {
  standingsQuery,
  mapBoardsQuery,
  phaseOf,
  joinOpen,
  generateCode,
  gameTourneyText,
  MONTHLY_SERIES_KEY,
  MONTHLY_POOL_SIZE,
  MONTHLY_MIN_POOL,
  MONTHLY_MIN_FINISHERS,
  MONTHLY_SCORING,
  MONTHLY_CANDIDATE_FETCH,
  MONTHLY_MAX_SKIP_STREAK,
  MONTHLY_TERMINAL,
  monthPeriodKey,
  monthlyWindow,
  prevMonthWindow,
  prevPeriodKey,
  decideMonthlyPool,
  monthlySlug,
  monthlyName,
  monthlyDescription,
} from "./tournaments.js";

// Async (thread-pool) compression for the request/ingest paths — the sync
// variants block the event loop for the duration of an 8MB trajectory.
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Points a player scores for their best rank on a map (top-15 scoring). Kept in
// sync with the CASE expression used to build the standings table.
export const POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

const POINTS_CASE = `CASE rank
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

// Skill Rating (SR): a second, skill-oriented standing that complements Points.
// Where Points SUMS a top-15 placement bonus across every map (so it rewards
// breadth of participation), SR measures demonstrated speed: how close a
// player's best work runs to each map's world record, against real competition.
//
// Per map, a player's PB of time t on a map whose WR time is w scores
//   perf = (w/t)^SR_GAMMA   in (0, 1]   (1.0 at the WR)
// — the power spreads the top end (raw w/t squeezed the whole competitive
// population into ~0.85-1.0, so the board barely discriminated). Each perf is
// weighted by the strength of the field it was set against,
//   fw   = log2(1 + N)      N = players with a PB on that map
// and only contested maps count (N >= SR_MIN_FIELD, i.e. you plus at least two
// other finishers): with nobody to beat, a time proves nothing, and solo-map
// WRs were free perf=1.0 samples.
//
// A player is scored on SR_TOP_K slots — the same sample size for EVERYONE.
// Sort their qualifying perfs descending, take the first K, and average them as
// a Bayesian weighted mean; any slot they haven't filled counts as a minimum-
// field map raced at the prior (weight SR_FILL_W, value μ), so a 50-map catalog
// and a 5-map one are the same measurement:
//
//   e   = SR_TOP_K - n           empty slots (n = qualifying maps used, <= K)
//   SR  = 1000 * ( Σ perf*fw + κ*μ + e*SR_FILL_W*μ )
//              / ( Σ fw       + κ   + e*SR_FILL_W  )
//
// (κ = SR_KAPPA regresses even a full sample toward the prior μ = SR_MU, IMDb
// style.) Every one of the 50 slots counts, weak maps included — the rating
// answers "how fast are you across 50 maps", not "what's the flattering
// subset". A player with no qualifying map at all sits at exactly 1000*SR_MU,
// which is what 50 empty slots average to.
//
// Consequences, deliberately chosen. (1) SR is no longer grind-proof: until
// 2026-07-30 it was the MAX over prefixes 1..K, so a map entered the rating
// only if it held up at the player's proven level and cruising a 51st map could
// never lower it. Now a slow run inside your top 50 does pull the number down —
// improving your weakest counted map is real progress, and the profile
// breakdown exists to show you which one that is. (2) A short catalog can no
// longer ride high on a handful of near-WRs; it climbs as it fills slots.
//
// Measured on the 2026-07-30 production DB (9,193 ranked players) BEFORE the
// empty-slot padding was added: 4,618 players moved, every one downward, and
// the top 10 was bit-identical (they all hold a full 50). Only 600 players had
// 50 qualifying maps — the other 8,588 were still being compared on shorter
// samples, which is exactly what the fixed-K rule set out to stop; that gap is
// what SR_FILL_W closes. A soft fill weight (a minimum-field map) was chosen
// over a typical one (the median fw, ~6.2): the strict version dropped an
// 8-map player from 863 to 444 but squeezed the whole mid-board into p90=375 /
// median=345 / p10=331, so SR stopped discriminating below the top few hundred.
//
// Calibrated against the 2026-07 production snapshot (236k races, 9.2k
// players): the proven multi-WR names hold the top-10 in a credible order,
// sub-10-map one-hit wonders drop from the top-10 to #150-500 (22 of the SR
// top-50 had <10 maps under the old formula; now 0), and the distribution
// spreads to p1=898 / median=319 / p90=224 instead of bunching at 850-980.
//
// SR_TOP_K was widened from 20 to 50 so deep, consistently-strong catalogs get
// full credit for their depth.
//
// Why the fixed 50 instead of the old prefix-max: under prefix-max the SAMPLE
// SIZE varied per player — one racer's rating was the mean of their best 50,
// another's of their best 20, whichever flattered each of them most. Comparing
// those two numbers on one leaderboard is comparing different measurements, and
// the deeper catalog was effectively penalised for the maps it had to leave in.
// A common denominator (everyone's top 50) is the point, accepted with open eyes
// that it lowers most ratings and makes a lazy run cost something.
//
// SR_MIN_FIELD was relaxed from 5 to 3 at the same time — a map qualifies once
// the player plus two others have set a time on it. Five was tuned when the cap
// was 20 and mainly guarded against thin samples, a job the Bayesian prior
// already does; the stricter bar was silently disqualifying a lot of smaller
// community maps where a 3-strong field is still a real contest, and with a
// fixed top-50 the wider pool matters more (more players actually reach 50
// qualifying maps). The field weight log2(1+N) still counts a 3-player map for
// far less than a 30-player one. Both changes reshuffle the board; ratings move
// in both directions and are NOT comparable to pre-2026-07-30 numbers, including
// the daily sr_history points already stored (the trend line will show a step).
export const SR_MU = 0.35;
export const SR_KAPPA = 10;
export const SR_GAMMA = 3;
export const SR_TOP_K = 50;
export const SR_MIN_FIELD = 3;
// What one unfilled slot weighs: exactly a minimum-field map's field weight, so
// "you haven't raced this slot yet" costs the same as having raced the least
// contested map that qualifies — deliberately the gentlest fill that still
// enforces a common sample size.
export const SR_FILL_W = Math.log2(1 + SR_MIN_FIELD);

// How many maps a player must have finished before their SR counts as a rating
// at all. Below this they are UNRANKED: no number on the leaderboard, no place,
// no bar on the distribution, no daily history point — the value is still
// computed and stored, it just isn't published as a rating.
//
// The fixed-K formula gives everyone a number, including someone with one PB,
// by padding their 49 empty slots at the prior. That is the right way to make
// ratings COMPARABLE, but it produces a rating that is mostly padding: on the
// 2026-08-10 board, 6,699 of 9,201 players (73%) sat under 5 maps, and their
// SRs span just 284-451 (stddev 19) around the prior because the padding
// dominates whatever they actually raced. Publishing that as a skill rating
// says almost nothing about the player, and it buries the 2,502 rated players
// (97-982, stddev 186) under a spike of near-identical placeholder numbers.
//
// Five is the point where a quarter of the slots that decide the number are the
// player's own runs rather than the prior. NOTE this deliberately WIDENS the
// published distribution (removing the spike raises stddev 104 -> 186); it is a
// fix for "this number is meaningless", not a fix for chart spread.
export const SR_MIN_MAPS = 5;

// Is this standings row publishable as a rating? One predicate, used by every
// read path, so "unranked" can never mean different things on the leaderboard,
// the profile and the distribution.
export function srIsRanked(maps) {
  return num(maps) >= SR_MIN_MAPS;
}

// How many days of per-player Skill Rating history to retain (rolling window).
// One SR value is snapshotted per player per UTC day at the tail of an aggregate
// refresh (snapshotSrHistory), and anything older than this many days is pruned
// in the same pass, so the `sr_history` table stays bounded and the profile
// shows a 30-day trend. See the 20260723130000000_sr_history migration.
export const SR_HISTORY_DAYS = 30;

// How many days of air-strafe-quality trend to show on the profile — one per-day
// rating point per UTC day, matching the SR-history window. Unlike SR (snapshotted
// daily), the per-day rating is derived on read by averaging the per-run
// strafe_quality stored on each finish, bucketed by UTC day. See migration
// 20260730120000000_strafe_quality.
export const STRAFE_HISTORY_DAYS = 30;

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
//
// "loadfail" is machine-generated (a game box's crash guard reporting a map
// that killed the server on load), not a player report. It has to be in this
// list or the flag endpoint silently coerces it to "other" with a 200, and a
// server-killing map becomes indistinguishable from a cosmetic complaint.
export const FLAG_REASONS = ["broken", "offensive", "wrong_name", "duplicate", "other", "loadfail"];

// Map-quarantine policy. Two failures of the same map, or one failure on each
// of two DISTINCT servers, puts it on the blocked-maps feed. Thin evidence
// expires after a week so a transient local fault (a half-written pk3) heals
// itself; see recordMapLoadFailure.
export const MAP_QUARANTINE_FAILS = Math.max(1, Number(process.env.RS_QUARANTINE_FAILS) || 2);
export const MAP_QUARANTINE_EXPIRE_SECS = Math.max(
  3600,
  Number(process.env.RS_QUARANTINE_EXPIRE_SECS) || 7 * 24 * 3600
);

// Longest nick stored alongside a tournament entry (matches the HTTP layer's
// MAX_NAME_LEN — these are display/diagnostic copies of a name, never the
// identity, which is always the resolved canonical player id).
const MAX_ENTRY_NAME = 64;

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

// The grouping key for collapsing every duplicate identity of ONE person into a
// single leaderboard row. Identity keys PURELY on the colour-stripped nick
// (identKey). Login used to win over the nick, but the matchmaker auth servers
// are gone: `login` is empty on every new record, and the only non-empty logins
// left are historical. Keying on those dead logins split one human who raced
// both anonymously AND under an old auth login (e.g. "sjn|gibbz") into several
// canonical groups — each surfacing as its own Hall-of-Fame / per-map row with
// an independent points/WR/map total. Login is therefore ignored for grouping.
// It is still STORED on the player row, so login-first grouping is fully
// reversible (see migration 20260717120000000_canonical_group_by_nick). Empty
// nick falls back to a sentinel. `_login` is kept only for call-site parity.
export function canonKey(simplified, _login) {
  return identKey(simplified) || "?empty?";
}

// Escape LIKE/ILIKE metacharacters in user-supplied search text so "50%" or
// "a_b" match literally (the historical SQLite layer had this hole).
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => "\\" + c);
}

// Resolve the maps page ?weapon= filter into { codes, strafe }. Accepts a 2-char
// code, full weapon name, or alias (comma/space separated => AND), plus the
// reserved token "strafe". Unknown tokens are ignored. Mirrors the in-game
// randmap token rules so the website search behaves the same as a vote.
function parseWeaponFilter(param) {
  const codes = [];
  let strafe = false;
  let slick = false;
  for (const tok of String(param || "").toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (tok === "strafe") { strafe = true; continue; }
    const code = tokenToCode(tok);
    // "sl" is a surface tag with its own column, not a member of the weapons
    // array — pulling it out here keeps the weapons @> ARRAY[...] test honest
    // (map_weapon.weapons never contains "sl", so leaving it in matches nothing).
    if (code === SLICK_CODE) { slick = true; continue; }
    if (code && !codes.includes(code)) codes.push(code);
  }
  return { codes, strafe, slick };
}

export async function openDatabase(connectionString) {
  const pool = new pg.Pool({
    connectionString,
    max: parseInt(process.env.PG_POOL_SIZE || "10", 10),
    // A wedged/unreachable Postgres surfaces as a per-request error instead of
    // queueing callers forever.
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS || "5000", 10),
  });
  // pg-pool re-emits idle-client backend errors (Postgres restart, network
  // reset) as an 'error' event; with no listener that is an uncaught exception
  // that kills the process. The broken client is already discarded before the
  // emit, so logging is the whole job — later queries reconnect on demand.
  pool.on("error", (e) => {
    console.error("pg pool idle-client error (client discarded):", e?.message ?? e);
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
  await race.syncGhostPayloads(); // durable ghosts: backfill payloads + restore any lost files
  await race.loadCensorConfig(); // offensive-name word list + per-player overrides
  // Re-read the censor config periodically so an admin edit on ONE web replica
  // converges on the others (mirrors the ~live cadence of map-block/motd). Admin
  // mutations also call refreshCensor() for an immediate local effect.
  setInterval(() => race.loadCensorConfig().catch(() => {}), 60000).unref();
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
    try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
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
      SELECT DISTINCT ON (pl.canonical_id, r.map_id)
             pl.canonical_id AS player_id, r.map_id,
             r.global_rank AS rank, r.time, r.version_id
      FROM race r JOIN player pl ON pl.id = r.player_id
      ORDER BY pl.canonical_id, r.map_id, r.time ASC, r.id ASC;
    CREATE INDEX ON best_new(map_id);
    CREATE INDEX ON best_new(player_id);

    CREATE UNLOGGED TABLE standings_new AS
      -- SR inputs (see the SR_* constants' comment): per contested map
      -- (field >= SR_MIN_FIELD), each player's sharpened perf (w/t)^gamma and
      -- field weight, ranked best-first; the player's SR is the Bayesian
      -- weighted mean over SR_TOP_K slots — the top K qualifying maps plus a
      -- prior-valued placeholder for every slot they haven't filled, so every
      -- player is measured on the same sample size.
      WITH mm AS (
        SELECT map_id,
               MIN(time)                                AS wr_time,
               COUNT(*)::int                            AS n,
               log(2.0, (1 + COUNT(*))::numeric)::float AS fw
        FROM best_new GROUP BY map_id
      ),
      contrib AS (
        SELECT b.player_id,
               power(mm.wr_time::float / b.time, ${SR_GAMMA}) AS p,
               mm.fw,
               ROW_NUMBER() OVER (
                 PARTITION BY b.player_id
                 ORDER BY power(mm.wr_time::float / b.time, ${SR_GAMMA}) DESC,
                          mm.fw DESC, b.map_id
               ) AS rn
        FROM best_new b JOIN mm ON mm.map_id = b.map_id
        WHERE mm.n >= ${SR_MIN_FIELD} AND b.time > 0
      ),
      skill AS (
        -- (SR_TOP_K - COUNT(*)) is the empty-slot count; the WHERE caps COUNT(*)
        -- at SR_TOP_K, so it can never go negative.
        SELECT player_id,
               ROUND(1000.0 * (SUM(p * fw) + ${SR_KAPPA} * ${SR_MU}
                               + (${SR_TOP_K} - COUNT(*)) * ${SR_FILL_W} * ${SR_MU})
                            / (SUM(fw) + ${SR_KAPPA}
                               + (${SR_TOP_K} - COUNT(*)) * ${SR_FILL_W}))::int AS sr
        FROM contrib
        WHERE rn <= ${SR_TOP_K}
        GROUP BY player_id
      )
      SELECT s.*, ROW_NUMBER() OVER (ORDER BY points DESC, wr DESC, player_id) AS rank
      FROM (
        SELECT b.player_id,
               COUNT(*)::int                                  AS maps,
               SUM(CASE WHEN b.rank=1 THEN 1 ELSE 0 END)::int AS wr,
               SUM(CASE WHEN b.rank<=3 THEN 1 ELSE 0 END)::int AS podium,
               SUM(${POINTS_CASE.replace(/\brank\b/g, "b.rank")})::int AS points,
               -- MAX is a no-op (skill has one row per player); no contested
               -- maps at all -> the bare prior.
               COALESCE(MAX(sk.sr), ${Math.round(1000 * SR_MU)})::int AS sr,
               -- Most recent attempt-or-finish across all of this canonical
               -- player's maps; NULL (never active) when no tally exists yet.
               MAX(la.last_active)                            AS last_active
        FROM best_new b
        LEFT JOIN skill sk ON sk.player_id = b.player_id
        LEFT JOIN (
          SELECT pl.canonical_id AS player_id,
                 NULLIF(MAX(GREATEST(COALESCE(rt.last_finish, 0),
                                     COALESCE(rt.last_attempt, 0))), 0) AS last_active
          FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
          GROUP BY pl.canonical_id
        ) la ON la.player_id = b.player_id
        GROUP BY b.player_id
      ) s;
    CREATE INDEX ON standings_new(player_id);
    CREATE INDEX ON standings_new(points DESC);
    CREATE INDEX ON standings_new(sr DESC);
    CREATE INDEX ON standings_new(rank);
    CREATE INDEX ON standings_new(last_active DESC NULLS LAST);

    CREATE UNLOGGED TABLE map_index_new AS
      SELECT m.id AS map_id, m.name AS name,
             COALESCE(rc.records, 0)::int AS records,
             COALESCE(ft.finishes, rc.records, 0)::int AS finishes,
             COALESCE(pc.players, 0)::int AS players,
             ft.last_played,
             wr.wr_time, wr.wr_pid, wr.wr_version, wr.wr_race_id
      FROM map m
      LEFT JOIN (SELECT map_id, COUNT(*) records FROM race GROUP BY map_id) rc
             ON rc.map_id = m.id
      -- last_played: most recent attempt-or-finish by ANYONE on the map; NULL
      -- when no tally exists (e.g. topscores-only history, never played live).
      LEFT JOIN (
        SELECT map_id, SUM(finishes) finishes,
               NULLIF(MAX(GREATEST(COALESCE(last_finish, 0),
                                   COALESCE(last_attempt, 0))), 0) AS last_played
        FROM run_tally GROUP BY map_id
      ) ft ON ft.map_id = m.id
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
    CREATE INDEX ON map_index_new(last_played DESC NULLS LAST);
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
  played: "mi.last_played",
});
const PLAYER_SORTS = Object.assign(Object.create(null), {
  points: "points",
  sr: "sr",
  wr: "wr",
  podium: "podium",
  maps: "maps",
  rank: "rank",
  name: "lower(p.simplified)",
  active: "s.last_active",
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
    // Offensive-name censoring config: word-list matcher (shared by player AND
    // map names) + per-player and per-map override maps, loaded from
    // censor_term/player_censor/map_censor and refreshed on a timer + admin edit.
    // Starts empty (a no-op matcher) so reads before the first load never throw.
    this._censor = {
      matcher: buildMatcher([]),
      overrides: new Map(),
      mapOverrides: new Map(), // by map id
      mapOverridesByName: new Map(), // by lowercased map name, for sync/no-id display spots
    };
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
      maps: num(
        (await one("SELECT COUNT(*) c FROM map m WHERE NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = m.id)")).c
      ),
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
    const hallOfFame = (
      await this.all(
        `SELECT s.rank, s.player_id id, p.name, p.simplified, s.points, s.sr, s.wr, s.podium, s.maps
         FROM standings s JOIN player p ON p.id = s.player_id
         ORDER BY s.rank LIMIT 20`
      )
    ).map((r) =>
      this._censorNamed({ ...r, rank: num(r.rank), id: num(r.id), srRanked: srIsRanked(r.maps) }, num(r.id))
    );
    const recent = await this.recentRecords(8);
    const lastUpdate = await this.one("SELECT value FROM config WHERE key='last_update'");
    return {
      lastUpdate: lastUpdate ? parseInt(lastUpdate.value, 10) : null,
      totals,
      versions,
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
    ).map((r) =>
      this._censorMapped(
        this._censorNamed(
          {
            ...r,
            id: num(r.id),
            map_id: num(r.map_id),
            player_id: num(r.player_id),
            created_at: num(r.created_at),
            versionName: null,
          },
          num(r.player_id)
        ),
        num(r.map_id)
      )
    );
  }

  // Recent finishes from the full finish log (every completed run, not just PBs
  // — those are `race`/recentRecords). Optionally scoped to one map or one
  // player (canonical id). Carries each run's checkpoint splits so the map/
  // player pages can show per-run split breakdowns, and `pb` marks the run that
  // equals the player's current best on that map. Powers the per-map and
  // per-player finish history.
  async recentFinishes({ limit = 12, mapId = null, playerId = null } = {}) {
    // Build the filters dynamically: the `$n IS NULL OR col = $n` form forces
    // the generic plan to cover both shapes, which keeps Postgres off the
    // scoped indexes ((map_id, created_at), (player_id, created_at)).
    const conds = [];
    const args = [];
    if (mapId != null) { args.push(mapId); conds.push(`f.map_id = $${args.length}`); }
    if (playerId != null) { args.push(playerId); conds.push(`pl.canonical_id = $${args.length}`); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    args.push(limit);
    return (
      await this.all(
        `SELECT f.id, f.time, f.created_at, f.map_id, m.name AS map,
                pl.canonical_id AS player_id, disp.name, disp.simplified,
                sv.name AS server,
                (b.time IS NOT NULL AND f.time <= b.time) AS pb,
                COALESCE(
                  (SELECT array_agg(fc.time ORDER BY fc.number)
                     FROM finish_checkpoint fc WHERE fc.finish_id = f.id),
                  ARRAY[]::integer[]
                ) AS checkpoints
         FROM finish f
         JOIN player pl ON pl.id = f.player_id
         JOIN map m ON m.id = f.map_id
         JOIN player disp ON disp.id = pl.canonical_id
         LEFT JOIN server sv ON sv.id = f.server_id
         LEFT JOIN best b ON b.map_id = f.map_id AND b.player_id = pl.canonical_id
         ${where}
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT $${args.length}`,
        args
      )
    ).map((r) =>
      this._censorMapped(
        this._censorNamed(
          {
            id: num(r.id),
            time: num(r.time),
            created_at: num(r.created_at),
            map_id: num(r.map_id),
            map: r.map,
            player_id: num(r.player_id),
            name: r.name,
            simplified: r.simplified,
            server: r.server,
            pb: !!r.pb,
            checkpoints: (r.checkpoints || []).map(num),
          },
          num(r.player_id)
        ),
        num(r.map_id)
      )
    );
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
      out.push(
        this._censorMapped(
          this._censorNamed(
            {
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
            },
            undefined,
            "raw_name",
            "player"
          ),
          num(r.map_id)
        )
      );
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
      `SELECT id, name, status, created_at, last_seen_at, records, address, rcon_password,
              restart_requested_at, restart_requested_by, restart_acked_at
       FROM server WHERE id = $1`,
      [id]
    );
    if (!row) return null;
    return {
      ...row,
      id: num(row.id),
      created_at: num(row.created_at),
      last_seen_at: num(row.last_seen_at),
      records: num(row.records),
      restart_requested_at: num(row.restart_requested_at),
      restart_acked_at: num(row.restart_acked_at),
    };
  }

  // Like servers() but for the admin ops page: adds a boolean `rcon` (whether a
  // password is set) WITHOUT ever returning the secret itself.
  async serversAdmin() {
    return (
      await this.all(
        `SELECT id, name, status, created_at, last_seen_at, records, address,
                (rcon_password IS NOT NULL) AS rcon,
                restart_requested_at, restart_requested_by, restart_acked_at
         FROM server ORDER BY last_seen_at DESC NULLS LAST, id`
      )
    ).map((s) => ({
      ...s,
      id: num(s.id),
      created_at: num(s.created_at),
      last_seen_at: num(s.last_seen_at),
      records: num(s.records),
      rcon: !!s.rcon,
      restart_requested_at: num(s.restart_requested_at),
      restart_acked_at: num(s.restart_acked_at),
    }));
  }

  // --- Force restart (poll-delivered) -----------------------------------------
  // Raise the flag the box's healthcheck watchdog collects on its next poll.
  // Unlike the RCON `quit` path this needs nothing from the engine, so it also
  // works on a server that has stopped answering entirely — the case that
  // motivated it. Re-requesting just refreshes the stamp.
  async requestServerRestart(serverId, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      `UPDATE server SET restart_requested_at = $1, restart_requested_by = $2, restart_acked_at = NULL
       WHERE id = $3`,
      [now, by || null, serverId]
    );
    return r.rowCount > 0;
  }

  // Hand a pending request to the box, exactly once. The clear happens in the
  // same statement that reads it, so two watchdog polls racing (or a poll that
  // arrives twice) cannot both come away with a restart and bounce the server
  // repeatedly. Returns true only for the caller that actually claimed it.
  async claimServerRestart(serverId, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      `UPDATE server SET restart_requested_at = NULL, restart_acked_at = $1
       WHERE id = $2 AND restart_requested_at IS NOT NULL
       RETURNING id`,
      [now, serverId]
    );
    return r.rowCount > 0;
  }

  // Withdraw a request that has not been collected yet (admin changed their
  // mind, or the box was fixed another way).
  async cancelServerRestart(serverId) {
    const r = await this.pool.query(
      "UPDATE server SET restart_requested_at = NULL, restart_requested_by = NULL WHERE id = $1",
      [serverId]
    );
    return r.rowCount > 0;
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
  // Get-or-create by name. DO UPDATE (a no-op rewrite of the unique key) makes
  // RETURNING yield the row even when a concurrent transaction inserted it
  // first — a plain INSERT would raise a unique violation and abort. Same
  // idiom as the ingest and tournament-pool paths.
  //
  // This MINTS A ROW, so it is deliberately not a drop-in for mapIdByName.
  // Every map row is publicly listable (db.js maps() filters only on
  // map_block), so callers must decide the name is trustworthy first. The
  // charset check is a floor, not that decision: it stops path traversal and
  // control characters, it cannot tell a real map from a typo.
  //
  // Returns null for a name that fails the charset check — never a partial row.
  async ensureMapByName(name) {
    const n = String(name || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(n)) return null;
    const row = await this.one(
      `INSERT INTO map (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [n]
    );
    return row ? num(row.id) : null;
  }
  // Real (un-censored) map name for a map id. Used by the /map/:id/padpork
  // redirect so an offensive map name resolves to its external page WITHOUT the
  // name ever reaching the client.
  async mapNameById(id) {
    const row = await this.one("SELECT name FROM map WHERE id = $1", [id]);
    return row ? row.name : null;
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
       SELECT k.rid, k.time, k.cid, rep.name
       FROM k JOIN player rep ON rep.id = k.cid
       WHERE k.rn = 1 ORDER BY k.time, k.rid LIMIT 50`,
      [map.id]
    );
    const sanitize = (n) => String(n).replace(/["\r\n\t]/g, "").slice(0, 64);

    // All 50 rows' checkpoints in one round trip (was one query per row).
    const rids = top.map((r) => num(r.rid));
    const cpsByRace = new Map();
    if (rids.length) {
      for (const c of await this.all(
        "SELECT race_id, time FROM checkpoint WHERE race_id = ANY($1) ORDER BY race_id, number",
        [rids]
      )) {
        const rid = num(c.race_id);
        if (!cpsByRace.has(rid)) cpsByRace.set(rid, []);
        cpsByRace.get(rid).push(c.time | 0);
      }
    }

    let body = `//${name} top scores\n\n`;
    for (const r of top) {
      const cleanName = sanitize(this._cn(r.name, r.cid));
      if (!cleanName) continue; // empty token would truncate the loader
      const sectors = cpsByRace.get(num(r.rid)) || [];
      let line = `"${r.time}" "${cleanName}" "${sectors.length}" `;
      for (const s of sectors) line += `"${s}" `;
      body += line + "\n";
    }
    return body;
  }

  // Live per-map global ranks for game servers (GET /api/game/ranks?map=).
  // Unlike gameTopscoresText (top-50 only), this returns EVERY finisher so the
  // in-game scoreboard can show a true "Pos" for players ranked past 50.
  // Deduped by canonical_id (a player's nick-variants collapse to their single
  // best) and ranked by time with dense ties — matching how the site and
  // race.global_rank rank a map. Computed LIVE from `race` (whose global_rank
  // the ingest keeps current, db.js ingest UPDATE ... RANK() OVER) rather than
  // the batch-built `best` table, so a rank is correct the moment a record
  // lands and the cache is evicted.
  //
  // Format mirrors the other game payloads' leading "//" so the fetch native can
  // reject a captive-portal / proxy error page answering 200:
  //   //ranks <total_finishers>
  //   <rank> <raw display name>
  // The raw (colour-coded) representative name is emitted verbatim; the game
  // applies the SAME removeColorTokens().tolower() to it AND to each client name
  // before matching, so normalisation can never drift between the two sides. A
  // player racing under a different nick than their canonical representative
  // won't match — identical to how the local top-50 board already matches by the
  // name a record was set under.
  async gameRanksText(mapName) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return null;
    const map = await this.one("SELECT id FROM map WHERE name = $1", [name]);
    if (!map) return null;

    const rows = await this.all(
      `WITH bests AS (
         SELECT pl.canonical_id AS cid, MIN(r.time) AS t
         FROM race r JOIN player pl ON pl.id = r.player_id
         WHERE r.map_id = $1
         GROUP BY pl.canonical_id
       )
       SELECT rep.name AS name, b.cid AS cid, RANK() OVER (ORDER BY b.t) AS rank
       FROM bests b JOIN player rep ON rep.id = b.cid
       ORDER BY rank, rep.name`,
      [map.id]
    );

    // Strip only line/field separators so a name can't break the line framing;
    // colour codes and spaces are kept (the game cleans them itself). Cap the
    // length for parity with the topscores payload.
    const sanitize = (n) => String(n).replace(/[\r\n\t]/g, "").slice(0, 64);

    // Header carries the TRUE total-finisher count (rows.length) even if a rare
    // empty-name row is skipped from the body below.
    let body = `//ranks ${rows.length}\n`;
    for (const r of rows) {
      const nm = sanitize(this._cn(r.name, r.cid));
      if (!nm) continue; // an empty name would be an unmatchable, malformed line
      body += `${num(r.rank)} ${nm}\n`;
    }
    return body;
  }

  // One player's current Skill Rating, looked up by the identKey() form of a
  // nick (the same normalisation gamePlayerRecordText matches records with), or
  // 0 when they have none. Several canonical groups can share one identKey form
  // (historic logins that never merged), so the best rating of the matches wins
  // — the same "best of the matches" posture the record lookup takes with time.
  //
  // `standings` is built by the aggregate refresh, not by a migration, so on a
  // brand-new database it does not exist yet: a failed lookup degrades to 0
  // (blank SR column) rather than failing the whole player-record fetch, which
  // seeds records and checkpoint splits the game needs more than a rating.
  async playerSkillRating(cleanKey) {
    if (!cleanKey) return 0;
    try {
      const row = await this.one(
        // Unranked players (< SR_MIN_MAPS) are filtered out here rather than
        // zeroed after the MAX: otherwise one unranked alias could out-rank the
        // player's real rated group and blank an SR the scoreboard should show.
        `SELECT MAX(s.sr)::int AS sr
         FROM standings s
         WHERE s.maps >= ${SR_MIN_MAPS}
           AND s.player_id IN (
           SELECT DISTINCT pl.canonical_id FROM player pl
           WHERE trim(regexp_replace(
                   lower(regexp_replace(pl.name, '\\^[0-9]', '', 'g')),
                   '\\s*\\(\\d+\\)\\s*$', '')) = $1
         )`,
        [cleanKey]
      );
      return row && row.sr != null ? num(row.sr) : 0;
    } catch {
      return 0; // no standings table yet (pre-first-refresh) => unrated
    }
  }

  // One player's personal best on a map for game servers (GET
  // /api/game/player-record?map=&name=). The hrace gametype fetches this the
  // moment a player joins (hrace/playerrecord.as, via the RS_ApiFetchPlayerRecord
  // native) and seeds that player's best_recordTime — rank, finish time AND the
  // checkpoint splits — so the scoreboard "Pos"/time works for players ranked
  // PAST the local top-50 board, and the live per-checkpoint comparison is ready
  // from their first run this session (no re-finish needed).
  //
  // `name` is a colour-stripped, lowercased nick the game derived with
  // removeColorTokens().tolower(); we normalise it with identKey() — the SAME
  // basis canonical grouping uses (strip ^N, lower, drop a trailing "(N)"
  // collision suffix, trim) — and match it against every nick that finished this
  // map, then resolve to that nick's CANONICAL group so a player's colour/(N)
  // variants collapse to their single best (identical grouping to gameRanksText
  // / the site). The rank is that group's RANK() over the field — the same
  // number gameRanksText would emit for the player's line in the ranks blob.
  //
  // The header also carries the player's GLOBAL Skill Rating (see the SR_* block
  // at the top of this file), which the gametype shows in its own scoreboard
  // column. SR is map-independent, so this per-player fetch is the natural
  // carrier: it already fires once per join/rename, for exactly the players the
  // scoreboard lists. 0 = unrated/unknown (the game leaves the column blank).
  //
  // Format reuses the topscores single-record line so the game's existing
  // token-based loader parses it unchanged, behind a leading "//" the fetch
  // native uses to reject captive-portal / proxy error bodies:
  //   //playerrec <rank> <total_finishers> <sr>
  //   "<time>" "<cleanName>" "<numSectors>" "<sector0>" "<sector1>" ...
  // A player with an SR but no record HERE (never finished this map, or a mirror
  // bot racing on a peer server) still gets the header alone — "//playerrec 0 0
  // <sr>": rank 0 reads as "no rank" on the game side, so only the SR lands.
  // Two fail-open return values: null = unknown/unsafe map (a 404 upstream,
  // matching the other game payloads); "" (empty body, 200) = known map and
  // nothing at all to say about this player (no record here AND no rating) — the
  // game leaves its board seed untouched (the fetch native rejects a non-"//"
  // body, so an empty body reads as "none").
  async gamePlayerRecordText(mapName, playerName) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return null;
    const map = await this.one("SELECT id FROM map WHERE name = $1", [name]);
    if (!map) return null;
    // identKey() is the JS twin of the game's removeColorTokens().tolower() AND
    // the basis canonical grouping uses (strip ^N, lower, drop a trailing "(N)"
    // collision suffix, trim); the SQL below applies the same transform to
    // player.name so a PB set under a colour/(N) variant is still found.
    const clean = identKey(playerName);
    if (!clean) return ""; // name normalised to nothing => no findable record

    // Global rating for the scoreboard's SR column (0 = unrated/unknown).
    const sr = await this.playerSkillRating(clean);

    // Fastest race per canonical group (rn=1), ranked by time across all groups
    // (identical bests/RANK() shape to gameRanksText, so the rank is byte-equal
    // to this player's line in the ranks blob); `match` is the canonical group(s)
    // that finished this map under a nick whose identKey form equals the request.
    const row = await this.one(
      `WITH k AS (
         SELECT pl.canonical_id cid, r.id rid, r.time,
                ROW_NUMBER() OVER (PARTITION BY pl.canonical_id ORDER BY r.time, r.id) rn
         FROM race r JOIN player pl ON pl.id = r.player_id
         WHERE r.map_id = $1
       ),
       winners AS ( SELECT cid, rid, time FROM k WHERE rn = 1 ),
       ranked AS (
         SELECT cid, rid, time,
                RANK() OVER (ORDER BY time) rank,
                COUNT(*) OVER () total
         FROM winners
       ),
       match AS (
         SELECT DISTINCT pl.canonical_id cid
         FROM race r JOIN player pl ON pl.id = r.player_id
         WHERE r.map_id = $1
           AND trim(regexp_replace(
                 lower(regexp_replace(pl.name, '\\^[0-9]', '', 'g')),
                 '\\s*\\(\\d+\\)\\s*$', '')) = $2
       )
       SELECT rk.rank, rk.time, rk.rid, rk.cid, rk.total, rep.name AS name
       FROM ranked rk
       JOIN player rep ON rep.id = rk.cid
       WHERE rk.cid IN (SELECT cid FROM match)
       ORDER BY rk.time
       LIMIT 1`,
      [map.id, clean]
    );
    // Known map, no record for this player here: still worth a header-only body
    // when they carry a rating, so the scoreboard's SR column fills in for a
    // player who has never finished THIS map. Rank 0 => the game stamps no Pos.
    if (!row) return sr > 0 ? `//playerrec 0 0 ${sr}\n` : "";

    const sanitize = (n) => String(n).replace(/["\r\n\t]/g, "").slice(0, 64);
    const cleanName = sanitize(this._cn(row.name, row.cid));
    // Unmatchable name token => treat as no record (SR still travels).
    if (!cleanName) return sr > 0 ? `//playerrec 0 0 ${sr}\n` : "";

    const sectors = (
      await this.all(
        "SELECT time FROM checkpoint WHERE race_id = $1 ORDER BY number",
        [num(row.rid)]
      )
    ).map((c) => c.time | 0);

    let body = `//playerrec ${num(row.rank)} ${num(row.total)} ${sr}\n`;
    let line = `"${num(row.time)}" "${cleanName}" "${sectors.length}" `;
    for (const s of sectors) line += `"${s}" `;
    return body + line + "\n";
  }

  // --------------------------------------------------------------------------
  // Saved START positions: where a player wants to spawn on a map -----------
  // Set in-game with /savestart and restored on rejoin. One row per (canonical
  // player, map, direction). See migration 20260728140000000_player_saved_start.

  // One player's saved start(s) for a map, as the plain-text blob the game polls
  // per player on join (hrace/savedstarts.as via RS_ApiFetchSavedStart). Matches
  // the player by clean nick exactly like gamePlayerRecordText, resolves to their
  // canonical group, and emits a "//starts" header (the fetch native rejects
  // non-"//" bodies) then one line per saved direction, most-recent wins:
  //   //starts
  //   race <x> <y> <z> <pitch> <yaw> <roll>
  //   reverse <x> <y> <z> <pitch> <yaw> <roll>
  // A bare "//starts\n" = this player has no saved start here (fail-open: the game
  // leaves them at the map default). null (unknown/invalid map) => 404 upstream.
  async savedStartText(mapName, playerName) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return null;
    const map = await this.one("SELECT id FROM map WHERE name = $1", [name]);
    if (!map) return null;
    const clean = simplifyName(playerName).toLowerCase();
    if (!clean) return "//starts\n";

    const rows = await this.all(
      `SELECT s.mode AS mode, s.loc_x, s.loc_y, s.loc_z, s.ang_x, s.ang_y, s.ang_z
       FROM player_saved_start s
       WHERE s.map_id = $1
         AND s.player_id IN (
           SELECT DISTINCT pl.canonical_id FROM player pl
           WHERE lower(regexp_replace(pl.name, '\\^[0-9]', '', 'g')) = $2
         )
       ORDER BY s.updated_at DESC`,
      [map.id, clean]
    );

    const fmt = (v) => Number(v).toFixed(3);
    const seen = {};
    let body = "//starts\n";
    for (const r of rows) {
      if (r.mode !== "race" && r.mode !== "reverse") continue;
      if (seen[r.mode]) continue; // one line per direction (most-recent first)
      seen[r.mode] = true;
      body += `${r.mode} ${fmt(r.loc_x)} ${fmt(r.loc_y)} ${fmt(r.loc_z)} ${fmt(r.ang_x)} ${fmt(r.ang_y)} ${fmt(r.ang_z)}\n`;
    }
    return body;
  }

  // In-game "achievement unlocked" poll (hrace/awards.as via the
  // RS_ApiFetchAwards native, one fetch per player slot). Stateless by design:
  // the GAME keeps the high-water award row id per slot and asks for rows above
  // it — nothing is marked "notified" here, because a public game GET must stay
  // side-effect-free (cacheable, spoofable). Two modes:
  //   seed=true   the join-time fetch: just the NEWEST row (or nothing), so the
  //               gametype can set its high-water mark without replaying the
  //               player's award history as popups.
  //   after=N     rows with id > N, OLDEST first, capped — the poll announces in
  //               earn order and ends holding the newest id; a burst larger than
  //               the cap pages itself out over successive polls.
  // Header "//awards" (the native rejects non-"//" bodies as captive-portal
  // noise), then one "<rowId>\t<tier>\t<title>\t<description>" line per award —
  // tab-delimited because titles carry spaces; tabs/control chars are stripped
  // from the text fields so the line shape survives any admin-entered text.
  // Awards are stored under the canonical rep id, so match the name's whole
  // canonical group like savedStartText does. null = unusable name (route 404s).
  async gameAwardsText(playerName, { after = 0, seed = false } = {}) {
    const clean = simplifyName(playerName).toLowerCase();
    if (!clean) return null;
    const aft = Math.max(0, Math.floor(Number(after) || 0));
    const strip = (s) =>
      String(s || "")
        .replace(/[\x00-\x1f\x7f]+/g, " ")
        .trim();
    const groupSql = `SELECT DISTINCT COALESCE(pl.canonical_id, pl.id) FROM player pl
         WHERE lower(regexp_replace(pl.name, '\\^[0-9]', '', 'g')) = $1`;
    const rows = seed
      ? await this.all(
          `SELECT pa.id, a.tier, a.title, a.description
           FROM player_achievement pa JOIN achievement a ON a.id = pa.achievement_id
           WHERE pa.player_id IN (${groupSql})
           ORDER BY pa.id DESC LIMIT 1`,
          [clean]
        )
      : await this.all(
          `SELECT pa.id, a.tier, a.title, a.description
           FROM player_achievement pa JOIN achievement a ON a.id = pa.achievement_id
           WHERE pa.player_id IN (${groupSql}) AND pa.id > $2
           ORDER BY pa.id ASC LIMIT 20`,
          [clean, aft]
        );
    let body = "//awards\n";
    for (const r of rows) body += `${num(r.id)}\t${strip(r.tier)}\t${strip(r.title)}\t${strip(r.description)}\n`;
    return body;
  }

  // Store (or replace) a player's saved start for a map+direction. Resolves the
  // raw (name, login) to its CANONICAL player id — like the replay upserts — so
  // aliases share one row and a returning player matches by nick. `origin` and
  // `angles` are [x,y,z]. Most-recent-wins (the player is explicitly moving their
  // spawn). Creates the map row if new (a start can be saved on a never-finished
  // map). Returns true.
  async upsertPlayerSavedStart({ map, name, login = "", mode, origin, angles, serverId = null }) {
    const m = String(mode) === "reverse" ? "reverse" : "race";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const q1 = async (sql, params) => (await client.query(sql, params)).rows[0];
      const mapRow = await q1(
        `INSERT INTO map (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [String(map).toLowerCase()]
      );
      const rawPlayerId = await this._resolvePlayer(client, { name, login });
      const cRow = (await client.query("SELECT canonical_id FROM player WHERE id = $1", [rawPlayerId])).rows[0];
      const playerId = cRow && cRow.canonical_id != null ? num(cRow.canonical_id) : rawPlayerId;
      await client.query(
        `INSERT INTO player_saved_start
           (player_id, map_id, mode, loc_x, loc_y, loc_z, ang_x, ang_y, ang_z, server_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (player_id, map_id, mode) DO UPDATE SET
           loc_x = EXCLUDED.loc_x, loc_y = EXCLUDED.loc_y, loc_z = EXCLUDED.loc_z,
           ang_x = EXCLUDED.ang_x, ang_y = EXCLUDED.ang_y, ang_z = EXCLUDED.ang_z,
           server_id = EXCLUDED.server_id, updated_at = EXCLUDED.updated_at`,
        [
          playerId, num(mapRow.id), m,
          Number(origin[0]), Number(origin[1]), Number(origin[2]),
          Number(angles[0]), Number(angles[1]), Number(angles[2]),
          serverId, Math.floor(Date.now() / 1000),
        ]
      );
      await client.query("COMMIT");
      return true;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Remove a player's saved start for a map+direction (in-game /clearstart). Looks
  // up existing ids only (never creates rows). Returns true if a row was removed.
  async deletePlayerSavedStart({ map, name, login = "", mode }) {
    const m = String(mode) === "reverse" ? "reverse" : "race";
    const mapRow = await this.one("SELECT id FROM map WHERE name = $1", [String(map).toLowerCase()]);
    if (!mapRow) return false;
    const rep = await this.one("SELECT player_id FROM canonical WHERE key = $1", [canonKey(simplifyName(name), login)]);
    if (!rep) return false;
    const r = await this.pool.query(
      "DELETE FROM player_saved_start WHERE player_id = $1 AND map_id = $2 AND mode = $3",
      [num(rep.player_id), num(mapRow.id), m]
    );
    return r.rowCount > 0;
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
        [
          ids.mapId, ids.playerId, ids.versionId, time, demoPath, bytes, serverId,
          Math.floor(Date.now() / 1000),
        ]
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
    // Compress BEFORE the transaction (and off the event loop): gzipping a
    // multi-MB trajectory while holding the FOR UPDATE row lock stalled every
    // concurrent upload for that (map, player) and blocked the whole process.
    const payload = { v: 1, map, player: name, login, time, hz, cps, frames };
    const gz = await gzipAsync(Buffer.from(JSON.stringify(payload)));

    const taken = await this._withReplayIds({ version, map, name, login }, async (client, ids) => {
      const existing = (await client.query(
        "SELECT time FROM player_ghost WHERE map_id = $1 AND player_id = $2 FOR UPDATE",
        [ids.mapId, ids.playerId]
      )).rows[0];
      if (existing && existing.time <= time) return null;

      await client.query(
        `INSERT INTO player_ghost (map_id, player_id, version_id, time, hz, frames, bytes, server_id, captured_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (map_id, player_id) DO UPDATE SET
           version_id = EXCLUDED.version_id, time = EXCLUDED.time, hz = EXCLUDED.hz,
           frames = EXCLUDED.frames, bytes = EXCLUDED.bytes, server_id = EXCLUDED.server_id,
           captured_at = EXCLUDED.captured_at, payload = EXCLUDED.payload`,
        [ids.mapId, ids.playerId, ids.versionId, time, hz, frames.length, gz.length, serverId, Math.floor(Date.now() / 1000), gz]
      );
      return ids;
    });
    if (!taken) return false;

    // Write the local file only after the row is committed: a rollback can no
    // longer leave a file newer than the DB. If the write fails the DB payload
    // is still durable — ghostGzip() restores the file on the next read.
    const file = this._ghostPath(taken.mapId, taken.playerId);
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, gz);
    } catch (e) {
      console.error(`ghost file write failed (payload is in the DB): ${file}:`, e?.message ?? e);
    }
    return true;
  }

  // Read the gzipped ghost bytes for one specific (map, player): the local file
  // if present, else the durable DB payload (restoring the file for later reads
  // + the heatmap). null when the row has neither a file nor a payload — an
  // orphan captured before the payload column whose file was lost to a volume
  // reset (see syncGhostPayloads). Assumes the row exists.
  async _readGhostBytes(mapId, pid) {
    const file = this._ghostPath(mapId, pid);
    try {
      return await fs.promises.readFile(file);
    } catch {
      const row = await this.one("SELECT payload FROM player_ghost WHERE map_id = $1 AND player_id = $2", [mapId, pid]);
      if (!row || !row.payload) return null;
      const buf = Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload);
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); } catch { /* read-only fs: still serve */ }
      return buf;
    }
  }

  // Raw gzipped ghost JSON for a (map, player), served with Content-Encoding:
  // gzip to the browser viewer. playerId omitted => the map's fastest recorded
  // ghost (the WR replay). null if there is no such ghost / the file is missing.
  async ghostGzip(mapId, playerId = null) {
    if (playerId != null) {
      if (!(await this.one("SELECT 1 FROM player_ghost WHERE map_id = $1 AND player_id = $2", [mapId, playerId])))
        return null;
      return this._readGhostBytes(mapId, num(playerId));
    }
    // WR replay: the fastest ghost we can ACTUALLY serve. A fastest-but-lost
    // legacy row (no local file AND no DB payload — captured before the payload
    // column, its file gone to a volume reset) must not shadow the recoverable
    // ghosts behind it, or the map serves no WR ghost at all even though slower,
    // intact ghosts exist (and the in-game ghost racer + browser replay go
    // blank). Walk candidates fastest-first and return the first that yields
    // bytes. Cheap: rows/map are few, this endpoint is cache-fronted, and the
    // common case (fastest row intact) returns on the first iteration.
    const rows = (await this.pool.query(
      "SELECT player_id FROM player_ghost WHERE map_id = $1 ORDER BY time ASC",
      [mapId]
    )).rows;
    for (const r of rows) {
      const buf = await this._readGhostBytes(mapId, num(r.player_id));
      if (buf) return buf;
    }
    return null;
  }

  // Reconcile the ghost files on disk with the durable DB payloads: backfill a
  // payload from any file that predates the payload column, and restore any file
  // lost to a volume reset from its stored payload. Idempotent; run on startup so
  // the shared /data mount holds every ghost we can prove we captured. Rows with
  // neither a file nor a payload are unrecoverable (lost before this fix).
  async syncGhostPayloads() {
    const rows = (await this.pool.query(
      "SELECT map_id, player_id, (payload IS NOT NULL) AS has_payload FROM player_ghost"
    )).rows;
    let backfilled = 0, restored = 0, lost = 0;
    for (const r of rows) {
      const file = this._ghostPath(r.map_id, r.player_id);
      const onDisk = fs.existsSync(file);
      if (!r.has_payload && onDisk) {
        try {
          const buf = fs.readFileSync(file);
          await this.pool.query(
            "UPDATE player_ghost SET payload = $1 WHERE map_id = $2 AND player_id = $3 AND payload IS NULL",
            [buf, r.map_id, r.player_id]
          );
          backfilled++;
        } catch { /* unreadable file — skip */ }
      } else if (r.has_payload && !onDisk) {
        const pr = (await this.pool.query(
          "SELECT payload FROM player_ghost WHERE map_id = $1 AND player_id = $2", [r.map_id, r.player_id]
        )).rows[0];
        if (pr && pr.payload) {
          const buf = Buffer.isBuffer(pr.payload) ? pr.payload : Buffer.from(pr.payload);
          try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); restored++; } catch { /* skip */ }
        }
      } else if (!r.has_payload && !onDisk) {
        lost++;
      }
    }
    if (backfilled || restored || lost)
      console.log(`ghost sync: backfilled ${backfilled} payload(s), restored ${restored} file(s)${lost ? `, ${lost} unrecoverable` : ""}`);
    return { backfilled, restored, lost };
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
      g = JSON.parse((await gunzipAsync(buf)).toString("utf8"));
    } catch {
      return null;
    }
    const frames = Array.isArray(g.frames) ? g.frames : [];
    const cleanName = this._cn(String(g.player || ""))
      .replace(/[\r\n\t]/g, "")
      .slice(0, 64);
    let body = `RSGHOST 1 ${g.hz | 0} ${g.time | 0} ${frames.length}\n`;
    body += cleanName + "\n";
    body += (Array.isArray(g.cps) ? g.cps.map((n) => n | 0).join(" ") : "") + "\n";
    for (const f of frames) {
      // 9 numbers, fixed order; trailing-space-free, one frame per line.
      body += f.map((v) => (Math.round(Number(v) * 1000) / 1000)).join(" ") + "\n";
    }
    return body;
  }

  async maps({ q = "", sort = "records", order, limit, offset, weapon = "" } = {}) {
    const col = MAP_SORTS[sort] || MAP_SORTS.records;
    const direction = dir(order, sort === "name" ? "ASC" : "DESC");
    const lim = clampLimit(limit);
    const off = toOffset(offset);

    // Build the WHERE incrementally so the weapon/strafe filter and the name
    // search share one parameter list (both the COUNT and the page query use it).
    const conds = ["NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = mi.map_id)"];
    const args = [];
    if (q) {
      args.push(`%${likeEscape(q)}%`);
      conds.push(`mi.name ILIKE $${args.length}`);
    }
    const { codes, strafe, slick } = parseWeaponFilter(weapon);
    if (slick) {
      // Measured slick floor share, thresholded at query time so retuning
      // SLICK_MIN_FRAC needs no re-scan (partial index on slick_frac > 0).
      args.push(SLICK_MIN_FRAC);
      conds.push(
        `EXISTS (SELECT 1 FROM map_weapon w WHERE w.name = lower(mi.name) AND w.slick_frac >= $${args.length})`
      );
    }
    if (codes.length) {
      // weapons @> ARRAY[...] => the map carries ALL requested weapons (GIN idx).
      args.push(codes);
      conds.push(
        `EXISTS (SELECT 1 FROM map_weapon w WHERE w.name = lower(mi.name) AND w.weapons @> $${args.length})`
      );
    }
    if (strafe) {
      // Same union as the in-game randmap: scanned-strafe OR a "strafe" map name.
      conds.push(
        `(EXISTS (SELECT 1 FROM map_weapon w WHERE w.name = lower(mi.name) AND w.is_strafe) OR mi.name ILIKE '%strafe%')`
      );
    }
    const where = `WHERE ${conds.join(" AND ")}`;

    const total = num((await this.one(`SELECT COUNT(*) c FROM map_index mi ${where}`, args)).c);
    const rows = (
      await this.all(
        `SELECT mi.map_id AS id, mi.name, mi.records, mi.finishes, mi.players, mi.wr_time,
                mi.last_played, mi.wr_pid, mi.wr_version, p.name AS wr_name, p.simplified AS wr_simplified,
                w.weapons, w.is_strafe, w.slick_frac
         FROM map_index mi
         LEFT JOIN player p ON p.id = mi.wr_pid
         LEFT JOIN map_weapon w ON w.name = lower(mi.name)
         ${where}
         ORDER BY ${col} ${direction} NULLS LAST, lower(mi.name) ASC
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, lim, off]
      )
    ).map((r) => this._censorMapped(this._censorNamed({
      ...r,
      id: num(r.id),
      wr_pid: num(r.wr_pid),
      wr_version: num(r.wr_version),
      races: r.records,
      last_played: r.last_played != null ? num(r.last_played) : null,
      wr_version_name: this.versions[num(r.wr_version)] || null,
      weapons: Array.isArray(r.weapons) ? r.weapons : [],
      is_strafe: !!r.is_strafe,
      // Rounded to whole percent: the tag reads "Slick 34%", and shipping the
      // raw float would imply a precision the grid measurement doesn't have.
      slick_pct: r.slick_frac != null ? Math.round(Number(r.slick_frac) * 100) : 0,
      is_slick: isSlick(r.slick_frac),
    }, num(r.wr_pid), "wr_name", "wr_simplified"), num(r.id), "name"));
    return { total, limit: lim, offset: off, rows };
  }

  // Demo directory index: every map that has at least one recorded demo, with a
  // count + the fastest recorded time + when its newest demo landed. Blocked
  // maps are hidden (same as maps()); names are censored on the way out.
  async demoMaps({ q = "", limit, offset } = {}) {
    const lim = clampLimit(limit);
    const off = toOffset(offset);
    const conds = ["NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = d.map_id)"];
    const args = [];
    if (q) {
      args.push(`%${likeEscape(q)}%`);
      conds.push(`m.name ILIKE $${args.length}`);
    }
    const where = `WHERE ${conds.join(" AND ")}`;
    const total = num(
      (await this.one(
        `SELECT COUNT(DISTINCT d.map_id) c FROM player_demo d JOIN map m ON m.id = d.map_id ${where}`,
        args
      )).c
    );
    const rows = (
      await this.all(
        `SELECT d.map_id AS id, m.name,
                COUNT(*)           AS demos,
                MIN(d.time)        AS fastest,
                MAX(d.captured_at) AS latest
         FROM player_demo d JOIN map m ON m.id = d.map_id
         ${where}
         GROUP BY d.map_id, m.name
         ORDER BY latest DESC NULLS LAST, lower(m.name) ASC
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, lim, off]
      )
    ).map((r) =>
      this._censorMapped(
        {
          id: num(r.id),
          name: r.name,
          demos: num(r.demos),
          fastest: r.fastest != null ? num(r.fastest) : null,
          latest: r.latest != null ? num(r.latest) : null,
        },
        num(r.id),
        "name"
      )
    );
    return { total, limit: lim, offset: off, rows };
  }

  // Shape one player_demo row (joined to player) for the public API: who ran it,
  // when it was captured, and the direct download URL (null when DEMO_BASE_URL
  // is unset — the UI hides the button). Names are censored on the way out.
  _demoRow(r) {
    return this._censorNamed(
      {
        playerId: num(r.player_id),
        name: r.name,
        simplified: r.simplified,
        time: r.time,
        bytes: r.bytes != null ? num(r.bytes) : null,
        captured_at: r.captured_at != null ? num(r.captured_at) : null,
        version: this.versions[num(r.version_id)] || null,
        url: DEMO_BASE_URL ? `${DEMO_BASE_URL}/demos/${r.demo_path}` : null,
        path: r.demo_path,
      },
      num(r.player_id)
    );
  }

  // One map's demos: every player's PB demo, fastest first, each carrying its
  // own download URL (null when DEMO_BASE_URL is unset — the button is hidden).
  // Returns null for an unknown map so the route can 404.
  async demosForMap(id) {
    const map = await this.one("SELECT id, name FROM map WHERE id = $1", [id]);
    if (!map) return null;
    const demos = (
      await this.all(
        `SELECT d.player_id, d.time, d.demo_path, d.bytes, d.captured_at, d.version_id,
                p.name, p.simplified
         FROM player_demo d JOIN player p ON p.id = d.player_id
         WHERE d.map_id = $1
         ORDER BY d.time ASC`,
        [id]
      )
    ).map((r) => this._demoRow(r));
    return {
      map: this._censorMapped({ id: num(map.id), name: map.name }, num(map.id), "name"),
      demos,
    };
  }

  // The whole demo catalogue in one feed: the directory index (demoMaps) with
  // each map's per-player demo list inlined, so a client can mirror/archive
  // everything without an N+1 walk of /api/demos/:mapId. Paged by MAP —
  // limit/offset count maps, and every map carries ALL of its demos, so a page
  // of 200 maps can be a few thousand demo rows. Blocked maps stay hidden and
  // names stay censored, exactly as the two endpoints it composes.
  async allDemos({ q = "", limit, offset } = {}) {
    const index = await this.demoMaps({ q, limit, offset });
    const byMap = new Map(index.rows.map((m) => [m.id, []]));
    if (index.rows.length) {
      for (const r of await this.all(
        `SELECT d.map_id, d.player_id, d.time, d.demo_path, d.bytes, d.captured_at, d.version_id,
                p.name, p.simplified
         FROM player_demo d JOIN player p ON p.id = d.player_id
         WHERE d.map_id = ANY($1)
         ORDER BY d.map_id ASC, d.time ASC`,
        [index.rows.map((m) => m.id)]
      )) {
        const list = byMap.get(num(r.map_id));
        if (list) list.push(this._demoRow(r));
      }
    }
    return {
      total: index.total,
      limit: index.limit,
      offset: index.offset,
      maps: index.rows.map((m) => ({
        id: m.id,
        name: m.name,
        count: m.demos, // demoMaps() reports the count here; `demos` is the list below
        fastest: m.fastest,
        latest: m.latest,
        demos: byMap.get(m.id) || [],
      })),
    };
  }

  async mapDetail(id, { limit } = {}) {
    const map = await this.one("SELECT id, name FROM map WHERE id = $1", [id]);
    if (!map) return null;
    const idx = await this.one("SELECT * FROM map_index WHERE map_id = $1", [id]);
    const lim = clampLimit(limit, 50, 10000);

    const leaderboard = (
      await this.all(
        `SELECT b.player_id, b.time, b.rank AS global_rank, b.version_id AS version,
                p.name, p.simplified
         FROM best b JOIN player p ON p.id = b.player_id
         WHERE b.map_id = $1
         ORDER BY b.time ASC, b.player_id ASC LIMIT $2`,
        [id, lim]
      )
    ).map((r, i) =>
      this._censorNamed(
        {
          pos: i + 1,
          playerId: num(r.player_id),
          name: r.name,
          simplified: r.simplified,
          time: r.time,
          globalRank: r.global_rank,
          version: num(r.version),
          versionName: this.versions[num(r.version)] || null,
        },
        num(r.player_id)
      )
    );

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
        // payload IS NOT NULL => the ghost bytes are servable (see wr.ghost note).
        "SELECT player_id, time, hz, frames FROM player_ghost WHERE map_id = $1 AND player_id = ANY($2) AND payload IS NOT NULL",
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

      // Per-PB run facts: how well the record run was strafed and how many
      // attempts it took (see migration 20260801130000000). `best` is built per
      // CANONICAL player and carries no race id, so re-pick the same PB row here
      // with the identical tie-break buildAggregates uses (fastest time, then
      // lowest race id) — that guarantees this is the very run on the row above.
      const pbByPid = new Map();
      for (const r of await this.all(
        `SELECT DISTINCT ON (pl.canonical_id)
                pl.canonical_id AS player_id, r.strafe_quality, r.attempts
           FROM race r JOIN player pl ON pl.id = r.player_id
          WHERE r.map_id = $1 AND pl.canonical_id = ANY($2)
          ORDER BY pl.canonical_id, r.time ASC, r.id ASC`,
        [id, pids]
      )) pbByPid.set(num(r.player_id), r);
      for (const row of leaderboard) {
        const pb = pbByPid.get(row.playerId);
        // Basis points -> percent, mirroring the profile's strafe readouts.
        // null (not 0) when the run predates the measurement or the server
        // never reported it, so the UI can say "no data" rather than "0%".
        row.strafeQuality = pb && pb.strafe_quality != null ? num(pb.strafe_quality) / 100 : null;
        row.attempts = pb && pb.attempts != null ? num(pb.attempts) : null;
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
      this._censorNamed(wr, wr.playerId); // WR holder name

      // Best-captured replay for this map: the fastest recorded demo/ghost
      // across all players (one PB per player per map, faster-only upsert).
      // That run may pre-date or lag the absolute WR (e.g. the #1 was set before
      // the replay feature, or on a server that didn't capture it). Surface it
      // anyway — a replay of the fastest recorded run beats no replay — carrying
      // its OWN time/holder, with isWr telling the UI whether it's the outright
      // record so it can label a slower replay honestly.
      const demo = await this.one(
        `SELECT d.player_id, d.time, d.demo_path, d.bytes, p.name AS holder, p.simplified AS holder_s
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
        this._censorNamed(wr.demo, num(demo.player_id), "holder", "holderSimplified");
      }
      const g = await this.one(
        // Only advertise a ghost whose trajectory bytes are actually servable:
        // ghostGzip() serves from the DB payload (or a file it restores from the
        // payload), so a row with a NULL payload and a lost file 404s. Requiring
        // payload IS NOT NULL keeps the "Watch replay" button and /replay/:id in
        // sync with what the ghost endpoint can serve. syncGhostPayloads()
        // backfills payload from any surviving file at startup, so this predicate
        // is exactly "recoverable".
        `SELECT g.player_id, g.time, g.hz, g.frames, p.name AS holder, p.simplified AS holder_s
         FROM player_ghost g JOIN player p ON p.id = g.player_id
         WHERE g.map_id = $1 AND g.payload IS NOT NULL ORDER BY g.time ASC LIMIT 1`,
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
        this._censorNamed(wr.ghost, wr.ghost.playerId, "holder", "holderSimplified");
      }
    }

    return {
      id: num(map.id),
      name: this._cnMap(map.name, num(map.id)),
      records: idx ? idx.records : 0,
      races: idx ? idx.records : 0, // legacy alias
      finishes: idx ? idx.finishes : 0,
      recentFinishes: await this.recentFinishes({ limit: 20, mapId: num(map.id) }),
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
      for (const r of rows)
        owner.set(num(r.id), this._censorNamed({ name: r.name, simplified: r.simplified }, undefined));
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
    // Players with no recorded activity yet (last_active NULL) sort last in
    // either direction, so the "last raced" ordering never leads with blanks.
    const nulls = col === PLAYER_SORTS.active ? " NULLS LAST" : "";
    // Sorting by SR asks "who is best" — so the unpublished ratings go last in
    // BOTH directions rather than filling the ascending page with placeholder
    // numbers that are not ratings at all.
    const rankedFirst = col === PLAYER_SORTS.sr ? `(s.maps >= ${SR_MIN_MAPS}) DESC, ` : "";
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
                s.points, s.sr, s.wr, s.podium, s.maps, s.last_active
         FROM standings s JOIN player p ON p.id = s.player_id
         ${where}
         ORDER BY ${rankedFirst}${col} ${direction}${nulls}, s.rank ASC
         LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        [...args, lim, off]
      )
    ).map((r) =>
      this._censorNamed(
        {
          ...r,
          rank: num(r.rank),
          id: num(r.id),
          // The directory still lists everyone; the SR column just renders "—"
          // for players whose rating is not published yet.
          srRanked: srIsRanked(r.maps),
          last_active: r.last_active != null ? num(r.last_active) : null,
        },
        num(r.id)
      )
    );
    return { total, limit: lim, offset: off, rows };
  }

  async playerDetail(id, { sort = "time", order, limit, offset, q, version } = {}) {
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
      "SELECT rank, points, sr, wr, podium, maps FROM standings WHERE player_id = $1",
      [canonId]
    )) || { rank: null, points: 0, sr: 0, wr: 0, podium: 0, maps: 0 };
    if (standing.rank != null) standing.rank = num(standing.rank);
    // SR is published only once the player has finished SR_MIN_MAPS maps; below
    // that the number is mostly the fill prior, not them. The raw `sr` stays on
    // the payload (the breakdown still explains how it is built) — `srRanked`
    // is what decides whether it is shown AS a rating.
    standing.srRanked = srIsRanked(standing.maps);
    standing.srMinMaps = SR_MIN_MAPS;
    standing.srMapsToRank = Math.max(0, SR_MIN_MAPS - num(standing.maps));

    // Rolling-window Skill Rating history for the profile trend chart: the stored
    // daily points (oldest -> newest), already capped to SR_HISTORY_DAYS server
    // side. Always end the series at the *current* SR so the chart runs up to
    // "today" even before today's snapshot has been written (first refresh after
    // midnight) — carrying today's value forward rather than showing a stale tail.
    const today = new Date().toISOString().slice(0, 10);
    // Read-side window bound (UTC, matching the snapshot's day bucketing). Span
    // the full SR_HISTORY_DAYS (today - 30d), NOT today - 29d: the prune runs on
    // the FIRST refresh of each UTC day, so on a quiet day (or just after midnight
    // before that refresh) "today" has already advanced past the last pruned day,
    // and a today-29 cutoff would clip the oldest still-retained row -> 29 days
    // shown instead of 30. today-30 always covers everything the prune keeps, and
    // since the table is itself capped at 30 days it can never over-return.
    const cutoff = new Date(Date.now() - SR_HISTORY_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    // Read across ALL nick variants of this canonical group, not just the current
    // representative id: each daily row is written under whichever id was the
    // representative that day (standings.player_id), so if the representative
    // later flips, earlier rows would otherwise orphan under the old id. One
    // snapshot per day + the (player_id, day) key still yields at most one row per
    // day across the group. LIMIT is a pure backstop (the cutoff already bounds
    // the set) sized just above the window so it can never clip a real point.
    const srHistory = (
      await this.all(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, sr FROM sr_history
         WHERE player_id IN (SELECT id FROM player WHERE canonical_id = $1)
           AND day >= $2::date
         ORDER BY day ASC
         LIMIT ${SR_HISTORY_DAYS + 1}`,
        [canonId, cutoff]
      )
    ).map((r) => ({ day: r.day, sr: num(r.sr) }));
    const curSr = num(standing.sr);
    // An unranked player shows no trend at all. The daily snapshot stopped
    // writing them, but rows banked BEFORE the SR_MIN_MAPS floor existed are
    // still in the table for up to SR_HISTORY_DAYS — without this they would
    // draw a decaying chart for a rating the rest of the page refuses to show.
    if (!standing.srRanked) srHistory.length = 0;
    // Today's live value is appended only for a ranked player. Doing it
    // unconditionally would draw a one-point trend for someone with no published
    // rating — and the daily snapshot no longer writes them, so that point would
    // be the only thing on the chart.
    if (standing.srRanked) {
      const lastPt = srHistory[srHistory.length - 1];
      // Today's stored snapshot is refreshed to the live value rather than left
      // as whatever it was when the day's rows were written.
      if (!lastPt || lastPt.day !== today) srHistory.push({ day: today, sr: curSr });
      else lastPt.sr = curSr;
    }

    // Where this rating sits among everyone else's. Counted here rather than
    // derived client-side from the shared histogram (/api/sr/distribution),
    // because a bucket only knows "somewhere in this 18-point band" and the
    // percentile is the one number the card is actually about. Ranked only:
    // a player with no standings row is not on the board to have a place on it.
    // Both the place and the population it is a place IN are ranked-only, so an
    // unranked player gets no percentile at all rather than one measured against
    // a board they are not on.
    let srPlace = null;
    if (standing.rank != null && srIsRanked(standing.maps)) {
      const pos = await this.one(
        `SELECT COUNT(*)::int                            AS total,
                COUNT(*) FILTER (WHERE sr <  $1)::int    AS below,
                COUNT(*) FILTER (WHERE sr >  $1)::int    AS above
           FROM standings
          WHERE maps >= ${SR_MIN_MAPS}`,
        [curSr]
      );
      const total = num(pos.total);
      if (total > 0)
        srPlace = {
          total,
          // "Ahead of N% of ranked players" — ties are neither ahead nor
          // behind, so they sit outside both this and `rank` by design.
          percentile: Math.round((num(pos.below) / total) * 1000) / 10,
          rank: num(pos.above) + 1,
        };
    }

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

    // Lifetime movement / behaviour metrics summed across every map/version this
    // player (all nick variants) has raced. Rows written before these columns
    // existed contribute 0.
    const mrow = await this.one(
      `SELECT COALESCE(SUM(wall_jumps),0) wj, COALESCE(SUM(dashes),0) da,
              COALESCE(SUM(prejump_failures),0) pj, COALESCE(SUM(restarts),0) rs,
              COALESCE(SUM(distance),0) di, COALESCE(SUM(strafes),0) st
       FROM run_tally WHERE ${groupWhere}`,
      [canonId]
    );
    const metrics = {
      wallJumps: num(mrow.wj),
      dashes: num(mrow.da),
      prejumpFailures: num(mrow.pj),
      restarts: num(mrow.rs),
      distance: num(mrow.di),
      strafes: num(mrow.st),
    };
    // Fastest speed hit in any finished run (ups). NULL until a server with the
    // speed-reporting native delivers a finish — never a misleading 0.
    const spRow = await this.one(`SELECT MAX(max_speed) ms FROM finish WHERE ${groupWhere}`, [canonId]);
    metrics.maxSpeed = spRow && spRow.ms != null ? num(spRow.ms) : null;

    // Air-strafe quality (accel efficiency, stored per finish as basis points
    // 0..10000). Lifetime average across every nick variant for the headline
    // number, then a per-UTC-day average over a rolling window for the trend
    // chart. Both span the canonical group and skip NULLs (pre-column / older
    // servers), matching the SR-history read below. Reported as a percent.
    const sqRow = await this.one(
      `SELECT AVG(strafe_quality) q, COUNT(strafe_quality) n
       FROM finish WHERE ${groupWhere} AND strafe_quality IS NOT NULL`,
      [canonId]
    );
    metrics.strafeQuality = num(sqRow.n) > 0 ? num(sqRow.q) / 100 : null;
    // finish.created_at is epoch SECONDS (db.js _ingestTx: Math.floor(Date.now()/1000)).
    const strafeCutoff = Math.floor(Date.now() / 1000) - STRAFE_HISTORY_DAYS * 86400;
    const strafeHistory = (
      await this.all(
        `SELECT to_char(to_timestamp(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                AVG(strafe_quality) q, MAX(strafe_quality) mx, MIN(strafe_quality) mn
         FROM finish
         WHERE ${groupWhere} AND strafe_quality IS NOT NULL AND created_at >= $2
         GROUP BY day ORDER BY day ASC`,
        [canonId, strafeCutoff]
      )
    ).map((r) => ({
      day: r.day,
      quality: num(r.q) / 100, // per-day average (percent)
      max: num(r.mx) / 100, // best run that day
      min: num(r.mn) / 100, // worst run that day
    }));

    const col = RECORD_SORTS[sort] || RECORD_SORTS.time;
    const direction = dir(order, "ASC");
    const lim = clampLimit(limit, 50, 500);
    const off = toOffset(offset);

    // Optional record filters: map-name search (q) and game version (version).
    // Both narrow the records list AND the total/pager count. $1 is always the
    // canonical player id; any filter params are appended after it.
    const filters = ["b.player_id = $1"];
    const fargs = [canonId];
    const qStr = typeof q === "string" ? q.trim() : "";
    if (qStr) {
      fargs.push(`%${likeEscape(qStr)}%`);
      filters.push(`m.name ILIKE $${fargs.length} ESCAPE '\\'`);
    }
    const vId = version == null || version === "" ? null : parseInt(version, 10);
    if (vId != null && !Number.isNaN(vId)) {
      fargs.push(vId);
      filters.push(`b.version_id = $${fargs.length}`);
    }
    const recWhere = filters.join(" AND ");

    const total = num(
      (await this.one(`SELECT COUNT(*) c FROM best b JOIN map m ON m.id = b.map_id WHERE ${recWhere}`, fargs)).c
    );

    // Game versions this player has records in — powers the filter dropdown.
    // Always the full list (independent of the active q/version) so the user
    // can switch between them.
    const versions = (
      await this.all(
        "SELECT version_id, COUNT(*)::int c FROM best WHERE player_id = $1 GROUP BY version_id ORDER BY c DESC",
        [canonId]
      )
    ).map((v) => ({
      id: num(v.version_id),
      name: this.versions[num(v.version_id)] || String(v.version_id),
      count: num(v.c),
    }));

    const records = (
      await this.all(
        `SELECT b.map_id, m.name AS map_name, b.time, b.rank, b.version_id,
                GREATEST(COALESCE(t.attempts, 0), COALESCE(t.finishes, 0))::int AS attempts,
                COALESCE(t.finishes, 0)::int AS finishes
         FROM best b JOIN map m ON m.id = b.map_id
         LEFT JOIN (
           SELECT map_id, SUM(attempts) attempts, SUM(finishes) finishes
           FROM run_tally WHERE ${groupWhere} GROUP BY map_id
         ) t ON t.map_id = b.map_id
         WHERE ${recWhere}
         ORDER BY ${col} ${direction}, b.time ASC, b.map_id ASC
         LIMIT $${fargs.length + 1} OFFSET $${fargs.length + 2}`,
        [...fargs, lim, off]
      )
    ).map((r) =>
      this._censorMapped(
        {
          ...r,
          map_id: num(r.map_id),
          version: num(r.version_id),
          versionName: this.versions[num(r.version_id)] || String(r.version_id),
        },
        num(r.map_id),
        "map_name"
      )
    );

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
        // payload IS NOT NULL => the ghost bytes are servable (see wr.ghost note).
        "SELECT map_id, time, hz, frames FROM player_ghost WHERE player_id = $1 AND map_id = ANY($2) AND payload IS NOT NULL",
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

    this._censorNamed(player, num(player.id)); // canonical display name
    for (const a of aliases) this._censorNamed(a, undefined); // alias variants (no id => word list)
    return {
      id: num(player.id),
      name: player.name,
      simplified: player.simplified,
      login: player.login,
      aliases,
      standing,
      srHistory,
      srPlace,
      strafeHistory,
      finishes,
      attempts,
      metrics,
      // Earned awards ride the main profile payload so badges render without a
      // second fetch; progress toward unearned ones is the lazy
      // /players/:id/achievements endpoint (like the SR breakdown).
      achievements: await this._earnedAchievements(canonId),
      // Tournament trophies ride the payload for the same reason: they are the
      // rarest thing on a profile and almost always an empty array, so a lazy
      // endpoint would cost a round trip to render nothing.
      trophies: await this.playerTrophies(canonId),
      recentFinishes: await this.recentFinishes({ limit: 5, playerId: canonId }),
      versions,
      records: { total, limit: lim, offset: off, rows: records },
    };
  }

  // The shape of the whole SR board: how many ranked players sit in each slice
  // of the rating scale, plus the quartile marks. Player-independent on purpose
  // — every profile draws the SAME histogram and only marks a different spot on
  // it (the marker's position comes from `srPlace` on the profile payload), so
  // this is one cacheable answer for the entire site rather than one per player.
  //
  // The buckets span the OBSERVED range rather than the nominal 0–1000: real
  // ratings occupy a fraction of that scale (the fill prior pins most players
  // into a few hundred points of it), and bucketing the empty 900 points would
  // spend most of the chart drawing nothing. Bounds are snapped outward to a
  // round 10 so the axis labels read as numbers a player recognises.
  //
  // Only RANKED players (>= SR_MIN_MAPS) are counted, matching the leaderboard —
  // a histogram over a different population than the board beside it is worse
  // than no histogram. This removes the spike that used to sit on the prior
  // (73% of rows, all within 284-451) and therefore makes the chart WIDER, not
  // narrower: what is left is the real spread of rated players.
  async srDistribution({ buckets = 40 } = {}) {
    const n = Math.max(4, Math.min(120, Math.trunc(buckets) || 40));
    const b = await this.one(
      `SELECT COUNT(*)::int                   AS total,
              (FLOOR(MIN(sr) / 10.0) * 10)::int AS lo,
              (CEIL (MAX(sr) / 10.0) * 10)::int AS hi,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sr)::int AS p50
         FROM standings
        WHERE maps >= ${SR_MIN_MAPS}`
    );
    const total = num(b && b.total);
    if (!total)
      return { total: 0, lo: 0, hi: 0, width: 0, minMaps: SR_MIN_MAPS, buckets: [], median: null };

    const lo = num(b.lo);
    // A board where everyone shares one rating (a fresh install, or one player)
    // would give a zero-width range, and width_bucket rejects lo = hi.
    const hi = Math.max(num(b.hi), lo + 10);

    // width_bucket returns n+1 for a value exactly at the upper bound — LEAST
    // folds that top edge back into the last bucket instead of losing the
    // highest-rated player off the end of the chart.
    const rows = await this.all(
      `SELECT LEAST(width_bucket(sr::float, $1::float, $2::float, $3), $3)::int AS idx,
              COUNT(*)::int AS c
         FROM standings
        WHERE maps >= ${SR_MIN_MAPS}
        GROUP BY 1
        ORDER BY 1`,
      [lo, hi, n]
    );

    const counts = new Array(n).fill(0);
    for (const r of rows) {
      const i = num(r.idx) - 1; // width_bucket is 1-based
      if (i >= 0 && i < n) counts[i] += num(r.c);
    }
    const width = (hi - lo) / n;
    return {
      total,
      lo,
      hi,
      width,
      // Surfaced so the chart can say what its population IS. Without it the
      // histogram silently describes a different set of players than the
      // leaderboard next to it, and `total` looks like the whole community.
      minMaps: SR_MIN_MAPS,
      median: num(b.p50),
      buckets: counts.map((count, i) => ({
        lo: Math.round(lo + i * width),
        hi: Math.round(lo + (i + 1) * width),
        count,
      })),
    };
  }

  // The per-map contributions behind a player's Skill Rating: the SR_TOP_K
  // strongest contested maps that the rating is the weighted mean of, ranked
  // exactly as the standings build ranks them (see the SR_* block at the top of
  // this file). EVERY row returned counts — the last row's running value is the
  // rating — so the view answers both "which maps is this made of" and "which
  // of my weak maps is holding it down".
  //
  // `contested` is how many maps qualified in total: when it exceeds the rows
  // returned, the surplus is the tail that missed the top-K cut; when it falls
  // short of SR_TOP_K, the shortfall is `emptySlots` and those slots are in the
  // rating at the prior. The UI says which.
  //
  // Each row's `running` is "what your rating would be if this were your whole
  // catalog" — the maps down to that row, with EVERY remaining slot still
  // empty. That makes the last row exactly the live rating (its remaining slots
  // are the real empty ones) and each step's movement honest: a map above the
  // prior lifts the number, a map below it drags.
  //
  // The running mean is recomputed here in JS instead of re-deriving the SQL
  // window: same doubles, same order, but the arithmetic stays next to the
  // explanation. It's a lazy per-profile read (the dropdown fetches it on open),
  // so the field sizes are re-aggregated for just this player's maps rather than
  // the whole `best` table.
  async srBreakdown(id) {
    let canonId = id;
    const c = await this.one("SELECT canonical_id FROM player WHERE id = $1", [id]);
    if (c && c.canonical_id != null) canonId = num(c.canonical_id);
    const player = await this.one("SELECT id, name, simplified FROM player WHERE id = $1", [canonId]);
    if (!player) return null;

    const standing = await this.one("SELECT sr, maps FROM standings WHERE player_id = $1", [canonId]);

    // COUNT(*) OVER () is evaluated before LIMIT, so `contested` is the full
    // number of qualifying maps even though only the top K rows come back.
    const raw = await this.all(
      `WITH mine AS (
         SELECT map_id, time, rank, version_id FROM best WHERE player_id = $1 AND time > 0
       ),
       mm AS (
         SELECT map_id,
                MIN(time)                                AS wr_time,
                COUNT(*)::int                            AS n,
                log(2.0, (1 + COUNT(*))::numeric)::float AS fw
         FROM best WHERE map_id IN (SELECT map_id FROM mine)
         GROUP BY map_id
       )
       SELECT mine.map_id, m.name AS map_name, mine.time, mine.rank, mine.version_id,
              mm.wr_time, mm.n, mm.fw,
              power(mm.wr_time::float / mine.time, ${SR_GAMMA}) AS p,
              COUNT(*) OVER ()::int AS contested
       FROM mine
       JOIN mm ON mm.map_id = mine.map_id
       JOIN map m ON m.id = mine.map_id
       WHERE mm.n >= ${SR_MIN_FIELD}
       ORDER BY p DESC, mm.fw DESC, mine.map_id
       LIMIT ${SR_TOP_K}`,
      [canonId]
    );

    // Accumulate the weighted mean row by row, each step padded out to SR_TOP_K
    // slots; the value after the LAST row is the rating.
    let sumPw = 0, sumW = 0, running = SR_MU;
    const rows = raw.map((r, i) => {
      const p = Number(r.p), fw = Number(r.fw);
      sumPw += p * fw;
      sumW += fw;
      const empty = Math.max(0, SR_TOP_K - (i + 1)) * SR_FILL_W;
      running = (sumPw + SR_KAPPA * SR_MU + empty * SR_MU) / (sumW + SR_KAPPA + empty);
      return this._censorMapped(
        {
          map_id: num(r.map_id),
          map_name: r.map_name,
          time: num(r.time),
          rank: num(r.rank),
          version: num(r.version_id),
          versionName: this.versions[num(r.version_id)] || String(r.version_id),
          wr_time: num(r.wr_time),
          field: num(r.n),
          weight: fw,
          // (wr/t) before the gamma sharpening — "how fast, as a fraction of the
          // record" is the intuitive number; `perf` is what the formula uses.
          ratio: num(r.wr_time) / num(r.time),
          perf: p,
          running: Math.round(1000 * running),
        },
        num(r.map_id),
        "map_name"
      );
    });

    this._censorNamed(player, num(player.id));
    return {
      id: num(player.id),
      name: player.name,
      simplified: player.simplified,
      // The board's own number, so the dropdown can never silently disagree with
      // the headline; `computed` is what these rows add up to (they match — this
      // is the same arithmetic on the same inputs).
      sr: standing ? num(standing.sr) : Math.round(1000 * SR_MU),
      computed: Math.round(1000 * running),
      // Maps in the rating = rows returned (the top-K cut). Kept as its own
      // field so the UI never has to infer it from the array length.
      counted: rows.length,
      // Slots still to fill, each sitting in the rating at the prior.
      emptySlots: Math.max(0, SR_TOP_K - rows.length),
      fillWeight: SR_FILL_W,
      // Contested maps this player has a PB on (may exceed the rows returned).
      contested: raw.length ? num(raw[0].contested) : 0,
      maps: standing ? num(standing.maps) : 0,
      topK: SR_TOP_K,
      minField: SR_MIN_FIELD,
      gamma: SR_GAMMA,
      mu: SR_MU,
      kappa: SR_KAPPA,
      rows,
    };
  }

  // Resolve any variant id to its canonical player row + overall standing.
  // Shared by compare() (and a natural home for any future multi-player view).
  async playerCard(id) {
    let canonId = id;
    const c = await this.one("SELECT canonical_id FROM player WHERE id = $1", [id]);
    if (c && c.canonical_id != null) canonId = num(c.canonical_id);
    const player = await this.one("SELECT id, name, simplified, login FROM player WHERE id = $1", [canonId]);
    if (!player) return null;
    const standing = (await this.one(
      "SELECT rank, points, sr, wr, podium, maps FROM standings WHERE player_id = $1",
      [canonId]
    )) || { rank: null, points: 0, sr: 0, wr: 0, podium: 0, maps: 0 };
    if (standing.rank != null) standing.rank = num(standing.rank);
    this._censorNamed(player, num(player.id));
    return {
      id: num(player.id),
      name: player.name,
      simplified: player.simplified,
      login: player.login,
      standing,
    };
  }

  // Head-to-head comparison of two players: overall standings side by side plus
  // the direct record on every map BOTH have a PB for (the truest "who is
  // faster" signal — same map, same task). Aggregate counts are computed in SQL
  // over ALL shared maps so the headline verdict stays exact even though the
  // per-map detail list is capped.
  async compare(aId, bId, { limit = 1000 } = {}) {
    const [a, b] = await Promise.all([this.playerCard(aId), this.playerCard(bId)]);
    if (!a || !b) return null;
    if (a.id === b.id) return { a, b, same: true, shared: 0, head: [], summary: null };

    // Exact aggregate over the full shared-map set (positive relMargin => A is
    // faster on average; it's the mean of (b_time-a_time)/midpoint per map).
    const agg = await this.one(
      `SELECT COUNT(*)::int AS shared,
              SUM(CASE WHEN ba.time <  bb.time THEN 1 ELSE 0 END)::int AS a_wins,
              SUM(CASE WHEN bb.time <  ba.time THEN 1 ELSE 0 END)::int AS b_wins,
              SUM(CASE WHEN ba.time =  bb.time THEN 1 ELSE 0 END)::int AS ties,
              AVG((bb.time - ba.time)::float / NULLIF((ba.time + bb.time) / 2.0, 0)) AS a_rel_margin
       FROM best ba
       JOIN best bb ON bb.map_id = ba.map_id AND bb.player_id = $2
       WHERE ba.player_id = $1`,
      [a.id, b.id]
    );

    // Per-map detail, most-competitive maps first (both players near the top).
    const lim = clampLimit(limit, 1000, 5000);
    const head = (
      await this.all(
        `SELECT ba.map_id, m.name,
                ba.time AS a_time, bb.time AS b_time,
                ba.rank AS a_rank, bb.rank AS b_rank
         FROM best ba
         JOIN best bb ON bb.map_id = ba.map_id AND bb.player_id = $2
         JOIN map m ON m.id = ba.map_id
         WHERE ba.player_id = $1
         ORDER BY LEAST(ba.rank, bb.rank) ASC, lower(m.name) ASC
         LIMIT $3`,
        [a.id, b.id, lim]
      )
    ).map((r) => {
      const aTime = r.a_time, bTime = r.b_time;
      return {
        mapId: num(r.map_id),
        name: this._cnMap(r.name, num(r.map_id)),
        aTime,
        bTime,
        aRank: r.a_rank,
        bRank: r.b_rank,
        delta: Math.abs(aTime - bTime),
        winner: aTime < bTime ? "a" : bTime < aTime ? "b" : "tie",
      };
    });

    const shared = num(agg.shared);
    const aWins = num(agg.a_wins);
    const bWins = num(agg.b_wins);
    const ties = num(agg.ties);
    const relMargin = agg.a_rel_margin == null ? null : Number(agg.a_rel_margin);

    // Per-metric winners: which player leads each overall dimension. "sr" is the
    // skill-first tiebreak used for the headline when the head-to-head is level.
    const metric = (av, bv, higher = true) =>
      av === bv ? "tie" : (higher ? av > bv : av < bv) ? "a" : "b";
    const metrics = {
      points: metric(a.standing.points, b.standing.points),
      sr: metric(a.standing.sr, b.standing.sr),
      wr: metric(a.standing.wr, b.standing.wr),
      podium: metric(a.standing.podium, b.standing.podium),
      maps: metric(a.standing.maps, b.standing.maps),
    };

    // Headline verdict: prefer the direct head-to-head (same maps, so it's the
    // fairest); fall back to Skill Rating when they've never shared a map or
    // split it evenly.
    let leader = null;
    let basis = null;
    if (aWins !== bWins) {
      leader = aWins > bWins ? "a" : "b";
      basis = "head-to-head";
    } else if (a.standing.sr !== b.standing.sr) {
      leader = a.standing.sr > b.standing.sr ? "a" : "b";
      basis = "sr";
    } else if (a.standing.points !== b.standing.points) {
      leader = a.standing.points > b.standing.points ? "a" : "b";
      basis = "points";
    }

    return {
      a,
      b,
      same: false,
      summary: { shared, aWins, bWins, ties, relMargin, metrics, leader, basis },
      head,
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
    ).map((m) => ({ id: num(m.id), name: this._cnMap(m.name, num(m.id)), records: m.records, finishes: m.finishes, races: m.records }));

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
    ).map((r) =>
      this._censorNamed(
        { id: num(r.id), name: r.name, simplified: r.simplified, rank: num(r.rank), points: r.points },
        num(r.id)
      )
    );
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
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
    // Best-effort daily SR snapshot off the freshly-committed standings. Never
    // let a snapshot failure fail the aggregate refresh — the live site depends
    // on the aggregates, not on the history table; the next refresh retries.
    try {
      await this.snapshotSrHistory();
    } catch (e) {
      console.error("sr_history snapshot failed (will retry next refresh):", e?.message ?? e);
    }
  }

  // Append today's Skill Rating for every ranked player to sr_history, then
  // prune anything outside the rolling SR_HISTORY_DAYS window. Called at the tail
  // of every refreshAggregates but does real work at most once per UTC day: the
  // first refresh after midnight writes the day's rows; later refreshes (many per
  // minute during active play) short-circuit on an in-memory memo, and across the
  // two web replicas / a restart on the day already present in the table.
  //
  // `day` is computed in UTC in JS so the bucket never depends on the Postgres
  // session TZ. The (player_id, day) PK makes the whole thing idempotent: the
  // advisory lock + a re-check inside it means the second replica to arrive skips
  // the ~9k-row write entirely rather than redoing it.
  async snapshotSrHistory() {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    if (this._srSnapshotDay === day) return;
    // Cheap pre-lock gate: today's snapshot already taken by anyone?
    if (await this.one("SELECT 1 FROM sr_history WHERE day = $1 LIMIT 1", [day])) {
      this._srSnapshotDay = day;
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727411002)"); // distinct from the aggregate lock
      // Re-check under the lock: the replica that lost the race must not repeat
      // the full insert the winner just committed.
      const taken = await client.query("SELECT 1 FROM sr_history WHERE day = $1 LIMIT 1", [day]);
      if (taken.rows.length === 0) {
        await client.query(
          // Ranked players only: an unranked player has no published rating, so
          // there is no trend to record. Their history starts the day they cross
          // SR_MIN_MAPS — the chart then shows the rating from when it began to
          // mean something rather than a flat run of prior-valued placeholders.
          `INSERT INTO sr_history (player_id, day, sr)
           SELECT player_id, $1::date, sr FROM standings WHERE maps >= ${SR_MIN_MAPS}
           ON CONFLICT (player_id, day) DO UPDATE SET sr = EXCLUDED.sr`,
          [day]
        );
        await client.query(
          `DELETE FROM sr_history WHERE day < $1::date - ${SR_HISTORY_DAYS - 1}`,
          [day]
        );
      }
      await client.query("COMMIT");
      this._srSnapshotDay = day;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
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
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
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
  async blockedMapNames(now = Math.floor(Date.now() / 1000)) {
    // UNION of the moderator's blocks and the machine's active quarantine.
    // Deliberately only here: the admin-facing blockedMaps() below stays
    // map_block-only, so a machine quarantine never shows up in the moderator's
    // blocked-maps table as though a human had put it there.
    //
    // This one query is the entire network-wide propagation. Both consumers are
    // already deployed: server/entrypoint.sh subtracts this at boot (dropping
    // the map from g_maplist, rs_idle_pool AND the boot map) and
    // hrace/blockedmaps.as re-fetches every ~30s for the vote/rotation paths.
    return (
      await this.all(
        `SELECT m.name FROM map_block b JOIN map m ON m.id = b.map_id
         UNION
         SELECT q.map_name FROM map_quarantine q
          WHERE q.active AND (q.expires_at IS NULL OR q.expires_at > $1)
         ORDER BY 1`,
        [now]
      )
    ).map((r) => String(r.name).toLowerCase());
  }

  // ---------------------------- Map quarantine -----------------------------
  // A map that fails to LOAD is reported here by the game boxes' crash guard.
  // Policy lives in this one function so the endpoint stays dumb.
  //
  // Activates when either the same map has failed RS_QUARANTINE_FAILS times
  // (default 2 — one failure could be a transient host condition), OR two
  // DISTINCT servers have seen it fail. The second rule escalates immediately
  // and on purpose: two nodes cannot both be holding the same locally-corrupt
  // pk3, so that is the map, not the box.
  //
  // Returns { active, activatedNow, failCount, serverCount } so the caller can
  // decide whether to file a moderator flag and evict the blocklist cache.
  async recordMapLoadFailure({
    mapName,
    serverId = null,
    detector = "crashguard",
    note = null,
    now = Math.floor(Date.now() / 1000),
    failsToQuarantine = MAP_QUARANTINE_FAILS,
    expireSecs = MAP_QUARANTINE_EXPIRE_SECS,
  }) {
    const name = String(mapName || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return { ok: false, error: "invalid map name" };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Evidence first. ON CONFLICT DO NOTHING so several reporters describing
      // the same event at the same second collapse to one row.
      await client.query(
        `INSERT INTO map_load_failure (map_name, server_id, detected_at, detector, note)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (server_id, map_name, detected_at) DO NOTHING`,
        [name, serverId, now, detector, note]
      );
      // server_count is recomputed from the evidence rather than incremented,
      // so one node reporting ten times never looks like ten nodes.
      const counts = (
        await client.query(
          `SELECT COUNT(*)::int AS fails, COUNT(DISTINCT server_id)::int AS servers
             FROM map_load_failure WHERE map_name = $1`,
          [name]
        )
      ).rows[0];
      const failCount = counts.fails;
      const serverCount = counts.servers;
      const active = failCount >= failsToQuarantine || serverCount >= 2;
      // Thin evidence expires so a one-off self-heals; once it is unambiguous
      // (>= 3 failures) it stays until a human clears it.
      const expiresAt = !active ? null : failCount >= 3 ? null : now + expireSecs;

      const prev = (
        await client.query("SELECT active FROM map_quarantine WHERE map_name = $1", [name])
      ).rows[0];

      await client.query(
        `INSERT INTO map_quarantine
           (map_name, fail_count, server_count, first_failed_at, last_failed_at,
            last_server_id, last_note, active, expires_at, cleared_by, cleared_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, NULL, NULL)
         ON CONFLICT (map_name) DO UPDATE SET
           fail_count     = EXCLUDED.fail_count,
           server_count   = EXCLUDED.server_count,
           last_failed_at = EXCLUDED.last_failed_at,
           last_server_id = EXCLUDED.last_server_id,
           last_note      = EXCLUDED.last_note,
           active         = EXCLUDED.active,
           expires_at     = EXCLUDED.expires_at,
           cleared_by     = NULL,
           cleared_at     = NULL`,
        [name, failCount, serverCount, now, serverId, note, active, expiresAt]
      );
      await client.query("COMMIT");
      return {
        ok: true,
        active,
        activatedNow: active && !(prev && prev.active),
        failCount,
        serverCount,
        expiresAt,
      };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Quarantine rows for the admin panel, worst first. `effective` is what the
  // game servers actually see right now (active AND unexpired), which is not
  // the same as `active` once expires_at has passed.
  async quarantinedMaps(now = Math.floor(Date.now() / 1000)) {
    return (
      await this.all(
        `SELECT q.*, s.name AS server_name,
                (q.active AND (q.expires_at IS NULL OR q.expires_at > $1)) AS effective
           FROM map_quarantine q
           LEFT JOIN server s ON s.id = q.last_server_id
          ORDER BY q.active DESC, q.last_failed_at DESC`,
        [now]
      )
    ).map((r) => ({ ...r, last_server_id: r.last_server_id == null ? null : num(r.last_server_id) }));
  }

  // Lift a quarantine. Deliberately keeps the map_load_failure evidence: the
  // history is what tells a moderator this map has been cleared and came back.
  async clearMapQuarantine(mapName, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      `UPDATE map_quarantine
          SET active = FALSE, expires_at = NULL, cleared_by = $2, cleared_at = $3
        WHERE map_name = $1`,
      [String(mapName || "").toLowerCase(), by || null, now]
    );
    return r.rowCount;
  }

  // ======================= Offensive-name censoring =========================
  // Names are masked at DISPLAY time only (originals stay in `player`). Every
  // display method below routes its name field(s) through _censorNamed / _cn,
  // so a nick that trips the word list is starred everywhere it is shown — and
  // future nicks are handled by the same read path with no backfill. See
  // censor.js and migration 20260728120000000_name_censor.sql.
  //
  // IMPORTANT for maintainers: any NEW query method that returns a player name
  // must route it through _censorNamed(row, playerId) (or _cn for a bare
  // string), or that surface will leak un-censored names.

  // (Re)load the word list + per-player overrides into an in-memory matcher.
  // Never throws: a pre-migration table or transient error keeps the prior
  // matcher (empty at worst), so a config hiccup can't take down reads.
  async loadCensorConfig() {
    try {
      const terms = await this.all("SELECT term, mode, severity FROM censor_term WHERE active = true");
      const overrides = new Map();
      for (const r of await this.all("SELECT player_id, action FROM player_censor")) {
        overrides.set(num(r.player_id), r.action);
      }
      const mapOverrides = new Map();
      const mapOverridesByName = new Map();
      for (const r of await this.all(
        "SELECT mc.map_id, mc.action, m.name FROM map_censor mc JOIN map m ON m.id = mc.map_id"
      )) {
        mapOverrides.set(num(r.map_id), r.action);
        mapOverridesByName.set(String(r.name).toLowerCase(), r.action);
      }
      this._censor = { matcher: buildMatcher(terms), overrides, mapOverrides, mapOverridesByName };
    } catch (e) {
      console.error("censor config load failed (keeping previous):", e?.message ?? e);
    }
  }
  // Re-read config immediately (called right after an admin edit).
  async refreshCensor() {
    return this.loadCensorConfig();
  }

  // Censor a bare raw name string for the given player row id (id omitted =>
  // word list only, no per-player override).
  _cn(name, id) {
    const ov = id != null ? this._censor.overrides.get(num(id)) : undefined;
    return censorName(name, this._censor.matcher, ov);
  }
  // Mask the {name, simplified} pair on a result row IN PLACE, keeping the two
  // consistent (simplified is re-derived from the masked raw name). Returns the
  // row so it can wrap a .map() expression.
  _censorNamed(obj, id, nameKey = "name", simpKey = "simplified") {
    if (!obj) return obj;
    const ov = id != null ? this._censor.overrides.get(num(id)) : undefined;
    if (obj[nameKey] != null) {
      const c = censorName(obj[nameKey], this._censor.matcher, ov);
      if (c !== obj[nameKey]) {
        obj[nameKey] = c;
        if (obj[simpKey] != null) obj[simpKey] = simplifyName(c);
      }
    } else if (obj[simpKey] != null) {
      obj[simpKey] = censorName(obj[simpKey], this._censor.matcher, ov);
    }
    return obj;
  }

  // Map-name equivalents. Map names are plain identifiers (no ^colour codes, no
  // separate `simplified`), masked with the SAME word list but keyed on the
  // per-MAP override. Display only — the stored map.name is untouched, so the
  // game still loads/votes by it and the site still routes by map id.
  _cnMap(name, id) {
    const ov = id != null ? this._censor.mapOverrides.get(num(id)) : undefined;
    return censorName(name, this._censor.matcher, ov);
  }
  // Censor a map name when only the NAME is known (sync display builders / live
  // snapshot spots that have no map id): resolves the per-map override by name
  // so a force-censor/allow still applies without a DB round-trip.
  _cnMapByName(name) {
    const ov = name != null ? this._censor.mapOverridesByName.get(String(name).toLowerCase()) : undefined;
    return censorName(name, this._censor.matcher, ov);
  }
  _censorMapped(obj, mapId, key = "map") {
    if (obj && obj[key] != null) obj[key] = this._cnMap(obj[key], mapId);
    return obj;
  }

  // ---- Admin management (the /admin/names page + CLI) ----
  async censorTerms() {
    return this.all(
      "SELECT term, mode, severity, active, added_at, added_by FROM censor_term ORDER BY severity, term"
    );
  }
  async addCensorTerm(term, mode, severity, by, now = Math.floor(Date.now() / 1000)) {
    const t = normalizeTerm(term);
    if (!t) return null;
    const m = mode === "word" ? "word" : "norm";
    const sev = ["slur", "hate", "sexual", "profanity"].includes(severity) ? severity : "profanity";
    await this.pool.query(
      `INSERT INTO censor_term (term, mode, severity, active, added_at, added_by)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (term) DO UPDATE SET mode = EXCLUDED.mode, severity = EXCLUDED.severity,
         active = true, added_at = EXCLUDED.added_at, added_by = EXCLUDED.added_by`,
      [t, m, sev, now, by]
    );
    await this.refreshCensor();
    return t;
  }
  async removeCensorTerm(term) {
    const t = normalizeTerm(term);
    const r = await this.pool.query("DELETE FROM censor_term WHERE term = $1", [t]);
    await this.refreshCensor();
    return r.rowCount > 0;
  }
  // action='allow' whitelists a false positive; action='censor' force-masks a
  // nick the word list missed. Keyed by the player row whose name is displayed.
  async setPlayerCensor(playerId, action, reason, by, now = Math.floor(Date.now() / 1000)) {
    if (action !== "allow" && action !== "censor") return false;
    await this.pool.query(
      `INSERT INTO player_censor (player_id, action, reason, set_at, set_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (player_id) DO UPDATE SET action = EXCLUDED.action, reason = EXCLUDED.reason,
         set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by`,
      [playerId, action, reason || null, now, by]
    );
    await this.refreshCensor();
    return true;
  }
  async clearPlayerCensor(playerId) {
    const r = await this.pool.query("DELETE FROM player_censor WHERE player_id = $1", [playerId]);
    await this.refreshCensor();
    return r.rowCount > 0;
  }
  // Representative (displayed) player rows that trip the word list OR carry an
  // override — the review table for /admin/names. Scans in memory against the
  // loaded matcher (cheap: short names, small term list).
  async censoredPlayers({ limit = 1000 } = {}) {
    // Scan the displayed (canonical) players in memory against the matcher.
    // Overridden rows first so they can't be pushed out by the cap; a generous
    // LIMIT bounds the fetch (prod has ~9k standings players) without clipping.
    const rows = await this.all(
      `SELECT p.id, p.name, p.simplified, pc.action, pc.reason, pc.set_by
       FROM player p
       JOIN standings s ON s.player_id = p.id
       LEFT JOIN player_censor pc ON pc.player_id = p.id
       ORDER BY (pc.action IS NOT NULL) DESC, p.id
       LIMIT 50000`
    );
    const out = [];
    for (const r of rows) {
      const id = num(r.id);
      const ov = this._censor.overrides.get(id);
      const terms = this._censor.matcher.scan(r.name);
      if (!terms.length && !ov) continue;
      out.push({
        id,
        name: r.name,
        simplified: r.simplified,
        masked: this._cn(r.name, id),
        terms,
        action: ov || null,
        reason: r.reason || null,
        set_by: r.set_by || null,
      });
      if (out.length >= limit) break;
    }
    return out; // already override-first via the query's ORDER BY
  }

  // --- Map-name overrides (share the /admin/names page + CLI) ----
  async setMapCensor(mapId, action, reason, by, now = Math.floor(Date.now() / 1000)) {
    if (action !== "allow" && action !== "censor") return false;
    await this.pool.query(
      `INSERT INTO map_censor (map_id, action, reason, set_at, set_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (map_id) DO UPDATE SET action = EXCLUDED.action, reason = EXCLUDED.reason,
         set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by`,
      [mapId, action, reason || null, now, by]
    );
    await this.refreshCensor();
    return true;
  }
  async clearMapCensor(mapId) {
    const r = await this.pool.query("DELETE FROM map_censor WHERE map_id = $1", [mapId]);
    await this.refreshCensor();
    return r.rowCount > 0;
  }
  // Maps whose name trips the word list OR carries an override, for /admin/names.
  async censoredMaps({ limit = 1000 } = {}) {
    const rows = await this.all(
      `SELECT m.id, m.name, mc.action, mc.reason, mc.set_by
       FROM map m
       LEFT JOIN map_censor mc ON mc.map_id = m.id
       ORDER BY (mc.action IS NOT NULL) DESC, m.name
       LIMIT 50000`
    );
    const out = [];
    for (const r of rows) {
      const id = num(r.id);
      const ov = this._censor.mapOverrides.get(id);
      const terms = this._censor.matcher.scan(r.name);
      if (!terms.length && !ov) continue;
      out.push({
        id,
        name: r.name,
        masked: this._cnMap(r.name, id),
        terms,
        action: ov || null,
        reason: r.reason || null,
        set_by: r.set_by || null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Per-map weapon inventory for the game servers' randmap-by-weapon voting
  // (hrace/mapweapons.as via the RS_ApiFetchMapWeapons native). Plain text, one
  // line per scanned map, sorted by name: "<name> code code ...". A strafe map
  // (no weapons) is a bare name with no codes. Sorted so the game can binary
  // search the parsed table.
  //
  // A slick map also carries the "sl" SURFACE tag in that same code list, so
  // `callvote randmap slick` — and combinations like `randmap rl slick` — reuse
  // the gametype's existing AND-combining filter with no new wire format. The
  // tag is derived here from the measured fraction rather than stored, so
  // retuning SLICK_MIN_FRAC does not need a re-scan. mapweapons.as knows to
  // ignore "sl" when deciding whether a map is a strafe map.
  async gameMapWeaponsText() {
    // COLLATE "C" => byte-order sort, so the gametype can binary search the
    // parsed table with a plain byte compare (AngelScript String has no opCmp).
    const rows = await this.all(
      'SELECT name, weapons, slick_frac FROM map_weapon ORDER BY name COLLATE "C"'
    );
    return rows
      .map((r) => {
        const codes = Array.isArray(r.weapons) ? [...r.weapons] : [];
        if (isSlick(r.slick_frac)) codes.push(SLICK_CODE);
        return codes.length ? `${r.name} ${codes.join(" ")}` : r.name;
      })
      .join("\n");
  }

  // Most-recently-played maps for the game servers' in-game /lastmaps command
  // (hrace/lastmaps.as via the RS_ApiFetchLastMaps native). Plain text, one
  // lowercased map name per line, most-recent first: the last 10 DISTINCT maps
  // anyone finished. The finish log is the live play signal — map_index.last_played
  // is an UNLOGGED aggregate rebuilt only on the periodic refresh and would lag
  // behind by minutes, so this queries finish directly (behind the endpoint's
  // short cache the full-table group is a rare, cheap-enough scan). Lowercased to
  // match how the game keys/prints map names everywhere else.
  async gameLastMapsText() {
    const rows = await this.all(
      `SELECT m.id AS map_id, m.name, MAX(f.created_at) AS last_played
         FROM finish f JOIN map m ON m.id = f.map_id
        GROUP BY m.id, m.name
        ORDER BY MAX(f.created_at) DESC
        LIMIT 10`
    );
    return rows.map((r) => this._cnMap(String(r.name).toLowerCase(), num(r.map_id))).join("\n");
  }

  // --- Site settings (admin-edited key/value, e.g. the game-server MOTD) -----
  // Returns null when the key was never set (callers pick their own default).
  async getSetting(key) {
    const r = await this.one("SELECT value, updated_at, updated_by FROM site_setting WHERE key = $1", [key]);
    return r ? { value: r.value, updated_at: num(r.updated_at), updated_by: r.updated_by } : null;
  }
  async setSetting(key, value, by, now = Math.floor(Date.now() / 1000)) {
    await this.pool.query(
      `INSERT INTO site_setting (key, value, updated_at, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [key, value, now, by || null]
    );
  }

  // --- Admin accounts + sessions ---------------------------------------------
  // Accounts are created out-of-band (admin.js admin-add); there is no public
  // sign-up. Returns null if the username is already taken.
  async createAdmin(username, passwordHash, role = "admin", now = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      `INSERT INTO admin_user (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
      [username, passwordHash, role, now]
    );
    return r ? { id: num(r.id), username, role } : null;
  }
  async getAdminByUsername(username) {
    const r = await this.one(
      "SELECT id, username, password_hash, role, last_login_at FROM admin_user WHERE username = $1",
      [username]
    );
    return r ? { ...r, id: num(r.id) } : null;
  }
  async listAdmins() {
    return (
      await this.all("SELECT id, username, role, created_at, last_login_at FROM admin_user ORDER BY username ASC")
    ).map((r) => ({ ...r, id: num(r.id) }));
  }
  // Change an account's tier ('admin' | 'moderator'). Returns rows updated (0 =
  // no such account). Existing sessions pick up the new role on their next
  // request (requireRole re-reads it from admin_user via getSession).
  async setAdminRole(username, role) {
    const r = await this.pool.query("UPDATE admin_user SET role = $1 WHERE username = $2", [role, username]);
    return r.rowCount;
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
  // so the table self-cleans on access. Returns { adminId, username, role, csrf } | null.
  // The role is read fresh from admin_user on every request, so a tier change
  // (node admin.js admin-role) takes effect without re-login.
  async getSession(tokenHash, now = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      `SELECT s.admin_id, s.csrf, s.expires_at, a.username, a.role
       FROM admin_session s JOIN admin_user a ON a.id = s.admin_id
       WHERE s.token_hash = $1`,
      [tokenHash]
    );
    if (!r) return null;
    if (num(r.expires_at) <= now) {
      await this.pool.query("DELETE FROM admin_session WHERE token_hash = $1", [tokenHash]);
      return null;
    }
    return { adminId: num(r.admin_id), username: r.username, role: r.role, csrf: r.csrf, expiresAt: num(r.expires_at) };
  }
  async deleteSession(tokenHash) {
    await this.pool.query("DELETE FROM admin_session WHERE token_hash = $1", [tokenHash]);
  }
  async deleteExpiredSessions(now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query("DELETE FROM admin_session WHERE expires_at <= $1", [now]);
    return r.rowCount;
  }

  // ------------------------------------------------------------------------
  // Achievements
  // ------------------------------------------------------------------------
  // Definitions live in `achievement` (rule kinds + params from
  // web/achievements.js — see the catalog there); awards in
  // `player_achievement`, keyed by canonical player id with an idempotent PK
  // insert, so evaluation can run repeatedly (both replicas, every ingest, the
  // daily sweep) without double-awarding. Reads span the canonical group like
  // sr_history reads do, in case the group representative ever flips.

  // Normalise an achievement row (pg BIGINTs -> numbers; rule arrives as an
  // object from jsonb).
  _achRow(r) {
    return {
      id: num(r.id),
      slug: r.slug,
      title: r.title,
      description: r.description,
      tier: r.tier,
      rule: r.rule,
      time_window: r.time_window,
      repeatable: r.repeatable,
      hidden: r.hidden,
      active: r.active,
      created_at: num(r.created_at),
      created_by: r.created_by,
      updated_at: r.updated_at != null ? num(r.updated_at) : null,
      updated_by: r.updated_by,
      earners: r.earners != null ? num(r.earners) : undefined,
    };
  }

  async listAchievements() {
    return (
      await this.all(
        `SELECT a.*, COALESCE(c.n, 0) AS earners
         FROM achievement a
         LEFT JOIN (
           SELECT pa.achievement_id, COUNT(DISTINCT COALESCE(p.canonical_id, p.id)) AS n
           FROM player_achievement pa JOIN player p ON p.id = pa.player_id
           GROUP BY 1
         ) c ON c.achievement_id = a.id
         ORDER BY a.active DESC, lower(a.title)`
      )
    ).map((r) => this._achRow(r));
  }

  async getAchievement(id) {
    const r = await this.one("SELECT * FROM achievement WHERE id = $1", [id]);
    return r ? this._achRow(r) : null;
  }

  // v is validateDefinition().value. Returns the new id, or null on a slug
  // collision (the only UNIQUE besides the PK).
  async createAchievement(v, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      `INSERT INTO achievement (slug, title, description, tier, rule, time_window, repeatable, hidden, active, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, FALSE, $9, $10)
       ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [v.slug, v.title, v.description, v.tier, JSON.stringify(v.rule), v.time_window, v.repeatable, v.hidden, now, by || null]
    );
    return r ? num(r.id) : null;
  }

  // Returns rows updated (0 = no such id); false on a slug collision.
  async updateAchievement(id, v, by, now = Math.floor(Date.now() / 1000)) {
    try {
      const r = await this.pool.query(
        `UPDATE achievement SET slug=$2, title=$3, description=$4, tier=$5, rule=$6::jsonb,
                time_window=$7, repeatable=$8, hidden=$9, updated_at=$10, updated_by=$11
         WHERE id = $1`,
        [id, v.slug, v.title, v.description, v.tier, JSON.stringify(v.rule), v.time_window, v.repeatable, v.hidden, now, by || null]
      );
      return r.rowCount;
    } catch (e) {
      if (e.code === "23505") return false; // slug taken by another definition
      throw e;
    }
  }

  async setAchievementActive(id, active, by, now = Math.floor(Date.now() / 1000)) {
    const r = await this.pool.query(
      "UPDATE achievement SET active = $2, updated_at = $3, updated_by = $4 WHERE id = $1",
      [id, active, now, by || null]
    );
    return r.rowCount;
  }

  // Deleting is only allowed while nothing has been awarded — once earned, a
  // definition is history (deactivate + hide instead).
  async deleteAchievement(id) {
    const r = await this.pool.query(
      `DELETE FROM achievement a WHERE a.id = $1
       AND NOT EXISTS (SELECT 1 FROM player_achievement pa WHERE pa.achievement_id = a.id)`,
      [id]
    );
    return r.rowCount;
  }

  // Dry run for the admin form: who would this definition award RIGHT NOW,
  // split into already-holding vs newly-qualifying, with a censored name
  // sample. Read-only — nothing is inserted.
  async previewAchievement(id, { sample = 20 } = {}) {
    const def = await this.getAchievement(id);
    if (!def) return null;
    const q = qualifyQuery(def);
    const rows = await this.all(q.sql, q.params);
    const period = periodKey(def);
    const holders = new Set(
      (
        await this.all(
          `SELECT DISTINCT COALESCE(p.canonical_id, p.id) AS cid
           FROM player_achievement pa JOIN player p ON p.id = pa.player_id
           WHERE pa.achievement_id = $1 AND pa.period = $2`,
          [def.id, period]
        )
      ).map((r) => num(r.cid))
    );
    const fresh = rows.filter((r) => !holders.has(num(r.player_id)));
    const ids = fresh.slice(0, sample).map((r) => num(r.player_id));
    const nameById = new Map();
    if (ids.length) {
      for (const n of await this.all("SELECT id, name, simplified FROM player WHERE id = ANY($1)", [ids])) {
        nameById.set(num(n.id), this._censorNamed({ id: num(n.id), name: n.name, simplified: n.simplified }, num(n.id)));
      }
    }
    return {
      total: rows.length,
      alreadyHolding: rows.length - fresh.length,
      newlyQualifying: fresh.length,
      sample: fresh.slice(0, sample).map((r) => ({
        ...(nameById.get(num(r.player_id)) || { id: num(r.player_id), name: "?", simplified: "?" }),
        value: r.value == null ? null : Number(r.value),
      })),
    };
  }

  // Evaluate every ACTIVE definition and award qualifiers. playerIds (raw or
  // canonical ids — they're mapped to canonical here) restricts the pass to an
  // ingest batch's players; null sweeps the whole field. Idempotent; returns
  // the number of NEW awards. A single broken definition logs and skips rather
  // than failing the pass.
  async evaluateAchievements(playerIds = null, now = new Date()) {
    let cids = null;
    if (playerIds) {
      if (!playerIds.length) return 0;
      cids = (
        await this.all("SELECT DISTINCT COALESCE(canonical_id, id) AS cid FROM player WHERE id = ANY($1)", [playerIds])
      ).map((r) => num(r.cid));
      if (!cids.length) return 0;
    }
    const defs = (await this.all("SELECT * FROM achievement WHERE active")).map((r) => this._achRow(r));
    let awarded = 0;
    for (const def of defs) {
      let rows;
      try {
        const q = qualifyQuery(def, { playerIds: cids, now });
        rows = await this.all(q.sql, q.params);
      } catch (e) {
        console.error(`achievement "${def.slug}" evaluation failed:`, e?.message ?? e);
        continue;
      }
      if (rows.length) awarded += await this._insertAwards(def, periodKey(def, now), rows, Math.floor(now.getTime() / 1000));
    }
    return awarded;
  }

  async _insertAwards(def, period, rows, nowSec) {
    const pids = rows.map((r) => num(r.player_id));
    const fids = rows.map((r) => (r.finish_id == null ? null : num(r.finish_id)));
    const vals = rows.map((r) => (r.value == null ? null : Math.round(Number(r.value))));
    const r = await this.pool.query(
      `INSERT INTO player_achievement (achievement_id, player_id, period, awarded_at, finish_id, detail)
       SELECT $1, t.pid, $2, $3, t.fid, jsonb_build_object('value', t.val)
       FROM unnest($4::bigint[], $5::bigint[], $6::bigint[]) AS t(pid, fid, val)
       WHERE NOT EXISTS (
         -- The same canonical GROUP already holds this award under another nick
         -- id (representative flip after rebuild-canonical) — don't re-award.
         SELECT 1 FROM player_achievement pa JOIN player p2 ON p2.id = pa.player_id
         WHERE pa.achievement_id = $1 AND pa.period = $2 AND pa.player_id <> t.pid
           AND COALESCE(p2.canonical_id, p2.id) =
               (SELECT COALESCE(canonical_id, id) FROM player WHERE id = t.pid)
       )
       ON CONFLICT DO NOTHING`,
      [def.id, period, nowSec, pids, fids, vals]
    );
    return r.rowCount;
  }

  // Full-field pass, claimed AT MOST once per UTC day across both web replicas
  // (same shape as snapshotSrHistory: in-memory memo -> cheap config probe ->
  // advisory lock + re-check). The claim is written BEFORE evaluating: awards
  // are idempotent and the post-ingest incremental pass runs continuously, so
  // a crash mid-sweep just means the field catches up tomorrow.
  async achievementsDailySweep(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    if (this._achSweepDay === day) return 0;
    if ((await this.getConfig("ach_sweep_day")) === day) {
      this._achSweepDay = day;
      return 0;
    }
    const client = await this.pool.connect();
    let claimed = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(727411003)"); // distinct from aggregate + sr locks
      const cur = await client.query("SELECT value FROM config WHERE key = 'ach_sweep_day'");
      if (!cur.rows.length || cur.rows[0].value !== day) {
        await client.query(
          `INSERT INTO config (key, value) VALUES ('ach_sweep_day', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [day]
        );
        claimed = true;
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
    this._achSweepDay = day;
    if (!claimed) return 0;
    return this.evaluateAchievements(null, now);
  }

  // Earned awards for one canonical group, newest first. DISTINCT ON keeps the
  // EARLIEST award per (achievement, period) if a representative flip ever
  // left duplicates across nick ids.
  async _earnedAchievements(canonId) {
    return (
      await this.all(
        `SELECT * FROM (
           SELECT DISTINCT ON (pa.achievement_id, pa.period)
             a.id, a.slug, a.title, a.description, a.tier, pa.period, pa.awarded_at
           FROM player_achievement pa JOIN achievement a ON a.id = pa.achievement_id
           WHERE pa.player_id IN (SELECT id FROM player WHERE canonical_id = $1)
           ORDER BY pa.achievement_id, pa.period, pa.awarded_at ASC
         ) e ORDER BY e.awarded_at DESC`,
        [canonId]
      )
    ).map((r) => ({
      id: num(r.id),
      slug: r.slug,
      title: r.title,
      description: r.description,
      tier: r.tier,
      period: r.period,
      awarded_at: num(r.awarded_at),
    }));
  }

  // The profile achievements panel: earned awards + progress toward every
  // active, visible, not-yet-earned definition (hidden ones stay invisible
  // until earned). Lazy endpoint — a handful of small per-definition queries.
  async playerAchievements(id) {
    let canonId = id;
    const c = await this.one("SELECT canonical_id FROM player WHERE id = $1", [id]);
    if (c && c.canonical_id != null) canonId = num(c.canonical_id);
    if (!(await this.one("SELECT 1 FROM player WHERE id = $1", [canonId]))) return null;

    const earned = await this._earnedAchievements(canonId);
    const now = new Date();
    const earnedKey = new Set(earned.map((e) => `${e.id}:${e.period}`));
    const defs = (
      await this.all("SELECT * FROM achievement WHERE active AND NOT hidden ORDER BY lower(title)")
    ).map((r) => this._achRow(r));

    const progress = [];
    for (const def of defs) {
      if (earnedKey.has(`${def.id}:${periodKey(def, now)}`)) continue;
      let value = null;
      try {
        const q = progressQuery(def, canonId, now);
        const row = await this.one(q.sql, q.params);
        if (row && row.value != null) value = Number(row.value);
      } catch (e) {
        console.error(`achievement "${def.slug}" progress failed:`, e?.message ?? e);
        continue;
      }
      const meta = displayMeta(def);
      progress.push({
        id: def.id,
        slug: def.slug,
        title: def.title,
        description: def.description,
        tier: def.tier,
        window: def.time_window,
        repeatable: def.repeatable,
        value,
        target: targetOf(def),
        format: meta.format,
        better: meta.better,
      });
    }
    return { earned, progress };
  }

  // The public /achievements directory: every active definition with how many
  // players hold it (rarity) and its most recent earners. Hidden achievements
  // come back masked — tier + earner count only — until a player earns them.
  async achievementsDirectory() {
    const players = num((await this.one("SELECT COUNT(*) c FROM standings")).c);
    const defs = (
      await this.all(
        `SELECT a.*, COALESCE(c.n, 0) AS earners
         FROM achievement a
         LEFT JOIN (
           SELECT pa.achievement_id, COUNT(DISTINCT COALESCE(p.canonical_id, p.id)) AS n
           FROM player_achievement pa JOIN player p ON p.id = pa.player_id
           GROUP BY 1
         ) c ON c.achievement_id = a.id
         WHERE a.active
         ORDER BY CASE a.tier WHEN 'legend' THEN 0 WHEN 'gold' THEN 1 WHEN 'silver' THEN 2 ELSE 3 END,
                  lower(a.title)`
      )
    ).map((r) => this._achRow(r));

    const recent = await this.all(
      `SELECT pa.achievement_id, pa.player_id, pa.awarded_at, p.name, p.simplified
       FROM player_achievement pa
       JOIN player p ON p.id = pa.player_id
       JOIN achievement a ON a.id = pa.achievement_id
       WHERE a.active
       ORDER BY pa.awarded_at DESC LIMIT 60`
    );
    const recentByAch = new Map();
    for (const r of recent) {
      const aid = num(r.achievement_id);
      const list = recentByAch.get(aid) || [];
      if (list.length < 3) {
        list.push(
          this._censorNamed(
            { id: num(r.player_id), name: r.name, simplified: r.simplified, awarded_at: num(r.awarded_at) },
            num(r.player_id)
          )
        );
        recentByAch.set(aid, list);
      }
    }

    return {
      players,
      achievements: defs.map((d) => {
        const base = {
          id: d.id,
          tier: d.tier,
          earners: d.earners || 0,
          rarity: players ? (d.earners || 0) / players : 0,
          hidden: d.hidden,
        };
        if (d.hidden) return base; // masked: no title/description/rule until earned
        return {
          ...base,
          slug: d.slug,
          title: d.title,
          description: d.description,
          window: d.time_window,
          repeatable: d.repeatable,
          recent: recentByAch.get(d.id) || [],
        };
      }),
    };
  }

  // Recent earners of one achievement, for the admin edit page (with revoke).
  async listAchievementAwards(achievementId, limit = 50) {
    return (
      await this.all(
        `SELECT pa.player_id, pa.period, pa.awarded_at, pa.detail, p.name, p.simplified
         FROM player_achievement pa JOIN player p ON p.id = pa.player_id
         WHERE pa.achievement_id = $1
         ORDER BY pa.awarded_at DESC LIMIT $2`,
        [achievementId, limit]
      )
    ).map((r) =>
      this._censorNamed(
        {
          player_id: num(r.player_id),
          period: r.period,
          awarded_at: num(r.awarded_at),
          value: r.detail && r.detail.value != null ? Number(r.detail.value) : null,
          name: r.name,
          simplified: r.simplified,
        },
        num(r.player_id)
      )
    );
  }

  async revokeAward(achievementId, playerId, period = "") {
    const r = await this.pool.query(
      "DELETE FROM player_achievement WHERE achievement_id = $1 AND player_id = $2 AND period = $3",
      [achievementId, playerId, period]
    );
    return r.rowCount;
  }

  // ------------------------------------------------------------------------
  // Tournaments
  // ------------------------------------------------------------------------
  // Time-boxed, map-limited competitions layered over the normal leaderboard.
  // See migration 20260801120000000_tournaments.sql for the model and
  // web/tournaments.js for the scoring SQL: a tournament owns no runs, it is a
  // filter over the finish log, frozen into tournament_standing at the end.

  _tournamentRow(r) {
    if (!r) return null;
    return {
      id: num(r.id),
      slug: r.slug,
      name: r.name,
      description: r.description || "",
      starts_at: num(r.starts_at),
      ends_at: num(r.ends_at),
      status: r.status,
      scoring: r.scoring,
      join_open: Boolean(r.join_open),
      repeat_every_days: num(r.repeat_every_days) || 0,
      repeat_gap_days: num(r.repeat_gap_days) || 0,
      series_key: r.series_key || null,
      edition: num(r.edition) || 1,
      finalized_at: r.finalized_at == null ? null : num(r.finalized_at),
      created_at: num(r.created_at),
      created_by: r.created_by || null,
      updated_at: r.updated_at == null ? null : num(r.updated_at),
      updated_by: r.updated_by || null,
      phase: phaseOf(r),
      // Counts come from the list/detail queries when they join them in.
      maps: r.map_count == null ? undefined : num(r.map_count),
      entrants: r.entrant_count == null ? undefined : num(r.entrant_count),
    };
  }

  // Tournament list. `includeDrafts` is the admin view; the public site only
  // ever sees published/finalized/cancelled rows.
  async tournaments({ includeDrafts = false, limit = 200, offset = 0 } = {}) {
    const gate = includeDrafts ? "" : "WHERE t.status <> 'draft'";
    const lim = clampLimit(limit, 200, 500);
    const off = toOffset(offset);
    const total = num((await this.one(`SELECT COUNT(*) c FROM tournament t ${gate}`)).c);
    const rows = await this.all(
      `SELECT t.*,
              (SELECT COUNT(*) FROM tournament_map tm WHERE tm.tournament_id = t.id)      AS map_count,
              (SELECT COUNT(*) FROM tournament_entrant te
                WHERE te.tournament_id = t.id AND te.player_id IS NOT NULL)               AS entrant_count
       FROM tournament t ${gate}
       ORDER BY t.starts_at DESC, t.id DESC
       LIMIT $1 OFFSET $2`,
      [lim, off]
    );
    return { total, limit: lim, offset: off, rows: rows.map((r) => this._tournamentRow(r)) };
  }

  async tournamentById(id, { includeDrafts = true } = {}) {
    const gate = includeDrafts ? "" : " AND t.status <> 'draft'";
    return this._tournamentRow(await this.one(`SELECT t.* FROM tournament t WHERE t.id = $1${gate}`, [id]));
  }

  async tournamentBySlug(slug, { includeDrafts = false } = {}) {
    const gate = includeDrafts ? "" : " AND t.status <> 'draft'";
    return this._tournamentRow(
      await this.one(`SELECT t.* FROM tournament t WHERE t.slug = $1${gate}`, [String(slug || "").toLowerCase()])
    );
  }

  // The tournament's map pool, in pool order. Names are censored for display
  // like everywhere else; `rawName` keeps the real name for the game feed and
  // for building rotation commands (which must use what the server has installed).
  async tournamentMaps(tournamentId) {
    return (
      await this.all(
        `SELECT m.id, m.name, tm.position
         FROM tournament_map tm JOIN map m ON m.id = tm.map_id
         WHERE tm.tournament_id = $1
         ORDER BY tm.position, m.name`,
        [tournamentId]
      )
    ).map((r) =>
      this._censorMapped({ id: num(r.id), name: r.name, rawName: r.name, position: num(r.position) }, num(r.id), "name")
    );
  }

  // Tie-aware places over an ORDERED standings result.
  //
  // The query's last tiebreak is player_id, which is arbitrary: on a dead tie
  // (common — an exact millisecond tie on a short map gives both players rank 1
  // and identical points) the lower id would otherwise silently take the place
  // above. Rows whose whole scoring tuple matches share a place, standard-
  // competition style (1, 2, 2, 4). Shared by the live board and the freeze so
  // the two can never disagree about a tie.
  _tournamentPlaces(rows, scoring) {
    const key = (r) =>
      scoring === "time_sum"
        ? `${r.complete ? 1 : 0}:${r.total_time}:${r.maps_played}`
        : `${r.points}:${r.map_wins}:${r.maps_played}:${r.total_time}`;
    const places = [];
    for (let i = 0; i < rows.length; i++) {
      places.push(i > 0 && key(rows[i]) === key(rows[i - 1]) ? places[i - 1] : i + 1);
    }
    return places;
  }

  // Live standings, computed from the finish log. Used by the public page while
  // a tournament runs AND as the input to the freeze at the end, so what
  // players watched is exactly what gets awarded.
  async _computeTournamentStandings(t, { limit = 500 } = {}) {
    const q = standingsQuery(t, { limit });
    const rows = await this.all(q.sql, q.params);
    if (!rows.length) return [];
    const ids = rows.map((r) => num(r.player_id));
    const nameById = new Map();
    for (const n of await this.all("SELECT id, name, simplified FROM player WHERE id = ANY($1)", [ids])) {
      nameById.set(num(n.id), { name: n.name, simplified: n.simplified });
    }
    const places = this._tournamentPlaces(rows, t.scoring);
    return rows.map((r, i) => {
      const pid = num(r.player_id);
      const nm = nameById.get(pid) || { name: "?", simplified: "?" };
      return this._censorNamed(
        {
          place: places[i],
          id: pid,
          name: nm.name,
          simplified: nm.simplified,
          points: num(r.points) || 0,
          mapsPlayed: num(r.maps_played) || 0,
          mapWins: num(r.map_wins) || 0,
          totalTime: r.total_time == null ? null : num(r.total_time),
          complete: Boolean(r.complete),
          detail: (r.detail || []).map((d) =>
            this._censorMapped({ ...d, mapId: num(d.mapId) }, num(d.mapId), "map")
          ),
        },
        pid
      );
    });
  }

  // Frozen standings for a finalized tournament, read back in place order.
  async _frozenTournamentStandings(tournamentId) {
    return (
      await this.all(
        `SELECT s.*, p.name, p.simplified
         FROM tournament_standing s JOIN player p ON p.id = s.player_id
         WHERE s.tournament_id = $1
         ORDER BY s.place`,
        [tournamentId]
      )
    ).map((r) =>
      this._censorNamed(
        {
          place: num(r.place),
          id: num(r.player_id),
          name: r.name,
          simplified: r.simplified,
          points: num(r.points) || 0,
          mapsPlayed: num(r.maps_played) || 0,
          mapWins: num(r.map_wins) || 0,
          totalTime: r.total_time == null ? null : num(r.total_time),
          complete: r.complete == null ? null : Boolean(r.complete),
          detail: (r.detail || []).map((d) =>
            this._censorMapped({ ...d, mapId: num(d.mapId) }, num(d.mapId), "map")
          ),
        },
        num(r.player_id)
      )
    );
  }

  // A finalized tournament reads its frozen snapshot; anything else is computed
  // live. That split is the whole durability story: a historical result never
  // moves when the finish log, the map pool or the alias grouping does.
  async tournamentStandings(t, { limit = 500 } = {}) {
    if (!t) return [];
    if (t.status === "finalized") return this._frozenTournamentStandings(t.id);
    if (t.status === "cancelled" || t.status === "draft") return [];
    return this._computeTournamentStandings(t, { limit });
  }

  // Per-map boards for the detail page: the fastest entrants on each pool map
  // inside the window. Live only — a finalized tournament's per-map detail
  // lives in each standing row's `detail`.
  async tournamentMapBoards(t, { perMap = 25 } = {}) {
    if (!t || t.status === "draft" || t.status === "cancelled") return {};
    const q = mapBoardsQuery(t, { perMap });
    const out = {};
    for (const r of await this.all(q.sql, q.params)) {
      const mid = num(r.map_id);
      (out[mid] ||= []).push(
        this._censorNamed(
          {
            id: num(r.player_id),
            name: r.name,
            simplified: r.simplified,
            time: num(r.time),
            rank: num(r.rank),
            points: num(r.points) || 0,
          },
          num(r.player_id)
        )
      );
    }
    return out;
  }

  // Registered entrants (never the unredeemed codes — those are private to
  // whoever minted them).
  async tournamentEntrants(tournamentId, { limit = 500 } = {}) {
    return (
      await this.all(
        `SELECT te.player_id, te.registered_at, te.registered_name, p.name, p.simplified
         FROM tournament_entrant te JOIN player p ON p.id = te.player_id
         WHERE te.tournament_id = $1 AND te.player_id IS NOT NULL
         ORDER BY te.registered_at ASC NULLS LAST, te.id ASC
         LIMIT $2`,
        [tournamentId, clampLimit(limit, 500, 2000)]
      )
    ).map((r) =>
      this._censorNamed(
        {
          id: num(r.player_id),
          name: r.name,
          simplified: r.simplified,
          registered_at: r.registered_at == null ? null : num(r.registered_at),
        },
        num(r.player_id)
      )
    );
  }

  // Everything the public tournament page needs in one round trip.
  async tournamentDetail(slug, { includeDrafts = false, perMap = 10 } = {}) {
    const t = await this.tournamentBySlug(slug, { includeDrafts });
    if (!t) return null;
    const [maps, standings, boards, entrants] = await Promise.all([
      this.tournamentMaps(t.id),
      this.tournamentStandings(t),
      this.tournamentMapBoards(t, { perMap }),
      this.tournamentEntrants(t.id),
    ]);
    return {
      tournament: { ...t, maps: maps.length, entrants: entrants.length, joinOpen: joinOpen(t) },
      maps: maps.map(({ rawName, ...m }) => m), // rawName is server-side only
      standings,
      boards,
      entrants,
    };
  }

  // The tournament that is running RIGHT NOW, if any. There can only be one:
  // the calendar is exclusive (the tournament_no_overlap constraint added by
  // migration 20260801140000000, plus the admin-form gate in front of it). The
  // LIMIT 1 and its tie-break stay anyway — a read that silently returns two
  // rows to a caller expecting one is a worse failure than a deterministic
  // pick, and this is the query every game server's feed is built from.
  async liveTournament(nowSec = Math.floor(Date.now() / 1000)) {
    return this._tournamentRow(
      await this.one(
        `SELECT * FROM tournament
         WHERE status = 'published' AND starts_at <= $1 AND ends_at > $1
         ORDER BY starts_at DESC, id DESC LIMIT 1`,
        [nowSec]
      )
    );
  }

  // What the game servers should be pointed at: the live tournament, or the
  // next one due to start if nothing is running. The servers advertise the
  // upcoming one so players can see what is coming without a website visit.
  async currentOrNextTournament(nowSec = Math.floor(Date.now() / 1000)) {
    const live = await this.liveTournament(nowSec);
    if (live) return live;
    return this._tournamentRow(
      await this.one(
        `SELECT * FROM tournament
         WHERE status = 'published' AND starts_at > $1
         ORDER BY starts_at ASC, id ASC LIMIT 1`,
        [nowSec]
      )
    );
  }

  // Plain-text feed for the game servers (hrace/tournament.as). Uses the RAW
  // map names — the server has to `map <name>` them, and a censored display
  // name would not load. The entrant count rides along for the in-game pitch
  // ("12 racers entered"); claimed entries only, so an unredeemed code minted
  // on the website never inflates it.
  async gameTourneyText(nowSec = Math.floor(Date.now() / 1000)) {
    const t = await this.currentOrNextTournament(nowSec);
    if (!t) return gameTourneyText(null, []);
    const [names, entrants] = await Promise.all([
      this.all(
        `SELECT m.name FROM tournament_map tm JOIN map m ON m.id = tm.map_id
         WHERE tm.tournament_id = $1 ORDER BY tm.position, m.name`,
        [t.id]
      ),
      this.one(
        `SELECT COUNT(*) c FROM tournament_entrant
         WHERE tournament_id = $1 AND player_id IS NOT NULL`,
        [t.id]
      ),
    ]);
    return gameTourneyText(t, names.map((r) => r.name), { nowSec, entrants: num(entrants.c) });
  }

  // Tournaments whose window intersects [startsAt, endsAt). Cancelled ones are
  // ignored — a called-off tournament should not block the calendar slot it
  // was going to occupy. Half-open, so back-to-back editions never collide.
  async overlappingTournaments(startsAt, endsAt, excludeId = null) {
    return (
      await this.all(
        `SELECT * FROM tournament
         WHERE status <> 'cancelled'
           AND starts_at < $2 AND ends_at > $1
           AND ($3::bigint IS NULL OR id <> $3)
         ORDER BY starts_at`,
        [startsAt, endsAt, excludeId]
      )
    ).map((r) => this._tournamentRow(r));
  }

  // When the calendar is next free: the latest end among scheduled tournaments,
  // or now. Used to pre-fill the admin form so the default is non-overlapping.
  async nextFreeTournamentSlot(nowSec = Math.floor(Date.now() / 1000)) {
    const r = await this.one(
      "SELECT MAX(ends_at) e FROM tournament WHERE status <> 'cancelled' AND ends_at > $1",
      [nowSec]
    );
    return r && r.e != null ? num(r.e) : nowSec;
  }

  // Replace a tournament's map pool.
  //
  // Map rows are CREATED ON DEMAND (the same get-or-create upsert the ingest
  // and saved-start paths use) rather than required to exist. `map` only holds
  // maps somebody has already raced, so requiring a pre-existing row would make
  // the most natural tournament of all — "here are three brand-new maps, go" —
  // impossible to set up. A pool entry for a never-raced map simply scores
  // nothing until the first finish lands, which is exactly right.
  //
  // `unraced` comes back so the admin form can warn about a likely typo: a name
  // nobody has ever finished is far more often a misspelling than a new map.
  //
  // NOTE for pool authors: a REVERSE run is stored under its own map row named
  // "<map>-reversed" (RACE_EffectiveMapName in hrace/racelog.as), so a pool
  // containing "coldrun" scores forward runs only. Add "coldrun-reversed" as a
  // separate entry to score the reverse direction.
  async setTournamentMaps(tournamentId, mapNames) {
    const wanted = mapNames.map((m) => String(m).toLowerCase());
    // "Raced" means somebody has actually finished it, NOT that a map row
    // exists: this very method creates rows on demand, so a row-existence test
    // would report a brand-new pool map as known the second time it is saved
    // and the typo warning would quietly stop working.
    const raced = new Set(
      wanted.length
        ? (
            await this.all(
              `SELECT m.name FROM map m
               WHERE m.name = ANY($1) AND EXISTS (SELECT 1 FROM race r WHERE r.map_id = m.id)`,
              [wanted]
            )
          ).map((r) => String(r.name).toLowerCase())
        : []
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM tournament_map WHERE tournament_id = $1", [tournamentId]);
      let pos = 0;
      for (const m of wanted) {
        const row = (
          await client.query(
            `INSERT INTO map (name) VALUES ($1)
             ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [m]
          )
        ).rows[0];
        await client.query(
          `INSERT INTO tournament_map (tournament_id, map_id, position) VALUES ($1, $2, $3)
           ON CONFLICT (tournament_id, map_id) DO UPDATE SET position = EXCLUDED.position`,
          [tournamentId, num(row.id), pos++]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
    return { added: wanted.length, unraced: wanted.filter((m) => !raced.has(m)) };
  }

  // Create a tournament + its pool. Returns {id, unraced}, null on a slug
  // collision, or {conflict:"overlap"} when the exclusive-calendar constraint
  // rejects the window (the caller re-renders the form with the message).
  //
  // The route checks for an overlap before calling this, so reaching the
  // constraint means two admins saved at once — rare, but the only alternative
  // is a 500 on a form the admin can plainly see is fine.
  async createTournament(v, by, now = Math.floor(Date.now() / 1000)) {
    let row;
    try {
      row = await this.one(
        `INSERT INTO tournament
           (slug, name, description, starts_at, ends_at, status, scoring, join_open,
            repeat_every_days, repeat_gap_days, series_key, edition, created_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          v.slug, v.name, v.description, v.starts_at, v.ends_at, v.status, v.scoring, v.join_open,
          v.repeat_every_days, v.repeat_gap_days,
          v.repeat_every_days > 0 ? v.series_key || v.slug : null,
          v.edition || 1, now, by || null,
        ]
      );
    } catch (e) {
      if (e.code === "23505") return null; // slug taken
      if (e.code === "23P01") return { conflict: "overlap" }; // calendar already booked
      throw e;
    }
    const id = num(row.id);
    const maps = await this.setTournamentMaps(id, v.mapNames || []);
    return { id, unraced: maps.unraced };
  }

  // Returns {rows, missing} — rows 0 means no such id; null on a slug
  // collision; {conflict:"overlap"} when the window is already booked.
  async updateTournament(id, v, by, now = Math.floor(Date.now() / 1000)) {
    let r;
    try {
      r = await this.pool.query(
        // An auto-monthly edition keeps repeat_every_days at 0 no matter what
        // the form posts. The chain scheduler gates on repeat_every_days > 0,
        // so a stray non-zero here would hand a Monthly Cup edition to the
        // fixed-day roll-forward as well — two schedulers writing the same
        // series, one of them with arithmetic that cannot express a month.
        // Enforced in the UPDATE rather than the route because the form is not
        // the only writer.
        `UPDATE tournament SET slug=$2, name=$3, description=$4, starts_at=$5, ends_at=$6,
                status=$7, scoring=$8, join_open=$9,
                repeat_every_days = CASE WHEN created_by = 'auto-monthly' THEN 0 ELSE $10 END,
                repeat_gap_days   = CASE WHEN created_by = 'auto-monthly' THEN 0 ELSE $11 END,
                updated_at=$12, updated_by=$13
         WHERE id = $1 AND status <> 'finalized'`,
        [
          id, v.slug, v.name, v.description, v.starts_at, v.ends_at, v.status, v.scoring, v.join_open,
          v.repeat_every_days, v.repeat_gap_days, now, by || null,
        ]
      );
    } catch (e) {
      if (e.code === "23505") return null;
      if (e.code === "23P01") return { conflict: "overlap" };
      throw e;
    }
    if (!r.rowCount) return { rows: 0, unraced: [] };
    const maps = await this.setTournamentMaps(id, v.mapNames || []);
    return { rows: r.rowCount, unraced: maps.unraced };
  }

  // Rows changed, or {conflict:"overlap"}. Only one status change can hit the
  // exclusive-calendar constraint: un-cancelling. A cancelled tournament frees
  // its slot (that is the whole point of cancelling), so by the time somebody
  // brings it back another tournament may be sitting in its window.
  async setTournamentStatus(id, status, by, now = Math.floor(Date.now() / 1000)) {
    try {
      const r = await this.pool.query(
        "UPDATE tournament SET status = $2, updated_at = $3, updated_by = $4 WHERE id = $1 AND status <> 'finalized'",
        [id, status, now, by || null]
      );
      return r.rowCount;
    } catch (e) {
      if (e.code === "23P01") return { conflict: "overlap" };
      throw e;
    }
  }

  // Deleting is only allowed while nobody has ENTERED. Once a player has
  // redeemed a code the tournament is somebody's plan for their week: the
  // cascade would take their entry, their frozen standing and their trophy
  // with it, and every code minted for it would go permanently dead. Cancel it
  // instead — that keeps the row, the history and the calendar slot's story.
  // (The achievements precedent refuses deletion once EARNED; the tournament
  // equivalent has to be "once anyone signed up", because the damage lands on
  // entrants long before any trophy exists.)
  async deleteTournament(id) {
    const r = await this.pool.query(
      `DELETE FROM tournament t WHERE t.id = $1
       AND NOT EXISTS (SELECT 1 FROM tournament_trophy tt WHERE tt.tournament_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM tournament_entrant te
         WHERE te.tournament_id = t.id AND te.player_id IS NOT NULL
       )`,
      [id]
    );
    return r.rowCount;
  }

  // Mint an UNCLAIMED entry code. The website hands this to a player, who binds
  // it to their in-game identity with "/tournament <code>". Retries on the
  // (astronomically unlikely) code collision rather than trusting the RNG.
  async createEntryCode(tournamentId, claimedName = "", now = Math.floor(Date.now() / 1000)) {
    const name = String(claimedName || "").trim().slice(0, MAX_ENTRY_NAME) || null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateCode((n) => crypto.randomBytes(n));
      try {
        const row = await this.one(
          `INSERT INTO tournament_entrant (tournament_id, code, claimed_name, created_at)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [tournamentId, code, name, now]
        );
        return { id: num(row.id), code };
      } catch (e) {
        if (e.code === "23505") continue; // code collision — draw again
        if (e.code === "23503") return null; // no such tournament
        throw e;
      }
    }
    throw new Error("could not mint a unique tournament entry code");
  }

  // Redeem a code in-game: bind the entry to the canonical player behind
  // (name, login). Returns a small result object the game turns into a printed
  // line; `reason` is a stable machine key, never player-facing text.
  async redeemEntryCode({ code, name, login = "", serverId = null }, now = Math.floor(Date.now() / 1000)) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the entry row first: two servers redeeming the same code at once
      // must serialize here, or both would see it unclaimed.
      const te = (
        await client.query("SELECT * FROM tournament_entrant WHERE code = $1 FOR UPDATE", [code])
      ).rows[0];
      if (!te) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "unknown_code" };
      }
      const t = this._tournamentRow(
        (await client.query("SELECT * FROM tournament WHERE id = $1", [te.tournament_id])).rows[0]
      );
      if (!t || !joinOpen(t, now)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "closed", tournament: t };
      }

      const rawId = await this._resolvePlayer(client, { name, login });
      const cRow = (await client.query("SELECT canonical_id FROM player WHERE id = $1", [rawId])).rows[0];
      const canonId = cRow && cRow.canonical_id != null ? num(cRow.canonical_id) : rawId;

      // Already registered for this tournament (possibly under a different
      // code, or under an alias that has since merged into this group)? Say so
      // and succeed — a second redeem is a no-op, not an error.
      const existing = (
        await client.query(
          `SELECT te2.id FROM tournament_entrant te2
           JOIN player pl ON pl.id = te2.player_id
           WHERE te2.tournament_id = $1 AND COALESCE(pl.canonical_id, pl.id) = $2`,
          [te.tournament_id, canonId]
        )
      ).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return { ok: true, already: true, tournament: t };
      }
      if (te.player_id != null) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "code_used", tournament: t };
      }

      await client.query(
        `UPDATE tournament_entrant
         SET player_id = $2, registered_name = $3, registered_at = $4, server_id = $5
         WHERE id = $1`,
        [num(te.id), canonId, String(name).slice(0, MAX_ENTRY_NAME), now, serverId]
      );
      await client.query("COMMIT");
      return { ok: true, already: false, tournament: t };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      if (e.code === "23505") return { ok: false, reason: "already_entered" }; // lost the race
      throw e;
    } finally {
      client.release();
    }
  }

  // In-game "/tournament join": enrol the nick the player is playing under,
  // right now, with no website round trip. The code is still minted (and shown
  // to them) so the entry looks identical to a website signup and they have
  // something to quote if they ever need support.
  async joinTournamentInGame({ tournamentId, name, login = "", serverId = null }, now = Math.floor(Date.now() / 1000)) {
    const t = await this.tournamentById(tournamentId);
    if (!t || !joinOpen(t, now)) return { ok: false, reason: "closed", tournament: t };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rawId = await this._resolvePlayer(client, { name, login });
      const cRow = (await client.query("SELECT canonical_id FROM player WHERE id = $1", [rawId])).rows[0];
      const canonId = cRow && cRow.canonical_id != null ? num(cRow.canonical_id) : rawId;
      const existing = (
        await client.query(
          `SELECT te.code FROM tournament_entrant te
           JOIN player pl ON pl.id = te.player_id
           WHERE te.tournament_id = $1 AND COALESCE(pl.canonical_id, pl.id) = $2`,
          [tournamentId, canonId]
        )
      ).rows[0];
      if (existing) {
        await client.query("COMMIT");
        return { ok: true, already: true, tournament: t, code: existing.code };
      }
      let code = null;
      for (let attempt = 0; attempt < 6 && code == null; attempt++) {
        const draw = generateCode((n) => crypto.randomBytes(n));
        try {
          await client.query("SAVEPOINT mint");
          await client.query(
            `INSERT INTO tournament_entrant
               (tournament_id, code, claimed_name, player_id, registered_name, registered_at, server_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$6)`,
            [tournamentId, draw, null, canonId, String(name).slice(0, MAX_ENTRY_NAME), now, serverId]
          );
          code = draw;
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT mint");
          if (e.code === "23505" && String(e.constraint || "").includes("uq_tentrant_player")) {
            // Someone else enrolled this player between the SELECT and here.
            await client.query("COMMIT");
            return { ok: true, already: true, tournament: t, code: null };
          }
          if (e.code === "23505") continue; // code collision — draw again
          throw e;
        }
      }
      if (code == null) throw new Error("could not mint a unique tournament entry code");
      await client.query("COMMIT");
      return { ok: true, already: false, tournament: t, code };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Is this nick registered for `tournamentId`, and where do they stand? Nick
  // lookup spans the whole canonical group, like the awards/saved-start feeds.
  async playerTournamentEntry(tournamentId, playerName) {
    const clean = simplifyName(playerName).toLowerCase();
    if (!clean) return null;
    // Match through the alias group in BOTH directions. tournament_entrant
    // stores the representative id AT REDEEM TIME, so after a canonical rebuild
    // picks a new representative the stored id is no longer what the nick
    // resolves to — comparing only forwards would tell a registered player they
    // are not registered while the standings still (correctly) score them.
    // Mapping the stored id through canonical_id, the way playerTrophies does,
    // survives the flip.
    const row = await this.one(
      `SELECT te.code, te.registered_at, te.player_id
       FROM tournament_entrant te
       JOIN player ep ON ep.id = te.player_id
       WHERE te.tournament_id = $1
         AND COALESCE(ep.canonical_id, ep.id) IN (
           SELECT DISTINCT COALESCE(pl.canonical_id, pl.id) FROM player pl
           WHERE lower(regexp_replace(pl.name, '\\^[0-9]', '', 'g')) = $2
         )
       LIMIT 1`,
      [tournamentId, clean]
    );
    if (!row) return null;
    return {
      code: row.code,
      registered_at: row.registered_at == null ? null : num(row.registered_at),
      playerId: num(row.player_id),
    };
  }

  // Every trophy a player holds, newest first — the profile card. Reads span
  // the canonical group so a trophy survives the representative flipping.
  async playerTrophies(id) {
    let canonId = id;
    const c = await this.one("SELECT canonical_id FROM player WHERE id = $1", [id]);
    if (c && c.canonical_id != null) canonId = num(c.canonical_id);
    return (
      await this.all(
        `SELECT tt.place, tt.points, tt.awarded_at,
                t.id AS tournament_id, t.slug, t.name, t.starts_at, t.ends_at,
                (SELECT COUNT(*) FROM tournament_standing s WHERE s.tournament_id = t.id) AS field
         FROM tournament_trophy tt
         JOIN tournament t ON t.id = tt.tournament_id
         WHERE tt.player_id IN (SELECT id FROM player WHERE canonical_id = $1)
         ORDER BY tt.awarded_at DESC, t.ends_at DESC`,
        [canonId]
      )
    ).map((r) => ({
      tournamentId: num(r.tournament_id),
      slug: r.slug,
      name: r.name,
      place: num(r.place),
      points: num(r.points) || 0,
      field: num(r.field) || 0,
      startsAt: num(r.starts_at),
      endsAt: num(r.ends_at),
      awardedAt: num(r.awarded_at),
    }));
  }

  // Freeze one tournament: snapshot its standings and mint trophies.
  //
  // Idempotent and replica-safe by construction. The whole pass runs in one
  // transaction that begins by locking the tournament row and re-checking that
  // it is still an un-finalized, published, ENDED tournament — so two replicas
  // (or a sweep racing an admin's "finalize now") can only ever have one of
  // them do the work; the loser sees status='finalized' and no-ops. The insert
  // shapes are ON CONFLICT DO NOTHING on top of that, so even a torn retry
  // cannot double-award.
  //
  // Trophies: place 1/2/3 for the podium, place 0 for everyone else who scored
  // at least one map. A tournament nobody entered is still finalized (with an
  // empty snapshot) so it stops being re-swept every night.
  async finalizeTournament(tournamentId, now = Math.floor(Date.now() / 1000)) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const t = this._tournamentRow(
        (await client.query("SELECT * FROM tournament WHERE id = $1 FOR UPDATE", [tournamentId])).rows[0]
      );
      if (!t || t.status !== "published" || t.ends_at > now) {
        await client.query("ROLLBACK");
        return { finalized: false, standings: 0, trophies: 0 };
      }

      const q = standingsQuery(t, { limit: 10000 });
      const rows = (await client.query(q.sql, q.params)).rows;
      let trophies = 0;
      const places = this._tournamentPlaces(rows, t.scoring);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const place = places[i];
        const complete = r.complete !== false;
        await client.query(
          `INSERT INTO tournament_standing
             (tournament_id, player_id, place, points, maps_played, map_wins, total_time, complete, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
           ON CONFLICT (tournament_id, player_id) DO NOTHING`,
          [
            t.id, num(r.player_id), place, num(r.points) || 0, num(r.maps_played) || 0,
            num(r.map_wins) || 0, r.total_time == null ? null : num(r.total_time),
            complete, JSON.stringify(r.detail || []),
          ]
        );
        // A podium trophy requires a podium place AND, under time_sum, a
        // COMPLETE entry: that format explicitly does not rank anyone who
        // skipped a pool map, so handing one of them a bronze because only two
        // players finished everything would contradict the board they are
        // standing on. They still get the participation trophy.
        const podium = place <= 3 && (t.scoring !== "time_sum" || complete);
        const res = await client.query(
          `INSERT INTO tournament_trophy (tournament_id, player_id, place, points, awarded_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tournament_id, player_id) DO NOTHING`,
          [t.id, num(r.player_id), podium ? place : 0, num(r.points) || 0, now]
        );
        trophies += res.rowCount;
      }
      await client.query(
        "UPDATE tournament SET status = 'finalized', finalized_at = $2, updated_at = $2 WHERE id = $1",
        [t.id, now]
      );
      await client.query("COMMIT");
      return { finalized: true, standings: rows.length, trophies, tournament: t };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // Schedule the next edition of a recurring tournament, starting
  // repeat_gap_days after `prev` ended and running for the same duration. The
  // gap is what guarantees a series never overlaps itself; an explicit overlap
  // with some OTHER tournament is skipped (logged by the caller) rather than
  // silently double-booking the calendar. Idempotent: the slug carries the
  // edition number, so a repeat run collides on the unique slug and no-ops.
  async scheduleNextEdition(prev, now = Math.floor(Date.now() / 1000)) {
    if (!prev || prev.repeat_every_days <= 0) return null;
    const duration = prev.ends_at - prev.starts_at;
    const seriesKey = prev.series_key || prev.slug;
    const edition = (prev.edition || 1) + 1;
    // Roll forward until the start is in the future: a series that lay dormant
    // while the site was down should resume NEXT, not replay every missed week.
    let startsAt = prev.ends_at + prev.repeat_gap_days * 86400;
    const step = prev.repeat_every_days * 86400;
    let guard = 0;
    while (startsAt + duration <= now && guard++ < 520) startsAt += step;

    // The slug is built from the SERIES key, which never changes across
    // editions, so there is nothing to strip: edition 2 of "weekly" is
    // "weekly-2", edition 3 is "weekly-3". (Stripping a trailing "-<digits>"
    // would have mangled a series whose own name ends in a number — "sprint-2026"
    // would have produced "sprint-2".)
    const slug = `${seriesKey}-${edition}`;
    const name = prev.name.replace(/\s*#\d+\s*$/, "") + ` #${edition}`;
    if ((await this.overlappingTournaments(startsAt, startsAt + duration)).length) return null;

    // Row and pool in ONE transaction: an edition that committed with an empty
    // map pool would be a published tournament nobody can score on, and the
    // reconciliation pass would consider the series healed and never retry.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (
        await client.query(
          `INSERT INTO tournament
             (slug, name, description, starts_at, ends_at, status, scoring, join_open,
              repeat_every_days, repeat_gap_days, series_key, edition, created_at, created_by)
           VALUES ($1,$2,$3,$4,$5,'published',$6,TRUE,$7,$8,$9,$10,$11,'auto') RETURNING id`,
          [
            slug, name, prev.description, startsAt, startsAt + duration, prev.scoring,
            prev.repeat_every_days, prev.repeat_gap_days, seriesKey, edition, now,
          ]
        )
      ).rows[0];
      const id = num(row.id);
      await client.query(
        `INSERT INTO tournament_map (tournament_id, map_id, position)
         SELECT $1, map_id, position FROM tournament_map WHERE tournament_id = $2
         ON CONFLICT DO NOTHING`,
        [id, prev.id]
      );
      await client.query("COMMIT");
      return { id, slug, startsAt, endsAt: startsAt + duration };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      if (e.code === "23505") return null; // this edition already exists
      // Someone booked the slot between the overlap check above and this
      // insert. Skipping is right: the sweep is a reconciliation and will try
      // again on its next pass, by which time the roll-forward has moved on.
      if (e.code === "23P01") return null;
      throw e;
    } finally {
      client.release();
    }
  }

  // The sweep: finalize every published tournament whose window has closed, and
  // make sure every recurring series has its next edition on the calendar.
  // Safe to run on both replicas and as often as you like (see
  // finalizeTournament's locking).
  //
  // The series roll-forward is a RECONCILIATION, not a follow-on step, and that
  // is deliberate. Scheduling cannot join the finalize transaction (it needs
  // the finalized row committed to know the window it follows), so a container
  // recreate — which every deploy does — landing between the two would leave a
  // weekly series permanently stuck with no next edition and nothing to notice.
  // Instead this asks the standing question "does any finalized recurring
  // tournament lack a successor?" every pass, so the series heals itself on the
  // next sweep no matter where it was interrupted.
  async finalizeDueTournaments(now = Math.floor(Date.now() / 1000)) {
    const due = await this.all(
      "SELECT id FROM tournament WHERE status = 'published' AND ends_at <= $1 ORDER BY ends_at",
      [now]
    );
    // Per-item isolation. Without it one tournament that throws (a corrupt
    // detail payload, a map deleted mid-freeze) takes finalization, trophies AND
    // the series reconciliation down with it for every OTHER tournament too —
    // and the sweep's single outer catch reports it once every five minutes with
    // no indication of which row is poisoned. Failures are collected and
    // surfaced so the caller can log them.
    const out = { finalized: 0, trophies: 0, scheduled: [], failed: [] };
    for (const d of due) {
      try {
        const r = await this.finalizeTournament(num(d.id), now);
        if (!r.finalized) continue;
        out.finalized++;
        out.trophies += r.trophies;
      } catch (e) {
        out.failed.push({ id: num(d.id), error: e?.message ?? String(e) });
      }
    }

    // Reconcile: the latest finalized edition of every recurring series that
    // has no later edition scheduled. scheduleNextEdition is itself idempotent
    // (the edition-numbered slug collides), so a duplicate pass is a no-op.
    const orphans = await this.all(
      `SELECT t.* FROM tournament t
       WHERE t.status = 'finalized' AND t.repeat_every_days > 0
         AND NOT EXISTS (
           SELECT 1 FROM tournament n
           WHERE COALESCE(n.series_key, n.slug) = COALESCE(t.series_key, t.slug)
             AND n.edition > t.edition
             AND n.status <> 'cancelled'
         )
       ORDER BY t.ends_at`
    );
    for (const o of orphans) {
      try {
        const next = await this.scheduleNextEdition(this._tournamentRow(o), now);
        if (next) out.scheduled.push(next);
      } catch (e) {
        out.failed.push({ id: num(o.id), error: e?.message ?? String(e) });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // The Monthly Cup — automatic monthly series
  // ------------------------------------------------------------------------
  // See docs/monthly-cup-design.md. The pure rule lives in tournaments.js; this
  // is the data access plus the one transaction that materialises an edition.

  // The previous month's most-FINISHED maps.
  //
  // The metric is raw COUNT(*) over the finish log, windowed to a calendar
  // month. `finish` is the only table that can answer this at all: run_tally is
  // a history-less cumulative counter and `race` holds PBs only, so a windowed
  // `race` count would mean "new personal bests set", not "played".
  //
  // Returns rows already ranked, NOT yet censor-filtered — the caller does that
  // in JS because the censor word matcher is an in-memory matcher with no SQL
  // form, and the game feed necessarily sends map names raw (a censored map
  // would otherwise be announced uncensored in-game while showing starred on the
  // site).
  async monthlyPoolCandidates({
    since,
    until,
    minFinishers = MONTHLY_MIN_FINISHERS,
    limit = MONTHLY_CANDIDATE_FETCH,
    excludeTournamentWindows = true,
  } = {}) {
    // The tournament is itself the strongest concentrator of play on its own
    // pool — `callvote tourneymap` actively moves servers onto those maps — so
    // counting finishes made INSIDE a tournament window on that tournament's own
    // pool maps would make the pool a fixed point: September's pool would equal
    // August's forever. Subtracting them makes the metric mean "popular in
    // ordinary play".
    //
    // status IN ('published','finalized') is load-bearing. `<> 'cancelled'`
    // would also match a forgotten DRAFT, which concentrates no play whatsoever
    // and (drafts may run up to 90 days) could silently subtract a quarter's
    // worth of popularity data.
    const tourneyExclusion = excludeTournamentWindows
      ? `AND NOT EXISTS (
           SELECT 1 FROM tournament t
             JOIN tournament_map tm ON tm.tournament_id = t.id AND tm.map_id = m.id
            WHERE t.status IN ('published','finalized')
              AND f.created_at >= t.starts_at
              AND f.created_at <  t.ends_at
         )`
      : "";
    return (
      await this.all(
        `SELECT m.id                                                   AS map_id,
                m.name                                                 AS map_name,
                COUNT(*)::int                                          AS finishes,
                COUNT(DISTINCT COALESCE(pl.canonical_id, pl.id))::int  AS finishers
           FROM finish f
           JOIN player pl ON pl.id = f.player_id
           JOIN map    m  ON m.id  = f.map_id
          WHERE f.created_at >= $1
            AND f.created_at <  $2
            -- A reverse run is its own map row "<map>-reversed". No pk3 contains
            -- that .bsp, so "callvote tourneymap" can never reach it: it would
            -- score and be unplayable.
            AND m.name NOT LIKE '%-reversed'
            -- Canonical case only. The auto pool is inserted BY MAP ID, but
            -- setTournamentMaps lowercases and get-or-creates BY NAME, so a
            -- mixed-case pool map would round-trip into a DIFFERENT, empty map
            -- row on any admin re-save — and because standingsQuery resolves the
            -- pool at READ time, every point already scored on it would vanish
            -- with no error at all.
            AND m.name = lower(m.name)
            -- Blocked maps are stripped from every in-game vote path, so a
            -- blocked pool map is another unreachable entry.
            AND NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = m.id)
            ${tourneyExclusion}
          GROUP BY m.id, m.name
         HAVING COUNT(DISTINCT COALESCE(pl.canonical_id, pl.id)) >= $3
          -- Ties are common at this site's scale, and under the skip rule a tie
          -- at the last pool slot can decide whether the month runs at all, so
          -- the order has to be TOTAL and stable. finishers breaks most ties in
          -- practice; map.name is UNIQUE so the name key always resolves the
          -- rest, and COLLATE "C" keeps it byte-stable regardless of the
          -- server's locale.
          ORDER BY finishes DESC, finishers DESC, m.name COLLATE "C" ASC
          LIMIT $4`,
        [Math.trunc(since), Math.trunc(until), Math.max(1, Math.trunc(minFinishers)), clampLimit(limit, 40, 200)]
      )
    ).map((r) => ({
      mapId: num(r.map_id),
      mapName: r.map_name,
      finishes: num(r.finishes),
      finishers: num(r.finishers),
    }));
  }

  // The pool of the last edition of this series that ACTUALLY RAN, as map ids.
  //
  // Bounded by the WINDOW being decided, never by `now`. With `starts_at <= now`
  // a re-decide of a month whose edition already exists returns that month's OWN
  // edition as the comparand — whose pool is byte-identical to the one just
  // recomputed from the same data — so it would intersect fully and record
  // "skipped_overlap" for a tournament that is live and scoring. Reachable via
  // the force button, a restore, or a manual row delete.
  //
  // Restricted to the series: a hand-made tournament always lands with
  // series_key NULL (createTournament only sets it when repeat_every_days > 0),
  // so unrelated admin activity can never become the comparand.
  async monthlySeriesPrevPool(seriesKey, windowStart) {
    const prev = await this.one(
      `SELECT id FROM tournament
        WHERE series_key = $1 AND status IN ('published','finalized') AND starts_at < $2
        ORDER BY starts_at DESC, id DESC LIMIT 1`,
      [seriesKey, Math.trunc(windowStart)]
    );
    if (!prev) return { tournamentId: null, mapIds: [] };
    const ids = await this.all("SELECT map_id FROM tournament_map WHERE tournament_id = $1", [num(prev.id)]);
    return { tournamentId: num(prev.id), mapIds: ids.map((r) => num(r.map_id)) };
  }

  _autoPeriodRow(r) {
    if (!r) return null;
    return {
      series_key: r.series_key,
      period: r.period,
      decision: r.decision,
      tournament_id: r.tournament_id == null ? null : num(r.tournament_id),
      detail: r.detail || {},
      decided_at: num(r.decided_at),
    };
  }

  async autoPeriod(seriesKey, period) {
    return this._autoPeriodRow(
      await this.one("SELECT * FROM tournament_auto_period WHERE series_key = $1 AND period = $2", [seriesKey, period])
    );
  }

  async autoPeriods(seriesKey, limit = 12) {
    return (
      await this.all(
        `SELECT * FROM tournament_auto_period WHERE series_key = $1
          ORDER BY period DESC LIMIT $2`,
        [seriesKey, clampLimit(limit, 12, 120)]
      )
    ).map((r) => this._autoPeriodRow(r));
  }

  // Consecutive TERMINAL skips immediately preceding `period`. Walks backwards
  // and stops at the first month that is not a skip — including a month with no
  // row at all, which is the correct stop: a month the generator never reached
  // (the feature was off, the site was down) is not evidence that the rule is
  // deadlocked, and counting it would force an edition that nothing justified.
  async monthlySkipStreak(seriesKey, period, maxLookback = 24) {
    let streak = 0;
    let p = prevPeriodKey(period);
    for (let i = 0; i < maxLookback && p; i++) {
      const row = await this.autoPeriod(seriesKey, p);
      if (!row) break;
      const skipped =
        row.decision === "skipped_overlap" ||
        row.decision === "skipped_thin" ||
        // A force that never produced an edition is still a month that did not
        // run. Counting it as anything else would let a mistaken click reset the
        // escalation and push the automatic rescue further away.
        (row.decision === "forced" && row.tournament_id == null);
      if (!skipped) break;
      streak++;
      p = prevPeriodKey(p);
    }
    return streak;
  }

  // Record a decision that produces NO edition (skipped_thin / skipped_overlap /
  // blocked). Returns {changed} so the caller logs only when the decision moves
  // — a month blocked for a week would otherwise emit one identical warning
  // every sweep, ~2000 of them.
  async recordAutoPeriod(seriesKey, period, decision, detail, now = Math.floor(Date.now() / 1000)) {
    // Two guards, and both are load-bearing.
    //
    // TERMINAL rows are never downgraded. Without that guard a later pass could
    // overwrite a committed 'scheduled' with 'blocked' — and since a created
    // edition necessarily overlaps its own window, the month would then block
    // itself forever, silently, while telling the operator to cancel the very
    // cup they are being told is blocked.
    //
    // `changed` reports whether the DECISION moved, which is what gates the log
    // (a week-long block must warn once, not ~2000 times) — but detail and
    // decided_at are refreshed even when it did not, so the durable record never
    // goes on naming a blocker that has since been cleared.
    // Read-then-write rather than deriving the prior value inside RETURNING: a
    // subquery there reads the statement's own snapshot, which is a subtlety
    // nobody should have to re-derive to know whether this logs. The extra round
    // trip costs nothing on a job that runs every five minutes.
    const prior = await this.autoPeriod(seriesKey, period);
    if (prior && MONTHLY_TERMINAL.has(prior.decision)) return { changed: false, blockedByTerminal: true };
    await this.pool.query(
      `INSERT INTO tournament_auto_period AS ap (series_key, period, decision, detail, decided_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (series_key, period) DO UPDATE
         SET decision = EXCLUDED.decision, detail = EXCLUDED.detail, decided_at = EXCLUDED.decided_at
       WHERE ap.decision NOT IN ('scheduled','skipped_overlap','skipped_thin','cancelled')`,
      [seriesKey, period, decision, JSON.stringify(detail || {}), now]
    );
    return { changed: !prior || prior.decision !== decision };
  }

  // Mark a month for a forced re-decide (the operator escape hatch). Only a
  // terminal skip can be forced — forcing a month that already produced an
  // edition would be a request to double-book the calendar.
  // Returns rows changed, or {error} when the force cannot take effect.
  //
  // A force AFTER the window has opened is refused. It would otherwise be a
  // permanent no-op that reports success: the generator does nothing once
  // `now >= startsAt`, so the row would sit at 'forced' forever — and because
  // 'forced' is non-terminal it would ALSO stop counting toward the skip streak,
  // silently pushing the automatic escalation further away as a side effect of a
  // click that did nothing.
  async forceMonthlyPeriod(seriesKey, period, by, now = Math.floor(Date.now() / 1000)) {
    const win = monthlyWindow(period);
    if (!win) return { error: "That is not a month this series can schedule." };
    if (now >= win.startsAt) {
      return { error: "That month's window has already opened — it can no longer be re-decided." };
    }
    const r = await this.pool.query(
      `UPDATE tournament_auto_period
          SET decision = 'forced',
              -- forcedFrom preserves the decision being overridden, so the skip
              -- itself survives the override in the audit trail; forceRequestedAt
              -- is what lets the force survive an intervening 'blocked' write.
              detail = detail || jsonb_build_object(
                'forcedBy', $3::text, 'forcedAt', $4::bigint,
                'forceRequestedAt', $4::bigint, 'forcedFrom', decision),
              decided_at = $4
        WHERE series_key = $1 AND period = $2
          AND decision IN ('skipped_overlap','skipped_thin')`,
      [seriesKey, period, by || null, now]
    );
    return r.rowCount;
  }

  // Decide the current month for the automatic series, and materialise the
  // edition if it is to run.
  //
  // Every return carries an explicit `wrote` flag, and the sweep logs only when
  // it is true. Ordered so the cheap, ACTIONABLE condition is checked before the
  // expensive aggregate: overlappingTournaments is one indexed range scan, and
  // running it second would mean a month that was both collided and blocked
  // recorded "skipped_overlap" and never named the blocker an operator can
  // actually clear.
  async scheduleMonthlyEdition({
    seriesKey = MONTHLY_SERIES_KEY,
    now = Math.floor(Date.now() / 1000),
    period = null,
    poolSize = MONTHLY_POOL_SIZE,
    minPool = MONTHLY_MIN_POOL,
    minFinishers = MONTHLY_MIN_FINISHERS,
    scoring = MONTHLY_SCORING,
    maxSkipStreak = MONTHLY_MAX_SKIP_STREAK,
    excludeTournamentWindows = true,
    dryRun = false,
  } = {}) {
    const per = period || monthPeriodKey(now);
    const win = monthlyWindow(per);
    if (!win) return { period: per, decision: "invalid-period", wrote: false };

    // A month whose window has already opened is not a skip — it is a month the
    // generator could not reach in time. Writing nothing is what keeps a deploy
    // mid-month quiet instead of raising an alarm about a month that was never
    // going to run.
    if (!dryRun && now >= win.startsAt) return { period: per, decision: "window-open", wrote: false };

    // The preview reads exactly what the real pass reads — only the WRITES are
    // suppressed. A preview that ignored the existing decision would keep
    // cheerfully reporting "would pick <maps>" for a month that has already been
    // decided or lost, which is worse than no preview at all.
    const existing = await this.autoPeriod(seriesKey, per);
    if (existing && MONTHLY_TERMINAL.has(existing.decision)) {
      return { period: per, decision: existing.decision, wrote: false, detail: existing.detail };
    }
    // A force survives an intervening block: it is carried in the detail as well
    // as in the decision, so a `blocked` write in between cannot silently
    // destroy an operator's override.
    const forced = Boolean(existing && (existing.decision === "forced" || existing.detail?.forceRequestedAt));
    const carry = existing?.detail?.forceRequestedAt ? { forceRequestedAt: existing.detail.forceRequestedAt } : {};

    // Is OUR OWN edition for this period already on the calendar? That is not a
    // blocker — it is the answer. It happens whenever the decision row is lost
    // but the tournament survives (a partial restore, a manual delete), and
    // treating it as a blocker would make the month block itself forever.
    // Checked across EVERY status, because the slug is unique regardless of
    // status while the calendar constraint ignores cancelled rows — so a
    // cancelled edition is invisible to overlappingTournaments yet still owns
    // the slug the insert below would need.
    const holder = await this.one(
      "SELECT id, status, series_key, starts_at, ends_at FROM tournament WHERE slug = $1",
      [monthlySlug(per)]
    );
    // ...and it is only OURS if it is this series at exactly this window. A row
    // that merely happens to hold the slug — an admin's hand-made cup, a restore
    // from another instance — is a squatter, and adopting it would silently hand
    // the month's identity to a tournament nobody scheduled.
    const mine =
      holder &&
      holder.series_key === seriesKey &&
      num(holder.starts_at) === win.startsAt &&
      num(holder.ends_at) === win.endsAt
        ? holder
        : null;
    if (holder && !mine) {
      // Reported here rather than by letting the INSERT fail, so the diagnosis
      // does not depend on which unique constraint Postgres happens to raise
      // first (the slug 23505 fires before the calendar 23P01, which is what
      // made this look like a lost peer race).
      return {
        period: per, decision: "slug-taken", wrote: false,
        error: `slug ${monthlySlug(per)} is held by tournament ${num(holder.id)} (${holder.status})`,
      };
    }
    if (mine) {
      const status = mine.status;
      // An operator cancelling this month's cup IS the decision. Recording it
      // terminally is what stops the generator retrying the slug every five
      // minutes for the rest of the day.
      const decision = status === "cancelled" ? "cancelled" : "scheduled";
      const detail = {
        ...carry,
        reason: status === "cancelled"
          ? "an operator cancelled this month's edition"
          : "the edition already exists (decision record was rebuilt from the calendar)",
        period: per, tournamentId: num(mine.id), status,
      };
      if (dryRun) return { period: per, decision, wrote: false, detail, window: win };
      const { changed } = await this.recordAutoPeriod(seriesKey, per, decision, detail, now);
      if (changed) {
        await this.pool.query(
          "UPDATE tournament_auto_period SET tournament_id = $3 WHERE series_key = $1 AND period = $2",
          [seriesKey, per, num(mine.id)]
        );
      }
      return { period: per, decision, wrote: changed, detail, tournamentId: num(mine.id), window: win };
    }

    // The calendar rule is never bypassed, not even by a force.
    const blockers = await this.overlappingTournaments(win.startsAt, win.endsAt);
    if (blockers.length) {
      const detail = {
        ...carry,
        reason: "the calendar slot is taken",
        blockedBy: blockers.map((b) => ({
          id: b.id, slug: b.slug, name: b.name, status: b.status,
          startsAt: b.starts_at, endsAt: b.ends_at,
        })),
        window: { startsAt: win.startsAt, endsAt: win.endsAt },
      };
      if (dryRun) return { period: per, decision: "blocked", wrote: false, detail, window: win };
      const { changed } = await this.recordAutoPeriod(seriesKey, per, "blocked", detail, now);
      return { period: per, decision: "blocked", wrote: changed, detail, window: win };
    }

    const look = prevMonthWindow(per);
    const raw = await this.monthlyPoolCandidates({
      since: look.since,
      until: look.until,
      minFinishers,
      limit: MONTHLY_CANDIDATE_FETCH,
      excludeTournamentWindows,
    });
    // Censor in JS over the over-fetch (see monthlyPoolCandidates).
    const candidates = raw.filter((c) => this._cnMap(c.mapName, c.mapId) === c.mapName);

    const prev = await this.monthlySeriesPrevPool(seriesKey, win.startsAt);
    const skipStreak = await this.monthlySkipStreak(seriesKey, per);
    const decided = decideMonthlyPool({
      candidates, prevPoolIds: prev.mapIds, skipStreak, forced, poolSize, minPool, maxSkipStreak,
    });
    const detail = {
      ...carry,
      ...decided.detail,
      period: per,
      measured: { since: look.since, until: look.until },
      window: { startsAt: win.startsAt, endsAt: win.endsAt },
      previousEditionId: prev.tournamentId,
    };

    if (dryRun) {
      return { period: per, decision: decided.decision, wrote: false, detail, pool: decided.pool, window: win };
    }

    if (decided.decision === "skipped_thin" || decided.decision === "skipped_overlap") {
      const { changed } = await this.recordAutoPeriod(seriesKey, per, decided.decision, detail, now);
      return { period: per, decision: decided.decision, wrote: changed, detail };
    }

    // Materialise. Row + pool + claim in ONE transaction: the whole reason this
    // design is safe is that a tournament never exists without its pool, so
    // "published with an empty pool" — which would announce 0 maps in-game,
    // freeze an empty result and mint no trophies — is unreachable rather than
    // merely guarded.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // The claim goes FIRST and is checked by rowCount. This is the entire
      // two-replica story: ON CONFLICT DO NOTHING raises NOTHING and returns
      // zero rows, so a loser watching only for an exception would carry on and
      // create a second edition.
      const claim = await client.query(
        `INSERT INTO tournament_auto_period (series_key, period, decision, detail, decided_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (series_key, period) DO UPDATE
           SET decision = EXCLUDED.decision, detail = EXCLUDED.detail, decided_at = EXCLUDED.decided_at
         WHERE tournament_auto_period.decision IN ('blocked','forced')
         RETURNING period`,
        [seriesKey, per, "scheduled", JSON.stringify(detail), now]
      );
      if (!claim.rowCount) {
        await client.query("ROLLBACK");
        return { period: per, decision: "already-decided", wrote: false };
      }

      const trow = (
        await client.query(
          `INSERT INTO tournament
             (slug, name, description, starts_at, ends_at, status, scoring, join_open,
              repeat_every_days, repeat_gap_days, series_key, edition, created_at, created_by)
           VALUES ($1,$2,$3,$4,$5,'published',$6,TRUE,0,0,$7,$8,$9,'auto-monthly') RETURNING id`,
          [
            monthlySlug(per), monthlyName(per), monthlyDescription(per),
            win.startsAt, win.endsAt, scoring, seriesKey,
            // Edition numbers the calendar for display only; the identity that
            // matters is the month, which is in the slug.
            (await this._monthlyEditionNumber(client, seriesKey)) + 1,
            now,
          ]
        )
      ).rows[0];
      const tournamentId = num(trow.id);

      let pos = 0;
      for (const m of decided.pool) {
        await client.query(
          "INSERT INTO tournament_map (tournament_id, map_id, position) VALUES ($1,$2,$3)",
          [tournamentId, m.mapId, pos++]
        );
      }
      await client.query(
        "UPDATE tournament_auto_period SET tournament_id = $3 WHERE series_key = $1 AND period = $2",
        [seriesKey, per, tournamentId]
      );

      await client.query("COMMIT");
      return {
        period: per, decision: decided.decision, wrote: true, tournamentId,
        slug: monthlySlug(per), pool: decided.pool, detail, window: win,
      };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      // Discriminate, because these two are NOT the same event and the naive
      // handler conflates them. With both the slug and the window colliding
      // Postgres raises the slug 23505 FIRST and never reaches 23P01, so a
      // leftover row named e.g. "monthly-cup-2026-09" (a restore, a rolled-back
      // experiment, an admin) would look exactly like "the other replica won"
      // and loop silently forever with no decision row ever written.
      if (e.code === "23505" && /auto_period/.test(e.constraint || "")) {
        return { period: per, decision: "already-decided", wrote: false };
      }
      if (e.code === "23505") {
        return { period: per, decision: "slug-taken", wrote: false, error: e.constraint || "unique violation" };
      }
      if (e.code === "23P01") {
        return { period: per, decision: "blocked-race", wrote: false };
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async _monthlyEditionNumber(client, seriesKey) {
    const r = await client.query("SELECT COALESCE(MAX(edition), 0) e FROM tournament WHERE series_key = $1", [seriesKey]);
    return num(r.rows[0].e) || 0;
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
      // Every player row this request touched (raw ids) — the caller feeds
      // them to the post-ingest achievements pass.
      const touched = new Set();

      // Bump the per-(player,map,version) counters: race starts plus the
      // movement/behaviour metrics (wall jumps, dashes, prejump-rejected starts,
      // restarts) the game module attaches to the same flush. Missing metric
      // fields (older servers) default to 0, so this stays backward-compatible.
      const bumpTally = (playerId, count, m = {}) =>
        client.query(
          `INSERT INTO run_tally (player_id, map_id, version_id, finishes, attempts, last_attempt,
                                  wall_jumps, dashes, prejump_failures, restarts, distance, strafes)
           VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (player_id, map_id, version_id)
           DO UPDATE SET attempts = run_tally.attempts + EXCLUDED.attempts,
                         last_attempt = EXCLUDED.last_attempt,
                         wall_jumps = run_tally.wall_jumps + EXCLUDED.wall_jumps,
                         dashes = run_tally.dashes + EXCLUDED.dashes,
                         prejump_failures = run_tally.prejump_failures + EXCLUDED.prejump_failures,
                         restarts = run_tally.restarts + EXCLUDED.restarts,
                         distance = run_tally.distance + EXCLUDED.distance,
                         strafes = run_tally.strafes + EXCLUDED.strafes`,
          [
            playerId, mapRow.id, versionRow.id, count, now,
            m.wall_jumps || 0, m.dashes || 0, m.prejump_failures || 0, m.restarts || 0,
            m.distance || 0, m.strafes || 0,
          ]
        );

      if (tally) {
        for (const a of attempts) {
          const playerId = await this._resolvePlayer(client, a);
          touched.add(playerId);
          await bumpTally(playerId, a.count, a);
        }
      }

      for (const rec of records) {
        const playerId = await this._resolvePlayer(client, rec);
        touched.add(playerId);

        if (tally) {
          await client.query(
            `INSERT INTO run_tally (player_id, map_id, version_id, finishes, last_finish)
             VALUES ($1, $2, $3, 1, $4)
             ON CONFLICT (player_id, map_id, version_id)
             DO UPDATE SET finishes = run_tally.finishes + 1, last_finish = $4`,
            [playerId, mapRow.id, versionRow.id, now]
          );
          await bumpTally(playerId, rec.attempts != null ? rec.attempts : 1, rec);

          // Log EVERY finish, not just the PB that lands in `race` below, so the
          // full run history (each run + its splits) is kept. Guarded by `tally`
          // (source=racelog live finishes): a topscores re-sync resends the whole
          // top-50 each interval and would otherwise duplicate the log every run.
          const fin = await q1(
            `INSERT INTO finish (player_id, map_id, version_id, time, server_id, created_at,
                                 strafe_quality, max_speed, start_speed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              playerId, mapRow.id, versionRow.id, rec.time, serverId, now,
              rec.strafe_quality ?? null, rec.max_speed ?? null, rec.start_speed ?? null,
            ]
          );
          const cps = Array.isArray(rec.checkpoints) ? rec.checkpoints : [];
          if (cps.length) {
            // One bulk insert rather than N awaited round-trips: UNNEST the
            // splits array; WITH ORDINALITY yields the 1-based position, so
            // `number` = ord - 1 (0-based), matching the old per-row loop.
            await client.query(
              `INSERT INTO finish_checkpoint (finish_id, number, time)
               SELECT $1, (ord - 1)::int, t FROM unnest($2::int[]) WITH ORDINALITY AS s(t, ord)`,
              [fin.id, cps]
            );
          }
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
        // Snapshot how many tries this PB took. run_tally.attempts is a running
        // counter with no history, so it can only be captured HERE, while it
        // still reads as of this run. The tally bump above already counted the
        // attempt that produced this finish, so the sum is inclusive. Summed
        // over the whole canonical identity group and every game version on the
        // map, matching how the leaderboard row itself is grouped. Only for
        // racelog ingests: a topscores re-sync bumps no tally, so its counter is
        // unrelated to the run being recorded — NULL ("unknown") instead.
        let attemptsAtPb = null;
        if (tally) {
          const a = await q1(
            `SELECT SUM(rt.attempts) a
               FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
              WHERE rt.map_id = $1
                AND pl.canonical_id = (SELECT canonical_id FROM player WHERE id = $2)`,
            [mapRow.id, playerId]
          );
          // 0 means "counted nothing", which is not a real attempt count.
          attemptsAtPb = a && a.a != null && num(a.a) > 0 ? num(a.a) : null;
        }
        const raceId = await this._nextRaceId(client);
        await client.query(
          `INSERT INTO race (id, version_id, player_id, map_id, time, server_id, created_at,
                             strafe_quality, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            raceId, versionRow.id, playerId, mapRow.id, rec.time, serverId, now,
            // The PB's OWN strafe quality — the same measurement written to its
            // finish row above, denormalised so the leaderboard needn't guess
            // which finish produced the record.
            rec.strafe_quality ?? null, attemptsAtPb,
          ]
        );
        if (rec.checkpoints.length) {
          await client.query(
            `INSERT INTO checkpoint (race_id, number, time)
             SELECT $1, (ord - 1)::int, t FROM unnest($2::int[]) WITH ORDINALITY AS s(t, ord)`,
            [raceId, rec.checkpoints]
          );
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

      return { ...counts, playerIds: [...touched] };
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
