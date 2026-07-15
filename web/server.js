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
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "db.sqlite");

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
const MAX_CHECKPOINTS = 4096;
const MAX_TIME_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS_PER_REQUEST = 1000;

console.log(`Opening database at ${DB_PATH} ...`);
const race = openDatabase(DB_PATH);

// Live "who's playing" poller: UDP getstatus against each enrolled server
// that has a query address (admin.js address). /api/live serves the cache.
const live = createLivePoller(race);

const app = express();
app.disable("x-powered-by");

app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const api = express.Router();

function asInt(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

api.get("/overview", (_req, res) => res.json(race.overview()));
api.get("/servers", (_req, res) => res.json({ servers: race.servers() }));

api.get("/maps", (req, res) => res.json(race.maps(req.query)));

api.get("/maps/:id", (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid map id" });
  const detail = race.mapDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "map not found" });
  res.json(detail);
});

api.get("/players", (req, res) => res.json(race.players(req.query)));

api.get("/players/:id", (req, res) => {
  const id = asInt(req.params.id);
  if (id == null) return res.status(400).json({ error: "invalid player id" });
  const detail = race.playerDetail(id, req.query);
  if (!detail) return res.status(404).json({ error: "player not found" });
  res.json(detail);
});

api.get("/search", (req, res) => res.json(race.search(req.query.q || "", { limit: 8 })));

api.get("/live", (_req, res) => {
  const snap = live.getLive();
  res.json({
    ...snap,
    servers: snap.servers.map((s) => ({ ...s, mapId: s.map ? race.mapIdByName(s.map) : null })),
  });
});

// Live topscores for game servers: the hrace gametype's RS_ApiFetchTop
// native GETs this on map load and on a refresh interval, and swaps the
// response into the map's local topscores file — the payload is byte-format
// identical to that file, so the gametype's normal loader consumes it and
// every server connected to this API serves the same in-game `top` lists,
// HUD record lines and record announcements. Public read — it exposes
// nothing the map leaderboard pages don't already show.
api.get("/game/topscores", (req, res) => {
  const body = race.gameTopscoresText(req.query.map);
  if (body == null) return res.status(404).type("text/plain").send("// unknown map\n");
  res.type("text/plain").send(body);
});

api.get("/health", (_req, res) => res.json({ ok: true }));

// --- Aggregate refresh (debounced, with a max-wait so a continuous ingest
// stream from many servers can't starve the rebuild indefinitely). ----------
let refreshTimer = null;
let firstDirtyAt = 0;
function doRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  firstDirtyAt = 0;
  try {
    const t0 = Date.now();
    race.refreshAggregates();
    console.log(`aggregates refreshed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error("aggregate refresh failed (will retry on next ingest):", e.message);
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
function authenticateIngest(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7);
  if (!token) return null;

  // Per-server token (preferred).
  const srv = race.serverByTokenHash(sha256(token));
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

function sanitizeRecord(r) {
  if (!r || typeof r.name !== "string" || r.name.length === 0) return null;
  const time = Number(r.time);
  if (!Number.isInteger(time) || time <= 0 || time > MAX_TIME_MS) return null;
  const cpsIn = Array.isArray(r.checkpoints) ? r.checkpoints.slice(0, MAX_CHECKPOINTS) : [];
  return {
    name: r.name.slice(0, MAX_NAME_LEN),
    login: typeof r.login === "string" ? r.login.slice(0, MAX_NAME_LEN) : "",
    time,
    checkpoints: cpsIn.map((t) => {
      const n = Number(t);
      return Number.isInteger(n) && n > 0 ? n : 0;
    }),
  };
}

// Auth BEFORE body parsing so unauthenticated clients can't make us JSON.parse
// up to the body limit. Ingest identity is attached to req for the handler.
api.post(
  "/ingest",
  (req, res, next) => {
    const ident = authenticateIngest(req);
    if (!ident && !INGEST_TOKEN_HASH && !race.caps.server) {
      return res.status(503).json({ error: "ingest disabled (no tokens configured)" });
    }
    if (!ident) return res.status(401).json({ error: "unauthorized" });
    if (ident.revoked) return res.status(403).json({ error: "server revoked" });
    req.ingest = ident;
    next();
  },
  express.json({ limit: "2mb" }),
  (req, res) => {
    const { version, map, records } = req.body || {};
    const source = req.body && req.body.source === "racelog" ? "racelog" : "topscores";
    if (typeof version !== "string" || !version || typeof map !== "string" || !map) {
      return res.status(400).json({ error: "version and map are required" });
    }
    if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS_PER_REQUEST) {
      return res.status(400).json({ error: `records must be a non-empty array (max ${MAX_RECORDS_PER_REQUEST})` });
    }
    const clean = records.map(sanitizeRecord).filter(Boolean);
    if (!clean.length) return res.status(400).json({ error: "no valid records" });

    try {
      const counts = race.ingest({
        version,
        map: map.toLowerCase(),
        records: clean,
        source,
        serverId: req.ingest.serverId,
      });
      if (req.ingest.serverId != null) race.touchServer(req.ingest.serverId, counts.inserted + counts.improved);
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

app.get("/player/:id", (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  const d = Number.isNaN(id) ? null : race.playerDetail(id, { limit: 1 });
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
});

// The stats card behind og:image — rendered per player, cached a few minutes.
app.get("/og/player/:id.png", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = Number.isNaN(id) ? null : race.playerDetail(id, { limit: 1 });
  if (!d) return res.status(404).end();
  try {
    const png = playerCardCached(d.id, () => ({
      name: d.name,
      rank: d.standing.rank,
      points: d.standing.points,
      wr: d.standing.wr,
      maps: d.standing.maps,
      finishes: d.finishes,
      host: req.headers["x-forwarded-host"] || req.headers.host || "",
    }));
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(png);
  } catch (e) {
    console.error("og card render failed:", e.message);
    res.status(500).end();
  }
});

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

app.listen(PORT, () => {
  console.log(`Race stats server listening on http://0.0.0.0:${PORT}`);
  const modes = [];
  if (INGEST_TOKEN_HASH) modes.push("shared-token");
  if (race.caps.server) modes.push(`${race.servers().length} enrolled server(s)`);
  console.log(`Ingest: ${modes.length ? modes.join(" + ") : "DISABLED"}`);
  live.start();
  const liveTargets = race.servers().filter((s) => s.address).length;
  console.log(`Live poller: ${liveTargets} server(s) with a query address`);
});
