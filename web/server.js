// Race stats web server: hosts the race SQLite database behind a small REST API
// and serves the static frontend that consumes it.
import express from "express";
// The Sentry SDK is initialised out-of-band via `node --import ./instrument.mjs`
// (see web/Dockerfile CMD); this import only exposes the API. With SENTRY_DSN
// unset no client is created, so every Sentry.* call below is a silent no-op.
import * as Sentry from "@sentry/node";
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openDatabase, sha256, simplifyName, hashPassword, verifyPassword, FLAG_REASONS } from "./db.js";
import { createLivePoller, parseAddress } from "./live.js";
import { createStreamRegistry } from "./streams.js";
import { sendRcon, broadcastRcon, sanitizeCommand, sayCommand } from "./rcon.js";
import { playerCardCached, liveCardCached, serverCardCached } from "./og-image.js";
import { cache, invalidate } from "./cache.js";
import { RULE_KINDS, WINDOWS, TIERS, validateDefinition, describeRule } from "./achievements.js";
import {
  SCORINGS,
  STATUSES as TOURNAMENT_STATUSES,
  normalizeCode,
  formatCode,
  validateTournament,
  toAdminTime,
  phaseOf,
  PHASE_LABEL,
  joinOpen,
} from "./tournaments.js";

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

// Top-down map heatmaps, generated nightly by the heatmaps sidecar (see
// web/heatmap.js + docker-compose.yml) into HEATMAP_DIR under the shared ./data
// mount: <mapId>.png (transparent RGBA density image) + <mapId>.json (bounds,
// player/point counts, generatedAt). The image is served at
// /api/maps/:id/heatmap.png and its metadata is folded into /api/maps/:id; both
// degrade to "absent" until the sidecar has rendered a map.
const HEATMAP_DIR = process.env.HEATMAP_DIR || "/data/heatmaps";

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
if (INGEST_TOKEN_HASH) {
  // The shared token writes records with NO per-server identity (server_id
  // NULL), so a leak lets any holder forge records for any server and they can't
  // be attributed/rolled back per server. Per-server tokens (node admin.js
  // enroll) bound that blast radius — nudge operators toward them.
  console.warn(
    "NOTE: a shared INGEST_TOKEN is enabled (legacy). Prefer per-server tokens " +
      "(node admin.js enroll) and unset INGEST_TOKEN — records are then attributable per server."
  );
}

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
// Physically-impossible-fast floor: no real map is traversed in under this, so a
// sub-floor finish is a forged/absurd time — e.g. the classic time:1ms "seize the
// WR forever" from a leaked/compromised ingest token. This does NOT stop a
// PLAUSIBLE forgery by a trusted box (that is inherent to the trusted-server
// model), but it blocks the trivial case; every record additionally carries its
// submitting server_id for audit/rollback. Keep it well under any genuine WR.
const MIN_TIME_MS = 50;
const MAX_RECORDS_PER_REQUEST = 1000;
// Per-request ceiling on the TOTAL checkpoint rows across all records. The
// per-record (4096) and per-batch (1000) caps multiply to ~4M without this, so
// one authorized request could force millions of checkpoint inserts (DB bloat +
// pool pressure). 200k comfortably clears any real batch (a top-50 resync of
// full runs, or a live-finish flush) while rejecting the pathological product.
// Raise it if a legitimate server ever trips the 400 (see /ingest handler).
const MAX_TOTAL_CHECKPOINTS = 200000;
// Per-request ceiling on the SUM of attempt/metric counters. run_tally counters
// are monotonic (added, never reset), so a token holder could otherwise inflate
// a player's attempts/wall-jumps/etc. by billions per request. A real flush
// carries small per-player deltas; this rejects an implausibly large batch while
// clearing any genuine one by a wide margin. Cosmetic stats only (not rank).
const MAX_TALLY_PER_REQUEST = 5_000_000;
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

// Live video streams: maps enrolled servers -> their HLS playback URL (from the
// STREAM_URLS env), refined by optional encoder heartbeats. See streams.js.
const streams = createStreamRegistry();

const app = express();
app.disable("x-powered-by");
// One trusted proxy (the production nginx) so req.ip is the real client for
// rate limiting; harmless when hit directly (no X-Forwarded-For -> socket IP).
app.set("trust proxy", 1);

// Defense-in-depth security headers at the APP layer, so a response served
// directly by Node (nginx somehow bypassed, a future internal proxy that forgets
// them, or non-prod use) is never header-naked. In production the front nginx
// sets the authoritative copies (incl. the CSP + HSTS it alone can size against
// the deployed SPA/TLS) and strips these upstream duplicates via
// proxy_hide_header (see deploy/nginx/racesow.conf), so exactly one of each is on
// the wire. nosniff is idempotent even if a layer double-adds it. The admin
// router further tightens Referrer-Policy to no-referrer for its own responses.
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "SAMEORIGIN");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

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
// Deliberately generous, because a 429 here is not a delay — it is data loss. The
// reporting native treats any 4xx on a report as "the API rejected this body,
// retrying can never help" and DROPS it (g_rs_api.cpp, doPost branch), so a
// throttled finish is gone for good rather than retried like a 5xx. One finish
// can also cost several requests against this bucket (the record itself, then the
// ghost trajectory and the demo pointer, each its own authed mount), and bursts
// are structural: end-of-map flushes every connected player's counters at once.
// 10/s sustained per server leaves room for a full server doing all of that while
// still bounding a runaway or compromised feed.
const ingestLimiter = rateLimiter({
  windowMs: 60_000,
  max: 600,
  key: (req) => "ingest:" + (req.ingest ? req.ingest.serverId ?? req.ingest.serverName : req.ip),
});
// Public map-flag submissions: per IP, well under the read budget so a script
// can't spam the review queue (dedupe in the DB is the second line of defence).
const flagLimiter = rateLimiter({ windowMs: 60_000, max: 8, key: (req) => "flag:" + (req.ip || "?") });
// Tournament sign-up gets its OWN bucket, not the flag one: minting a join code
// and reporting a broken map are unrelated actions, and sharing a bucket meant
// a player who flagged eight maps could not then enter a tournament. This is
// only an anti-spam ceiling on row creation — what actually protects a code is
// its 30^8 keyspace, not this.
const joinLimiter = rateLimiter({ windowMs: 60_000, max: 10, key: (req) => "tjoin:" + (req.ip || "?") });
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

// /api/maps/:id leaderboard page size. The map page requests limit=10000
// ("everyone") and limit=1 (just map meta), so we can't hard-cap it low without
// truncating real leaderboards. Instead the raw limit is snapped to a small set
// of buckets that is ALSO the cache key (see the route): this collapses the
// attacker's key space — every distinct junk limit (1..N) and every unknown
// query param would otherwise mint a fresh cache/edge key and force an uncached
// leaderboard read each time. The returned value is the effective query limit,
// so the cached body always matches the key it was stored under.
const MAP_DETAIL_MAX_LIMIT = 10000;
const MAP_DETAIL_LIMIT_BUCKETS = [1, 50, 100, 1000];
function mapDetailLimit(raw) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return 50; // default page
  for (const b of MAP_DETAIL_LIMIT_BUCKETS) if (n <= b) return b;
  return MAP_DETAIL_MAX_LIMIT;
}

// Express 4 does not catch rejected async handlers; route through this so a
// DB error becomes a 500 via the error middleware instead of a hung request.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hot read endpoints are Redis-cached (short TTL). /overview is the heaviest
// aggregate and the most-hit page-load call, so it carries a wider window than
// the per-map/per-player reads — but not by much: the homepage also carries the
// two feeds people watch for their own run ("Recent PBs" and "Recent Finishes"),
// so it is cached as a live feed, not as a summary.
api.get("/overview", cache(45, { edge: true }), wrap(async (_req, res) => res.json(await race.overview())));
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
    live: li ? { ...li, map: race._cnMap(li.map, mapId), mapId } : { online: false, players: [] },
    stream: streams.for(id),
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
      name: race._cnMap(r.name, r.map_id), // display-only; real name unaffected in play
      reason: r.reason,
      blockedAt: Number(r.blocked_at),
      blockedBy: r.blocked_by,
    })),
  });
}));

// Metadata for a map's nightly top-down heatmap (web/heatmap.js): { url, width,
// height, players, points, generatedAt } or null when the sidecar hasn't
// rendered this map yet. Read from the sibling <mapId>.json the generator writes
// next to the PNG. Never throws — a missing/corrupt file just means "no heatmap".
function heatmapMeta(id) {
  try {
    const m = JSON.parse(readFileSync(path.join(HEATMAP_DIR, `${id}.json`), "utf8"));
    return {
      url: `/api/maps/${id}/heatmap.png?v=${m.generatedAt || 0}`,
      width: m.width,
      height: m.height,
      players: m.players,
      points: m.points,
      mapBase: m.mapBase || false,
      generatedAt: m.generatedAt || null,
    };
  } catch {
    return null;
  }
}

// The map leaderboard is the web-side scoreboard: it is where a player goes to
// see the run they just set, so it gets the shortest TTL of the public reads.
api.get("/maps/:id", cache(30, { edge: true, key: (req) => `${req.path}?limit=${mapDetailLimit(req.query.limit)}` }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = await race.mapDetail(id, { limit: mapDetailLimit(req.query.limit) });
  if (!detail) return res.status(404).json({ error: "map not found" });
  detail.heatmap = heatmapMeta(id);
  res.json(detail);
}));

// The heatmap PNG itself (transparent RGBA). A numeric :id so there is no path
// -traversal surface; the callback turns a not-yet-generated map into a clean
// 404. Cache-busted by the ?v=generatedAt the API hands the client, so a long
// browser cache is safe.
api.get("/maps/:id/heatmap.png", (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  res.sendFile(path.join(HEATMAP_DIR, `${id}.png`), { maxAge: "1h", headers: { "Content-Type": "image/png" } }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "no heatmap for this map yet" });
  });
});

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

// Demo directory: browse the maps that have downloadable demos, then drill into
// one map for its per-player demo files (each an individual download link).
api.get("/demos", cache(60, { edge: true }), wrap(async (req, res) => res.json(await race.demoMaps(req.query))));

// Everything in one feed: every map with its demos inline (who ran it, when it
// was captured, the direct download link), paged by map via ?limit/&offset and
// filterable by map name with ?q=. Registered BEFORE /demos/:mapId so "all" is
// routed here instead of failing the numeric map-id parse below.
api.get("/demos/all", cache(60, { edge: true }), wrap(async (req, res) => res.json(await race.allDemos(req.query))));

api.get("/demos/:mapId", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.mapId);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = await race.demosForMap(id);
  if (!detail) return res.status(404).json({ error: "map not found" });
  res.json(detail);
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

// Profiles list the player's own recent finishes — same "did my run land?"
// question as the map board, so the same short TTL.
api.get("/players/:id", cache(30, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const detail = await race.playerDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "player not found" });
  res.json(detail);
}));

// The maps behind a player's Skill Rating — the strongest contested maps in
// ranking order, flagged with which prefix the rating was actually taken from.
// Fetched lazily by the profile's SR dropdown, so it stays off the profile's
// critical path.
api.get("/players/:id/sr", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const bd = await race.srBreakdown(id);
  if (!bd) return res.status(404).json({ error: "player not found" });
  res.json(bd);
}));

// Public achievements directory: every active definition with rarity + recent
// earners. Hidden achievements come back masked (tier + earner count only).
api.get("/achievements", cache(300, { edge: true }), wrap(async (_req, res) => {
  res.json(await race.achievementsDirectory());
}));

// A player's earned awards + progress toward the visible unearned ones.
// Fetched lazily by the profile's achievements panel (like /players/:id/sr).
api.get("/players/:id/achievements", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const out = await race.playerAchievements(id);
  if (!out) return res.status(404).json({ error: "player not found" });
  res.json(out);
}));

// A player's tournament trophies, newest first. Lazy like /achievements, so a
// profile with no trophies pays nothing for the panel.
api.get("/players/:id/trophies", cache(60, { edge: true }), wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  res.json({ trophies: await race.playerTrophies(id) });
}));

// ===================== Tournaments (public) =================================
// The whole calendar in one shot. Deliberately NOT paginated: a free-form
// ?limit/?offset would mint a distinct cache key per value (cache.js defaultKey
// is path + sorted query) and hand anyone a cache-busting lever on the page —
// the same hazard /maps/:id solves with MAP_DETAIL_LIMIT_BUCKETS. The list is
// bounded by how many tournaments have ever been run, so the client just gets
// all of them and groups by phase.
//
// Short TTL: the phase (upcoming -> live -> ended) is derived from the clock,
// so a long cache would say "starts in 3 minutes" well after it started. The
// response carries `now` so the client derives phases from the SERVER's clock
// at generation time rather than trusting a possibly-stale body.
api.get("/tournaments", cache(30, { edge: true }), wrap(async (_req, res) => {
  const list = await race.tournaments({ limit: 200 });
  res.json({ ...list, now: Math.floor(Date.now() / 1000) });
}));

// One tournament: pool, standings, per-map boards and entrants.
//
// Goes through cache() like every other read (NOT a hand-set Cache-Control):
// tournamentDetail fans out to four queries, two of which window-scan `finish`
// across the whole pool — exactly the shape that must not run once per visitor
// when a link lands in a Discord announcement. cache() adds the Redis layer,
// in-process single-flight and stale-while-revalidate that a bare header does
// not. 15s flat, including for finalized tournaments: their body is immutable
// so a longer TTL would only save a frozen-table read, and one TTL keeps the
// cache key free of any dependence on the row we haven't fetched yet.
// The cache key is built from the NORMALISED slug, not the raw path: cache.js's
// default key is path + sorted query, while the handler lowercases the slug and
// ignores every query param — so /Summer-Cup, /summer-cup and /summer-cup?x=1
// would otherwise mint three Redis + edge entries for one byte-identical body,
// which is a free cache-busting lever on the most expensive read on the site.
// (Same defence /api/maps/:id uses with MAP_DETAIL_LIMIT_BUCKETS.)
const tournamentCacheKey = (req) => `/tournaments/${String(req.params.slug || "").toLowerCase().slice(0, 64)}`;
api.get("/tournaments/:slug", cache(15, { edge: true, key: tournamentCacheKey }), wrap(async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return res.status(400).json({ error: "invalid tournament" });
  const d = await race.tournamentDetail(slug);
  if (!d) return res.status(404).json({ error: "tournament not found" });
  res.json({ ...d, now: Math.floor(Date.now() / 1000) });
}));

// Take an entry: mint an unclaimed code the player redeems in-game with
// "/tournament <code>". Deliberately anonymous — the site has no player
// accounts, and the redeem is what binds the entry to a real identity, so
// handing out a code proves nothing and costs nothing. Rate-limited per IP the
// same way /flag is, so nobody can mint a million rows for fun.
api.post("/tournaments/:slug/join", joinLimiter, express.json({ limit: "8kb" }), wrap(async (req, res) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return res.status(400).json({ error: "invalid tournament" });
  const t = await race.tournamentBySlug(slug);
  if (!t) return res.status(404).json({ error: "tournament not found" });
  if (!joinOpen(t)) return res.status(409).json({ error: "this tournament is not taking entries" });
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, MAX_NAME_LEN) : "";
  const entry = await race.createEntryCode(t.id, name);
  if (!entry) return res.status(404).json({ error: "tournament not found" });
  // Nothing cached changes here: an unredeemed code is invisible to every
  // public read (entrant counts only see claimed rows), so there is no cache
  // to bust — the entry becomes visible when it is redeemed in-game.
  res.json({ code: entry.code, formatted: formatCode(entry.code), tournament: { slug: t.slug, name: t.name } });
}));

// Head-to-head comparison of two players (a vs b): overall standings plus the
// direct record on every shared map. Both ids may be any name variant; the DB
// resolves them to canonical.
api.get("/compare", cache(60, { edge: true }), wrap(async (req, res) => {
  const a = asInt(req.query.a);
  const b = asInt(req.query.b);
  if (a == null || b == null) return res.status(400).json({ error: "compare needs player ids a and b" });
  const cmp = await race.compare(a, b);
  if (!cmp) return res.status(404).json({ error: "player not found" });
  res.json(cmp);
}));

api.get("/search", cache(60), wrap(async (req, res) => res.json(await race.search(req.query.q || "", { limit: 8 }))));

// New records after a race id — the Discord announcer polls this (it has no
// database access; margin-to-#2 and version names are computed here). Public
// read: nothing the site's recent-records feed doesn't already show. Short TTL:
// the whole point of the consumer is to announce a record promptly, and the
// cursor (after_id) means a poll that finds nothing new is a cheap empty answer.
api.get("/records", cache(20), wrap(async (req, res) => {
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
    snap.servers.map(async (s) => {
      const mapId = s.map ? await race.mapIdByName(s.map) : null;
      // Censor the displayed current-map name (real name already used above for
      // the mapId link lookup).
      return { ...s, map: race._cnMap(s.map, mapId), mapId, stream: streams.for(s.id) };
    })
  );
  res.json({
    ...snap,
    servers,
    maintenance: maintenance.active
      ? { active: true, message: maintenance.message, since: maintenance.since }
      : { active: false },
  });
}));

// Active live video streams, joined with the live poller snapshot so the site
// can list "what can I watch right now". Public read (the HLS URLs are public).
api.get("/streams", cache(10), wrap(async (_req, res) => {
  const snap = live.getLive();
  const byId = new Map((snap.servers || []).map((s) => [s.id, s]));
  const list = [];
  for (const s of await race.servers()) {
    const stream = streams.for(s.id);
    if (!stream) continue;
    const li = byId.get(s.id) || null;
    list.push({
      id: s.id,
      name: s.name,
      hls: stream.hls,
      status: stream.status,
      pov: stream.pov,
      online: !!(li && li.online),
      players: li && li.players ? li.players.length : 0,
      map: li ? race._cnMapByName(li.map || null) : null,
    });
  }
  res.json({ updatedAt: snap.updatedAt, streams: list });
}));

// Encoder heartbeat: the tv-capture container POSTs its live status + current
// POV here every few seconds. Per-server bearer token (same as /ingest); the
// token's server must match the :id. The URL is never taken from the body — it
// stays trusted config — so a compromised token can't redirect viewers.
api.post(
  "/streams/:id/health",
  // Authenticate BEFORE parsing the body (mirror /ingest) so an unauthenticated
  // client can't make us JSON.parse first, and rate-limit per server.
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
    const id = asInt(req.params.id);
    if (id == null) return res.status(400).json({ error: "invalid server id" });
    // A heartbeat targets a specific stream id, so it must carry that server's
    // own per-server token. The legacy shared token has no server identity
    // (serverId null); allowing it would let one shared-token holder spoof the
    // status/POV shown for ANY configured stream, so it is refused here.
    if (req.ingest.serverId == null || req.ingest.serverId !== id) {
      return res.status(403).json({ error: "token/server mismatch" });
    }
    if (!streams.has(id)) return res.status(404).json({ error: "no stream configured for server" });
    const b = req.body || {};
    streams.recordHeartbeat(id, {
      status: b.status,
      players: Number(b.players),
      map: b.map,
      pov: b.pov,
    });
    res.json({ ok: true });
  })
);

// Live topscores for game servers: the hrace gametype's RS_ApiFetchTop
// native GETs this on map load and on a refresh interval, and swaps the
// response into the map's local topscores file — the payload is byte-format
// identical to that file, so the gametype's normal loader consumes it and
// every server connected to this API serves the same in-game `top` lists,
// HUD record lines and record announcements. Public read — it exposes
// nothing the map leaderboard pages don't already show.
//
// Evicted by /api/ingest the moment a record lands on the map, for the same
// reason ranks is (below) and one more: apitop.as fetches this out of band to
// VERIFY a pending "new server record" announcement, so a board left stale for
// the full TTL could confirm a record another node had already beaten — a false
// announce, not just a late one.
const topscoresCacheKey = (map) => `/api/game/topscores?map=${String(map || "").toLowerCase()}`;
api.get("/game/topscores", cache(120, { key: (req) => topscoresCacheKey(req.query.map) }), wrap(async (req, res) => {
  const body = await race.gameTopscoresText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body);
}));

// Shared cache-key builder for the ranks blob so the store path (the cache()
// middleware below) and the eviction path (the ingest handler) agree on the
// exact key regardless of Express req.path/mount quirks. Lowercased to match the
// map name the game fetches with. (cache()'s defaultKey would build a
// MOUNT-RELATIVE key here — req.path is "/game/ranks", without the "/api" — so
// an eviction written against the public URL would silently miss. Both game
// payloads therefore name their key explicitly rather than inheriting it.)
const ranksCacheKey = (map) => `/api/game/ranks?map=${String(map || "").toLowerCase()}`;

// True per-player global ranks for game servers (hrace/ranks.as polls this ~60s
// via the RS_ApiFetchRanks native). Unlike topscores (top-50), this lists EVERY
// finisher so the in-game scoreboard can show a real "Pos" for players ranked
// past 50. The leading "//" lets the fetch native reject non-payload bodies.
// Cached per map; the /api/ingest handler evicts this key the moment a new
// record lands on the map, so a fresh rank is one refresh interval away.
api.get("/game/ranks", cache(60, { key: (req) => ranksCacheKey(req.query.map) }), wrap(async (req, res) => {
  const body = await race.gameRanksText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body);
}));

// One player's personal best on a map (hrace/playerrecord.as polls this per
// player on join via the RS_ApiFetchPlayerRecord native). Carries the player's
// rank, finish time AND checkpoint splits so the scoreboard "Pos"/time works
// for players ranked past the local top-50 board and the live per-checkpoint
// comparison is ready from their first run — plus their global Skill Rating for
// the scoreboard's "SR" column. Cached per (map, name); the record only changes
// when THAT player finishes (updated live in-game anyway) and SR only moves on
// an aggregate refresh, so the short TTL without ingest eviction is fine — a
// stale seed is harmless. The name arrives already URL-decoded by Express; a 200
// empty body = nothing known about that player (fail-open), a 404 = unknown map
// or malformed name.
const playerRecCacheKey = (map, name) =>
  `/api/game/player-record?map=${String(map || "").toLowerCase()}&name=${String(name || "").slice(0, 64)}`;
api.get("/game/player-record", cache(60, { key: (req) => playerRecCacheKey(req.query.map, req.query.name) }), wrap(async (req, res) => {
  const { map, name } = req.query;
  if (typeof map !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(map.toLowerCase()))
    return res.status(404).type("text/plain").send("// unknown map\n");
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))
    return res.status(404).type("text/plain").send("// bad name\n");
  const body = await race.gamePlayerRecordText(map, name);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body); // "" => 200 empty (no record)
}));

// One player's saved START(s) for a map (hrace/savedstarts.as polls this per
// player on join via the RS_ApiFetchSavedStart native), so a returning player
// spawns where they left off. Plain text behind a "//starts" header: a
// "<race|reverse> x y z pitch yaw roll" line per saved direction, or a bare
// header when that player has none. Not cached: it is fetched once per join and
// must reflect a /savestart the player just made before reconnecting; the load
// is trivial. A 404 = unknown/invalid map or bad name.
api.get("/game/saved-start", wrap(async (req, res) => {
  const { map, name } = req.query;
  if (typeof map !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(map.toLowerCase()))
    return res.status(404).type("text/plain").send("// unknown map\n");
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))
    return res.status(404).type("text/plain").send("// bad name\n");
  const body = await race.savedStartText(map, name);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body);
}));

// In-game "achievement unlocked" announcements (hrace/awards.as polls this per
// player slot ~75s via the RS_ApiFetchAwards native). Payload contract lives in
// db.gameAwardsText: "//awards" header, then "<rowId>\t<tier>\t<title>\t<desc>"
// lines; ?seed=1 answers with just the newest row so a joining player's slot
// can set its high-water mark without replaying history, ?after=<id> returns
// the newer rows oldest-first. Public and side-effect-free like every game GET
// — the game tracks what it has announced, the web marks nothing. Short cache:
// a poll repeats its exact (name, after) until an award moves the mark, and a
// 15s-stale answer only delays the popup, never the award itself.
const awardsCacheKey = (req) =>
  `/api/game/awards?name=${String(req.query.name || "").slice(0, 64)}` +
  `&after=${String(req.query.after || 0).slice(0, 16)}&seed=${req.query.seed ? 1 : 0}`;
api.get("/game/awards", cache(15, { key: awardsCacheKey }), wrap(async (req, res) => {
  const { name, after, seed } = req.query;
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || /[\x00-\x1f\x7f]/.test(name))
    return res.status(404).type("text/plain").send("// bad name\n");
  const aft = typeof after === "string" && /^[0-9]{1,15}$/.test(after) ? Number(after) : 0;
  const body = await race.gameAwardsText(name, { after: aft, seed: Boolean(seed) });
  if (body == null) return res.status(404).type("text/plain").send("// bad name\n");
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

// Per-map weapon inventory for the game servers: the gametype polls this
// (hrace/mapweapons.as via RS_ApiFetchMapWeapons) so `callvote randmap rl` /
// `randmap strafe` can filter the vote pool by what a map plays like. Plain
// text, one line per scanned map "<name> code code ..." (a strafe map is a bare
// name). The data only changes when the maps are re-scanned, so cache long.
api.get("/game/map-weapons", cache(600), wrap(async (_req, res) => {
  const body = await race.gameMapWeaponsText();
  res.type("text/plain").send(body ? body + "\n" : "");
}));

// Most-recently-played maps for the game servers' in-game /lastmaps command
// (hrace/lastmaps.as polls this via the RS_ApiFetchLastMaps native). Plain text,
// one lowercased map name per line, most-recent first — the last 10 DISTINCT
// maps anyone finished across the network. Same public plain-text shape as
// blocked-maps; the game-side native rejects an HTML error body via its '<'
// check, so no header line is needed. The list moves slowly, so cache a minute.
api.get("/game/last-maps", cache(60), wrap(async (_req, res) => {
  const body = await race.gameLastMapsText();
  res.type("text/plain").send(body ? body + "\n" : "");
}));

// The current (or next) tournament for the game servers: the gametype polls
// this (~60s, hrace/tournament.as via RS_ApiFetchTourney) so "/tournament",
// "/tmaps" and the `callvote tourneymap` pool track the calendar without a
// restart. Plain text; "RSTOURNEY" first line lets the game-side native reject
// captive-portal / proxy error bodies that answer 200 (same idea as RSMOTD).
// An empty body after the header is a real state — "nothing scheduled".
// Cached 60s: the payload only changes when an admin edits the calendar or a
// tournament rolls over, and a minute of lag on either is invisible in-game.
api.get("/game/tournament", cache(60), wrap(async (_req, res) => {
  res.type("text/plain").send(await race.gameTourneyText());
}));

// In-game "/tournament <code>" and "/tournament join": a game server redeems an
// entry code (or enrols the nick outright) on behalf of a player. Server-token
// authed like /ingest — this WRITES, so it is a POST and never a game GET.
//
// The response is plain text the gametype prints almost verbatim, because
// AngelScript has no JSON parser: an "RSTJOIN" sentinel, then "ok" or "err",
// then one line per message. Auth runs BEFORE body parsing (DoS guard), the
// same ordering /ingest/saved-start uses.
api.post(
  "/game/tournament/join",
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
    const name = typeof body.name === "string" ? body.name.slice(0, MAX_NAME_LEN) : "";
    const login = typeof body.login === "string" ? body.login.slice(0, MAX_NAME_LEN) : "";
    // Every line of an RSTJOIN reply is printed to the player verbatim, so the
    // payload is line-delimited and control characters are structural. The
    // tournament NAME is admin-entered free text that lands in these lines, so
    // scrub it here the same way gameTourneyText scrubs it for the sibling feed
    // — otherwise a name containing a newline turns one message into several.
    const clean = (s) => String(s == null ? "" : s).replace(/[\x00-\x1f\x7f]+/g, " ").trim();
    const reply = (ok, ...lines) =>
      res
        .type("text/plain")
        .send(`RSTJOIN\n${ok ? "ok" : "err"}\n${lines.map(clean).filter(Boolean).join("\n")}\n`);
    if (!name) return reply(false, "Your name could not be read.");

    const rawCode = typeof body.code === "string" ? body.code : "";
    let result;
    if (rawCode) {
      const code = normalizeCode(rawCode);
      if (!code) return reply(false, "That is not a valid entry code (8 characters, e.g. RS9K-4MTB).");
      result = await race.redeemEntryCode({ code, name, login, serverId: req.ingest.serverId });
    } else {
      // No code: enrol in whatever is running (or starting next) right now.
      const t = await race.currentOrNextTournament();
      if (!t) return reply(false, "No tournament is scheduled right now.");
      if (!joinOpen(t)) return reply(false, `${t.name} is not taking entries.`);
      result = await race.joinTournamentInGame({
        tournamentId: t.id, name, login, serverId: req.ingest.serverId,
      });
    }

    if (!result.ok) {
      const why = {
        unknown_code: "No tournament entry matches that code.",
        code_used: "That entry code has already been claimed by someone else.",
        closed: "That tournament is not taking entries.",
        already_entered: "You are already registered for that tournament.",
      };
      return reply(false, why[result.reason] || "Could not register you for that tournament.");
    }
    const t = result.tournament;
    recordEvent(
      req.ingest.serverId,
      `/tournament ${rawCode ? "redeem" : "join"} ${t ? t.slug : "?"} by ${simplifyName(name)}` +
        `${result.already ? " [already registered]" : ""}`
    );
    if (result.already) return reply(true, `You are already registered for ${t.name}.`);
    return reply(
      true,
      `Registered for ${t.name}!`,
      result.code ? `Your entry code is ${formatCode(result.code)} - keep it safe.` : "",
      "Every run you set on a tournament map before it ends counts."
    );
  })
);

// Message of the day for the game servers: the gametype polls this (~60s,
// hrace/motd.as) and sets the engine's sv_MOTDString cvar, so an admin edit
// reaches newly connecting players without a restart. The "RSMOTD" first line
// lets the game-side native reject captive-portal / proxy error bodies that
// answer 200 (same idea as the RSGHOST header). An empty value after the
// header is a real state — "show no MOTD" — not an error.
api.get("/game/motd", cache(30), wrap(async (_req, res) => {
  const s = await race.getSetting("motd");
  res.type("text/plain").send("RSMOTD\n" + (s ? s.value : ""));
}));

// Rotating in-game announcements for the game servers: the gametype polls this
// (~60s, hrace/announcement.as) and broadcasts one message every
// rs_announce_interval seconds, rotating through the list, so an admin edit at
// /admin/announcements rotates in without a restart. One message per line; the
// "RSANN" first line lets the game-side native reject captive-portal / proxy
// error bodies that answer 200 (same idea as the RSMOTD header). An empty body
// after the header is a real state — "no announcements" — not an error.
api.get("/game/announcements", cache(30), wrap(async (_req, res) => {
  const s = await race.getSetting("announcements");
  res.type("text/plain").send("RSANN\n" + (s ? s.value : ""));
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

// ===================== Achievements evaluation ==============================
// Post-ingest, debounced: evaluate the active achievement definitions for just
// the players an ingest touched (db.js evaluateAchievements — awards are
// idempotent). This runs on EVERY racelog ingest, not only PB-changing ones,
// because a plain finish can complete "100 finishes"-style rules that the
// aggregate refresh (which only fires on inserted/improved) would never see.
// The debounce sits a little behind the aggregate one so standings-based rules
// usually read the freshly rebuilt standings; the daily sweep (whole field,
// claimed once per UTC day across replicas — db.js achievementsDailySweep) is
// the correctness backstop for anything a race with the rebuild missed.
const ACH_EVAL_DEBOUNCE_MS = 5000;
const pendingAchPlayers = new Set();
let achTimer = null;
let achRunning = false;
let achAgain = false;
async function doAchievementEval() {
  achTimer = null;
  if (achRunning) {
    achAgain = true;
    return;
  }
  achRunning = true;
  try {
    const ids = [...pendingAchPlayers];
    pendingAchPlayers.clear();
    try {
      const n = ids.length ? await race.evaluateAchievements(ids) : 0;
      if (n) recordEvent(null, `achievements: ${n} new award${n === 1 ? "" : "s"}`, "system");
    } catch (e) {
      console.error("achievement evaluation failed:", e?.message ?? e);
    }
    try {
      const n = await race.achievementsDailySweep();
      if (n) recordEvent(null, `achievements: ${n} new award${n === 1 ? "" : "s"} (daily sweep)`, "system");
    } catch (e) {
      console.error("achievement daily sweep failed:", e?.message ?? e);
    }
  } finally {
    achRunning = false;
    if (achAgain) {
      achAgain = false;
      scheduleAchievementEval();
    }
  }
}
function scheduleAchievementEval() {
  if (!achTimer) achTimer = setTimeout(doAchievementEval, ACH_EVAL_DEBOUNCE_MS);
}
// One pass shortly after boot so the daily sweep runs even on a day with no
// ingest traffic to this replica (e.g. right after a deploy).
setTimeout(scheduleAchievementEval, 15_000).unref();

// ===================== Tournament finalizer =================================
// Freeze the standings of every tournament whose window has closed, mint its
// trophies, and roll a recurring series forward. Runs on a plain interval on
// BOTH replicas rather than behind a day-claim like the achievements sweep:
// db.finalizeTournament locks the tournament row and re-checks the window
// inside the transaction, so a double run is a no-op, and a tournament that
// ended two minutes ago should not have to wait for tomorrow's sweep to award
// its podium. The query is one indexed range scan that returns nothing
// 99.99% of the time.
const TOURNAMENT_SWEEP_MS = Math.max(60_000, parseInt(process.env.TOURNAMENT_SWEEP_MS || "300000", 10));
let tournamentSweepRunning = false;
async function sweepTournaments() {
  if (shuttingDown || tournamentSweepRunning) return;
  tournamentSweepRunning = true;
  try {
    const r = await race.finalizeDueTournaments();
    if (r.finalized) {
      recordEvent(
        null,
        `tournaments: finalized ${r.finalized} (${r.trophies} troph${r.trophies === 1 ? "y" : "ies"} awarded)`,
        "system"
      );
    }
    for (const s of r.scheduled) {
      recordEvent(null, `tournaments: scheduled next edition ${s.slug} (starts ${new Date(s.startsAt * 1000).toISOString()})`, "system");
    }
  } catch (e) {
    console.error("tournament finalizer failed (will retry):", e?.message ?? e);
  } finally {
    tournamentSweepRunning = false;
  }
}
let tournamentSweepTimer = setInterval(sweepTournaments, TOURNAMENT_SWEEP_MS);
tournamentSweepTimer.unref();
setTimeout(sweepTournaments, 20_000).unref();

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

// Constant-time equality for two secret strings (e.g. the CSRF token), matching
// the codebase's constant-time practice for the bearer/password paths.
function safeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Resolve the Authorization header to an ingest identity, or null.
//   -> { serverId, serverName } for a per-server token
//   -> { serverId: null, serverName: 'shared' } for the legacy shared token
//
// TRUST BOUNDARY: a valid ingest token is TRUSTED to report game results for any
// player identity (the player name/login in a record is game-supplied, not
// proven here), so a compromised game box can forge records — inherent to a
// shared leaderboard fed by trusted servers. Blast radius is bounded by: (1)
// per-server tokens so each write is attributed to a server_id (audit/rollback);
// (2) the MIN_TIME_MS floor blocking absurd-time forgeries; (3) revocation
// (a revoked server is refused below). Retiring the shared token tightens (1).
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

// Movement/behaviour metrics (wall jumps, dashes, prejump-rejected starts,
// restarts) ride along on a finish or attempt flush. Each is a non-negative
// count since the player's last flush; absent/invalid -> 0. The cap mirrors
// MAX_ATTEMPTS_PER_ENTRY's intent — a movement event per frame for a long run
// still stays well under it; anything larger is a buggy/hostile server.
const MAX_METRIC_PER_ENTRY = 1000000;
function sanitizeMetric(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_METRIC_PER_ENTRY) : 0;
}

// Per-run air-strafe quality as basis points (0..10000 = 0.00%..100.00%). Unlike
// the movement counters this is a per-run SNAPSHOT, not an additive tally: it is
// stored on the finish row (never summed into run_tally, never part of metricSum),
// and null when absent/invalid so it stays distinct from a real 0% and so older
// servers that don't report it contribute nothing. See migration 20260730120000000.
const MAX_STRAFE_QUALITY = 10000;
function sanitizeStrafeQuality(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return Math.min(n, MAX_STRAFE_QUALITY);
}

// Per-run speed snapshots in ups (max over the run / at the start line). Same
// posture as strafe_quality: stored on the finish row, null when absent or
// invalid so older servers contribute nothing.
const MAX_SPEED_UPS = 100000;
function sanitizeSpeed(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return Math.min(n, MAX_SPEED_UPS);
}

// Distance travelled per flush period (game units). Additive like the movement
// counters but orders of magnitude larger, so it gets its own per-entry cap and
// its own per-request budget instead of joining metricSum (where it would eat
// the whole MAX_TALLY_PER_REQUEST allowance).
const MAX_DISTANCE_PER_ENTRY = 100_000_000;
const MAX_DISTANCE_PER_REQUEST = 500_000_000;
function sanitizeDistance(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_DISTANCE_PER_ENTRY) : 0;
}

function sanitizeRecord(r) {
  if (!r || typeof r.name !== "string" || r.name.length === 0) return null;
  const time = Number(r.time);
  if (!Number.isInteger(time) || time < MIN_TIME_MS || time > MAX_TIME_MS) return null;
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
    // Split times are ms into the run, so bound them like the record time: a
    // legit split is <= MAX_TIME_MS, and this keeps the value inside the
    // checkpoint.time INT4 column (a larger value would abort the whole ingest
    // tx with a numeric-overflow error).
    checkpoints: cpsIn.map((t) => {
      const n = Number(t);
      return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_TIME_MS) : 0;
    }),
    wall_jumps: sanitizeMetric(r.wall_jumps),
    dashes: sanitizeMetric(r.dashes),
    prejump_failures: sanitizeMetric(r.prejump_failures),
    restarts: sanitizeMetric(r.restarts),
    // Counter deltas since the last flush (added into run_tally like the
    // metrics above; distance has its own request budget, strafes joins
    // metricSum).
    distance: sanitizeDistance(r.distance),
    strafes: sanitizeMetric(r.strafes),
    // Per-run snapshots stored on the finish row: air-strafe quality (basis
    // points) + max/starting speed (ups). null when unreported; NOT part of
    // the additive metricSum below.
    strafe_quality: sanitizeStrafeQuality(r.strafe_quality),
    max_speed: sanitizeSpeed(r.max_speed),
    start_speed: sanitizeSpeed(r.start_speed),
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
  if (!Number.isInteger(time) || time < MIN_TIME_MS || time > MAX_TIME_MS) return null;
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
  const countRaw = Number(a.count);
  const count =
    Number.isInteger(countRaw) && countRaw > 0 ? Math.min(countRaw, MAX_ATTEMPTS_PER_ENTRY) : 0;
  const wall_jumps = sanitizeMetric(a.wall_jumps);
  const dashes = sanitizeMetric(a.dashes);
  const prejump_failures = sanitizeMetric(a.prejump_failures);
  const restarts = sanitizeMetric(a.restarts);
  const distance = sanitizeDistance(a.distance);
  const strafes = sanitizeMetric(a.strafes);
  // A metrics-only flush (e.g. a lone /kill) carries count 0 but real metrics —
  // keep it. Drop only when there is genuinely nothing to record.
  if (
    count === 0 &&
    wall_jumps === 0 &&
    dashes === 0 &&
    prejump_failures === 0 &&
    restarts === 0 &&
    distance === 0 &&
    strafes === 0
  )
    return null;
  return {
    name: a.name.slice(0, MAX_NAME_LEN),
    login: typeof a.login === "string" ? a.login.slice(0, MAX_NAME_LEN) : "",
    count,
    wall_jumps,
    dashes,
    prejump_failures,
    restarts,
    distance,
    strafes,
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
      if (typeof d.name !== "string" || !d.name || !Number.isInteger(time) || time < MIN_TIME_MS || time > MAX_TIME_MS)
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
    // Backstop the multiplied per-record/per-batch checkpoint caps: reject a
    // request whose total splits would balloon the checkpoint tables.
    const totalCheckpoints = clean.reduce((n, r) => n + r.checkpoints.length, 0);
    if (totalCheckpoints > MAX_TOTAL_CHECKPOINTS) {
      return res.status(400).json({ error: `too many checkpoints (max ${MAX_TOTAL_CHECKPOINTS} total)` });
    }
    // Reject an implausibly large sum of monotonic tally deltas (counter
    // inflation). Distance is budgeted separately — its plausible magnitude
    // (units, not events) would otherwise eat the whole allowance.
    const metricSum = (e) => e.wall_jumps + e.dashes + e.prejump_failures + e.restarts + e.strafes;
    const totalTally =
      clean.reduce((n, r) => n + (r.attempts != null ? r.attempts : 1) + metricSum(r), 0) +
      cleanAttempts.reduce((n, a) => n + a.count + metricSum(a), 0);
    if (totalTally > MAX_TALLY_PER_REQUEST) {
      return res.status(400).json({ error: `implausible counter totals (max ${MAX_TALLY_PER_REQUEST} per request)` });
    }
    const totalDistance =
      clean.reduce((n, r) => n + r.distance, 0) + cleanAttempts.reduce((n, a) => n + a.distance, 0);
    if (totalDistance > MAX_DISTANCE_PER_REQUEST) {
      return res.status(400).json({ error: `implausible distance total (max ${MAX_DISTANCE_PER_REQUEST} per request)` });
    }

    try {
      // playerIds (raw ids the batch touched) stays out of the HTTP response —
      // it only feeds the achievements pass below.
      const { playerIds = [], ...counts } = await race.ingest({
        version,
        map: map.toLowerCase(),
        records: clean,
        attempts: cleanAttempts,
        source,
        serverId: req.ingest.serverId,
      });
      // Evict BEFORE the touchServer round trip below, not after: the game asks
      // for a fresh board within seconds of a finish (hrace/ranks.as fires an
      // off-schedule pull), so every millisecond the stale blob stays readable is
      // a millisecond that pull can come back with the pre-finish board.
      if (counts.inserted || counts.improved) {
        // A new/improved time reorders the whole map's ranks (it bumps everyone
        // it passed), so evict the map's cached blobs — the next game fetch
        // recomputes them. `map` already carries the effective name (incl. any
        // "-reversed" variant the game reported under); both key builders
        // lowercase. Topscores rides along because the same record changes the
        // top-50 board every server shows as `top`, its HUD record lines, and the
        // board apitop.as verifies a record announcement against.
        invalidate(ranksCacheKey(map));
        invalidate(topscoresCacheKey(map));
      }
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
      // Live finishes may complete achievement rules even when no PB changed,
      // so this triggers on every racelog batch (topscores re-syncs excluded —
      // they replay existing records on an interval).
      if (source === "racelog" && playerIds.length) {
        for (const pid of playerIds) pendingAchPlayers.add(pid);
        scheduleAchievementEval();
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

// In-game "/savestart": a game server persists a player's chosen START position
// for the current map (or clears it, when coords is empty, for "/clearstart").
// Server-token authed like /ingest and keyed by map NAME + player nick (the game
// doesn't know the web's ids). Stored per (canonical player, map, direction) so
// it comes back when they rejoin. Auth runs BEFORE body parsing (DoS guard).
api.post(
  "/ingest/saved-start",
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
    if (!mapName || !/^[a-z0-9][a-z0-9_.-]*$/.test(mapName)) return res.status(400).json({ error: "map required" });
    const name = typeof body.name === "string" ? body.name.slice(0, MAX_NAME_LEN) : "";
    if (!name) return res.status(400).json({ error: "name required" });
    const login = typeof body.login === "string" ? body.login.slice(0, MAX_NAME_LEN) : "";
    const mode = body.mode === "reverse" ? "reverse" : "race";
    const coords = typeof body.coords === "string" ? body.coords.trim() : "";

    // Empty coords => "/clearstart": remove this direction's saved start.
    if (coords === "") {
      const cleared = await race.deletePlayerSavedStart({ map: mapName, name, login, mode });
      recordEvent(req.ingest.serverId, `/clearstart ${mapName} (${mode}) from ${req.ingest.serverName}${cleared ? "" : " [none]"}`);
      return res.json({ ok: true, cleared });
    }

    // "x y z pitch yaw roll" — six finite numbers; origin bounded to Quake
    // worldspace so a pathological payload can't store a nonsense spawn.
    const nums = coords.split(/\s+/).map(Number);
    if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6))
      return res.status(400).json({ error: "invalid coords" });
    if (nums.slice(0, 3).some((n) => Math.abs(n) > 65536))
      return res.status(400).json({ error: "coords out of range" });

    await race.upsertPlayerSavedStart({
      map: mapName, name, login, mode,
      origin: nums.slice(0, 3), angles: nums.slice(3, 6),
      serverId: req.ingest.serverId,
    });
    recordEvent(req.ingest.serverId, `/savestart ${mapName} (${mode}) from ${req.ingest.serverName}`);
    res.json({ ok: true });
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
  // Genuine server fault (500) — report to Sentry (no-op when unconfigured)
  // and log it. The 4xx client faults above returned already and are never sent.
  Sentry.captureException(err);
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

// Gate factory: attach req.session or bounce. Not signed in -> GET redirects to
// the login page, state-changing verbs -> 401 (the form 302s the user to login
// on reload). When `role` is "admin", a signed-in moderator is refused (403) so
// the admin-only surface (MOTD, RCON console, maintenance, broadcast, logs) is
// reachable only by full admins. `requireAuth` (role=null) admits any signed-in
// user — used for the flag/map-block/restart routes moderators share.
function requireRole(role) {
  return async (req, res, next) => {
    try {
      const sess = await currentSession(req);
      if (!sess) {
        if (req.method === "GET") return res.redirect(302, "/admin/login");
        return res.status(401).type("text/plain").send("Not signed in.");
      }
      req.session = sess;
      if (role === "admin" && sess.role !== "admin") {
        // Signed in, but lacks the tier. Defence in depth: the UI already hides
        // these controls from moderators; this refuses a hand-crafted request.
        if (req.method === "GET")
          return res
            .status(403)
            .type("html")
            .send(
              adminShell(
                "Forbidden",
                `<h1>Admins only</h1><p class="sub">This page is available to full admins only.</p>
                 <p><a href="/admin/flags">← back to the flag queue</a></p>`,
                sess
              )
            );
        return res.status(403).type("text/plain").send("Admins only.");
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}
const requireAuth = requireRole(null); // any signed-in user (admin or moderator)
const requireAdmin = requireRole("admin"); // full-admin tier only

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
  if (!token || typeof token !== "string" || !safeEqualStr(token, req.session.csrf)) {
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
button.danger,a.btn.danger{border-color:#6b2f22;color:#ffb4a0}
button:hover,.btn:hover{filter:brightness(1.12)}
button:disabled{opacity:.55;cursor:not-allowed;filter:none}
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

// True for a full-admin session; false for moderators (and unauthenticated).
// The single source of truth for the UI's "hide admin-only controls" gating.
function isAdminSession(session) {
  return Boolean(session) && session.role === "admin";
}

function adminShell(title, bodyHtml, session, headExtra = "") {
  const logout = session
    ? `<span class="who">${escHtml(session.username)} ·
         <span title="account tier">${escHtml(session.role || "admin")}</span> ·
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

admin.post("/logout", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  await race.deleteSession(sha256(req.session.raw));
  clearSessionCookie(req, res);
  res.redirect(303, "/admin/login");
}));

// --- Flag review ---
admin.get("/", requireAuth, (req, res) => res.redirect(302, "/admin/flags"));

admin.get("/flags", requireAuth, wrap(async (req, res) => {
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
      <a href="/admin/flags/all">history</a> · <a href="/admin/servers">servers</a>${isAdminSession(req.session) ? ` · <a href="/admin/logs">logs</a>` : ""} · <a href="/admin/blocked">blocked maps</a> · <a href="/admin/achievements">achievements</a> · <a href="/admin/tournaments">tournaments</a>${isAdminSession(req.session) ? ` · <a href="/admin/names">names</a> · <a href="/admin/motd">motd</a> · <a href="/admin/announcements">announcements</a>` : ""} · <a href="/admin/account">account</a></p>
    ${done}${body}`, req.session);
}));

admin.get("/flags/all", requireAuth, wrap(async (req, res) => {
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

admin.get("/flags/map/:id", requireAuth, wrap(async (req, res) => {
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
admin.post("/flags/:id/resolve", requireAuth, wrap((req, res) => closeOneFlag(req, res, "resolved")));
admin.post("/flags/:id/dismiss", requireAuth, wrap((req, res) => closeOneFlag(req, res, "dismissed")));

async function closeMapFlags(req, res, status) {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const n = await race.resolveMapFlags(id, status, req.session.username);
  res.redirect(303, `/admin/flags?done=${encodeURIComponent(`${status === "resolved" ? "Resolved" : "Dismissed"} ${n} flag(s).`)}`);
}
admin.post("/flags/map/:id/resolve-all", requireAuth, wrap((req, res) => closeMapFlags(req, res, "resolved")));
admin.post("/flags/map/:id/dismiss-all", requireAuth, wrap((req, res) => closeMapFlags(req, res, "dismissed")));

// Block a map (remove from the vote pool + cycle) — also resolves its open
// flags. Unblock reverses it. Both CSRF-guarded.
admin.post("/flags/map/:id/block", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const r = await race.blockMap(id, "blocked via admin flag review", req.session.username);
  if (!r.ok) return res.status(404).type("text/plain").send("map not found");
  res.redirect(303, `/admin/flags?done=${encodeURIComponent("Blocked the map and closed its open flags. It will drop from rotation on the game servers' next restart.")}`);
}));
admin.post("/maps/:id/unblock", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  await race.unblockMap(id);
  res.redirect(303, `/admin/blocked?done=${encodeURIComponent("Unblocked. It returns to rotation on the game servers' next restart.")}`);
}));

admin.get("/blocked", requireAuth, wrap(async (req, res) => {
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

// --- Offensive-name censoring ---
// Masks offensive player nicks at display time everywhere they are shown (site,
// OG/Discord cards, in-game topscores/ranks, live rosters). Originals stay in
// the DB, so records/history are untouched. The word list auto-catches existing
// AND future nicks; per-player overrides fix the edges. See web/censor.js.
const CENSOR_SEVERITIES = ["slur", "hate", "sexual", "profanity"];
function censorSevBadge(sev) {
  return `<span class="cs-sev cs-${CENSOR_SEVERITIES.includes(sev) ? sev : "profanity"}">${escHtml(sev)}</span>`;
}
const CENSOR_CSS = `
  .cs-sev{display:inline-block;font-size:11px;padding:1px 6px;border-radius:10px;margin-left:4px;vertical-align:middle}
  .cs-slur{background:#b00020;color:#fff}.cs-hate{background:#7c1fa0;color:#fff}
  .cs-sexual{background:#a15c00;color:#fff}.cs-profanity{background:#555;color:#fff}
  .cs-pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px}
  .cs-auto{background:#334;color:#cde}.cs-force{background:#b00020;color:#fff}.cs-allow{background:#1f7a2f;color:#fff}
  table.cs{border-collapse:collapse;width:100%;margin:10px 0}
  table.cs th,table.cs td{text-align:left;padding:6px 8px;border-bottom:1px solid #2a2a34;vertical-align:top}
  table.cs td.mono,table.cs td.cs-masked{font-family:monospace}
  .cs-muted{color:#888}`;

admin.get("/names", requireAdmin, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const csrf = escHtml(req.session.csrf);
  const [players, terms, maps] = await Promise.all([
    race.censoredPlayers(),
    race.censorTerms(),
    race.censoredMaps(),
  ]);

  const pbtn = (id, act, label) =>
    `<form class="inline" method="post" action="/admin/names/player/${id}">` +
    `<input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="${act}">` +
    `<button type="submit">${label}</button></form>`;
  const playerRows = players.length
    ? players
        .map((p) => {
          const orig = escHtml(simplifyName(p.name)) || "<span class='cs-muted'>(blank)</span>";
          const masked = escHtml(simplifyName(p.masked));
          const termList = p.terms.length
            ? p.terms.map((t) => `${escHtml(t.term)}${censorSevBadge(t.severity)}`).join(" ")
            : "<span class='cs-muted'>—</span>";
          const state =
            p.action === "allow"
              ? `<span class="cs-pill cs-allow">shown in full</span>`
              : p.action === "censor"
              ? `<span class="cs-pill cs-force">force-censored</span>`
              : `<span class="cs-pill cs-auto">auto</span>`;
          const actions = [
            p.action !== "censor" ? pbtn(p.id, "censor", "Force-censor") : "",
            p.action !== "allow" ? pbtn(p.id, "allow", "Allow") : "",
            p.action ? pbtn(p.id, "clear", "Clear") : "",
          ].join(" ");
          return `<tr>
            <td><a href="/player/${p.id}" target="_blank" rel="noopener">${orig}</a></td>
            <td class="cs-masked">${p.action === "allow" ? "<span class='cs-muted'>—</span>" : masked}</td>
            <td>${termList}</td>
            <td>${state}</td>
            <td class="actions">${actions}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">No names currently flagged or censored.</td></tr>`;

  const mbtn = (id, act, label) =>
    `<form class="inline" method="post" action="/admin/names/map/${id}">` +
    `<input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="action" value="${act}">` +
    `<button type="submit">${label}</button></form>`;
  const mapRows = maps.length
    ? maps
        .map((m) => {
          const termList = m.terms.length
            ? m.terms.map((t) => `${escHtml(t.term)}${censorSevBadge(t.severity)}`).join(" ")
            : "<span class='cs-muted'>—</span>";
          const state =
            m.action === "allow"
              ? `<span class="cs-pill cs-allow">shown in full</span>`
              : m.action === "censor"
              ? `<span class="cs-pill cs-force">force-censored</span>`
              : `<span class="cs-pill cs-auto">auto</span>`;
          const actions = [
            m.action !== "censor" ? mbtn(m.id, "censor", "Force-censor") : "",
            m.action !== "allow" ? mbtn(m.id, "allow", "Allow") : "",
            m.action ? mbtn(m.id, "clear", "Clear") : "",
          ].join(" ");
          return `<tr>
            <td class="mono"><a href="/map/${m.id}" target="_blank" rel="noopener">${escHtml(m.name)}</a></td>
            <td class="cs-masked">${m.action === "allow" ? "<span class='cs-muted'>—</span>" : escHtml(m.masked)}</td>
            <td>${termList}</td>
            <td>${state}</td>
            <td class="actions">${actions}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" class="empty">No map names currently flagged or censored.</td></tr>`;

  const sevOptions = CENSOR_SEVERITIES.map((s) => `<option value="${s}">${s}</option>`).join("");
  const termRows = terms.length
    ? terms
        .map(
          (t) => `<tr>
          <td class="mono">${escHtml(t.term)}</td>
          <td>${escHtml(t.mode)}</td>
          <td>${censorSevBadge(t.severity)}</td>
          <td>${t.added_by ? escHtml(t.added_by) : ""}</td>
          <td class="actions"><form class="inline" method="post" action="/admin/names/term/remove">
            <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="term" value="${escHtml(t.term)}">
            <button type="submit">Remove</button></form></td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Word list is empty.</td></tr>`;

  sendAdmin(
    res,
    "Names",
    `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Name censoring</h1>
    <p class="sub">Offensive player nicks and map names are masked wherever they appear (site, Discord cards, in-game
      boards, live rosters). Originals stay in the database — records, history and map loading are never altered.
      <b>norm</b> matches anywhere in the colour/punctuation-stripped nick (best for slurs);
      <b>word</b> matches only whole words (fewer false positives).</p>
    ${done}
    <h2>Flagged &amp; censored players <span class="cs-muted">(${players.length})</span></h2>
    <p class="sub"><b>Allow</b> whitelists a false positive; <b>Force-censor</b> masks a nick the word list missed.</p>
    <table class="cs">
      <thead><tr><th>Original</th><th>Shown as</th><th>Matched</th><th>State</th><th></th></tr></thead>
      <tbody>${playerRows}</tbody>
    </table>
    <h2>Flagged &amp; censored maps <span class="cs-muted">(${maps.length})</span></h2>
    <p class="sub">Map names are masked on the site + feeds only; the real name is untouched so the map still loads,
      votes and links normally. To remove a map from play entirely use <a href="/admin/blocked">blocked maps</a>.</p>
    <table class="cs">
      <thead><tr><th>Map (real name)</th><th>Shown as</th><th>Matched</th><th>State</th><th></th></tr></thead>
      <tbody>${mapRows}</tbody>
    </table>
    <h2>Word list <span class="cs-muted">(${terms.length})</span></h2>
    <form class="card" method="post" action="/admin/names/term/add" style="max-width:560px">
      <input type="hidden" name="_csrf" value="${csrf}">
      <div class="actions" style="gap:8px;flex-wrap:wrap">
        <input name="term" placeholder="term" maxlength="64" required style="font-family:monospace">
        <select name="mode"><option value="norm">norm</option><option value="word">word</option></select>
        <select name="severity">${sevOptions}</select>
        <button class="primary" type="submit">Add / update</button>
      </div>
    </form>
    <table class="cs">
      <thead><tr><th>Term</th><th>Mode</th><th>Severity</th><th>Added by</th><th></th></tr></thead>
      <tbody>${termRows}</tbody>
    </table>`,
    req.session,
    `<style>${CENSOR_CSS}</style>`
  );
}));

admin.post("/names/term/add", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const t = await race.addCensorTerm(
    req.body && req.body.term,
    req.body && req.body.mode,
    req.body && req.body.severity,
    req.session.username
  );
  res.redirect(303, `/admin/names?done=${encodeURIComponent(t ? `Added "${t}".` : "Nothing to add.")}`);
}));
admin.post("/names/term/remove", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const ok = await race.removeCensorTerm(req.body && req.body.term);
  res.redirect(303, `/admin/names?done=${encodeURIComponent(ok ? "Removed term." : "Term not found.")}`);
}));
admin.post("/names/player/:id", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad player id");
  const action = req.body && req.body.action;
  if (action === "clear") {
    await race.clearPlayerCensor(id);
    return res.redirect(303, `/admin/names?done=${encodeURIComponent("Cleared override.")}`);
  }
  const ok = await race.setPlayerCensor(id, action, "set via /admin/names", req.session.username);
  res.redirect(303, `/admin/names?done=${encodeURIComponent(ok ? "Override updated." : "Invalid action.")}`);
}));
admin.post("/names/map/:id", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad map id");
  const action = req.body && req.body.action;
  if (action === "clear") {
    await race.clearMapCensor(id);
    return res.redirect(303, `/admin/names?done=${encodeURIComponent("Cleared map override.")}`);
  }
  const ok = await race.setMapCensor(id, action, "set via /admin/names", req.session.username);
  res.redirect(303, `/admin/names?done=${encodeURIComponent(ok ? "Map override updated." : "Invalid action.")}`);
}));

// --- Game-server MOTD ---
// The text travels: site_setting -> /api/game/motd -> sv_MOTDString cvar -> a
// `motd 1 "<text>"` game command to each connecting client. A double quote
// would close that quoted argument early, so it becomes a single quote; CRs
// and other control characters (newline excepted — the MOTD box is
// multi-line) are dropped. The engine truncates at MAX_MOTD_LEN (1024) — cap
// below that so what an admin previews here is exactly what ships.
function sanitizeMotd(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/"/g, "'")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 1000);
}

admin.get("/motd", requireAdmin, wrap(async (req, res) => {
  const done = req.query.ok ? `<div class="msg ok">Saved. Game servers pick it up within ~2 minutes; it shows to players connecting after that.</div>` : "";
  const s = await race.getSetting("motd");
  const meta = s && s.updated_at
    ? `<p class="sub">last changed ${fmtWhen(s.updated_at)}${s.updated_by ? ` by ${escHtml(s.updated_by)}` : ""}</p>`
    : "";
  sendAdmin(res, "MOTD", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Message of the day</h1>
    <p class="sub">Shown to every player connecting to a game server ·
      served at <span style="font-family:monospace">/api/game/motd</span> ·
      empty = no MOTD popup · Warsow ^colors work · quotes become apostrophes</p>
    ${done}${meta}
    <form class="card" method="post" action="/admin/motd" style="max-width:640px">
      <input type="hidden" name="_csrf" value="${escHtml(req.session.csrf)}">
      <label for="motd">MOTD (max 1000 chars, multi-line ok)</label>
      <textarea id="motd" name="motd" rows="5" maxlength="1000"
        style="width:100%;box-sizing:border-box;font-family:monospace">${escHtml(s ? s.value : "")}</textarea>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>`, req.session);
}));

admin.post("/motd", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  await race.setSetting("motd", sanitizeMotd(req.body && req.body.motd), req.session.username);
  res.redirect(303, "/admin/motd?ok=1");
}));

// Rotating in-game announcements: one message per line. Normalise newlines,
// strip control characters (keep the newline separators), trim + drop blank
// lines, cap each line and the number of lines. Quotes are kept: the text goes
// straight to G_PrintMsg in-game, not into a quoted game command like the MOTD.
function sanitizeAnnouncements(raw) {
  return String(raw || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((l) => l.trim().slice(0, 200))
    .filter((l) => l.length > 0)
    .slice(0, 20)
    .join("\n");
}

admin.get("/announcements", requireAdmin, wrap(async (req, res) => {
  const done = req.query.ok ? `<div class="msg ok">Saved. Game servers pick it up within ~2 minutes and rotate through the messages.</div>` : "";
  const s = await race.getSetting("announcements");
  const meta = s && s.updated_at
    ? `<p class="sub">last changed ${fmtWhen(s.updated_at)}${s.updated_by ? ` by ${escHtml(s.updated_by)}` : ""}</p>`
    : "";
  // Inline live preview: renders each line with Warsow ^colors exactly as it
  // appears in-game. Written without template literals / ${} so it embeds
  // safely inside this server-side backtick template.
  const previewScript = `<script>
(function(){
  var pal={"0":"#1a1a1a","1":"#ff3d3d","2":"#4dff5a","3":"#ffe23d","4":"#4d74ff","5":"#35e0ff","6":"#ff5ce0","7":"#ffffff","8":"#ff9a3d","9":"#9099ad"};
  var ta=document.getElementById("ann"), pv=document.getElementById("annprev");
  if(!ta||!pv)return;
  function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
  function render_line(str){
    var out="",color="7",buf="";
    function flush(){ if(buf){ out+='<span style="color:'+pal[color]+(color==="0"?";text-shadow:0 0 1px #888,0 0 2px #666":"")+'">'+esc(buf)+"</span>"; buf=""; } }
    for(var i=0;i<str.length;i++){
      if(str[i]==="^"&&/[0-9]/.test(str[i+1]||"")){ flush(); color=str[++i]; }
      else buf+=str[i];
    }
    flush();
    return out||'<span style="opacity:.4">(empty line)</span>';
  }
  function render(){
    var lines=ta.value.replace(/\\r\\n?/g,"\\n").split("\\n").filter(function(l){return l.trim().length;});
    if(!lines.length){ pv.innerHTML='<div style="opacity:.5">No messages — the rotation is off.</div>'; return; }
    pv.innerHTML=lines.map(function(l,i){return '<div class="annrow"><span class="annnum">'+(i+1)+'</span><span>'+render_line(l)+"</span></div>";}).join("");
  }
  ta.addEventListener("input",render); render();
})();
</script>`;
  sendAdmin(res, "Announcements", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <style>
      #annprev{background:#171717;border-radius:8px;padding:12px 14px;margin-top:8px;font-family:monospace;line-height:1.7;color:#fff}
      #annprev .annrow{display:flex;gap:10px;align-items:baseline}
      #annprev .annnum{color:#6b6257;min-width:1.4em;text-align:right;font-size:12px}
    </style>
    <h1>In-game announcements</h1>
    <p class="sub">Broadcast to players on every game server, one message per line, rotating every few minutes ·
      served at <span style="font-family:monospace">/api/game/announcements</span> ·
      empty = rotation off · Warsow <span style="font-family:monospace">^</span>colors work ·
      <a href="/colors" target="_blank" rel="noopener">compose colors with the tester ↗</a></p>
    ${done}${meta}
    <form class="card" method="post" action="/admin/announcements" style="max-width:720px">
      <input type="hidden" name="_csrf" value="${escHtml(req.session.csrf)}">
      <label for="ann">Messages (one per line · up to 20 lines · 200 chars each)</label>
      <textarea id="ann" name="text" rows="8" maxlength="4400"
        style="width:100%;box-sizing:border-box;font-family:monospace">${escHtml(s ? s.value : "")}</textarea>
      <label style="margin-top:10px">Live preview (as players see it in-game)</label>
      <div id="annprev"></div>
      <div class="actions"><button class="primary" type="submit">Save</button></div>
    </form>
    ${previewScript}`, req.session);
}));

admin.post("/announcements", requireAdmin, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  await race.setSetting("announcements", sanitizeAnnouncements(req.body && req.body.text), req.session.username);
  res.redirect(303, "/admin/announcements?ok=1");
}));

// --- Achievements (admin + moderator) ---
// Definitions are composed from the vetted rule catalog (web/achievements.js)
// and created INACTIVE; the preview page dry-runs "who would earn this right
// now?" before an admin flips it on. Activation triggers a full retroactive
// evaluation, then the post-ingest pass + daily sweep keep awards current.

function fmtNumAdmin(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

// One kind's parameter inputs, hidden/shown by the kind <select> below. Field
// names are namespaced per kind (p_<kind>_<key>) so switching kinds never
// bleeds a value across.
function achParamFieldsHtml(kindKey, spec, rule) {
  const cur = rule && rule.kind === kindKey ? rule : {};
  const fields = spec.params
    .map((f) => {
      const name = `p_${kindKey}_${f.key}`;
      const val = cur[f.key];
      if (f.type === "bool") {
        return `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="${name}" style="width:auto" ${val ? "checked" : ""}> ${escHtml(f.label)}</label>`;
      }
      if (f.type === "select") {
        const opts = f.options
          .map((o) => `<option value="${escHtml(o.value)}" ${val === o.value ? "selected" : ""}>${escHtml(o.label)}</option>`)
          .join("");
        return `<label>${escHtml(f.label)}</label><select name="${name}">${opts}</select>`;
      }
      const mode = f.type === "int" ? `inputmode="numeric"` : f.type === "pct" ? `inputmode="decimal"` : "";
      return `<label>${escHtml(f.label)}${f.optional ? ` <span style="color:#8f857a">(optional)</span>` : ""}</label>
        <input name="${name}" value="${val != null ? escHtml(String(val)) : ""}" ${mode} maxlength="128">`;
    })
    .join("");
  return `<div class="achkind" data-kind="${escHtml(kindKey)}" data-windows="${spec.windows.join(",")}">
    <p class="sub" style="margin:8px 0 0">${escHtml(spec.help || "")}</p>${fields}</div>`;
}

// The create/edit form. The inline script (same no-template-literal idiom as
// the announcements preview) shows only the chosen kind's params and disables
// time-window options the kind doesn't support; validateDefinition re-checks
// everything server-side regardless.
function achFormHtml(session, def, action) {
  const rule = def ? def.rule : null;
  const curKind = rule && Object.prototype.hasOwnProperty.call(RULE_KINDS, rule.kind) ? rule.kind : Object.keys(RULE_KINDS)[0];
  const kindOpts = Object.entries(RULE_KINDS)
    .map(([k, s]) => `<option value="${k}" ${k === curKind ? "selected" : ""}>${escHtml(s.label)}</option>`)
    .join("");
  const winOpts = Object.entries(WINDOWS)
    .map(([k, label]) => `<option value="${k}" ${def && def.time_window === k ? "selected" : ""}>${escHtml(label)}</option>`)
    .join("");
  const tierOpts = TIERS.map((t) => `<option value="${t}" ${def && def.tier === t ? "selected" : ""}>${t}</option>`).join("");
  const paramBlocks = Object.entries(RULE_KINDS)
    .map(([k, s]) => achParamFieldsHtml(k, s, rule))
    .join("");
  return `
  <form class="card" method="post" action="${action}" style="max-width:720px">
    <input type="hidden" name="_csrf" value="${escHtml(session.csrf)}">
    <label for="atitle">Title (shown to players)</label>
    <input id="atitle" name="title" maxlength="120" required value="${def ? escHtml(def.title) : ""}">
    <label for="aslug">Slug (a–z, 0–9, dashes · blank = derived from the title)</label>
    <input id="aslug" name="slug" maxlength="64" value="${def ? escHtml(def.slug) : ""}">
    <label for="adesc">Description (shown to players)</label>
    <textarea id="adesc" name="description" rows="2" maxlength="500">${def ? escHtml(def.description) : ""}</textarea>
    <label for="atier">Tier</label>
    <select id="atier" name="tier">${tierOpts}</select>
    <label for="akind">Rule</label>
    <select id="akind" name="kind">${kindOpts}</select>
    ${paramBlocks}
    <label for="awindow">Time window</label>
    <select id="awindow" name="window">${winOpts}</select>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0 0"><input type="checkbox" name="repeatable" style="width:auto" ${def && def.repeatable ? "checked" : ""}> Repeatable — earnable again each calendar month / day (windowed rules only)</label>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 0 0"><input type="checkbox" name="hidden" style="width:auto" ${def && def.hidden ? "checked" : ""}> Hidden — players only see it once they earn it</label>
    <div class="actions"><button class="primary" type="submit">${def ? "Save changes" : "Create (inactive)"}</button></div>
  </form>
  <script>
(function(){
  var sel=document.getElementById("akind"), winSel=document.getElementById("awindow");
  if(!sel||!winSel)return;
  function upd(){
    var k=sel.value, blocks=document.querySelectorAll(".achkind"), allowed="";
    for(var i=0;i<blocks.length;i++){
      var on=blocks[i].getAttribute("data-kind")===k;
      blocks[i].style.display=on?"":"none";
      if(on)allowed=blocks[i].getAttribute("data-windows")||"";
    }
    var list=allowed.split(","), opts=winSel.querySelectorAll("option"), anySel=false;
    for(var j=0;j<opts.length;j++){
      var ok=list.indexOf(opts[j].value)>=0;
      opts[j].disabled=!ok;
      if(!ok&&opts[j].selected)opts[j].selected=false;
      if(opts[j].selected&&!opts[j].disabled)anySel=true;
    }
    if(!anySel){for(var m=0;m<opts.length;m++){if(!opts[m].disabled){opts[m].selected=true;break;}}}
  }
  sel.addEventListener("change",upd);upd();
})();
  </script>`;
}

// Pull the chosen kind's namespaced params back out of a form body.
function achInput(body) {
  const kind = String((body && body.kind) || "");
  const params = {};
  if (Object.prototype.hasOwnProperty.call(RULE_KINDS, kind)) {
    for (const f of RULE_KINDS[kind].params) params[f.key] = body[`p_${kind}_${f.key}`];
  }
  return {
    title: body.title,
    slug: body.slug,
    description: body.description,
    tier: String(body.tier || ""),
    kind,
    params,
    window: String(body.window || ""),
    repeatable: Boolean(body.repeatable),
    hidden: Boolean(body.hidden),
  };
}

admin.get("/achievements", requireAuth, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const defs = await race.listAchievements();
  const rows = defs
    .map(
      (d) => `<tr>
        <td><a href="/admin/achievements/${d.id}">${escHtml(d.title)}</a>${d.hidden ? ` <span class="tag">hidden</span>` : ""}</td>
        <td>${escHtml(d.tier)}</td>
        <td class="meta">${escHtml(describeRule(d))}</td>
        <td class="${d.active ? "st-resolved" : "st-dismissed"}">${d.active ? "active" : "inactive"}</td>
        <td class="meta">${fmtNumAdmin(d.earners)}</td>
        <td class="meta">${escHtml(d.updated_by || d.created_by || "")}</td>
      </tr>`
    )
    .join("");
  const body = defs.length
    ? `<table><thead><tr><th>Achievement</th><th>Tier</th><th>Rule</th><th>Status</th><th>Earned by</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">No achievements defined yet.</div>`;
  sendAdmin(res, "Achievements", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Achievements</h1>
    <p class="sub">Admin-defined awards, evaluated automatically as players play ·
      shown on player profiles and at <a href="/achievements" target="_blank" rel="noopener">/achievements ↗</a> ·
      new definitions start <b>inactive</b> — preview who qualifies, then activate.</p>
    ${done}${err}
    <div class="actions" style="margin-bottom:14px"><a class="btn" href="/admin/achievements/new">+ New achievement</a></div>
    ${body}`, req.session);
}));

admin.get("/achievements/new", requireAuth, wrap(async (req, res) => {
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  sendAdmin(res, "New achievement", `<div class="crumbs"><a href="/admin/achievements">← achievements</a></div>
    <h1>New achievement</h1>
    <p class="sub">Created inactive — you'll preview who qualifies before switching it on.</p>
    ${err}${achFormHtml(req.session, null, "/admin/achievements/new")}`, req.session);
}));

admin.post("/achievements/new", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const v = validateDefinition(achInput(req.body));
  if (v.error) return res.redirect(303, `/admin/achievements/new?error=${encodeURIComponent(v.error)}`);
  const id = await race.createAchievement(v.value, req.session.username);
  if (!id)
    return res.redirect(303, `/admin/achievements/new?error=${encodeURIComponent("That slug is already taken.")}`);
  res.redirect(303, `/admin/achievements/${id}?done=${encodeURIComponent("Created (inactive). Preview who qualifies, then activate.")}`);
}));

admin.get("/achievements/:id", requireAuth, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  const def = id != null ? await race.getAchievement(id) : null;
  if (!def) return res.status(404).type("text/plain").send("No such achievement.");
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const csrf = escHtml(req.session.csrf);
  const earners = await race.listAchievementAwards(def.id, 50);
  const earnerRows = earners
    .map(
      (e) => `<tr>
        <td><a href="/player/${e.player_id}" target="_blank" rel="noopener">${escHtml(e.simplified || e.name)}</a></td>
        <td class="meta">${e.period ? escHtml(e.period) : "—"}</td>
        <td class="meta">${e.value != null ? fmtNumAdmin(e.value) : ""}</td>
        <td class="meta">${fmtWhen(e.awarded_at)}</td>
        <td><form class="inline" method="post" action="/admin/achievements/${def.id}/revoke">
          <input type="hidden" name="_csrf" value="${csrf}">
          <input type="hidden" name="player_id" value="${e.player_id}">
          <input type="hidden" name="period" value="${escHtml(e.period)}">
          <button class="danger" type="submit">Revoke</button>
        </form></td>
      </tr>`
    )
    .join("");
  const statusCard = `<div class="card">
    <div class="flag-head"><span class="mapname">${escHtml(def.title)}</span>
      <span class="meta">${def.active ? "ACTIVE" : "inactive"} · ${escHtml(describeRule(def))}</span></div>
    <div class="actions">
      <a class="btn" href="/admin/achievements/${def.id}/preview">Preview who qualifies</a>
      <form class="inline" method="post" action="/admin/achievements/${def.id}/active">
        <input type="hidden" name="_csrf" value="${csrf}">
        <input type="hidden" name="on" value="${def.active ? "0" : "1"}">
        <button class="${def.active ? "warn" : "ok"}" type="submit">${def.active ? "Deactivate" : "Activate now"}</button>
      </form>
      ${earners.length === 0 ? `<form class="inline" method="post" action="/admin/achievements/${def.id}/delete">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button class="danger" type="submit">Delete</button>
      </form>` : ""}
    </div>
  </div>`;
  sendAdmin(res, `Achievement · ${def.title}`, `<div class="crumbs"><a href="/admin/achievements">← achievements</a></div>
    <h1>Edit achievement</h1>
    ${done}${err}${statusCard}
    ${achFormHtml(req.session, def, `/admin/achievements/${def.id}`)}
    <h2>Recent earners${earners.length ? ` (${earners.length})` : ""}</h2>
    ${earners.length
      ? `<table><thead><tr><th>Player</th><th>Period</th><th>Value</th><th>Awarded</th><th></th></tr></thead><tbody>${earnerRows}</tbody></table>`
      : `<div class="empty">Nobody has earned this yet.</div>`}`, req.session);
}));

admin.post("/achievements/:id", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null || !(await race.getAchievement(id)))
    return res.status(404).type("text/plain").send("No such achievement.");
  const v = validateDefinition(achInput(req.body));
  if (v.error) return res.redirect(303, `/admin/achievements/${id}?error=${encodeURIComponent(v.error)}`);
  const r = await race.updateAchievement(id, v.value, req.session.username);
  if (r === false)
    return res.redirect(303, `/admin/achievements/${id}?error=${encodeURIComponent("That slug is already taken.")}`);
  res.redirect(303, `/admin/achievements/${id}?done=Saved.`);
}));

admin.get("/achievements/:id/preview", requireAuth, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  const def = id != null ? await race.getAchievement(id) : null;
  if (!def) return res.status(404).type("text/plain").send("No such achievement.");
  const pv = await race.previewAchievement(id, { sample: 20 });
  const csrf = escHtml(req.session.csrf);
  const sampleRows = pv.sample
    .map(
      (s) => `<tr>
        <td><a href="/player/${s.id}" target="_blank" rel="noopener">${escHtml(s.simplified || s.name)}</a></td>
        <td class="meta">${s.value != null ? fmtNumAdmin(s.value) : ""}</td>
      </tr>`
    )
    .join("");
  sendAdmin(res, `Preview · ${def.title}`, `<div class="crumbs"><a href="/admin/achievements/${def.id}">← ${escHtml(def.title)}</a></div>
    <h1>Who qualifies right now?</h1>
    <p class="sub">${escHtml(describeRule(def))} · dry run — nothing has been awarded.</p>
    <div class="card">
      <div class="tags">
        <span class="tag"><b>${fmtNumAdmin(pv.newlyQualifying)}</b> would be newly awarded</span>
        <span class="tag"><b>${fmtNumAdmin(pv.alreadyHolding)}</b> already hold it</span>
      </div>
      ${def.active
        ? `<p class="sub">This achievement is already active — the evaluator awards qualifiers automatically.</p>`
        : `<div class="actions"><form class="inline" method="post" action="/admin/achievements/${def.id}/active">
            <input type="hidden" name="_csrf" value="${csrf}">
            <input type="hidden" name="on" value="1">
            <button class="ok" type="submit">Looks right — activate</button>
          </form></div>`}
    </div>
    ${pv.sample.length
      ? `<h2>Sample of the newly qualifying (${pv.sample.length} of ${fmtNumAdmin(pv.newlyQualifying)})</h2>
         <table><thead><tr><th>Player</th><th>Value</th></tr></thead><tbody>${sampleRows}</tbody></table>`
      : `<div class="empty">Nobody newly qualifies right now.</div>`}`, req.session);
}));

admin.post("/achievements/:id/active", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  const def = id != null ? await race.getAchievement(id) : null;
  if (!def) return res.status(404).type("text/plain").send("No such achievement.");
  const on = req.body.on === "1";
  await race.setAchievementActive(id, on, req.session.username);
  recordEvent(null, `achievement "${def.slug}" ${on ? "activated" : "deactivated"} by ${req.session.username}`, "system");
  if (on) {
    // Retroactive pass in the background: everyone already qualifying gets the
    // award now instead of at the next ingest/daily sweep.
    race
      .evaluateAchievements(null)
      .then((n) => {
        if (n) recordEvent(null, `achievements: ${n} award${n === 1 ? "" : "s"} on activation of "${def.slug}"`, "system");
      })
      .catch((e) => console.error("activation evaluation failed:", e?.message ?? e));
  }
  res.redirect(303, `/admin/achievements/${id}?done=${encodeURIComponent(on ? "Activated — retroactive awards are being applied." : "Deactivated. Existing awards are kept.")}`);
}));

admin.post("/achievements/:id/delete", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(404).type("text/plain").send("No such achievement.");
  const r = await race.deleteAchievement(id);
  if (!r)
    return res.redirect(303, `/admin/achievements/${id}?error=${encodeURIComponent("Not deleted — it has been earned. Deactivate (and hide) it instead.")}`);
  res.redirect(303, `/admin/achievements?done=Deleted.`);
}));

admin.post("/achievements/:id/revoke", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  const playerId = asInt(req.body.player_id);
  if (id == null || playerId == null) return res.status(400).type("text/plain").send("Bad revoke request.");
  const r = await race.revokeAward(id, playerId, typeof req.body.period === "string" ? req.body.period : "");
  recordEvent(null, `achievement award revoked (ach ${id}, player ${playerId}) by ${req.session.username}`, "system");
  res.redirect(303, `/admin/achievements/${id}?done=${encodeURIComponent(
    r
      ? "Award revoked. Note: if the player still qualifies on the underlying data, the evaluator will re-award it — fix the data (or deactivate the achievement) for a permanent removal."
      : "Nothing to revoke."
  )}`);
}));

// --- Tournaments ------------------------------------------------------------
// CRUD over the calendar. ONE tournament runs at a time: the window must not
// overlap any other non-cancelled tournament, with no override, because
// everything the players see — the game feed, "/tournament join", the in-game
// announcement — can only carry one. The schema enforces it too (migration
// 20260801140000000); the check here exists to say WHICH tournament clashes
// instead of showing a constraint error.
//
// The other rule the form adds is that pool maps must already exist in the
// database — a tournament on a map nobody has ever finished would score nothing
// and quietly look broken, so the admin gets a warning naming them.

function tournamentPhaseBadge(t) {
  const phase = phaseOf(t);
  const cls =
    phase === "live" ? "st-open" : phase === "finalized" ? "st-resolved" : phase === "cancelled" ? "st-dismissed" : "";
  return `<span class="${cls}">${escHtml(PHASE_LABEL[phase] || phase)}</span>`;
}

// The create/edit form. `t` null = new; `maps` is the pool as a newline list.
function tournamentFormHtml(session, t, maps, action, { defaultStart = null } = {}) {
  const v = (x) => escHtml(x == null ? "" : String(x));
  const start = t ? toAdminTime(t.starts_at) : toAdminTime(defaultStart);
  const end = t ? toAdminTime(t.ends_at) : toAdminTime((defaultStart || 0) + 7 * 86400);
  const scoringOpts = Object.entries(SCORINGS)
    .map(([k, label]) => `<option value="${v(k)}"${t && t.scoring === k ? " selected" : ""}>${escHtml(label)}</option>`)
    .join("");
  const statusOpts = TOURNAMENT_STATUSES.filter((s) => s !== "finalized")
    .map((s) => `<option value="${v(s)}"${t && t.status === s ? " selected" : ""}>${escHtml(s)}</option>`)
    .join("");
  return `<form class="card" method="post" action="${v(action)}">
    <input type="hidden" name="_csrf" value="${escHtml(session.csrf)}">
    <label>Name<input name="name" required maxlength="120" value="${v(t && t.name)}" placeholder="Summer Sprint"></label>
    <label>URL slug (blank = from the name)<input name="slug" maxlength="64" value="${v(t && t.slug)}" placeholder="summer-sprint"></label>
    <label>Description<textarea name="description" rows="4" maxlength="2000" placeholder="What this tournament is, any rules, prizes…">${v(t && t.description)}</textarea></label>
    <label>Starts — <b>UTC</b>, not your local time<input name="startsAt" type="datetime-local" step="1" required value="${v(start)}"></label>
    <label>Ends — <b>UTC</b>, not your local time<input name="endsAt" type="datetime-local" step="1" required value="${v(end)}"></label>
    <label>Scoring<select name="scoring">${scoringOpts}</select></label>
    <label>Status<select name="status">${statusOpts}</select>
      <span class="meta">draft = invisible on the site · published = live on the calendar</span></label>
    <label>Map pool — one map name per line (they must already exist on the site)
      <textarea name="maps" rows="8" required placeholder="hrace_line&#10;pornstar&#10;…">${v(maps)}</textarea></label>
    <label><input type="checkbox" name="joinOpen" style="width:auto" ${!t || t.join_open ? "checked" : ""}> Accepting entries</label>
    <label>Repeat every N days after it ends (0 = one-off)
      <input name="repeatEveryDays" type="number" min="0" max="365" value="${v(t ? t.repeat_every_days : 0)}"></label>
    <label>Gap before the next edition starts (days)
      <input name="repeatGapDays" type="number" min="0" max="365" value="${v(t ? t.repeat_gap_days : 1)}"></label>
    <p class="meta">One tournament runs at a time — this window has to be clear of every other
      tournament that isn't cancelled.</p>
    <div class="actions"><button class="primary" type="submit">Save</button></div>
  </form>`;
}

function tournamentInput(body) {
  return {
    name: String(body.name || ""),
    slug: String(body.slug || ""),
    description: String(body.description || ""),
    startsAt: String(body.startsAt || ""),
    endsAt: String(body.endsAt || ""),
    scoring: String(body.scoring || ""),
    status: String(body.status || ""),
    joinOpen: Boolean(body.joinOpen),
    maps: String(body.maps || ""),
    repeatEveryDays: body.repeatEveryDays,
    repeatGapDays: body.repeatGapDays,
  };
}

admin.get("/tournaments", requireAuth, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const { rows } = await race.tournaments({ includeDrafts: true, limit: 200 });
  const body = rows.length
    ? `<table><thead><tr><th>Tournament</th><th>Window (UTC)</th><th>Phase</th><th>Maps</th><th>Entrants</th><th>Scoring</th></tr></thead><tbody>${rows
        .map(
          (t) => `<tr>
            <td><a href="/admin/tournaments/${t.id}">${escHtml(t.name)}</a>
                ${t.repeat_every_days ? ` <span class="tag">repeats</span>` : ""}</td>
            <td class="meta">${fmtWhen(t.starts_at)} → ${fmtWhen(t.ends_at)}</td>
            <td>${tournamentPhaseBadge(t)}</td>
            <td class="meta">${fmtNumAdmin(t.maps || 0)}</td>
            <td class="meta">${fmtNumAdmin(t.entrants || 0)}</td>
            <td class="meta">${escHtml(t.scoring)}</td>
          </tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="empty">No tournaments yet.</div>`;
  sendAdmin(res, "Tournaments", `<div class="crumbs"><a href="/admin/flags">← queue</a></div>
    <h1>Tournaments</h1>
    <p class="sub">Time-boxed competitions on a fixed map pool · players join for a code and redeem it in-game with
      <code>/tournament &lt;code&gt;</code> · public calendar at
      <a href="/tournaments" target="_blank" rel="noopener">/tournaments ↗</a>.</p>
    ${done}${err}
    <div class="actions" style="margin-bottom:14px"><a class="btn" href="/admin/tournaments/new">+ New tournament</a></div>
    ${body}`, req.session);
}));

admin.get("/tournaments/new", requireAuth, wrap(async (req, res) => {
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  // Default the start to the moment the calendar is next free, so the obvious
  // action produces a non-overlapping tournament without any thought.
  const free = await race.nextFreeTournamentSlot();
  sendAdmin(res, "New tournament", `<div class="crumbs"><a href="/admin/tournaments">← tournaments</a></div>
    <h1>New tournament</h1>
    <p class="sub">Starts pre-filled at the next free slot (${fmtWhen(free)}), so the default never overlaps.</p>
    ${err}${tournamentFormHtml(req.session, null, "", "/admin/tournaments/new", { defaultStart: free })}`, req.session);
}));

// Shared overlap gate for create + edit + un-cancel. Returns an error string,
// or null. Not an override in sight: one tournament at a time is a rule, and
// the database holds it whatever this says.
async function tournamentOverlapError(startsAt, endsAt, excludeId) {
  const clash = await race.overlappingTournaments(startsAt, endsAt, excludeId);
  if (!clash.length) return null;
  const names = clash.slice(0, 3).map((c) => `${c.name} (${fmtWhen(c.starts_at)} → ${fmtWhen(c.ends_at)})`).join("; ");
  return `Only one tournament runs at a time, and that window overlaps: ${names}. Move it, or cancel the other one.`;
}

// What create/edit/status say when the database itself refused the window —
// two admins saving at once, which the check above cannot see.
const TOURNAMENT_OVERLAP_RACE =
  "That window was taken while you were saving — only one tournament runs at a time. Reload and pick another slot.";

admin.post("/tournaments/new", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const v = validateTournament(tournamentInput(req.body));
  if (v.error) return res.redirect(303, `/admin/tournaments/new?error=${encodeURIComponent(v.error)}`);
  const clash = await tournamentOverlapError(v.value.starts_at, v.value.ends_at, null);
  if (clash) return res.redirect(303, `/admin/tournaments/new?error=${encodeURIComponent(clash)}`);
  const created = await race.createTournament(v.value, req.session.username);
  if (created && created.conflict)
    return res.redirect(303, `/admin/tournaments/new?error=${encodeURIComponent(TOURNAMENT_OVERLAP_RACE)}`);
  if (!created) return res.redirect(303, `/admin/tournaments/new?error=${encodeURIComponent("That slug is already taken.")}`);
  const note = created.unraced.length
    ? `Created. Heads up — nobody has ever finished these pool maps, so check for a typo: ${created.unraced.join(", ")}`
    : "Created.";
  recordEvent(null, `tournament created: ${v.value.slug} by ${req.session.username}`, "system");
  res.redirect(303, `/admin/tournaments/${created.id}?done=${encodeURIComponent(note)}`);
}));

admin.get("/tournaments/:id", requireAuth, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  const t = id != null ? await race.tournamentById(id) : null;
  if (!t) return res.status(404).type("text/plain").send("No such tournament.");
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const csrf = escHtml(req.session.csrf);
  const maps = await race.tournamentMaps(t.id);
  const entrants = await race.tournamentEntrants(t.id, { limit: 200 });
  const standings = await race.tournamentStandings(t, { limit: 50 });

  const standingRows = standings
    .map(
      (s) => `<tr><td>${s.place}</td>
        <td><a href="/player/${s.id}" target="_blank" rel="noopener">${escHtml(s.simplified || s.name)}</a></td>
        <td class="meta">${fmtNumAdmin(s.points)}</td>
        <td class="meta">${fmtNumAdmin(s.mapsPlayed)}</td>
        <td class="meta">${fmtNumAdmin(s.mapWins)}</td></tr>`
    )
    .join("");

  const finalizable = t.status === "published" && t.ends_at <= Math.floor(Date.now() / 1000);
  const controls = `<div class="actions">
    ${t.status === "draft"
      ? `<form class="inline" method="post" action="/admin/tournaments/${t.id}/status">
           <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="status" value="published">
           <button class="ok" type="submit">Publish</button></form>`
      : ""}
    ${t.status === "published"
      ? `<form class="inline" method="post" action="/admin/tournaments/${t.id}/status">
           <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="status" value="cancelled">
           <button class="warn" type="submit">Cancel</button></form>`
      : ""}
    ${finalizable
      ? `<form class="inline" method="post" action="/admin/tournaments/${t.id}/finalize">
           <input type="hidden" name="_csrf" value="${csrf}">
           <button class="primary" type="submit">Finalize now</button></form>`
      : ""}
    ${entrants.length === 0
      ? `<form class="inline" method="post" action="/admin/tournaments/${t.id}/delete">
           <input type="hidden" name="_csrf" value="${csrf}">
           <button class="danger" type="submit">Delete</button></form>`
      : ""}
  </div>`;

  sendAdmin(res, `Tournament · ${t.name}`, `<div class="crumbs"><a href="/admin/tournaments">← tournaments</a></div>
    <h1>${escHtml(t.name)}</h1>
    <p class="sub">${tournamentPhaseBadge(t)} · ${fmtWhen(t.starts_at)} → ${fmtWhen(t.ends_at)} ·
      ${maps.length} map${maps.length === 1 ? "" : "s"} · ${entrants.length} entrant${entrants.length === 1 ? "" : "s"} ·
      <a href="/tournaments/${escHtml(t.slug)}" target="_blank" rel="noopener">public page ↗</a>
      ${t.finalized_at ? ` · finalized ${fmtWhen(t.finalized_at)}` : ""}</p>
    ${done}${err}
    ${controls}
    ${t.status === "finalized"
      ? `<div class="msg ok">This tournament is final — its standings and trophies are frozen and can no longer be edited.</div>`
      : tournamentFormHtml(req.session, t, maps.map((m) => m.rawName).join("\n"), `/admin/tournaments/${t.id}`)}
    <h2>Standings ${t.status === "finalized" ? "(final)" : "(live)"}</h2>
    ${standings.length
      ? `<table><thead><tr><th>#</th><th>Player</th><th>Points</th><th>Maps</th><th>Wins</th></tr></thead><tbody>${standingRows}</tbody></table>`
      : `<div class="empty">Nobody has scored yet.</div>`}
    <h2>Entrants</h2>
    ${entrants.length
      ? `<table><thead><tr><th>Player</th><th>Registered</th></tr></thead><tbody>${entrants
          .map(
            (e) => `<tr><td><a href="/player/${e.id}" target="_blank" rel="noopener">${escHtml(e.simplified || e.name)}</a></td>
              <td class="meta">${fmtWhen(e.registered_at)}</td></tr>`
          )
          .join("")}</tbody></table>`
      : `<div class="empty">Nobody has redeemed a code yet.</div>`}`, req.session);
}));

admin.post("/tournaments/:id", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("Bad tournament id.");
  const v = validateTournament(tournamentInput(req.body));
  if (v.error) return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent(v.error)}`);
  const clash = await tournamentOverlapError(v.value.starts_at, v.value.ends_at, id);
  if (clash) return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent(clash)}`);
  const r = await race.updateTournament(id, v.value, req.session.username);
  if (r && r.conflict)
    return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent(TOURNAMENT_OVERLAP_RACE)}`);
  if (r === null) return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent("That slug is already taken.")}`);
  if (!r.rows)
    return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent("Not saved — a finalized tournament can't be edited.")}`);
  const note = r.unraced.length
    ? `Saved. Heads up — nobody has ever finished these pool maps, so check for a typo: ${r.unraced.join(", ")}`
    : "Saved.";
  res.redirect(303, `/admin/tournaments/${id}?done=${encodeURIComponent(note)}`);
}));

admin.post("/tournaments/:id/status", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  const status = String(req.body.status || "");
  if (id == null || !["draft", "published", "cancelled"].includes(status))
    return res.status(400).type("text/plain").send("Bad status change.");
  // Bringing a cancelled tournament back re-takes a slot somebody else may
  // have moved into meanwhile — the one status change that can clash.
  const before = await race.tournamentById(id);
  if (before && before.status === "cancelled" && status !== "cancelled") {
    const clash = await tournamentOverlapError(before.starts_at, before.ends_at, id);
    if (clash) return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent(clash)}`);
  }
  const n = await race.setTournamentStatus(id, status, req.session.username);
  if (n && n.conflict)
    return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent(TOURNAMENT_OVERLAP_RACE)}`);
  // Only log the change that actually applied — the UPDATE is a no-op on a
  // finalized tournament, and an audit log that records changes which never
  // happened is worse than no audit log.
  if (n) recordEvent(null, `tournament ${id} -> ${status} by ${req.session.username}`, "system");
  res.redirect(303, `/admin/tournaments/${id}?done=${encodeURIComponent(n ? `Now ${status}.` : "A finalized tournament can't change status.")}`);
}));

// Finalize early/by hand. The db call re-checks that the window has closed, so
// this can never freeze a tournament that is still running.
admin.post("/tournaments/:id/finalize", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("Bad tournament id.");
  const r = await race.finalizeTournament(id);
  if (!r.finalized)
    return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent("Not finalized — it is still running, or already final.")}`);
  recordEvent(null, `tournament ${id} finalized by ${req.session.username}: ${r.trophies} trophies`, "system");
  // A recurring series' next edition is scheduled by the sweep's reconciliation
  // pass (db.finalizeDueTournaments), not here — doing it inline would be a
  // second, unprotected step that a crash could skip forever.
  const repeats = r.tournament && r.tournament.repeat_every_days > 0;
  res.redirect(303, `/admin/tournaments/${id}?done=${encodeURIComponent(
    `Final. ${r.standings} placed, ${r.trophies} trophies awarded.` +
      (repeats ? " The next edition is scheduled automatically within a few minutes." : "")
  )}`);
}));

admin.post("/tournaments/:id/delete", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("Bad tournament id.");
  const n = await race.deleteTournament(id);
  if (!n)
    return res.redirect(303, `/admin/tournaments/${id}?error=${encodeURIComponent("Not deleted — players have entered. Cancel it instead, so their entries and any trophies survive.")}`);
  recordEvent(null, `tournament ${id} deleted by ${req.session.username}`, "system");
  res.redirect(303, "/admin/tournaments?done=Deleted.");
}));

// --- Account (self-service password change) ---
admin.get("/account", requireAuth, (req, res) => {
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

admin.post("/account/password", requireAuth, wrap(async (req, res) => {
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

admin.get("/servers", requireAuth, wrap(async (req, res) => {
  const done = req.query.done ? `<div class="msg ok">${escHtml(String(req.query.done))}</div>` : "";
  const err = req.query.error ? `<div class="msg err">${escHtml(String(req.query.error))}</div>` : "";
  const servers = await race.serversAdmin();
  const snap = live.getLive();
  const csrf = escHtml(req.session.csrf);
  // Moderators get a restart-only view: no maintenance/broadcast/RCON/logs.
  const isAdmin = isAdminSession(req.session);
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
          <td>${
            isAdmin
              ? `${s.rcon ? `<a class="btn" href="/admin/servers/${s.id}/rcon">Console</a> <a class="btn danger" href="/admin/servers/${s.id}/restart">Restart</a> ` : ""}<a class="btn" href="/admin/logs?server=${s.id}">Logs</a>`
              : (s.rcon ? `<a class="btn danger" href="/admin/servers/${s.id}/restart">Restart</a>` : `<span class="meta">—</span>`)
          }</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="empty">No servers enrolled.</td></tr>`;
  sendAdmin(res, "Servers", `
    <h1>Servers &amp; operations</h1>
    <p class="sub"><a href="/admin/flags">← flag queue</a>${isAdmin ? ` · <a href="/admin/logs">logs</a> ·
      RCON is enabled per server with <span style="font-family:monospace">node admin.js rcon &lt;id&gt; &lt;password&gt;</span>` : ` · restart-only moderator view (a server needs RCON enabled to be restartable)`}</p>
    ${done}${err}
    ${isAdmin ? `<h2>Maintenance mode</h2>${maintBox}
    <h2>Broadcast</h2>${bcast}` : ""}
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

// Restart a single game server. There is no engine "restart" command — instead
// we send RCON `quit`, which exits the engine cleanly; the container's
// supervisor loop (server/entrypoint.sh) relaunches it ~5s later, re-exec'ing
// env.cfg so a fresh map rotation / blocked-map list / MOTD takes effect. GET
// renders a confirmation interstitial: the page CSP forbids inline JS, so a
// mis-click guard has to be a real page, not a confirm() dialog.
admin.get("/servers/:id/restart", requireAuth, wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad server id");
  const s = await race.serverById(id);
  if (!s) return res.status(404).type("text/plain").send("server not found");
  const csrf = escHtml(req.session.csrf);
  const ready = !!(s.rcon_password && s.address);
  const warn = !ready
    ? `<div class="msg err">No RCON ${s.rcon_password ? "address" : "password"} set, so this server can't be restarted remotely.</div>`
    : "";
  const li = (live.getLive().servers || []).find((x) => x.id === s.id) || null;
  const playing = li && li.online && Array.isArray(li.players) ? li.players.length : 0;
  const impact = playing
    ? `<b>${playing}</b> player${playing === 1 ? " is" : "s are"} connected right now and will be dropped.`
    : "No players are connected right now.";
  sendAdmin(res, `Restart · ${s.name}`, `
    <div class="crumbs"><a href="/admin/servers">← servers</a></div>
    <h1>Restart ${escHtml(s.name)}?</h1>
    <p class="sub">${s.address ? escHtml(s.address) : "no address"}</p>
    ${warn}
    <div class="card">
      <p>This sends <span style="font-family:monospace">quit</span> over RCON. The engine exits and the
         server's supervisor relaunches it in about 5&nbsp;seconds, reloading the current config
         (map rotation, blocked maps, MOTD). ${impact}</p>
      <form class="inline" method="post" action="/admin/servers/${s.id}/restart">
        <input type="hidden" name="_csrf" value="${csrf}">
        <button class="danger" type="submit"${ready ? "" : " disabled"}>Restart now</button>
        <a class="btn" href="/admin/servers" style="margin-left:8px">Cancel</a>
      </form>
    </div>`, req.session);
}));

admin.post("/servers/:id/restart", requireAuth, wrap(async (req, res) => {
  if (!checkCsrf(req, res)) return;
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).type("text/plain").send("bad server id");
  const s = await race.serverById(id);
  if (!s) return res.status(404).type("text/plain").send("server not found");
  if (!s.rcon_password || !s.address) {
    recordEvent(s.id, `restart by ${req.session.username} BLOCKED (no RCON configured)`, "rcon", "warn");
    return res.redirect(303, "/admin/servers?error=" + encodeURIComponent(`${s.name}: no RCON configured — can't restart.`));
  }
  const parsed = parseAddress(s.address);
  const result = parsed
    ? await sendRcon(parsed.host, parsed.port, s.rcon_password, "quit")
    : { ok: false, error: "bad address", replied: false, reply: "" };
  recordEvent(
    s.id,
    `restart by ${req.session.username} → ${result.ok ? "quit sent (relaunch ~5s)" : "FAIL (" + (result.error || (result.authFailed ? "auth" : "no reply")) + ")"}`,
    "rcon",
    result.ok ? null : "warn"
  );
  // `quit` is fire-and-forget: the engine exits without echoing, so a silent
  // server is ok=true whether it was up or already down (only a socket error or
  // an auth refusal fails). Condition the copy on the live snapshot the servers
  // page already shows rather than promising a restart we can't confirm.
  const wasOnline = !!((live.getLive().servers || []).find((x) => x.id === s.id)?.online);
  const summary = result.ok
    ? wasOnline
      ? `Restarting ${s.name} — it should be back in a few seconds.`
      : `Sent restart to ${s.name}. It wasn't showing as online, but if it was up it'll relaunch within a few seconds.`
    : `Couldn't restart ${s.name}: ${result.error || (result.authFailed ? "bad rcon password" : "no reply")}.`;
  res.redirect(303, `/admin/servers?${result.ok ? "done" : "error"}=` + encodeURIComponent(summary));
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
  // Body-parser/client faults carry a 4xx status; anything else is a server
  // fault — log it and say so instead of masking it as the client's fault.
  const clientFault = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  if (!clientFault) {
    Sentry.captureException(err); // no-op when Sentry is unconfigured
    console.error("admin route error:", err);
  }
  if (clientFault) return res.status(400).type("text/plain").send("bad request");
  res.status(500).type("text/plain").send("server error");
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
    map: race._cnMapByName(s.map), // display-only; name-keyed override (sync builder, no id)
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
  let li = (live.getLive().servers || []).find((x) => x.id === id) || null;
  // Censor the displayed current-map for the OG card + description (the raw name
  // is only needed to resolve the map id, which we do first for override support).
  if (li && li.map) {
    const mapId = await race.mapIdByName(li.map);
    li = { ...li, map: race._cnMap(li.map, mapId), mapId };
  }
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

// Shareable /tournaments/:slug page: SPA shell with tournament-specific OG tags,
// so a link dropped in a Discord announcement previews as the tournament rather
// than as the generic site card. No custom og:image — the calendar has nothing
// worth rendering to a PNG that the text summary doesn't already say.
app.get("/tournaments/:slug", renderLimiter, wrap(async (req, res, next) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return next(); // -> plain SPA shell
  const t = await race.tournamentBySlug(slug);
  if (!t) return next();
  const origin = siteOrigin(req);
  const phase = phaseOf(t);
  const when =
    phase === "live"
      ? `Running now until ${new Date(t.ends_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : phase === "upcoming"
      ? `Starts ${new Date(t.starts_at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`
      : `${new Date(t.starts_at * 1000).toISOString().slice(0, 10)} — ${new Date(t.ends_at * 1000).toISOString().slice(0, 10)}`;
  const desc = `${when} · ${t.maps == null ? "" : `${t.maps} maps · `}${simplifyName(t.description).slice(0, 140) || "Race the pool, climb the board."}`;
  const image = `${origin}/assets/img/warsow-logo.png`;
  sendShell(
    res,
    withOgTags([
      ["og:site_name", "Racesow"],
      ["og:type", "website"],
      ["og:title", `${simplifyName(t.name)} — Racesow tournament`],
      ["og:description", desc],
      ["og:url", `${origin}/tournaments/${t.slug}`],
      ["og:image", image],
      ["twitter:card", "summary"],
      ["twitter:title", `${simplifyName(t.name)} — Racesow tournament`],
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
    // No trailing-slash directory redirects: public/maps/ (the replay meshes)
    // shares a name with the client-side /maps route, and serve-static's
    // default 301 to /maps/ breaks that page — browsers cache 301s
    // PERMANENTLY, so one hit stuck every future visit on the dead-end
    // /maps/ URL until a hard refresh. A directory path now just falls
    // through to the SPA fallback below.
    redirect: false,
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
// External padpork.org link for a map, by id. The site links here (never by
// name) so a censored/offensive map name never reaches the client: we resolve
// the REAL name server-side and 302 to its padpork page. Reversed variants have
// no padpork entry, so strip the "-reversed" suffix and link to the base map.
app.get("/map/:id/padpork", wrap(async (req, res) => {
  const id = asInt(req.params.id);
  const name = id == null ? null : await race.mapNameById(id);
  const base = name ? String(name).replace(/-reversed$/, "") : "";
  res.redirect(302, base ? "https://padpork.org/maps/" + encodeURIComponent(base) : "https://padpork.org/maps");
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return next();
  sendShell(res, defaultShell(req));
});

// Global Sentry catch-all for any route error NOT already consumed by the
// path-scoped /api and /admin error handlers above (those capture explicitly
// then respond, so their errors never reach here — no double-reporting).
// Registered last so Express treats it as error-handling middleware. Only
// reports 5xx / no-status faults; 4xx client errors carry a status and are
// skipped. Installed only when Sentry is configured (see instrument.mjs).
if (Sentry.getClient()) {
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError(error) {
      const status = error?.status ?? error?.statusCode ?? 500;
      return status >= 500;
    },
  });
}

const server = app.listen(PORT, async () => {
  console.log(`Race stats server listening on http://0.0.0.0:${PORT}`);
  // The status lines are informational — a DB blip here must not become an
  // unhandled rejection that kills a freshly-booted replica.
  try {
    const servers = await race.servers();
    const modes = [];
    if (INGEST_TOKEN_HASH) modes.push("shared-token");
    modes.push(`${servers.length} enrolled server(s)`);
    console.log(`Ingest: ${modes.join(" + ")}`);
    const liveTargets = servers.filter((s) => s.address).length;
    console.log(`Live poller: ${liveTargets} server(s) with a query address`);
  } catch (e) {
    console.error("boot status check failed (continuing):", e?.message ?? e);
  }
  if (!shuttingDown) live.start(); // a signal may land during the await above
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
  clearInterval(tournamentSweepTimer);
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
  // Deliver any buffered Sentry events before exit (no-op when unconfigured).
  await Sentry.flush(2000).catch(() => {});
  await race.close().catch(() => {});
  process.exit(0);
}
onSignal = shutdown;
