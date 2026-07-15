// Race stats web server: hosts the race SQLite database behind a small REST API
// and serves the static frontend that consumes it.
import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDatabase, sha256, simplifyName } from "./db.js";
import { createLivePoller } from "./live.js";
import { playerCardCached } from "./og-image.js";

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

api.get("/overview", wrap(async (_req, res) => res.json(await race.overview())));
api.get("/servers", wrap(async (_req, res) => res.json({ servers: await race.servers() })));

api.get("/maps", wrap(async (req, res) => res.json(await race.maps(req.query))));

api.get("/maps/:id", wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = await race.mapDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "map not found" });
  res.json(detail);
}));

api.get("/players", wrap(async (req, res) => res.json(await race.players(req.query))));

api.get("/players/:id", wrap(async (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const detail = await race.playerDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "player not found" });
  res.json(detail);
}));

api.get("/search", wrap(async (req, res) => res.json(await race.search(req.query.q || "", { limit: 8 }))));

// New records after a race id — the Discord announcer polls this (it has no
// database access; margin-to-#2 and version names are computed here). Public
// read: nothing the site's recent-records feed doesn't already show.
api.get("/records", wrap(async (req, res) => {
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
api.get("/game/topscores", wrap(async (req, res) => {
  const body = await race.gameTopscoresText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
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
    const source = body.source === "racelog" ? "racelog" : "topscores";
    if (typeof body.version !== "string" || !body.version || typeof body.map !== "string" || !body.map) {
      return res.status(400).json({ error: "version and map are required" });
    }
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
const INDEX_HTML = readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
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
  res.send(
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
    const png = playerCardCached(d.id, () => ({
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

app.get("/", (req, res) => res.send(defaultShell(req)));

// Static frontend.
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// SPA fallback for client-side routes (non-API, non-asset).
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.includes(".")) return next();
  res.send(defaultShell(req));
});

app.listen(PORT, async () => {
  console.log(`Race stats server listening on http://0.0.0.0:${PORT}`);
  const servers = await race.servers();
  const modes = [];
  if (INGEST_TOKEN_HASH) modes.push("shared-token");
  modes.push(`${servers.length} enrolled server(s)`);
  console.log(`Ingest: ${modes.join(" + ")}`);
  live.start();
  const liveTargets = servers.filter((s) => s.address).length;
  console.log(`Live poller: ${liveTargets} server(s) with a query address`);
});
