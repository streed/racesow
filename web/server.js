// Race stats web server: hosts the race SQLite database behind a small REST API
// and serves the static frontend that consumes it.
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDatabase, sha256, simplifyName, hashPassword, verifyPassword, FLAG_REASONS } from "./db.js";
import { createLivePoller, parseAddress } from "./live.js";
import { sendRcon, broadcastRcon, sanitizeCommand, sayCommand } from "./rcon.js";
import { playerCardCached, liveCardCached, serverCardCached } from "./og-image.js";
import { cache } from "./cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8080", 10);
// PostgreSQL connection (see docker-compose.yml postgres service). The old
// DB_PATH/SQLite file is only used by the one-time migrate-sqlite-to-pg.js.
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";

// Canonical public origin for server-rendered share URLs (og:url/og:image) and
// the OG card footer. Pinning it here means those never depend on the
// attacker-controllable Host / X-Forwarded-Host header (which would otherwise
// let a request point another viewer's share tags at an arbitrary host and
// poison the id-keyed OG image cache). Unset -> derive per request (dev).
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const PUBLIC_HOST = PUBLIC_ORIGIN ? new URL(PUBLIC_ORIGIN).host : "";

// Weekly public database backup, published by the db-backup sidecar (see
// backup/ + docker-compose.yml) into BACKUP_DIR under the shared ./data mount.
// The zip is served for download at /backup/racesow-db-latest.zip and its
// metadata at /api/backup; both 404 gracefully until the first backup exists.
const BACKUP_DIR = process.env.BACKUP_DIR || "/data/backups";
const BACKUP_LATEST_ZIP = path.join(BACKUP_DIR, "racesow-db-latest.zip");
const BACKUP_LATEST_META = path.join(BACKUP_DIR, "racesow-db-latest.json");

// Legacy single-server token (optional). Per-server tokens live in the DB
// `server` table and are the recommended path for multi-server deploys.
const PLACEHOLDER_TOKEN = "change-me-ingest-token";
let INGEST_TOKEN = process.env.INGEST_TOKEN || "";
if (INGEST_TOKEN === PLACEHOLDER_TOKEN) {
  console.warn(
    "WARNING: INGEST_TOKEN is the well-known placeholder — ignoring it and disabling the shared-token path. " +
      "Set a real secret (openssl rand -hex 32) or enroll per-server tokens."
  );
  INGEST_TOKEN = "";
}
const INGEST_TOKEN_HASH = INGEST_TOKEN ? sha256(INGEST_TOKEN) : "";

// How stale the in-memory aggregates may get during a sustained ingest stream.
const REFRESH_DEBOUNCE_MS = 3000;
const REFRESH_MAX_WAIT_MS = 30000;
// Defensive caps on a single ingested record (a buggy/hostile authorized
// collector could otherwise bloat the DB). Real data maxes ~2730 checkpoints.
const MAX_NAME_LEN = 64;
const MAX_MAP_LEN = 128;
const MAX_VERSION_LEN = 64;
const MAX_CHECKPOINTS = 4096;
const MAX_TIME_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS_PER_REQUEST = 1000;
// Free-text on a public map-flag report; capped so a report can't be an essay.
const FLAG_NOTE_MAX = 500;

// Signals are handled from the very first tick: node may run as container
// PID 1, where SIGTERM with no handler installed is silently ignored (docker
// then waits 10s and SIGKILLs). During boot (DB probe + migrations below) the
// handler just exits; once the server is up it is swapped for the graceful
// drain defined at the bottom of this file.
let shuttingDown = false;
let onSignal = () => process.exit(0);
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

console.log(`Connecting to database ...`);
const race = await openDatabase(DATABASE_URL);

// Live "who's playing" poller: UDP getstatus against each enrolled server
// that has a query address (admin.js address). /api/live serves the cache.
const live = createLivePoller(race);

const app = express();
app.disable("x-powered-by");
// One trusted proxy (the production nginx) so req.ip is the real client for
// rate limiting; harmless when hit directly (no X-Forwarded-For -> socket IP).
app.set("trust proxy", 1);

// Minimal dependency-free fixed-window rate limiter. The production nginx also
// rate-limits, but the game-server render routes (/player, /og) and ingest
// warrant an in-app cap too: those routes do synchronous DB work + PNG
// rasterization that blocks the single event loop, so an unthrottled flood of
// distinct ids can stall the whole site. Keyed per client (IP) or per ingest
// server; an unref'd sweeper bounds the map so distinct-key floods can't grow
// it without limit.
function rateLimiter({ windowMs, max, key = (req) => req.ip || "?" }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const now = Date.now();
    const k = key(req);
    let e = hits.get(k);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(k, e);
    }
    if (++e.count > max) {
      res.set("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: "rate limited" });
    }
    next();
  };
}

// Server-rendered player/OG routes: expensive (DB + resvg PNG), so keep this
// tighter than the API. ~1/s average per IP absorbs crawlers and real users.
const renderLimiter = rateLimiter({ windowMs: 60_000, max: 60 });
// Public read API backstop (nginx does the primary 20r/s); generous so page
// fan-out isn't affected, but bounds a direct-to-:8080 flood.
const apiLimiter = rateLimiter({ windowMs: 60_000, max: 600 });
// Ingest: keyed by the authenticated server so one server can't starve others.
const ingestLimiter = rateLimiter({
  windowMs: 60_000,
  max: 120,
  key: (req) => "ingest:" + (req.ingest ? req.ingest.serverId ?? req.ingest.serverName : req.ip),
});
// Public map-flag submissions: per IP, well under the read budget so a script
// can't spam the review queue (dedupe in the DB is the second line of defence).
const flagLimiter = rateLimiter({ windowMs: 60_000, max: 8, key: (req) => "flag:" + (req.ip || "?") });
// Admin login POST: tight per-IP brute-force backstop (nginx also fronts this).
const loginLimiter = rateLimiter({ windowMs: 60_000, max: 10, key: (req) => "login:" + (req.ip || "?") });
// Public backup download: a multi-MB file, so cap per-IP pulls (nginx also
// fronts it) — generous enough for a browser plus a resumed/parallel download
// manager, tight enough that it can't be used as a bandwidth amplifier.
const backupLimiter = rateLimiter({ windowMs: 60_000, max: 20, key: (req) => "backup:" + (req.ip || "?") });

app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const api = express.Router();
api.use(apiLimiter);

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// Express 4 does not catch rejected async handlers; route through this so a
// DB error becomes a 500 via the error middleware instead of a hung request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hot read endpoints are Redis-cached (short TTL). /overview is the heaviest
// aggregate and the most-hit page-load call, so it gets the longest window.
api.get("/overview", cache(120, { edge: true }), wrap(async (_req, res) => res.json(await race.overview())));
api.get("/servers", wrap(async (_req, res) => res.json({ servers: await race.servers() })));

// One enrolled server: its DB record (name, status, records, last-seen,
// address) merged with the live poller's current snapshot (online, hostname,
// map, current players). Powers the /server/:id page.
api.get("/servers/:id", wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid server id" });
  const s = (await race.servers()).find((x) => x.id === id);
  if (!s) return res.status(404).json({ error: "server not found" });
  const snap = live.getLive();
  const li = (snap.servers || []).find((x) => x.id === id) || null;
  const mapId = li && li.map ? await race.mapIdByName(li.map) : null;
  res.json({
    ...s,
    updatedAt: snap.updatedAt,
    live: li ? { ...li, mapId } : { online: false, players: [] },
  });
}));

api.get("/maps", cache(60, { edge: true }), wrap(async (req, res) => res.json(await race.maps(req.query))));

// Maps a moderator has blocked from play (see the admin area). Registered BEFORE
// "/maps/:id" so "blocked" isn't captured as an :id. Public read — it only names
// maps already pulled from rotation.
api.get("/maps/blocked", cache(60), wrap(async (_req, res) => {
  const rows = await race.blockedMaps();
  res.json({
    maps: rows.map((r) => ({
      id: r.map_id,
      name: r.name,
      reason: r.reason,
      blockedAt: Number(r.blocked_at),
      blockedBy: r.blocked_by,
    })),
  });
}));

api.get("/maps/:id", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = await race.mapDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "map not found" });
  res.json(detail);
}));

// Ghost trajectory for the in-browser replay viewer (gzipped JSON). Served with
// Content-Encoding: gzip so the stored bytes go straight to the client.
// ?player=<id> selects that player's PB ghost; omitted => the map's WR ghost.
api.get("/maps/:id/ghost", wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const player = req.query.player != null ? asInt(req.query.player) : null;
  if (req.query.player != null && player == null)
    return res.status(400).json({ error: "invalid player id" });
  const buf = await race.ghostGzip(id, player);
  if (!buf) return res.status(404).json({ error: "no ghost for this map/player" });
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Content-Encoding", "gzip");
  res.set("Cache-Control", "public, max-age=300");
  res.send(buf);
}));

// Public "flag this map for review" (broken / offensive / wrong metadata / …).
// Anonymous, tightly rate-limited, and deduped per reporter (db.flagMap): a
// reporter is identified only by a salted hash of their IP, never stored raw.
// A duplicate (same reporter+reason still open) returns ok with duplicate:true
// rather than an error, so the UI can say "already reported" without leaking
// how many others flagged it.
api.post(
  "/maps/:id/flag",
  flagLimiter,
  express.json({ limit: "8kb" }),
  wrap(async (req, res) => {
    const id = asInt(req.params.id);
    if (id == null) return res.status(400).json({ error: "invalid map id" });
    const body = req.body || {};
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!FLAG_REASONS.includes(reason)) return res.status(400).json({ error: "invalid reason" });
    let note = typeof body.note === "string" ? body.note.trim().slice(0, FLAG_NOTE_MAX) : "";
    if (!note) note = null;
    const reporterHash = sha256("mapflag:" + (req.ip || "?"));
    const r = await race.flagMap({ mapId: id, reason, note, reporterHash });
    if (!r.ok) return res.status(404).json({ error: r.error || "map not found" });
    res.json({ ok: true, duplicate: !!r.duplicate });
  })
);

api.get("/players", cache(60, { edge: true }), wrap(async (req, res) => res.json(await race.players(req.query))));

api.get("/players/:id", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const detail = await race.playerDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "player not found" });
  res.json(detail);
}));

api.get("/search", cache(60), wrap(async (req, res) => res.json(await race.search(req.query.q || "", { limit: 8 }))));

// New records after a race id — the Discord announcer polls this (it has no
// database access; margin-to-#2 and version names are computed here). Public
// read: nothing the site's recent-records feed doesn't already show.
api.get("/records", cache(60), wrap(async (req, res) => {
  res.json(
    await race.recordsAfter({
      afterId: asInt(req.query.after_id) ?? 0,
      maxRank: asInt(req.query.max_rank) ?? 1,
      limit: asInt(req.query.limit) ?? 10,
    })
  );
}));

api.get("/live", wrap(async (_req, res) => {
  const snap = live.getLive();
  const servers = await Promise.all(
    snap.servers.map(async (s) => ({ ...s, mapId: s.map ? await race.mapIdByName(s.map) : null }))
  );
  res.json({
    ...snap,
    servers,
    maintenance: maintenance.active
      ? { active: true, message: maintenance.message, since: maintenance.since }
      : { active: false },
  });
}));

// Live topscores for game servers: the hrace gametype's RS_ApiFetchTop
// native GETs this on map load and on a refresh interval, and swaps the
// response into the map's local topscores file — the payload is byte-format
// identical to that file, so the gametype's normal loader consumes it and
// every server connected to this API serves the same in-game `top` lists,
// HUD record lines and record announcements. Public read — it exposes
// nothing the map leaderboard pages don't already show.
api.get("/game/topscores", cache(120), wrap(async (req, res) => {
  const body = await race.gameTopscoresText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body);
}));

// Flat-text WR ghost for game servers: the hrace gametype's RS_ApiFetchGhost
// native GETs this on map load and drives an in-game "ghost racer" along it.
// Text (not the gzipped JSON) because AngelScript can't decompress/parse JSON.
// Short TTL (not 120s): meshed servers re-pull this the moment a peer sets a
// faster time (hrace/ghostbot.as) so every server races the current WR ghost —
// a long cache would keep serving the superseded ghost for minutes. The MIN(time)
// lookup is index-backed and game-server fetch volume is low, so 15s is cheap.
api.get("/game/ghost", cache(15), wrap(async (req, res) => {
  const body = await race.gameGhostText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// no ghost\n");
  res.type("text/plain").send(body);
}));

// Blocked maps for the game servers: server/entrypoint.sh GETs this while
// building g_maplist and drops these maps from the vote pool + cycle. Plain
// text, one lowercased map name per line (empty body = nothing blocked).
api.get("/game/blocked-maps", cache(30), wrap(async (_req, res) => {
  const names = await race.blockedMapNames();
  res.type("text/plain").send(names.length ? names.join("\n") + "\n" : "");
}));

api.get("/health", (_req, res) => res.json({ ok: true }));

// Metadata for the latest public database backup: size, sha256, when it was
// generated, and what it includes/excludes. A missing file means "no backup
// yet" (404); any other error (permissions, disk, corrupt JSON) is a real fault
// worth surfacing (500 + a log) rather than masking as the not-yet-run state.
api.get("/backup", wrap(async (_req, res) => {
  let meta;
  try {
    meta = JSON.parse(await readFile(BACKUP_LATEST_META, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return res.status(404).json({ error: "no backup available yet" });
    console.error("backup metadata unavailable:", e.message);
    return res.status(500).json({ error: "backup metadata unavailable" });
  }
  res.json(meta);
}));

// --- Aggregate refresh (debounced, with a max-wait so a continuous ingest
// stream from many servers can't starve the rebuild indefinitely). ----------
let refreshTimer = null;
let firstDirtyAt = 0;
let refreshRunning = false;
let refreshAgain = false;
async function doRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  firstDirtyAt = 0;
  // A rebuild started mid-drain would hold a pool client past server.close()
  // and push the shutdown into its force-exit backstop; the replacement
  // container recomputes aggregates at boot anyway.
  if (shuttingDown) return;
  // The rebuild is async now: never run two at once (they'd deadlock on the
  // table swap); a request arriving mid-rebuild queues exactly one more pass.
  if (refreshRunning) {
    refreshAgain = true;
    return;
  }
  refreshRunning = true;
  try {
    const t0 = Date.now();
    await race.refreshAggregates();
    console.log(`aggregates refreshed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("aggregate refresh failed (will retry on next ingest):", e.message);
  } finally {
    refreshRunning = false;
    if (refreshAgain) {
      refreshAgain = false;
      doRefresh();
    }
  }
}
function scheduleAggregateRefresh() {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  if (now - firstDirtyAt >= REFRESH_MAX_WAIT_MS) return doRefresh();
  clearTimeout(refreshTimer);
  const wait = Math.min(REFRESH_DEBOUNCE_MS, firstDirtyAt + REFRESH_MAX_WAIT_MS - now);
  refreshTimer = setTimeout(doRefresh, wait);
}

// ===================== Operator log stream + maintenance ====================
// The admin "servers" page (server-rendered, no client JS) is an operator
// console: it ships game-server stdout into /admin/logs, sends RCON broadcasts,
// and drives a persistent "maintenance mode" that re-notifies players on a
// timer. State lives in the DB (config + server_log) so both web replicas agree.
const LOG_MAX_LINES_PER_POST = 500;
const LOG_MAX_LINE_LEN = 2000;
const LOG_KEEP = Math.max(1000, parseInt(process.env.LOG_KEEP || "20000", 10));
// Re-broadcast cadence while maintenance mode is active (so players who join
// mid-maintenance still see the notice). Clamped to a sane floor.
const MAINT_REBROADCAST_SECS = Math.max(30, parseInt(process.env.MAINT_REBROADCAST_SECS || "180", 10));
const MAINT_STATE_REFRESH_MS = 10_000;
const DEFAULT_MAINT_MSG =
  "^3Scheduled maintenance in progress^7 — the server may restart shortly. Thanks for your patience!";

// In-memory maintenance snapshot for the hot /api/live path. Both replicas
// reconcile it from the DB every MAINT_STATE_REFRESH_MS; the replica that serves
// a toggle updates its own copy immediately.
let maintenance = { active: false, since: null, message: null, by: null };

// Record one operator-log line: keep the existing stdout log AND persist it to
// server_log for /admin/logs. Fire-and-forget — a log write must never break a
// request or the poller.
function recordEvent(serverId, line, source = "event", level = null) {
  console.log(line);
  race.appendServerLog([{ serverId: serverId ?? null, source, level, line }]).catch(() => {});
}

// Best-effort severity from a shipped console line so /admin/logs can tint it.
function logLevelOf(line) {
  if (/\b(error|failed|fatal)\b/i.test(line)) return "error";
  if (/\b(warn|warning)\b/i.test(line)) return "warn";
  return null;
}

let lastPruneAt = 0;
function maybePruneLogs() {
  const now = Date.now();
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  race.pruneServerLogs(LOG_KEEP).catch(() => {});
}

// Fan a command out to every RCON-enabled server and log the per-server outcome.
async function broadcastCommand(command, { source = "rcon", label = "rcon" } = {}) {
  const targets = await race.rconTargets();
  if (!targets.length) return { targets: 0, ok: 0, results: [] };
  const results = await broadcastRcon(targets, command, { parseAddress });
  const ok = results.filter((r) => r.ok).length;
  const entries = results.map((r) => ({
    serverId: r.id,
    source,
    level: r.ok ? null : "warn",
    line: `${label} → ${r.name}: ${
      r.ok ? "sent" : "FAILED (" + (r.error || (r.authFailed ? "bad rcon password" : "no reply")) + ")"
    }`,
  }));
  race.appendServerLog(entries).catch(() => {});
  return { targets: targets.length, ok, results };
}

// --- Maintenance re-broadcast timer (replica-safe) ---------------------------
let maintTimer = null;
let maintRefreshTimer = null;
function startMaintTimer() {
  if (maintTimer) return;
  maintTimer = setInterval(async () => {
    if (shuttingDown || !maintenance.active) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      // Atomic claim: with two replicas running this timer, exactly one wins the
      // round and sends, so players don't get duplicate notices.
      if (await race.claimMaintenanceRebroadcast(now, MAINT_REBROADCAST_SECS)) {
        await broadcastCommand(sayCommand(maintenance.message || DEFAULT_MAINT_MSG), {
          source: "maintenance",
          label: "maintenance re-notice",
        });
      }
    } catch {
      /* transient DB/UDP issue — the next tick retries */
    }
  }, 30_000);
  maintTimer.unref();
}
function stopMaintTimer() {
  clearInterval(maintTimer);
  maintTimer = null;
}

// Reconcile the in-memory snapshot from the DB (startup + periodic, both
// replicas) and (de)activate the local re-broadcast timer to match.
async function refreshMaintenance() {
  try {
    maintenance = await race.maintenanceState();
    if (maintenance.active) startMaintTimer();
    else stopMaintTimer();
  } catch {
    /* keep the last snapshot on a transient DB error */
  }
}

// Toggle maintenance mode: persist state, announce it in-game, and (on) arm the
// re-broadcast timer / (off) send an all-clear. Returns the broadcast summary.
async function setMaintenance(active, message, by) {
  const now = Math.floor(Date.now() / 1000);
  if (active) {
    const msg = message || DEFAULT_MAINT_MSG;
    await race.setConfig("maintenance_active", "1");
    await race.setConfig("maintenance_since", String(now));
    await race.setConfig("maintenance_message", msg);
    await race.setConfig("maintenance_by", by || "");
    await race.setConfig("maintenance_rebroadcast_at", String(now + MAINT_REBROADCAST_SECS));
    maintenance = { active: true, since: now, message: msg, by: by || null };
    const b = await broadcastCommand(sayCommand(msg), { source: "maintenance", label: "maintenance ON" });
    recordEvent(null, `maintenance ENABLED by ${by || "?"} — notified ${b.ok}/${b.targets} server(s)`, "maintenance");
    startMaintTimer();
    return b;
  }
  await race.setConfig("maintenance_active", "0");
  await race.setConfig("maintenance_since", null);
  await race.setConfig("maintenance_message", null);
  await race.setConfig("maintenance_by", null);
  await race.setConfig("maintenance_rebroadcast_at", null);
  maintenance = { active: false, since: null, message: null, by: null };
  stopMaintTimer();
  const b = await broadcastCommand(
    sayCommand("^2Maintenance complete^7 — thanks for your patience! Racing is back to normal."),
    { source: "maintenance", label: "maintenance OFF" }
  );
  recordEvent(null, `maintenance DISABLED by ${by || "?"} — notified ${b.ok}/${b.targets} server(s)`, "maintenance");
  return b;
}

// Constant-time bearer-token check. Hashing both sides first makes the compare
// length-independent (timingSafeEqual throws on unequal lengths otherwise).
function tokenMatches(presented, expectedHash) {
  if (!expectedHash) return false;
  const a = Buffer.from(sha256(presented), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolve the Authorization header to an ingest identity, or null.
//   -> { serverId, serverName } for a per-server token
//   -> { serverId: null, serverName: 'shared' } for the legacy shared token
async function authenticateIngest(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7);
  if (!token) return null;

  // Per-server token (preferred).
  const srv = await race.serverByTokenHash(sha256(token));
  if (srv) {
    if (srv.status === "revoked") return { revoked: true };
    return { serverId: srv.id, serverName: srv.name };
  }
  // Legacy shared token.
  if (INGEST_TOKEN_HASH && tokenMatches(token, INGEST_TOKEN_HASH)) {
    return { serverId: null, serverName: "shared" };
  }
  return null;
}

// Cap on attempt counts per entry: at humanly-possible restart spam (~1/s)
// a full map's worth of attempts stays well under this; anything above is a
// buggy or hostile server inflating a counter.
const MAX_ATTEMPTS_PER_ENTRY = 10000;

function sanitizeRecord(r) {
  if (!r || typeof r.name !== "string" || r.name.length === 0) return null;
  const time = Number(r.time);
  if (!Number.isInteger(time) || time <= 0 || time > MAX_TIME_MS) return null;
  const cpsIn = Array.isArray(r.checkpoints) ? r.checkpoints.slice(0, MAX_CHECKPOINTS) : [];
  // attempts = race starts since the player's last flush (includes the start
  // that produced this finish). Absent/invalid -> null: an old server that
  // predates attempt tracking (its finish still implies one attempt).
  const attempts = Number(r.attempts);
  return {
    name: r.name.slice(0, MAX_NAME_LEN),
    login: typeof r.login === "string" ? r.login.slice(0, MAX_NAME_LEN) : "",
    time,
    attempts:
      Number.isInteger(attempts) && attempts >= 0 ? Math.min(attempts, MAX_ATTEMPTS_PER_ENTRY) : null,
    checkpoints: cpsIn.map((t) => {
      const n = Number(t);
      return Number.isInteger(n) && n > 0 ? n : 0;
    }),
  };
}

// A WR demo path is a relative "<map>/<file>.wdz20" the game host serves. It
// becomes part of a download URL, so validate hard against path traversal:
// no "..", no backslash, no leading slash, exactly one segment separator, a
// .wdz20 extension, and only a URL-safe charset. The mod already restricts the
// player-name fragment to [A-Za-z0-9_-] (hrace/demos.as RACE_DemoCleanName),
// so this stays a tight allowlist rather than mirroring the engine's looser set.
const DEMO_SEG = /^[A-Za-z0-9_.-]+$/;
function validDemoPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) return false;
  if (p.includes("..") || p.includes("\\") || p.startsWith("/")) return false;
  if (!/\.wdz20$/.test(p)) return false;
  const parts = p.split("/");
  return parts.length === 2 && parts.every((s) => DEMO_SEG.test(s));
}

// A ghost is a fixed-rate trajectory: N frames of 9 finite numbers
// [x,y,z,pitch,yaw,roll,vx,vy,vz], implicit time = frameIndex / hz. Caps bound
// a hostile/buggy server (30000 frames = 20 min at 25 Hz).
const MAX_GHOST_FRAMES = 30000;
const MAX_GHOST_HZ = 250;
function sanitizeGhost(body) {
  const time = Number(body.time);
  const hz = Number(body.hz);
  if (typeof body.name !== "string" || !body.name) return null;
  if (!Number.isInteger(time) || time <= 0 || time > MAX_TIME_MS) return null;
  if (!Number.isInteger(hz) || hz <= 0 || hz > MAX_GHOST_HZ) return null;
  if (!Array.isArray(body.frames) || body.frames.length === 0 || body.frames.length > MAX_GHOST_FRAMES)
    return null;
  const frames = [];
  for (const f of body.frames) {
    // 9 numbers [x,y,z,pitch,yaw,roll,vx,vy,vz], optionally a 10th = the pressed-
    // keys bitmask (Warsow Key_*, 0-255) for the in-viewer key-press overlay.
    if (!Array.isArray(f) || (f.length !== 9 && f.length !== 10)) return null;
    const row = [];
    for (let k = 0; k < 9; k++) {
      const n = Number(f[k]);
      if (!Number.isFinite(n)) return null;
      row.push(Math.round(n * 1000) / 1000);
    }
    if (f.length === 10) {
      const keys = Number(f[9]);
      row.push(Number.isFinite(keys) ? keys & 255 : 0);
    }
    frames.push(row);
  }
  const cps = (Array.isArray(body.cps) ? body.cps : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < frames.length)
    .slice(0, MAX_CHECKPOINTS);
  return {
    name: body.name.slice(0, MAX_NAME_LEN),
    login: typeof body.login === "string" ? body.login.slice(0, MAX_NAME_LEN) : "",
    time,
    hz,
    frames,
    cps,
  };
}

// Standalone attempt flush entries (body.attempts[]): starts with no finish
// to ride on — the player disconnected or the map ended mid-run.
function sanitizeAttempt(a) {
  if (!a || typeof a.name !== "string" || a.name.length === 0) return null;
  const count = Number(a.count);
  if (!Number.isInteger(count) || count <= 0) return null;
  return {
    name: a.name.slice(0, MAX_NAME_LEN),
    login: typeof a.login === "string" ? a.login.slice(0, MAX_NAME_LEN) : "",
    count: Math.min(count, MAX_ATTEMPTS_PER_ENTRY),
  };
}

// Auth BEFORE body parsing so unauthenticated clients can't make us JSON.parse
// up to the body limit. Ingest identity is attached to req for the handler.
api.post(
  "/ingest",
  wrap(async (req, res, next) => {
    const ident = await authenticateIngest(req);
    if (!ident) return res.status(401).json({ error: "unauthorized" });
    if (ident.revoked) return res.status(403).json({ error: "server revoked" });
    req.ingest = ident;
    next();
  }),
  ingestLimiter, // per-server cap (after auth so req.ingest is set)
  express.json({ limit: "2mb" }),
  async (req, res) => {
    const body = req.body || {};
    if (typeof body.version !== "string" || !body.version || typeof body.map !== "string" || !body.map) {
      return res.status(400).json({ error: "version and map are required" });
    }

    // Player demo metadata: a pointer to a .wd file the game host serves, one
    // per (player, map). Does not touch the leaderboard — just records where the
    // player's PB demo is. (Wire key stays "wr_demo" for game-module compat.)
    if (body.source === "wr_demo" || body.wr_demo) {
      const d = body.wr_demo || {};
      const time = Number(d.time);
      if (typeof d.name !== "string" || !d.name || !Number.isInteger(time) || time <= 0 || time > MAX_TIME_MS)
        return res.status(400).json({ error: "invalid wr_demo record" });
      if (!validDemoPath(d.demo)) return res.status(400).json({ error: "invalid demo path" });
      try {
        await race.upsertPlayerDemo({
          version: body.version.slice(0, MAX_VERSION_LEN),
          map: body.map.slice(0, MAX_MAP_LEN).toLowerCase(),
          name: d.name.slice(0, MAX_NAME_LEN),
          login: typeof d.login === "string" ? d.login.slice(0, MAX_NAME_LEN) : "",
          time,
          demoPath: d.demo,
          bytes: Number.isInteger(Number(d.bytes)) && Number(d.bytes) >= 0 ? Number(d.bytes) : null,
          serverId: req.ingest.serverId,
        });
        recordEvent(req.ingest.serverId, `wr_demo ${body.map} from ${req.ingest.serverName}: ${d.demo}`);
        return res.json({ ok: true });
      } catch (e) {
        console.error("wr_demo ingest failed:", e);
        return res.status(500).json({ error: "ingest failed" });
      }
    }

    const source = body.source === "racelog" ? "racelog" : "topscores";
    // Cap the top-level strings for parity with record name/login, so an
    // enrolled server can't persist multi-KB map/version rows (DB bloat).
    const version = body.version.slice(0, MAX_VERSION_LEN);
    const map = body.map.slice(0, MAX_MAP_LEN);
    // A request carries finish records, standalone attempt flushes, or both.
    const records = Array.isArray(body.records) ? body.records : [];
    const attempts = Array.isArray(body.attempts) ? body.attempts : [];
    if (records.length > MAX_RECORDS_PER_REQUEST || attempts.length > MAX_RECORDS_PER_REQUEST) {
      return res.status(400).json({ error: `too many entries (max ${MAX_RECORDS_PER_REQUEST})` });
    }
    const clean = records.map(sanitizeRecord).filter(Boolean);
    const cleanAttempts = attempts.map(sanitizeAttempt).filter(Boolean);
    if (!clean.length && !cleanAttempts.length) {
      return res.status(400).json({ error: "no valid records or attempts" });
    }

    try {
      const counts = await race.ingest({
        version,
        map: map.toLowerCase(),
        records: clean,
        attempts: cleanAttempts,
        source,
        serverId: req.ingest.serverId,
      });
      if (req.ingest.serverId != null) {
        await race.touchServer(req.ingest.serverId, counts.inserted + counts.improved);
      }
      if (counts.inserted || counts.improved) {
        recordEvent(
          req.ingest.serverId,
          `ingest ${map} from ${req.ingest.serverName} [${source}]: +${counts.inserted} new, ${counts.improved} improved`
        );
        scheduleAggregateRefresh();
      }
      res.json(counts);
    } catch (e) {
      console.error("ingest failed:", e);
      res.status(500).json({ error: "ingest failed" });
    }
  }
);

// WR ghost trajectory upload (Phase 2): a separate route from /ingest because
// the frames are the payload (bigger body limit) and it writes a file, not a
// leaderboard row. Same per-server auth + rate limiter.
api.post(
  "/ingest/ghost",
  wrap(async (req, res, next) => {
    const ident = await authenticateIngest(req);
    if (!ident) return res.status(401).json({ error: "unauthorized" });
    if (ident.revoked) return res.status(403).json({ error: "server revoked" });
    req.ingest = ident;
    next();
  }),
  ingestLimiter,
  express.json({ limit: "8mb" }),
  wrap(async (req, res) => {
    const body = req.body || {};
    if (typeof body.version !== "string" || !body.version || typeof body.map !== "string" || !body.map)
      return res.status(400).json({ error: "version and map are required" });
    const g = sanitizeGhost(body);
    if (!g) return res.status(400).json({ error: "invalid ghost" });
    try {
      const stored = await race.upsertPlayerGhost({
        version: body.version.slice(0, MAX_VERSION_LEN),
        map: body.map.slice(0, MAX_MAP_LEN).toLowerCase(),
        name: g.name,
        login: g.login,
        time: g.time,
        hz: g.hz,
        frames: g.frames,
        cps: g.cps,
        serverId: req.ingest.serverId,
      });
      recordEvent(
        req.ingest.serverId,
        `ghost ${body.map} from ${req.ingest.serverName}: ${g.frames.length} frames${stored ? "" : " (kept faster)"}`
      );
      res.json({ ok: true, stored });
    } catch (e) {
      console.error("ghost ingest failed:", e);
      res.status(500).json({ error: "ingest failed" });
    }
  })
);

// Game-server console log shipping: the game host tees its stdout through a
// batcher (server/entrypoint.sh) and POSTs newline-delimited lines here. Same
// per-server bearer auth + rate limiter as /ingest, so a line is attributed to
// the authenticated server and shows up in /admin/logs. Body is text/plain
// (not JSON) so the shell shipper can just pipe raw lines with curl --data-binary.
api.post(
  "/ingest/log",
  wrap(async (req, res, next) => {
    const ident = await authenticateIngest(req);
    if (!ident) return res.status(401).json({ error: "unauthorized" });
    if (ident.revoked) return res.status(403).json({ error: "server revoked" });
    req.ingest = ident;
    next();
  }),
  ingestLimiter,
  express.text({ type: () => true, limit: "256kb" }),
  wrap(async (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0).slice(0, LOG_MAX_LINES_PER_POST);
    if (!lines.length) return res.json({ ok: true, stored: 0 });
    const entries = lines.map((l) => ({
      serverId: req.ingest.serverId,
      source: "console",
      level: logLevelOf(l),
      line: l.slice(0, LOG_MAX_LINE_LEN),
    }));
    const stored = await race.appendServerLog(entries);
    maybePruneLogs();
    res.json({ ok: true, stored });
  })
);

// In-game "/flag" command target: a game server flags the CURRENT map on behalf
// of a player. Server-token authed (same as /ingest) and keyed by map NAME (the
// game doesn't know the web's map id). Deduped per player, so a player's repeat
// /flag on a map is a no-op. The map must already exist in the DB.
api.post(
  "/game/flag",
  wrap(async (req, res, next) => {
    const ident = await authenticateIngest(req);
    if (!ident) return res.status(401).json({ error: "unauthorized" });
    if (ident.revoked) return res.status(403).json({ error: "server revoked" });
    req.ingest = ident;
    next();
  }),
  ingestLimiter,
  express.json({ limit: "8kb" }),
  wrap(async (req, res) => {
    const body = req.body || {};
    const mapName = typeof body.map === "string" ? body.map.slice(0, MAX_MAP_LEN).toLowerCase() : "";
    if (!mapName) return res.status(400).json({ error: "map required" });
    const reason = FLAG_REASONS.includes(body.reason) ? body.reason : "other";
    let note = typeof body.note === "string" ? body.note.trim().slice(0, FLAG_NOTE_MAX) : "";
    if (!note) note = null;
    const mapId = await race.mapIdByName(mapName);
    if (mapId == null) return res.status(404).json({ error: "unknown map" });
    // Dedupe per player: prefer the auth login, else the display name, else the
    // reporting server (so an anonymous /flag still can't be spammed endlessly).
    const who =
      (typeof body.login === "string" && body.login) ||
      (typeof body.player === "string" && body.player) ||
      `srv${req.ingest.serverId}`;
    const reporterHash = sha256("gameflag:" + who);
    // Store the reporter's display name (colour codes stripped) so moderators
    // can see who flagged it — the /flag command pulls it from the player's client.
    const reporterName =
      typeof body.player === "string" && body.player ? simplifyName(body.player).slice(0, MAX_NAME_LEN) || null : null;
    const r = await race.flagMap({ mapId, reason, note, reporterHash, reporterName });
    if (!r.ok) return res.status(404).json({ error: "unknown map" });
    recordEvent(req.ingest.serverId, `/flag ${mapName} from ${req.ingest.serverName} (${reason})${r.duplicate ? " [dup]" : ""}`);
    res.json({ ok: true, duplicate: !!r.duplicate });
  })
);

app.use("/api", api);

// JSON body-parse errors (and any other error surfaced by middleware) return
// JSON, not Express's default HTML page — keeps the API contract consistent.
app.use("/api", (err, _req, res, _next) => {
  if (!err) return res.status(500).json({ error: "internal error" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "payload too large" });
  // Body-parse / malformed-request faults are genuine client errors (400).
  // Anything else here is an unexpected server fault forwarded by wrap()'s
  // .catch(next) (e.g. a DB error) — report 500 and log it, so a real failure
  // isn't hidden from monitoring behind a 400.
  if (err.type === "entity.parse.failed" || err.status === 400 || err.statusCode === 400) {
    return res.status(400).json({ error: "bad request" });
  }
  console.error("api error:", err);
  res.status(500).json({ error: "internal error" });
});

// ============================ Admin area ====================================
// Map-flag review behind a login. Deliberately UNLINKED from the public site
// (no nav entry, and a noindex header) — you reach it by knowing the URL and
// having an account (created out-of-band with `node admin.js admin-add`).
//
// Every page is a pure server-rendered form: the production CSP
// (deploy/nginx/racesow.conf) permits inline <style> ('unsafe-inline' in
// style-src) but NOT inline <script>, so there is zero client JS in here — all
// state changes are <form> POSTs. Sessions are DB-backed (web/db.js
// admin_session): the browser holds only an opaque random cookie value; the DB
// stores its SHA-256, an absolute expiry, and a per-session CSRF token.
const ADMIN_COOKIE = "rs_admin";
const ADMIN_SESSION_TTL = 7 * 24 * 3600; // seconds (absolute, no sliding renew)
const REASON_LABELS = {
  broken: "Broken",
  offensive: "Offensive",
  wrong_name: "Wrong name / metadata",
  duplicate: "Duplicate",
  other: "Other",
};
// A constant-cost decoy hash: verified against when the username is unknown so
// a failed login costs the same scrypt work whether or not the account exists
// (defeats username enumeration by timing). Computed once at boot.
const DECOY_PW_HASH = hashPassword(crypto.randomBytes(24).toString("hex"));

function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieAttrs(req) {
  const a = ["HttpOnly", "SameSite=Strict", "Path=/admin"];
  // Secure whenever TLS is terminated at the edge (trust proxy honours
  // X-Forwarded-Proto); dropped for plain-HTTP local dev / tests so the cookie
  // still round-trips. ADMIN_COOKIE_INSECURE=1 forces it off explicitly.
  if (req.secure && process.env.ADMIN_COOKIE_INSECURE !== "1") a.push("Secure");
  return a;
}
function setSessionCookie(req, res, value, maxAge) {
  res.append("Set-Cookie", [`${ADMIN_COOKIE}=${value}`, ...cookieAttrs(req), `Max-Age=${maxAge}`].join("; "));
}
function clearSessionCookie(req, res) {
  res.append("Set-Cookie", [`${ADMIN_COOKIE}=`, ...cookieAttrs(req), "Max-Age=0"].join("; "));
}

async function currentSession(req) {
  const raw = parseCookies(req)[ADMIN_COOKIE];
  if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
  const sess = await race.getSession(sha256(raw));
  return sess ? { ...sess, raw } : null;
}

// Gate: attach req.session or bounce. GET -> redirect to the login page;
// state-changing verbs -> 401 (the form will 302 the user to login on reload).
async function requireAdmin(req, res, next) {
  try {
    const sess = await currentSession(req);
    if (!sess) {
      if (req.method === "GET") return res.redirect(302, "/admin/login");
      return res.status(401).type("text/plain").send("Not signed in.");
    }
    req.session = sess;
    next();
  } catch (e) {
    next(e);
  }
}

// True when a request is an explicit cross-site submission. Sec-Fetch-Site is
// browser-set and not forgeable by page script; the Origin host check is the
// fallback for browsers that don't send it. Absent headers (same-origin form
// posts, server-to-server) pass. Used for CSRF defence AND for login (where
// there is no session yet, so a cross-site auto-submit could otherwise fixate a
// victim into the attacker's account — "login CSRF").
function isCrossSite(req) {
  if (req.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.get("origin");
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host && host !== req.get("host") && !(PUBLIC_HOST && host === PUBLIC_HOST)) return true;
  }
  return false;
}

// CSRF for session-bearing form POSTs: the per-session token (defeats a blind
// cross-site submit) plus the cross-site guard (defence in depth over
// SameSite=Strict and the CSP's form-action 'self'). Returns true to proceed.
function checkCsrf(req, res) {
  const token = req.body && req.body._csrf;
  if (!token || typeof token !== "string" || token !== req.session.csrf) {
    res.status(403).type("text/plain").send("Bad CSRF token — reload and retry.");
    return false;
  }
  if (isCrossSite(req)) {
    res.status(403).type("text/plain").send("Cross-origin request refused.");
    return false;
  }
  return true;
}

const ADMIN_STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#12100e;color:#eee;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
a{color:#ff8a3c;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:940px;margin:0 auto;padding:0 20px}
header{background:#1b1815;border-bottom:1px solid #2c2823;padding:14px 0;margin-bottom:26px}
header .wrap{display:flex;align-items:center;justify-content:space-between}
header b{color:#ff6a1a}
.who{font-size:13px;color:#b7ada2}
.who form{display:inline}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:16px;margin:26px 0 10px;color:#e9c9a8}
.sub{color:#b7ada2;margin:0 0 18px}
.card{background:#1b1815;border:1px solid #2c2823;border-radius:10px;padding:16px 18px;margin:0 0 14px}
.flag-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}
.mapname{font-weight:700;font-size:16px}
.tags{margin:8px 0}
.tag{display:inline-block;background:#2a2620;border:1px solid #3a352d;border-radius:20px;padding:2px 10px;margin:2px 6px 2px 0;font-size:12px}
.tag b{color:#ffb87a}
.note{color:#cdbfae;font-style:italic;margin:6px 0 0;white-space:pre-wrap;word-break:break-word}
.meta{color:#8f857a;font-size:12px;margin-top:6px}
.actions{margin-top:12px;display:flex;gap:8px;flex-wrap:wrap}
form.inline{display:inline}
button,.btn{font:inherit;cursor:pointer;border-radius:7px;border:1px solid #3a352d;background:#2a2620;color:#eee;padding:7px 13px}
button.primary{background:#ff6a1a;border-color:#ff6a1a;color:#1a1206;font-weight:600}
button.ok{border-color:#3a6b3a;color:#bfe6bf}
button.warn{border-color:#6b5a2a;color:#e6d6a0}
button.danger{border-color:#6b2f22;color:#ffb4a0}
button:hover{filter:brightness(1.12)}
label{display:block;margin:12px 0 4px;font-size:13px;color:#cdbfae}
input,select,textarea{width:100%;font:inherit;background:#12100e;color:#eee;border:1px solid #3a352d;border-radius:7px;padding:9px 11px}
.login{max-width:360px;margin:8vh auto 0}
.msg{border-radius:8px;padding:10px 13px;margin:0 0 14px}
.msg.err{background:#3a1c17;border:1px solid #6b2f22;color:#ffb4a0}
.msg.ok{background:#1c3320;border:1px solid #2f6b3a;color:#b4e6bf}
.empty{color:#8f857a;padding:30px 0;text-align:center}
.crumbs{margin:0 0 14px;font-size:13px;color:#8f857a}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #2c2823}
th{color:#b7ada2;font-weight:600}
.st-open{color:#ffb87a}.st-resolved{color:#9fd6a0}.st-dismissed{color:#9a9088}
.rcon-out{background:#0c0b09;border:1px solid #2c2823;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cdead0;max-height:60vh;overflow:auto}
.logfilter{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.logfilter label{margin:0}
.logfilter>div{flex:0 0 auto}
.logfilter select,.logfilter input{width:auto;min-width:90px}
.logs{background:#0c0b09;border:1px solid #2c2823;border-radius:8px;padding:8px 10px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:70vh;overflow:auto}
.logline{white-space:pre-wrap;word-break:break-word;padding:1px 0;border-bottom:1px solid #191612}
.logline .lt{color:#7d746a}
.logline .lg{color:#e9c9a8}
.logline.err{color:#ffb4a0}.logline.warn{color:#e6d6a0}
.src-console .ls{color:#8fb0d6}.src-event .ls{color:#9a9088}.src-rcon .ls{color:#ff8a3c}.src-maintenance .ls{color:#e6b0ff}.src-system .ls{color:#9a9088}
`;

function adminShell(title, bodyHtml, session, headExtra = "") {
  const logout = session
    ? `<span class="who">${escHtml(session.username)} ·
         <form class="inline" method="post" action="/admin/logout">
           <input type="hidden" name="_csrf" value="${escHtml(session.csrf)}">
           <button type="submit" style="padding:2px 8px;font-size:12px">sign out</button>
         </form></span>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${headExtra}<title>${escHtml(title)} · Racesow Admin</title>
<style>${ADMIN_STYLE}</style></head>
<body><header><div class="wrap"><span><b>RACESOW</b> ADMIN</span>${logout}</div></header>
<main class="wrap">${bodyHtml}</main></body></html>`;
}
function sendAdmin(res, title, body, session, headExtra = "") {
  res.type("html").send(adminShell(title, body, session, headExtra));
}

function fmtWhen(ts) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z" : "—";
}

const admin = express.Router();
// Security headers FIRST — before the body parser — so they also cover a
// parser-error response (e.g. a 413 from an over-limit form body): the admin
// area must never be indexed, cached, or referrer-leaked on ANY path.
admin.use((_req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
admin.use(express.urlencoded({ extended: false, limit: "16kb" }));

// --- Auth ---
admin.get("/login", wrap(async (req, res) => {
  if (await currentSession(req)) return res.redirect(302, "/admin/flags");
  const err = req.query.error ? `<div class="msg err">Invalid username or password.</div>` : "";
  sendAdmin(res, "Sign in", `
    <form class="login card" method="post" action="/admin/login" autocomplete="off">
      <h1>Racesow Admin</h1>
      <p class="sub">Moderator sign-in.</p>
      ${err}
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" autofocus maxlength="64" required>
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" maxlength="200" required>
      <div class="actions"><button class="primary" type="submit">Sign in</button></div>
    </form>`);
}));

admin.post("/login", loginLimiter, wrap(async (req, res) => {
  // Login CSRF guard: no session exists yet (nothing to token-check), but a
  // cross-site auto-submitted login would fixate the victim into the attacker's
  // account. Refuse an explicitly cross-site POST.
  if (isCrossSite(req)) return res.status(403).type("text/plain").send("Cross-origin request refused.");
  const username = String((req.body && req.body.username) || "").trim().slice(0, 64);
  const password = String((req.body && req.body.password) || "");
  const acct = username ? await race.getAdminByUsername(username) : null;
  // Always run scrypt (decoy when the account is missing) for uniform timing.
  const ok = verifyPassword(password, acct ? acct.password_hash : DECOY_PW_HASH);
  if (!acct || !ok) return res.redirect(303, "/admin/login?error=1");

  const rawToken = crypto.randomBytes(32).toString("hex");
  const csrf = crypto.randomBytes(24).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  await race.createSession({
    tokenHash: sha256(rawToken),
    adminId: acct.id,
    csrf,
    expiresAt: now + ADMIN_SESSION_TTL,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    now,
  });
  await race.touchAdminLogin(acct.id, now);
  race.deleteExpiredSessions(now).catch(() => {}); // opportunistic sweep
  setSessionCookie(req, res, rawToken, ADMIN_SESSION_TTL);
  res.redirect(303, "/admin/flags");
}));

admin.post("/logout", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  await race.deleteSession(sha256(req.session.raw));
  clearSessionCookie(req, res);
  res.redirect(303, "/admin/login");
}));

// --- Flag review ---
admin.get("/", requireAdmin, (req, res) => res.redirect(302, "/admin/flags"));

admin.get("/flags", requireAdmin, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const groups = await race.openFlagSummary();
  const csrf = escHtml(req.session.csrf);
  const body = groups.length
    ? groups.map((g) => {
        const tags = Object.entries(g.reasons)
          .map(([r, c]) => `<span class="tag"><b>${escHtml(REASON_LABELS[r] || r)}</b> ×${c}</span>`)
          .join("");
        return `<div class="card">
          <div class="flag-head">
            <span class="mapname">${escHtml(g.name)}</span>
            <span class="meta">${g.openCount} open · last ${fmtWhen(g.lastAt)}${g.latestReporter ? ` · latest by ${escHtml(g.latestReporter)}` : ""}</span>
          </div>
          <div class="tags">${tags}</div>
          ${g.latestNote ? `<p class="note">“${escHtml(g.latestNote)}”</p>` : ""}
          <div class="actions">
            <a class="btn" href="/admin/flags/map/${g.mapId}">Review ${g.openCount} flag${g.openCount === 1 ? "" : "s"}</a>
            <a class="btn" href="/map/${g.mapId}" target="_blank" rel="noopener">Open map ↗</a>
            <form class="inline" method="post" action="/admin/flags/map/${g.mapId}/resolve-all">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="ok" type="submit">Resolve all</button>
            </form>
            <form class="inline" method="post" action="/admin/flags/map/${g.mapId}/dismiss-all">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="warn" type="submit">Dismiss all</button>
            </form>
            <form class="inline" method="post" action="/admin/flags/map/${g.mapId}/block">
              <input type="hidden" name="_csrf" value="${csrf}">
              <button class="danger" type="submit" title="Remove from the vote pool + map cycle">Block map</button>
            </form>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">No open flags. All clear. 🎉</div>`;
  sendAdmin(res, "Flag queue", `
    <h1>Open map flags</h1>
    <p class="sub">${groups.length} map${groups.length === 1 ? "" : "s"} with open reports ·
      <a href="/admin/flags/all">history</a> · <a href="/admin/servers">servers</a> · <a href="/admin/logs">logs</a> · <a href="/admin/blocked">blocked maps</a> · <a href="/admin/account">account</a></p>
    ${done}${body}`, req.session);
}));

admin.get("/flags/all", requireAdmin, wrap(async (req, res) => {
  const rows = await race.listFlags({ status: "all", limit: 500 });
  const body = rows.length
    ? `<table><thead><tr><th>Map</th><th>Reason</th><th>Status</th><th>Note</th><th>By</th><th>Reported</th><th>Closed by</th></tr></thead>
       <tbody>${rows.map((f) => `<tr>
         <td><a href="/admin/flags/map/${f.map_id}">${escHtml(f.name)}</a></td>
         <td>${escHtml(REASON_LABELS[f.reason] || f.reason)}</td>
         <td class="st-${escHtml(f.status)}">${escHtml(f.status)}</td>
         <td>${f.note ? escHtml(f.note) : ""}</td>
         <td>${f.reporter_name ? escHtml(f.reporter_name) : ""}</td>
         <td class="meta">${fmtWhen(f.created_at)}</td>
         <td class="meta">${f.resolved_by ? escHtml(f.resolved_by) : ""}</td>
       </tr>`).join("")}</tbody></table>`
    : `<div class="empty">No flags on record.</div>`;
  sendAdmin(res, "Flag history", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Flag history</h1><p class="sub">Most recent ${rows.length} report(s).</p>${body}`, req.session);
}));

admin.get("/flags/map/:id", requireAdmin, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const map = await race.mapDetail(id, { limit: 1 });
  if (!map) return res.status(404).type("text/plain").send("map not found");
  const flags = await race.flagsForMap(id);
  const blocked = await race.isMapBlocked(id);
  const csrf = escHtml(req.session.csrf);
  const blockBox = blocked
    ? `<div class="msg err">⛔ This map is <b>blocked</b> — removed from the vote pool + map cycle.
         <form class="inline" method="post" action="/admin/maps/${id}/unblock" style="margin-left:8px">
           <input type="hidden" name="_csrf" value="${csrf}"><button class="ok" type="submit">Unblock</button></form></div>`
    : `<form class="inline" method="post" action="/admin/flags/map/${id}/block">
         <input type="hidden" name="_csrf" value="${csrf}">
         <button class="danger" type="submit" title="Remove from the vote pool + map cycle">Block this map</button></form>`;
  const rows = flags.length
    ? flags.map((f) => `<div class="card">
        <div class="flag-head">
          <span class="mapname">${escHtml(REASON_LABELS[f.reason] || f.reason)}</span>
          <span class="st-${escHtml(f.status)}">${escHtml(f.status)}</span>
        </div>
        ${f.note ? `<p class="note">“${escHtml(f.note)}”</p>` : `<p class="meta">no note</p>`}
        <div class="meta">reported ${fmtWhen(f.created_at)}${f.reporter_name ? ` by ${escHtml(f.reporter_name)}` : ""}${f.resolved_by ? ` · closed by ${escHtml(f.resolved_by)} ${fmtWhen(f.resolved_at)}` : ""}</div>
        ${f.status === "open" ? `<div class="actions">
          <form class="inline" method="post" action="/admin/flags/${f.id}/resolve">
            <input type="hidden" name="_csrf" value="${csrf}"><button class="ok" type="submit">Resolve</button></form>
          <form class="inline" method="post" action="/admin/flags/${f.id}/dismiss">
            <input type="hidden" name="_csrf" value="${csrf}"><button class="warn" type="submit">Dismiss</button></form>
        </div>` : ""}
      </div>`).join("")
    : `<div class="empty">No flags for this map.</div>`;
  sendAdmin(res, `Flags · ${map.name}`, `
    <div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <div class="flag-head"><h1>${escHtml(map.name)}</h1>
      <a class="btn" href="/map/${id}" target="_blank" rel="noopener">Open map ↗</a></div>
    <p class="sub">${flags.filter((f) => f.status === "open").length} open · ${flags.length} total</p>
    <div class="actions" style="margin:0 0 16px">${blockBox}</div>
    ${rows}`, req.session);
}));

// Resolve/dismiss one flag, then all-flags for a map. Each guards CSRF and
// bounces back to the map's flag page (or the queue for the bulk actions).
async function closeOneFlag(req, res, status) {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad flag id");
  const flag = await race.flagById(id);
  await race.setFlagStatus(id, status, req.session.username);
  res.redirect(303, flag ? `/admin/flags/map/${flag.map_id}` : "/admin/flags");
}
admin.post("/flags/:id/resolve", requireAdmin, wrap((req, res) => closeOneFlag(req, res, "resolved")));
admin.post("/flags/:id/dismiss", requireAdmin, wrap((req, res) => closeOneFlag(req, res, "dismissed")));

async function closeMapFlags(req, res, status) {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const n = await race.resolveMapFlags(id, status, req.session.username);
  res.redirect(303, `/admin/flags?done=${encodeURIComponent(`${status === "resolved" ? "Resolved" : "Dismissed"} ${n} flag(s).`)}`);
}
admin.post("/flags/map/:id/resolve-all", requireAdmin, wrap((req, res) => closeMapFlags(req, res, "resolved")));
admin.post("/flags/map/:id/dismiss-all", requireAdmin, wrap((req, res) => closeMapFlags(req, res, "dismissed")));

// Block a map (remove from the vote pool + cycle) — also resolves its open
// flags. Unblock reverses it. Both CSRF-guarded.
admin.post("/flags/map/:id/block", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const r = await race.blockMap(id, "blocked via admin flag review", req.session.username);
  if (!r.ok) return res.status(404).type("text/plain").send("map not found");
  res.redirect(303, `/admin/flags?done=${encodeURIComponent("Blocked the map and closed its open flags. It will drop from rotation on the game servers' next restart.")}`);
}));
admin.post("/maps/:id/unblock", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  await race.unblockMap(id);
  res.redirect(303, `/admin/blocked?done=${encodeURIComponent("Unblocked. It returns to rotation on the game servers' next restart.")}`);
}));

admin.get("/blocked", requireAdmin, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const rows = await race.blockedMaps();
  const csrf = escHtml(req.session.csrf);
  const body = rows.length
    ? rows.map((m) => `<div class="card">
        <div class="flag-head">
          <span class="mapname">${escHtml(m.name)}</span>
          <span class="meta">blocked ${fmtWhen(Number(m.blocked_at))}${m.blocked_by ? ` by ${escHtml(m.blocked_by)}` : ""}</span>
        </div>
        ${m.reason ? `<p class="note">${escHtml(m.reason)}</p>` : ""}
        <div class="actions">
          <a class="btn" href="/admin/flags/map/${m.map_id}">Flags</a>
          <a class="btn" href="/map/${m.map_id}" target="_blank" rel="noopener">Open map ↗</a>
          <form class="inline" method="post" action="/admin/maps/${m.map_id}/unblock">
            <input type="hidden" name="_csrf" value="${csrf}"><button class="ok" type="submit">Unblock</button></form>
        </div>
      </div>`).join("")
    : `<div class="empty">No blocked maps.</div>`;
  sendAdmin(res, "Blocked maps", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Blocked maps</h1>
    <p class="sub">${rows.length} map${rows.length === 1 ? "" : "s"} removed from the vote pool + cycle ·
      served to game servers at <span style="font-family:monospace">/api/game/blocked-maps</span></p>
    ${done}${body}`, req.session);
}));

// --- Account (self-service password change) ---
admin.get("/account", requireAdmin, (req, res) => {
  const msg = req.query.ok
    ? `<div class="msg ok">Password changed. Other sessions were signed out.</div>`
    : req.query.error === "mismatch"
    ? `<div class="msg err">New passwords did not match, or the new one was too short (min 10).</div>`
    : req.query.error
    ? `<div class="msg err">Current password was incorrect.</div>`
    : "";
  sendAdmin(res, "Account", `
    <div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Account · ${escHtml(req.session.username)}</h1>
    ${msg}
    <form class="card" method="post" action="/admin/account/password" autocomplete="off" style="max-width:420px">
      <input type="hidden" name="_csrf" value="${escHtml(req.session.csrf)}">
      <label for="cur">Current password</label>
      <input id="cur" name="current" type="password" autocomplete="current-password" required>
      <label for="n1">New password (min 10 chars)</label>
      <input id="n1" name="next" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>
      <label for="n2">Confirm new password</label>
      <input id="n2" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="200" required>
      <div class="actions"><button class="primary" type="submit">Change password</button></div>
    </form>`, req.session);
});

admin.post("/account/password", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const current = String((req.body && req.body.current) || "");
  const next = String((req.body && req.body.next) || "");
  const confirm = String((req.body && req.body.confirm) || "");
  const acct = await race.getAdminByUsername(req.session.username);
  if (!acct || !verifyPassword(current, acct.password_hash)) return res.redirect(303, "/admin/account?error=1");
  if (next.length < 10 || next !== confirm) return res.redirect(303, "/admin/account?error=mismatch");
  await race.setAdminPassword(req.session.username, hashPassword(next));
  // Invalidate every OTHER session for this admin, then re-issue this one so the
  // current browser stays signed in (a password change should boot stale/leaked
  // cookies but not the person doing the change).
  const now = Math.floor(Date.now() / 1000);
  const keep = sha256(req.session.raw);
  await race.pool.query("DELETE FROM admin_session WHERE admin_id = $1 AND token_hash <> $2", [acct.id, keep]);
  res.redirect(303, "/admin/account?ok=1");
}));

// --- Servers, RCON, maintenance & logs (operator console) ------------------
// One page ties together: the live/enrolled server list, a persistent
// maintenance toggle (re-broadcasts on a timer), a one-off broadcast, per-server
// RCON, and the /admin/logs tail. All POSTs are CSRF-guarded; RCON secrets are
// set out-of-band (node admin.js rcon <id> <pw>) and never rendered.
function fmtSec(ts) {
  return ts ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";
}

// Commands that can drop players, wipe config, or lock you out — allowed only
// when the operator explicitly ticks the confirm box in the console.
const DANGEROUS_RCON = /^\s*(quit|killserver|rcon_password|set\s+rcon_password|sv_cheats|exec|unbindall|writeconfig|reconnect)\b/i;
// The engine's command buffer runs ';'-separated commands in one line, so a
// bare first-token check would let `status; quit` slip past the confirm guard.
// Classify EVERY segment. sanitizeCommand already strips newlines, but split on
// them too for defence in depth.
function isDangerousRcon(command) {
  return String(command)
    .split(/[;\n]/)
    .some((seg) => DANGEROUS_RCON.test(seg));
}

admin.get("/servers", requireAdmin, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const servers = await race.serversAdmin();
  const snap = live.getLive();
  const csrf = escHtml(req.session.csrf);
  const everyMin = Math.round(MAINT_REBROADCAST_SECS / 60);
  const maintBox = maintenance.active
    ? `<div class="msg err">🛠 <b>Maintenance mode ACTIVE</b>${maintenance.since ? ` since ${fmtWhen(maintenance.since)}` : ""}${maintenance.by ? ` (by ${escHtml(maintenance.by)})` : ""} —
         re-notifying servers every ${everyMin} min.
         <p class="note" style="margin:6px 0 8px">“${escHtml(maintenance.message || "")}”</p>
         <form class="inline" method="post" action="/admin/maintenance">
           <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="off">
           <button class="ok" type="submit">Turn OFF + send all-clear</button></form></div>`
    : `<form class="card" method="post" action="/admin/maintenance">
         <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="on">
         <label for="mmsg">Maintenance notice — broadcast to all servers now, then re-sent every ${everyMin} min while active</label>
         <input id="mmsg" name="message" maxlength="300" value="${escHtml(DEFAULT_MAINT_MSG)}">
         <div class="actions"><button class="warn" type="submit">Enable maintenance mode</button></div></form>`;
  const bcast = `<form class="card" method="post" action="/admin/broadcast">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label for="bmsg">One-off message to all servers (in-game chat via RCON <span style="font-family:monospace">say</span>)</label>
      <input id="bmsg" name="message" maxlength="300" placeholder="e.g. New maps added — have fun!" required>
      <div class="actions"><button class="primary" type="submit">Broadcast</button></div></form>`;
  const rows = servers.length
    ? servers.map((s) => {
        const li = (snap.servers || []).find((x) => x.id === s.id) || null;
        const state = li && li.online
          ? `<span class="st-resolved">online</span>${li.map ? ` · ${escHtml(li.map)}` : ""}${li.players ? ` · ${li.players.length}p` : ""}`
          : `<span class="st-dismissed">offline</span>`;
        return `<tr>
          <td>${escHtml(s.name)}${s.status !== "trusted" ? ` <span class="st-dismissed">(${escHtml(s.status)})</span>` : ""}</td>
          <td class="meta">${s.address ? escHtml(s.address) : "—"}</td>
          <td>${s.rcon ? '<span class="st-resolved">yes</span>' : '<span class="st-dismissed">no</span>'}</td>
          <td>${state}</td>
          <td class="meta">${fmtWhen(s.last_seen_at)}</td>
          <td>${s.rcon ? `<a class="btn" href="/admin/servers/${s.id}/rcon">Console</a> ` : ""}<a class="btn" href="/admin/logs?server=${s.id}">Logs</a></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty">No servers enrolled.</td></tr>`;
  sendAdmin(res, "Servers", `
    <h1>Servers &amp; operations</h1>
    <p class="sub"><a href="/admin/flags">← flag queue</a> · <a href="/admin/logs">logs</a> ·
      RCON is enabled per server with <span style="font-family:monospace">node admin.js rcon &lt;id&gt; &lt;password&gt;</span></p>
    ${done}${err}
    <h2>Maintenance mode</h2>${maintBox}
    <h2>Broadcast</h2>${bcast}
    <h2>Enrolled servers</h2>
    <table><thead><tr><th>Name</th><th>Address</th><th>RCON</th><th>Live</th><th>Last seen</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`, req.session);
}));

admin.post("/maintenance", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const action = String((req.body && req.body.action) || "");
  const message = String((req.body && req.body.message) || "").trim();
  if (action !== "on" && action !== "off")
    return res.redirect(303, "/admin/servers?error=" + encodeURIComponent("Unknown maintenance action."));
  const b = await setMaintenance(action === "on", message || DEFAULT_MAINT_MSG, req.session.username);
  const verb = action === "on" ? "ON" : "OFF";
  const summary = b.targets
    ? `Maintenance mode ${verb} — notified ${b.ok}/${b.targets} server(s).`
    : `Maintenance mode ${verb}. No RCON-enabled servers to notify.`;
  res.redirect(303, "/admin/servers?done=" + encodeURIComponent(summary));
}));

admin.post("/broadcast", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const message = String((req.body && req.body.message) || "").trim();
  if (!message) return res.redirect(303, "/admin/servers?error=" + encodeURIComponent("Message was empty."));
  const b = await broadcastCommand(sayCommand(message), { source: "rcon", label: "broadcast" });
  recordEvent(null, `broadcast by ${req.session.username}: “${message.slice(0, 200)}” → ${b.ok}/${b.targets} server(s)`, "rcon");
  const summary = b.targets ? `Broadcast sent to ${b.ok}/${b.targets} server(s).` : "No RCON-enabled servers to broadcast to.";
  res.redirect(303, "/admin/servers?done=" + encodeURIComponent(summary));
}));

// The RCON console page: form + last result + this server's recent RCON audit.
async function renderRconConsole(res, req, s, result, command) {
  const csrf = escHtml(req.session.csrf);
  const ready = !!(s.rcon_password && s.address);
  const warn = !s.rcon_password
    ? `<div class="msg err">No RCON password set. Enable it: <span style="font-family:monospace">node admin.js rcon ${s.id} &lt;password&gt;</span></div>`
    : "";
  const noAddr = !s.address
    ? `<div class="msg err">No query address set: <span style="font-family:monospace">node admin.js address ${s.id} &lt;host:port&gt;</span></div>`
    : "";
  const out = result
    ? `<h2>Result</h2>
       <p class="meta">${result.ok ? '<span class="st-resolved">sent</span>' : `<span class="st-dismissed">${escHtml(result.error || (result.authFailed ? "bad rcon password" : "no reply"))}</span>`}${result.replied ? "" : " · no reply datagram (many commands don't echo)"}</p>
       <pre class="rcon-out">${escHtml(result.reply && result.reply.length ? result.reply : "(no output returned)")}</pre>`
    : "";
  const recent = await race.recentServerLogs({ serverId: s.id, source: "rcon", limit: 20 });
  const history = recent.length
    ? `<h2>Recent RCON actions</h2><div class="logs">${recent
        .map((r) => `<div class="logline"><span class="lt">${fmtSec(r.createdAt)}</span> ${escHtml(r.line)}</div>`)
        .join("")}</div>`
    : "";
  sendAdmin(res, `RCON · ${s.name}`, `
    <div class="crumbs"><a href="/admin/servers">← servers</a></div>
    <h1>RCON console · ${escHtml(s.name)}</h1>
    <p class="sub">${s.address ? escHtml(s.address) : "no address"} · <a href="/admin/logs?server=${s.id}">logs</a></p>
    ${warn}${noAddr}
    <form class="card" method="post" action="/admin/servers/${s.id}/rcon" autocomplete="off">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label for="cmd">Command</label>
      <input id="cmd" name="command" maxlength="480" placeholder="status" value="${escHtml(command || "")}" ${ready ? "autofocus" : "disabled"}>
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="confirm" value="1" style="width:auto"> Allow potentially disruptive commands (quit, killserver, exec, …)</label>
      <div class="actions"><button class="primary" type="submit" ${ready ? "" : "disabled"}>Run</button></div>
    </form>
    ${out}${history}`, req.session);
}

admin.get("/servers/:id/rcon", requireAdmin, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad server id");
  const s = await race.serverById(id);
  if (!s) return res.status(404).type("text/plain").send("server not found");
  await renderRconConsole(res, req, s, null, "");
}));

admin.post("/servers/:id/rcon", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad server id");
  const s = await race.serverById(id);
  if (!s) return res.status(404).type("text/plain").send("server not found");
  const command = sanitizeCommand(String((req.body && req.body.command) || ""));
  const confirm = !!(req.body && req.body.confirm);
  if (!command || !s.rcon_password || !s.address) return renderRconConsole(res, req, s, null, command);
  if (isDangerousRcon(command) && !confirm) {
    recordEvent(s.id, `rcon by ${req.session.username} BLOCKED (needs confirm): ${command}`, "rcon", "warn");
    return renderRconConsole(res, req, s, { ok: false, error: "blocked — tick the confirm box to run a disruptive command", replied: false, reply: "" }, command);
  }
  const parsed = parseAddress(s.address);
  const result = parsed
    ? await sendRcon(parsed.host, parsed.port, s.rcon_password, command)
    : { ok: false, error: "bad address", replied: false, reply: "" };
  recordEvent(
    s.id,
    `rcon by ${req.session.username}: ${command} → ${result.ok ? "ok" : "FAIL (" + (result.error || (result.authFailed ? "auth" : "no reply")) + ")"}`,
    "rcon",
    result.ok ? null : "warn"
  );
  await renderRconConsole(res, req, s, result, command);
}));

admin.get("/logs", requireAdmin, wrap(async (req, res) => {
  const serverId = req.query.server && req.query.server !== "all" ? asInt(req.query.server) : null;
  const SOURCES = ["console", "event", "rcon", "maintenance", "system"];
  const source = SOURCES.includes(req.query.source) ? req.query.source : null;
  const n = Math.min(Math.max(asInt(req.query.n) || 200, 20), 1000);
  const refresh = req.query.refresh == null ? 5 : Math.max(0, Math.min(60, asInt(req.query.refresh) ?? 0));
  const [logs, servers] = await Promise.all([
    race.recentServerLogs({ serverId, source, limit: n }),
    race.serversAdmin(),
  ]);
  const opt = (val, label, sel) => `<option value="${escHtml(val)}"${String(sel) === String(val) ? " selected" : ""}>${escHtml(label)}</option>`;
  const serverOpts = [opt("all", "all servers", serverId == null ? "all" : serverId)]
    .concat(servers.map((s) => opt(String(s.id), s.name, serverId == null ? "all" : serverId)))
    .join("");
  const sourceOpts = [opt("all", "all sources", source || "all")]
    .concat(SOURCES.map((s) => opt(s, s, source || "all")))
    .join("");
  const refreshOpts = [0, 3, 5, 10, 30].map((v) => opt(String(v), v === 0 ? "off" : v + "s", refresh)).join("");
  const filter = `<form class="card logfilter" method="get" action="/admin/logs">
      <div><label>Server</label><select name="server">${serverOpts}</select></div>
      <div><label>Source</label><select name="source">${sourceOpts}</select></div>
      <div><label>Lines</label><input name="n" type="number" min="20" max="1000" value="${n}"></div>
      <div><label>Auto-refresh</label><select name="refresh">${refreshOpts}</select></div>
      <div><button class="primary" type="submit">Apply</button></div>
    </form>`;
  const body = logs.length
    ? `<div class="logs">${logs
        .map((l) => {
          const cls = `logline src-${escHtml(l.source)}${l.level === "error" ? " err" : l.level === "warn" ? " warn" : ""}`;
          return `<div class="${cls}"><span class="lt">${fmtSec(l.createdAt)}</span> <span class="ls">${escHtml(l.source)}</span> ${l.serverName ? `<span class="lg">${escHtml(l.serverName)}</span> ` : ""}${escHtml(l.line)}</div>`;
        })
        .join("")}</div>`
    : `<div class="empty">No log lines match.</div>`;
  // Auto-refresh via <meta http-equiv> keeps this page pure-HTML (no client JS,
  // which the admin CSP forbids). refresh=0 disables it.
  const headExtra = refresh > 0 ? `<meta http-equiv="refresh" content="${refresh}">\n` : "";
  sendAdmin(res, "Logs", `
    <div class="crumbs"><a href="/admin/servers">← servers</a></div>
    <h1>Server logs</h1>
    <p class="sub">Newest first · ${logs.length} line(s)${refresh > 0 ? ` · auto-refresh ${refresh}s` : ""}. Console lines are shipped from each game server's stdout.</p>
    ${filter}${body}`, req.session, headExtra);
}));

// Unknown /admin/* paths 404 as plain text (never fall through to the public
// SPA shell that the app.get("*") fallback would otherwise serve).
admin.use((_req, res) => res.status(404).type("text/plain").send("not found"));

app.use("/admin", admin);
// Admin form/parse errors (bad CSRF body, oversized form) as plain text, not
// the SPA shell, so a broken POST doesn't render a 200 HTML page.
app.use("/admin", (err, _req, res, _next) => {
  if (err && err.type === "entity.too.large") return res.status(413).type("text/plain").send("too large");
  res.status(400).type("text/plain").send("bad request");
});

// --- Server-rendered Open Graph tags -----------------------------------------
// The SPA is hash-routed, but URL fragments are never sent to servers, so
// Discord/social crawlers can't unfurl #/player/N links. Path-form URLs
// (/player/N) get the SPA shell with player-specific OG tags injected; the
// frontend routes those paths client-side (and rewrites the address bar to
// this shareable form on player pages).
// Cache-bust the SPA's JS/CSS: fingerprint each asset by content hash and
// rewrite its URL in the shell to /assets/…?v=<hash>. When app.js or style.css
// changes, its hash (and URL) changes, so browsers and Cloudflare fetch the
// new file instead of a stale cached one — the fix for old-JS-after-deploy
// (which is what left "#" URLs and broken back/forward on already-open tabs).
function assetVersion(rel) {
  try {
    return crypto.createHash("sha1").update(readFileSync(path.join(__dirname, "public", rel))).digest("hex").slice(0, 10);
  } catch {
    return "";
  }
}
const INDEX_HTML = readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  // app.js carries its own hash AND replay.js's (as ?rv=): app.js dynamically
  // imports replay.js from a constant URL, so without this a browser holding an
  // old replay.js never refetches it on a replay-only change. app.js reads the
  // rv param off its own <script src> and appends it to the import.
  .replace(
    "/assets/js/app.js",
    `/assets/js/app.js?v=${assetVersion("assets/js/app.js")}&rv=${assetVersion("assets/js/replay.js")}`
  )
  .replace("/assets/css/style.css", `/assets/css/style.css?v=${assetVersion("assets/css/style.css")}`);

// Send the SPA shell HTML with no-cache so browsers ALWAYS revalidate it (and
// thus always see the current asset ?v= URLs). The fingerprinted assets
// themselves stay long-cacheable — their URL changes on content change.
function sendShell(res, html) {
  res.set("Cache-Control", "no-cache");
  res.type("html").send(html);
}

const escAttr = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function siteOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN; // pinned: never trust request headers
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function withOgTags(tags) {
  const block = tags
    .map(([prop, content]) => {
      const attr = prop.startsWith("twitter:") ? "name" : "property";
      return `<meta ${attr}="${escAttr(prop)}" content="${escAttr(content)}">`;
    })
    .join("\n  ");
  // The static shell carries default OG tags between the markers; swap them
  // for the page-specific set.
  return INDEX_HTML.replace(/<!-- og -->[\s\S]*?<!-- \/og -->/, `<!-- og -->\n  ${block}\n  <!-- /og -->`);
}

app.get("/player/:id", renderLimiter, wrap(async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const d = Number.isNaN(id) ? null : await race.playerDetail(id, { limit: 1 });
  if (!d) return next(); // unknown player -> plain SPA shell (default tags)
  const origin = siteOrigin(req);
  const name = simplifyName(d.name);
  const s = d.standing;
  const bits = [
    s.rank != null ? `Rank #${s.rank}` : null,
    `${(s.points || 0).toLocaleString("en-US")} points`,
    `${s.wr || 0} world record${s.wr === 1 ? "" : "s"}`,
    `${s.maps || 0} maps ranked`,
    d.finishes != null ? `${d.finishes.toLocaleString("en-US")} finishes` : null,
    d.attempts != null ? `${d.attempts.toLocaleString("en-US")} attempts` : null,
  ].filter(Boolean);
  const image = `${origin}/og/player/${d.id}.png`;
  sendShell(
    res,
    withOgTags([
      ["og:site_name", "Racesow"],
      ["og:type", "profile"],
      ["og:title", `${name} — Racesow player stats`],
      ["og:description", bits.join(" · ")],
      ["og:url", `${origin}/player/${d.id}`],
      ["og:image", image],
      ["og:image:width", "1200"],
      ["og:image:height", "630"],
      ["og:image:type", "image/png"],
      ["profile:username", name],
      ["twitter:card", "summary_large_image"],
      ["twitter:title", `${name} — Racesow player stats`],
      ["twitter:description", bits.join(" · ")],
      ["twitter:image", image],
    ])
  );
}));

// The stats card behind og:image — rendered per player, cached a few minutes.
app.get("/og/player/:id.png", renderLimiter, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = Number.isNaN(id) ? null : await race.playerDetail(id, { limit: 1 });
  if (!d) return res.status(404).end();
  try {
    const png = await playerCardCached(d.id, () => ({
      name: d.name,
      rank: d.standing.rank,
      points: d.standing.points,
      wr: d.standing.wr,
      maps: d.standing.maps,
      finishes: d.finishes,
      attempts: d.attempts,
      // Fixed, config-derived host so the id-keyed cache render is
      // deterministic and can't be poisoned via the request's Host header.
      host: PUBLIC_HOST,
    }));
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(png);
  } catch (e) {
    console.error("og card render failed:", e.message);
    res.status(500).end();
  }
}));

// Shape the live poller's cached snapshot into OG-card data.
function liveCardData() {
  const snap = live.getLive();
  const servers = (snap.servers || []).map((s) => ({
    name: s.name,
    online: !!s.online,
    hostname: s.hostname,
    map: s.map,
    maxclients: s.maxclients,
    players: (s.players || []).length,
  }));
  const online = servers.filter((s) => s.online);
  return {
    servers,
    totalPlayers: online.reduce((n, s) => n + s.players, 0),
    onlineCount: online.length,
    host: PUBLIC_HOST,
  };
}

// Shareable /live page: SPA shell with live-status OG tags (og:image is the
// generated server-status card). The frontend routes the /live path to the
// Live view client-side.
app.get("/live", renderLimiter, (req, res) => {
  const origin = siteOrigin(req);
  const d = liveCardData();
  const desc = d.servers.length
    ? `${d.totalPlayers} player${d.totalPlayers === 1 ? "" : "s"} in game · ${d.onlineCount} of ${d.servers.length} server${d.servers.length === 1 ? "" : "s"} online right now.`
    : "Who's racing right now across the Racesow servers.";
  const image = `${origin}/og/live.png`;
  sendShell(
    res,
    withOgTags([
      ["og:site_name", "Racesow"],
      ["og:type", "website"],
      ["og:title", "Racesow — Live Servers"],
      ["og:description", desc],
      ["og:url", `${origin}/live`],
      ["og:image", image],
      ["og:image:width", "1200"],
      ["og:image:height", "630"],
      ["og:image:type", "image/png"],
      ["twitter:card", "summary_large_image"],
      ["twitter:title", "Racesow — Live Servers"],
      ["twitter:description", desc],
      ["twitter:image", image],
    ])
  );
});

// The live server-status card behind og:image. Short cache: it reflects the
// current snapshot, which the poller refreshes on its own cadence.
app.get("/og/live.png", renderLimiter, wrap(async (req, res) => {
  try {
    const png = await liveCardCached(liveCardData);
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=60");
    res.send(png);
  } catch (e) {
    console.error("live og card render failed:", e.message);
    res.status(500).end();
  }
}));

// Look up one enrolled server + its live snapshot (shared by the /server page
// and its OG card). Returns null for an unknown id.
async function serverForOg(id) {
  const s = (await race.servers()).find((x) => x.id === id);
  if (!s) return null;
  const li = (live.getLive().servers || []).find((x) => x.id === id) || null;
  return { db: s, live: li };
}

// Shareable /server/:id page: SPA shell with server-specific OG tags.
app.get("/server/:id", renderLimiter, wrap(async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const info = Number.isNaN(id) ? null : await serverForOg(id);
  if (!info) return next(); // unknown -> plain SPA shell
  const origin = siteOrigin(req);
  const name = simplifyName(info.db.name);
  const li = info.live;
  const desc = li && li.online
    ? `${li.players.length}${li.maxclients ? " / " + li.maxclients : ""} playing${li.map ? " on " + li.map : ""} · ${info.db.records.toLocaleString("en-US")} records contributed`
    : `Offline · ${info.db.records.toLocaleString("en-US")} records contributed`;
  const image = `${origin}/og/server/${id}.png`;
  sendShell(
    res,
    withOgTags([
      ["og:site_name", "Racesow"],
      ["og:type", "website"],
      ["og:title", `${name} — Racesow`],
      ["og:description", desc],
      ["og:url", `${origin}/server/${id}`],
      ["og:image", image],
      ["og:image:width", "1200"],
      ["og:image:height", "630"],
      ["og:image:type", "image/png"],
      ["twitter:card", "summary_large_image"],
      ["twitter:title", `${name} — Racesow`],
      ["twitter:description", desc],
      ["twitter:image", image],
    ])
  );
}));

// The per-server status card behind og:image.
app.get("/og/server/:id.png", renderLimiter, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = Number.isNaN(id) ? null : await serverForOg(id);
  if (!info) return res.status(404).end();
  try {
    const png = await serverCardCached(id, () => {
      const li = info.live;
      return {
        name: (li && li.online && li.hostname) || info.db.name,
        online: !!(li && li.online),
        map: li && li.map,
        maxclients: li && li.maxclients,
        players: (li && li.players) || [],
        host: PUBLIC_HOST,
      };
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=60");
    res.send(png);
  } catch (e) {
    console.error("server og card render failed:", e.message);
    res.status(500).end();
  }
}));

// Default tags with an absolute og:image (crawlers ignore relative URLs).
function defaultShell(req) {
  const origin = siteOrigin(req);
  return withOgTags([
    ["og:site_name", "Racesow"],
    ["og:type", "website"],
    ["og:title", "Racesow · Warsow Race Records"],
    ["og:description", "Live world records, maps and player rankings from Warsow race servers."],
    ["og:url", origin + "/"],
    ["og:image", `${origin}/assets/img/warsow-logo.png`],
    ["twitter:card", "summary"],
  ]);
}

// Public database backup download (the db-backup sidecar refreshes it weekly).
// A fixed path with no user input, so there is no path-traversal surface; the
// callback turns a missing file into a clean 404 instead of an Express error.
app.get("/backup/racesow-db-latest.zip", backupLimiter, (_req, res) => {
  res.download(BACKUP_LATEST_ZIP, "racesow-db-latest.zip", { maxAge: "1h" }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "no backup available yet" });
  });
});

app.get("/", (req, res) => sendShell(res, defaultShell(req)));

// Static frontend. The 3D replay model/vendor assets are large and stable, so
// give them a long browser cache (repeat replay views load the pig instantly);
// everything else keeps express.static's default (fingerprinted JS/CSS carry a
// ?v= hash, so the shell always requests the current URL).
app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
    setHeaders: (res, filePath) => {
      // Large, stable 3D assets: rigged models, vendored three.js, and the
      // converted map meshes. Long browser cache so repeat/SPA replay views
      // load them instantly instead of re-fetching from the origin.
      if (/[\\/](assets[\\/](models|vendor)|maps)[\\/]/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      }
    },
  })
);

// SPA fallback for client-side routes (non-API, non-asset).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return next();
  sendShell(res, defaultShell(req));
});

const server = app.listen(PORT, async () => {
  console.log(`Race stats server listening on http://0.0.0.0:${PORT}`);
  const servers = await race.servers();
  const modes = [];
  if (INGEST_TOKEN_HASH) modes.push("shared-token");
  modes.push(`${servers.length} enrolled server(s)`);
  console.log(`Ingest: ${modes.join(" + ")}`);
  if (!shuttingDown) live.start(); // a signal may land during the await above
  const liveTargets = servers.filter((s) => s.address).length;
  console.log(`Live poller: ${liveTargets} server(s) with a query address`);
  // Maintenance mode: load persisted state and keep it (and the re-broadcast
  // timer) reconciled from the DB so both web replicas agree.
  await refreshMaintenance();
  if (!shuttingDown) {
    maintRefreshTimer = setInterval(() => {
      if (!shuttingDown) refreshMaintenance();
    }, MAINT_STATE_REFRESH_MS);
    maintRefreshTimer.unref();
  }
  if (maintenance.active) console.log("Maintenance mode is ACTIVE (re-broadcasting notices)");
});

// Graceful shutdown, swapped in over the boot-time handler installed at the
// top of this file. The handler itself is what prevents the 10s
// SIGTERM-then-SIGKILL deploy hang: an installed handler runs even when node
// is container PID 1 (init:true in compose only adds zombie reaping on top).
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining connections`);
  // Backstop just under docker's 10s stop grace, in case a connection or the
  // pool refuses to drain.
  setTimeout(() => process.exit(1), 8000).unref();
  live.stop();
  stopMaintTimer();
  clearInterval(maintRefreshTimer);
  clearTimeout(refreshTimer);
  await new Promise((resolve) => {
    server.close(resolve); // stop accepting; resolves once all sockets close
    // Sweep repeatedly: a socket serving a request at signal time only turns
    // idle when its response finishes, which a one-shot sweep would miss.
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 500).unref();
    // Cut lingering keep-alive/streaming sockets so close() can complete.
    setTimeout(() => server.closeAllConnections(), 4000).unref();
  });
  await race.close().catch(() => {});
  process.exit(0);
}
onSignal = shutdown;
