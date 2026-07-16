// Race stats web server: hosts the race SQLite database behind a small REST API
// and serves the static frontend that consumes it.
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase, sha256, simplifyName } from "./db.js";
import { createLivePoller } from "./live.js";
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
  res.json({ ...snap, servers });
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
api.get("/game/ghost", cache(120), wrap(async (req, res) => {
  const body = await race.gameGhostText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// no ghost\n");
  res.type("text/plain").send(body);
}));

api.get("/health", (_req, res) => res.json({ ok: true }));

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
        console.log(`wr_demo ${body.map} from ${req.ingest.serverName}: ${d.demo}`);
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
        console.log(
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
      console.log(
        `ghost ${body.map} from ${req.ingest.serverName}: ${g.frames.length} frames${stored ? "" : " (kept faster)"}`
      );
      res.json({ ok: true, stored });
    } catch (e) {
      console.error("ghost ingest failed:", e);
      res.status(500).json({ error: "ingest failed" });
    }
  })
);

app.use("/api", api);

// JSON body-parse errors (and any other error surfaced by middleware) return
// JSON, not Express's default HTML page — keeps the API contract consistent.
app.use("/api", (err, _req, res, _next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "payload too large" });
  if (err) return res.status(400).json({ error: "bad request" });
  res.status(500).json({ error: "internal error" });
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
