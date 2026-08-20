/* Racesow stats — vanilla-JS single-page app over the /api backend. */
"use strict";

// Content hash of replay.js, appended to THIS script's src as ?rv= by the shell
// (server.js). replay.js is dynamically imported from a constant URL, so we use
// this to cache-bust the import when replay.js changes. document.currentScript
// is only valid during this synchronous top-level execution — capture it now.
const REPLAY_V = (() => {
  try {
    const src = document.currentScript && document.currentScript.src;
    return new URLSearchParams((src && src.split("?")[1]) || "").get("rv") || "";
  } catch (e) {
    return "";
  }
})();

const app = document.getElementById("app");

/* ---------------------- analytics (Tastatur) ----------------------------- */
// Privacy-friendly usage analytics. The loader (t.js, in index.html) auto-
// tracks pageviews by patching history.pushState — go() drives every in-app
// navigation through it, so path routes (/maps, /map/5, /player/5, /replay/…)
// are all counted with no extra calls here. track() sends NAMED events for the
// discrete actions a URL alone can't describe: searching, watching a replay,
// downloading a demo, copying a connect string, following an outbound link.
//
// This queue-stub matches the one t.js drains on load (it runs first — a
// parser-inserted <script> at the end of <body> executes before the deferred
// loader), so events fired early aren't lost, and track() stays a silent no-op
// when the script is blocked (adblock / offline / localhost dev).
window.tastatur = window.tastatur || function () {
  (window.tastatur.q = window.tastatur.q || []).push(arguments);
};
function track(name, props) {
  try {
    window.tastatur("event", name, props ? { props } : undefined);
  } catch (e) { /* analytics must never break the app */ }
}

/* ----------------------------- helpers ----------------------------------- */
async function api(path) {
  const res = await fetch("/api" + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch("/api" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  // Prefer the API's own {error: "..."} message over "409 Conflict": these are
  // shown verbatim to players ("this tournament is not taking entries"), and an
  // HTTP status name explains nothing.
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const b = await res.json();
      if (b && typeof b.error === "string" && b.error) msg = b.error;
    } catch (err) { /* not JSON — keep the status line */ }
    throw new Error(msg);
  }
  return res.json();
}

// Map-flag reasons (value -> label). Mirrors FLAG_REASONS in web/db.js; the
// server re-validates, so a stale client can never persist an unknown reason.
const FLAG_REASONS_UI = [
  ["broken", "Broken — unplayable, missing, or crashes"],
  ["offensive", "Offensive content"],
  ["wrong_name", "Wrong name or metadata"],
  ["duplicate", "Duplicate of another map"],
  ["other", "Something else"],
];

// The home page fetches /overview twice on load — once for the stat tiles
// (viewOverview) and once for the footer "Updated" date (DOMContentLoaded).
// Share a single in-flight request (and its result for a short window) so a
// cold load drives the origin's ~11 count queries once instead of twice. A
// rejected fetch is not memoized, so the next call retries.
let _overview = null;
let _overviewAt = 0;
function overview() {
  if (_overview && Date.now() - _overviewAt < 15000) return _overview;
  _overviewAt = Date.now();
  _overview = api("/overview").catch((e) => {
    _overview = null;
    throw e;
  });
  return _overview;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtNum(n) {
  return (n || 0).toLocaleString("en-US");
}

/* A Skill Rating cell. Unranked players (too few finished maps — the server
 * decides, and sends srRanked) show a dash: their stored rating is mostly the
 * fill prior, so printing it would read as a real rating. Rows from older
 * payloads have no srRanked and keep rendering the number. */
function srCell(p) {
  return p && p.srRanked === false
    ? `<span class="sr-unranked" title="Unrated — not enough finished maps yet">—</span>`
    : fmtNum(p ? p.sr : 0);
}

/* game units -> compact distance, e.g. 12500 -> "12.5k u", 3200000 -> "3.2M u" */
function fmtDist(u) {
  if (u == null) return "—";
  const n = Number(u);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B u";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M u";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k u";
  return fmtNum(n) + " u";
}

/* bytes -> human size, e.g. 5242880 -> "5.0 MB" */
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

/* milliseconds -> race clock, e.g. 10238 -> "10.238", 92560 -> "1:32.560" */
function fmtTime(ms) {
  if (ms == null) return "—";
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = String(ms % 1000).padStart(3, "0");
  const out = m > 0 ? `${m}:${String(s).padStart(2, "0")}.${mss}` : `${s}.${mss}`;
  return (neg ? "-" : "") + out;
}

/* Render a Warsow ^0-^9 coloured name into safe HTML. */
function wname(raw) {
  if (raw == null) return "";
  const str = String(raw);
  let html = "";
  let color = "7";
  let buf = "";
  const flush = () => {
    if (buf) html += `<span class="wc${color}">${esc(buf)}</span>`;
    buf = "";
  };
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "^" && i + 1 < str.length && /[0-9]/.test(str[i + 1])) {
      flush();
      color = str[i + 1];
      i++;
    } else {
      buf += str[i];
    }
  }
  flush();
  return `<span class="wname">${html}</span>`;
}

function rankClass(r) {
  return r === 1 ? "rank-1" : r === 2 ? "rank-2" : r === 3 ? "rank-3" : "";
}

/* Reverse-mode maps are recorded under a "<map>-reversed" name (a separate
   leaderboard from the normal run of the same BSP — see the About page). These
   helpers strip/label that suffix for display; the raw name stays intact for
   search, routing and API calls. */
const REVERSE_SUFFIX = "-reversed";
const isReversedMap = (n) => typeof n === "string" && n.endsWith(REVERSE_SUFFIX);
const baseMapName = (n) => (isReversedMap(n) ? n.slice(0, -REVERSE_SUFFIX.length) : n);
// Escaped display HTML for a map name: the base name, plus a REVERSE pill for
// reversed variants. Safe to interpolate directly into markup.
const mapNameHtml = (n) =>
  isReversedMap(n)
    ? `${esc(baseMapName(n))} <span class="pill rev" title="Reverse route — separate leaderboard">REVERSE</span>`
    : esc(n);

/* A map's external padpork.org page is linked by map id (/map/:id/padpork), so
   the server can resolve the REAL name for the redirect and a censored/offensive
   map name never reaches the client. Reversed variants strip "-reversed" there. */

function setActiveNav(path) {
  document.querySelectorAll("nav.main a").forEach((a) => {
    const target = a.getAttribute("data-nav");
    const on = target === "#/" ? path === "/" : path.startsWith(target.slice(1));
    a.classList.toggle("active", on);
  });
}

function loading() {
  app.innerHTML = `<div class="loading"><span class="spinner"></span></div>`;
}
function errorView(e) {
  app.innerHTML = `<div class="empty">Something went wrong<br><small>${esc(e.message || e)}</small></div>`;
}

/* ----------------------- routing (History API paths) --------------------- */
// The app uses clean path URLs (/live, /map/5, /player/5?sort=map) via
// pushState — no "#" in the address bar. `data-nav` values keep the "#/…"
// shorthand (it just means "an in-app route"); navHref() maps them to real
// paths. Legacy "#/…" URLs (old shared links, bookmarks) are normalized to
// the path form on load.
function navHref(target) {
  let t = String(target == null ? "/" : target);
  if (t.startsWith("#")) t = t.slice(1); // "#/live" -> "/live"
  if (!t.startsWith("/")) t = "/" + t; // "live" -> "/live"
  return t || "/";
}

function parseRoute() {
  // Ignore trailing slashes ("/maps/" ≡ "/maps"): serve-static's old directory
  // redirect left permanently-cached 301s to /maps/ in visitors' browsers, and
  // the exact-match routing below turned those into "Page not found". Keep the
  // normalization even though the server no longer redirects — the cached 301s
  // (and hand-typed trailing slashes) still arrive here.
  let path = (location.pathname || "/").replace(/\/+$/, "") || "/";
  const params = {};
  new URLSearchParams(location.search).forEach((v, k) => (params[k] = v));
  return { path, params };
}

function go(target) {
  const url = navHref(target);
  if (url !== location.pathname + location.search) history.pushState(null, "", url);
  router();
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== "" && v != null) usp.set(k, v);
  });
  const s = usp.toString();
  return s ? "?" + s : "";
}

/* ------------------------------ views ------------------------------------ */
async function viewOverview() {
  loading();
  const d = await overview();
  const t = d.totals;
  const maxV = Math.max(...d.versions.map((v) => v.records || v.races), 1);
  const players = t.canonicalPlayers != null ? t.canonicalPlayers : t.rankedPlayers;

  app.innerHTML = `
    <div class="tiles">
      ${tile(t.worldRecords, "World Records")}
      ${tile(t.maps, "Maps")}
      ${tile(players, "Players")}
      ${tile(t.records != null ? t.records : t.races, "Ranked Times")}
      ${tile(t.finishes != null ? t.finishes : t.races, "Finishes", "accent")}
    </div>

    <div class="grid-2">
      <div class="panel hof">
        <h3><span class="dot"></span> Hall of Fame</h3>
        <div class="tscroll"><table class="data">
          <thead><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num" title="Skill Rating — how close your strongest runs get to the world record, against real fields">SR</th><th class="num">WRs</th><th class="num">Maps</th></tr></thead>
          <tbody>
            ${d.hallOfFame.map((p) => `
              <tr class="clickable" data-nav="#/player/${p.id}">
                <td class="rankcell ${rankClass(p.rank)}">${p.rank}</td>
                <td>${wname(p.name)}</td>
                <td class="num">${fmtNum(p.points)}</td>
                <td class="num">${srCell(p)}</td>
                <td class="num">${fmtNum(p.wr)}</td>
                <td class="num">${fmtNum(p.maps)}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>
      </div>

      <div>
        <div class="panel" style="margin-bottom:20px">
          <h3><span class="dot teal"></span> Recent PBs</h3>
          ${d.recent && d.recent.length ? `
          <div class="feed">
            ${d.recent.map((r) => `
              <div class="feeditem clickable" data-nav="#/map/${r.map_id}">
                <div class="fi-main">
                  ${r.global_rank === 1 ? '<span class="pill wr">WR</span> ' : ""}${wname(r.name)}
                  <span class="fi-map">${mapNameHtml(r.map)}</span>
                </div>
                <div class="fi-side">
                  <span class="time">${fmtTime(r.time)}</span>
                  ${r.server ? `<span class="pill srv">${esc(r.server)}</span>` : ""}
                </div>
              </div>`).join("")}
          </div>` : `
          <div class="muted" style="padding:8px 2px">No records set recently &mdash; a run only appears here when it beats the player's existing best on a map.</div>`}
        </div>
        <div class="panel" style="margin-bottom:20px">
          <h3><span class="dot"></span> Finishes by Version</h3>
          <div class="vbars">
            ${d.versions.map((v) => { const n = v.records != null ? v.records : v.races; return `
              <div class="vbar">
                <div class="top"><b>${esc(v.name)}</b><span>${fmtNum(n)}</span></div>
                <div class="track"><div class="fill" style="width:${(n / maxV) * 100}%"></div></div>
              </div>`; }).join("")}
          </div>
        </div>
        ${d.servers && d.servers.length ? `
        <div class="panel" style="margin-top:20px">
          <h3><span class="dot teal"></span> Contributing Servers</h3>
          <div class="tscroll"><table class="data">
            <thead><tr><th>Server</th><th>Status</th><th class="num">Records</th><th class="num">Last Seen</th></tr></thead>
            <tbody>
              ${d.servers.map((s) => `
                <tr class="clickable" data-nav="#/server/${s.id}">
                  <td class="mapname">${esc(s.name)}</td>
                  <td><span class="pill ${s.status === "trusted" ? "ok" : ""}">${esc(s.status)}</span></td>
                  <td class="num">${fmtNum(s.records)}</td>
                  <td class="num"><span class="muted">${s.last_seen_at ? fmtAgo(s.last_seen_at) : "—"}</span></td>
                </tr>`).join("")}
            </tbody>
          </table></div>
        </div>` : ""}
      </div>
    </div>`;
}

/* unix seconds -> "3m ago" / "2h ago" / "5d ago" */
function fmtAgo(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function tile(num, lbl, variant = "") {
  return `<div class="tile ${variant}"><div class="num">${fmtNum(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;
}

/* ---- finish feed: every completed run from the finish log (not just PBs). ----
 * Shared by the overview feed and the per-player / per-map finish history.
 * showMap/showPlayer toggle which side is redundant on a scoped page; a run's
 * checkpoint splits ride along in the time cell's tooltip. */
function finishFeed(list, { showMap = true, showPlayer = true, emptyMsg } = {}) {
  if (!list || !list.length)
    return `<div class="muted" style="padding:8px 2px">${esc(emptyMsg || "No finishes recorded yet.")}</div>`;
  return `<div class="feed">${list
    .map((f) => {
      const nav = showMap ? `#/map/${f.map_id}` : `#/player/${f.player_id}`;
      const splits = f.checkpoints && f.checkpoints.length ? ` title="splits: ${f.checkpoints.map(fmtTime).join(" / ")}"` : "";
      return `
      <div class="feeditem clickable" data-nav="${nav}">
        <div class="fi-main">
          ${f.pb ? '<span class="pill pb" title="the player\'s current best on this map">PB</span> ' : ""}${showPlayer ? wname(f.name) : ""}${showMap ? `<span class="fi-map">${mapNameHtml(f.map)}</span>` : ""}
        </div>
        <div class="fi-side">
          <span class="time"${splits}>${fmtTime(f.time)}</span>
          <span class="muted">${fmtAgo(f.created_at)}</span>
          ${f.server ? `<span class="pill srv">${esc(f.server)}</span>` : ""}
        </div>
      </div>`;
    })
    .join("")}</div>`;
}

/* ---- Skill Rating trend (last 30 days) ---------------------------------- *
 * A player's daily SR points arrive oldest -> newest, already capped to the
 * retention window server side, with the current value carried onto "today".  */
// Inline-SVG trend sparkline shared by the SR-history and strafe-quality cards.
// `get(point)` pulls the numeric y; `fmtAxis(v)` labels the min/max gridlines;
// `minBand` is the smallest y-range shown so a near-flat series doesn't magnify
// tiny wiggles; `chartClass` lets a caller theme the line/area colour. Expects
// history = [{day:'YYYY-MM-DD', ...}] oldest -> newest, length >= 1.
function trendSparkline(history, { get, fmtAxis, ariaLabel, minBand = 40, chartClass = "", band = null }) {
  // Layout in SVG user units; the element scales to its container width via CSS
  // while keeping this aspect ratio (so text scales uniformly and stays crisp).
  const W = 660, H = 150, padL = 38, padR = 14, padT = 14, padB = 22;
  const xs = history.map((p) => Date.parse(p.day + "T00:00:00Z"));
  const ys = history.map((p) => get(p));
  // Optional per-point envelope (e.g. each day's min..max strafe rating), drawn as
  // a shaded band behind the main (average) line.
  const los = band ? history.map((p) => band.lo(p)) : null;
  const his = band ? history.map((p) => band.hi(p)) : null;
  const xMin = xs[0], xMax = xs[xs.length - 1];
  // Domain spans the band envelope when present so the min/max fit on-chart.
  const dataMin = band ? Math.min(...los) : Math.min(...ys);
  const dataMax = band ? Math.max(...his) : Math.max(...ys);
  // Give a flat/near-flat series a sane band so tiny wiggles don't read as huge
  // swings, then pad the top/bottom so the line never glues to an edge.
  let yLo = dataMin, yHi = dataMax;
  if (yHi - yLo < minBand) { const mid = (yHi + yLo) / 2; yLo = mid - minBand / 2; yHi = mid + minBand / 2; }
  const yPad = (yHi - yLo) * 0.15; yLo -= yPad; yHi += yPad;
  const xToPx = (x) => padL + (xMax === xMin ? 0.5 : (x - xMin) / (xMax - xMin)) * (W - padL - padR);
  const yToPx = (y) => padT + (1 - (y - yLo) / (yHi - yLo)) * (H - padT - padB);
  const pts = history.map((p, i) => [xToPx(xs[i]), yToPx(ys[i])]);
  const n = (v) => v.toFixed(1);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${n(x)} ${n(y)}`).join(" ");
  const baseY = n(H - padB);
  // Fill: a min..max envelope (across the highs, back along the lows) when a band
  // is given; otherwise the classic area down to the baseline.
  let area;
  if (band) {
    const top = history.map((p, i) => `${i ? "L" : "M"}${n(xToPx(xs[i]))} ${n(yToPx(his[i]))}`).join(" ");
    const bot = history.map((p, i) => [xToPx(xs[i]), yToPx(los[i])]).reverse()
      .map(([x, y]) => `L${n(x)} ${n(y)}`).join(" ");
    area = `${top} ${bot} Z`;
  } else {
    area = `M${n(pts[0][0])} ${baseY} ${pts.map(([x, y]) => `L${n(x)} ${n(y)}`).join(" ")} L${n(pts[pts.length - 1][0])} ${baseY} Z`;
  }
  const last = pts[pts.length - 1];
  const gY = { hi: n(yToPx(dataMax)), lo: n(yToPx(dataMin)) };
  const first = history[0], latest = history[history.length - 1];
  return `
    <svg class="srchart ${chartClass}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${ariaLabel}">
      <line class="srgrid" x1="${padL}" y1="${gY.hi}" x2="${W - padR}" y2="${gY.hi}"/>
      <line class="srgrid" x1="${padL}" y1="${gY.lo}" x2="${W - padR}" y2="${gY.lo}"/>
      <text class="sraxl" x="${padL - 7}" y="${gY.hi}" text-anchor="end" dominant-baseline="middle">${fmtAxis(dataMax)}</text>
      <text class="sraxl" x="${padL - 7}" y="${gY.lo}" text-anchor="end" dominant-baseline="middle">${fmtAxis(dataMin)}</text>
      <path class="srarea" d="${area}"/>
      <path class="srline" d="${line}"/>
      <circle class="srdot" cx="${n(last[0])}" cy="${n(last[1])}" r="4"/>
      <text class="sraxd" x="${padL}" y="${H - 6}" text-anchor="start">${first.day.slice(5)}</text>
      <text class="sraxd" x="${W - padR}" y="${H - 6}" text-anchor="end">${latest.day.slice(5)}</text>
    </svg>`;
}

function srSparkline(history) {
  const first = history[0], latest = history[history.length - 1];
  return trendSparkline(history, {
    get: (p) => p.sr,
    fmtAxis: (v) => String(Math.round(v)),
    minBand: 40,
    ariaLabel: `Skill Rating over the last 30 days, ${first.day} to ${latest.day}`,
  });
}

// The card also carries the collapsed "which maps make this rating" dropdown
// (see srBreakdownPanel): the breakdown is fetched only when it's first opened.
function srHistoryCard(history, playerId) {
  if (!history || !history.length) return "";
  const latest = history[history.length - 1];
  const enough = history.length >= 2;
  if (!enough)
    return `
    <div class="page-title" style="font-size:20px">SKILL RATING <span class="accent">·</span> tracking</div>
    <div class="panel srhist"><div class="srhist-empty">Now tracking your Skill Rating daily — a 30-day trend line appears here once there are a couple of days to compare. Current rating <b>${fmtNum(latest.sr)}</b>.</div>
      ${srBreakdownPanel()}
    </div>`;
  const delta = latest.sr - history[0].sr;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
  const disp = (delta > 0 ? "+" : "") + fmtNum(delta);
  return `
    <div class="page-title" style="font-size:20px">SKILL RATING <span class="accent">·</span> last 30 days</div>
    <div class="panel srhist">
      <div class="srhist-head">
        <div class="srhist-now"><div class="n">${fmtNum(latest.sr)}</div><div class="l">current</div></div>
        <div class="srhist-delta ${trend}" title="Change over the ${history.length} days tracked">${arrow} ${disp}<span class="l">30-day change</span></div>
      </div>
      ${srSparkline(history)}
      ${srBreakdownPanel()}
    </div>`;
}

/* ---- "which maps make up this rating" dropdown -------------------------- *
 * Collapsed <details> inside the SR card. Opening it fetches /players/:id/sr
 * once and lists every map in the rating, strongest first, with the running
 * rating after each one — so the maps dragging the number down are as visible
 * as the ones holding it up.                                                */
function srBreakdownPanel() {
  return `
    <details class="srbd" id="srbd">
      <summary><span class="srbd-caret">▸</span> Which maps make up this rating?<span class="srbd-hint">all 50, strongest first</span></summary>
      <div class="srbd-body"><div class="srbd-note">Loading…</div></div>
    </details>`;
}

function renderSrBreakdown(d) {
  if (!d.rows || !d.rows.length)
    return `<div class="srbd-note">No contested maps yet — a map only counts once <b>${fmtNum(d.minField)}</b> players (you and ${fmtNum(d.minField - 1)} others) have a time on it. All <b>${fmtNum(d.topK)}</b> rating slots are still empty, so this sits at the starting rating of <b>${fmtNum(d.sr)}</b>. Race a map a couple of other people have run and it'll start building.</div>`;

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  // Everyone is scored over the same ${d.topK} slots; the tail past it is what a
  // deep catalog leaves on the table, and unfilled slots sit at the prior.
  const spare = Math.max(0, d.contested - d.counted);
  const empty = d.emptySlots != null ? d.emptySlots : Math.max(0, d.topK - d.counted);
  const prior = Math.round(1000 * d.mu);
  // Each row's running value vs the one above it: green when the map lifted the
  // rating, red when it pulled it down. The first row is measured against the
  // starting prior, which is where every rating begins.
  const drift = (r, i) => (i === 0 ? r.running - Math.round(1000 * d.mu) : r.running - d.rows[i - 1].running);

  const row = (r, i) => {
    const dv = drift(r, i);
    return `
    <tr class="clickable" data-nav="#/map/${r.map_id}">
      <td class="num srbd-i">${i + 1}</td>
      <td class="mapname">${mapNameHtml(r.map_name)}</td>
      <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
      <td class="num ${rankClass(r.rank)}">${r.rank === 1 ? '<span class="pill wr">WR</span>' : "#" + fmtNum(r.rank)}</td>
      <td class="num"><span class="muted">${fmtTime(r.wr_time)}</span></td>
      <td class="num" title="Your time as a fraction of the world record — 100% is the record itself">${pct(r.ratio)}</td>
      <td class="num" title="${fmtNum(r.field)} players have a time on this map">${fmtNum(r.field)}</td>
      <td class="num srbd-run" title="The rating after this map and everything above it">${fmtNum(r.running)}
        <span class="srbd-d ${dv > 0 ? "up" : dv < 0 ? "down" : ""}">${dv > 0 ? "+" : ""}${fmtNum(dv)}</span>
      </td>
    </tr>`;
  };

  // Unfilled slots are IN the rating at the starting value, so show them as a
  // real row — otherwise the last map's running number looks unexplained.
  const emptyRow = empty
    ? `<tr class="srbd-empty">
         <td class="num srbd-i">${fmtNum(d.counted + 1)}–${fmtNum(d.topK)}</td>
         <td colspan="6">${fmtNum(empty)} slot${empty === 1 ? "" : "s"} still to fill — each one counts at the starting rating of ${fmtNum(prior)} until you race a ${fmtNum(d.minField)}-player map you don't already have</td>
         <td class="num srbd-run">${fmtNum(d.sr)}</td>
       </tr>`
    : "";

  return `
    <div class="srbd-note">
      Every player is rated on the same <b>${fmtNum(d.topK)}</b> slots, so a deep catalog
      and a short one are the same measurement. Yours holds <b>${fmtNum(d.counted)}</b> map${d.counted === 1 ? "" : "s"}${
        spare ? ` — ${fmtNum(spare)} more qualified but didn't make the cut` : ""
      }${
        empty ? `, with ${fmtNum(empty)} slot${empty === 1 ? "" : "s"} still empty at the starting rating of ${fmtNum(prior)}` : ""
      }. A map is contested once you and ${fmtNum(d.minField - 1)} other players have a time on it.
      Each map scores on how close you are to its world record, weighted by how big
      the field is, and <b>all ${fmtNum(d.topK)} slots count</b> — the running column is
      where the rating stands after each map, so anything with a red number beside it
      is dragging you down and is worth another run.
    </div>
    <div class="tscroll"><table class="data srbd-table">
      <thead><tr>
        <th class="num">#</th><th>Map</th><th class="num">Your Time</th><th class="num">Rank</th>
        <th class="num">WR</th><th class="num" title="Your time as a fraction of the world record">% of WR</th>
        <th class="num" title="Players with a time on this map">Field</th>
        <th class="num" title="The rating after counting this map and everything above it">Running SR</th>
      </tr></thead>
      <tbody>
        ${d.rows.map(row).join("")}
        ${emptyRow}
      </tbody>
    </table></div>`;
}

// Lazy-load on first open; a failed fetch stays retryable (close + reopen).
function wireSrBreakdown(playerId) {
  const det = document.getElementById("srbd");
  if (!det) return;
  let loaded = false;
  det.addEventListener("toggle", async () => {
    if (!det.open || loaded) return;
    loaded = true;
    track("View SR breakdown");
    const body = det.querySelector(".srbd-body");
    try {
      body.innerHTML = renderSrBreakdown(await api(`/players/${playerId}/sr`));
    } catch (e) {
      loaded = false;
      body.innerHTML = `<div class="srbd-note">Couldn't load the breakdown (${esc(e.message)}). Close and reopen to retry.</div>`;
    }
  });
}

/* ---- Skill Rating distribution (where you stand) ------------------------ *
 * The whole ranked board as a histogram with one bar lit up: yours. A rating on
 * its own says nothing — 412 is only meaningful next to the shape of everyone
 * else's — so the number the card actually leads with is the percentile, which
 * the server counts exactly (`srPlace`) rather than reading off a bucket.
 *
 * The curve is identical on every profile, so it is fetched once from the
 * shared /sr/distribution and only the marker moves. That also means the card
 * degrades cleanly: the percentile is already in the profile payload, so a
 * failed histogram fetch loses the picture, not the answer.                  */
function srDistCard() {
  return `
    <div class="page-title" style="font-size:20px">SKILL RATING <span class="accent">·</span> where you stand</div>
    <div class="panel srdist" id="srdist"><div class="srdist-note">Loading the rating distribution…</div></div>`;
}

// One bar per rating band, height = how many ranked players are in it, with the
// player's own band lit and their exact rating marked. Single series, so no
// legend: the title names it and the marker is direct-labelled.
function srDistChart(dist, place, sr) {
  const W = 660, H = 176, padL = 42, padR = 14, padT = 28, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const lo = dist.lo, hi = dist.hi, baseY = H - padB;
  const n = (v) => v.toFixed(1);
  const maxC = Math.max(1, ...dist.buckets.map((b) => b.count));
  const slot = plotW / dist.buckets.length;
  // Ratings -> px. Clamped because the marker draws from a live rating while the
  // histogram bounds come from a cached snapshot: between the two, a new WR can
  // put someone a few points outside the range the buckets were built for.
  const xOf = (v) => padL + Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))) * plotW;

  const bars = dist.buckets
    .map((b, i) => {
      const h = (b.count / maxC) * plotH;
      // The top band is closed at both ends (nothing is above it), so a rating
      // sitting exactly on `hi` belongs to it rather than to nothing.
      const last = i === dist.buckets.length - 1;
      const mine = place != null && sr >= b.lo && (sr < b.hi || (last && sr <= b.hi));
      // 2px of surface between bars: adjacent fills must never touch.
      return `<rect class="srdbar${mine ? " me" : ""}" x="${n(padL + i * slot)}" y="${n(baseY - h)}"
        width="${n(Math.max(1, slot - 2))}" height="${n(h)}" rx="2"
        ><title>${fmtNum(b.lo)}–${fmtNum(b.hi)} SR · ${fmtNum(b.count)} player${b.count === 1 ? "" : "s"}</title></rect>`;
    })
    .join("");

  // Median reference, dropped when it would sit on top of an axis-end label.
  const medX = xOf(dist.median);
  const medLabel =
    medX > padL + 54 && medX < W - padR - 54
      ? `<text class="sraxd srdmedl" x="${n(medX)}" y="${H - 6}" text-anchor="middle">median ${fmtNum(dist.median)}</text>`
      : "";
  const median =
    dist.median == null
      ? ""
      : `<line class="srdmed" x1="${n(medX)}" y1="${padT}" x2="${n(medX)}" y2="${baseY}"/>${medLabel}`;

  let marker = "";
  if (place != null) {
    const x = xOf(sr);
    // Keep the label inside the plot: anchored middle in open space, flipped to
    // start/end near the edges so it can never run off the chart.
    const anchor = x < padL + 46 ? "start" : x > W - padR - 46 ? "end" : "middle";
    const lx = anchor === "start" ? padL : anchor === "end" ? W - padR : x;
    marker = `
      <line class="srdme" x1="${n(x)}" y1="${padT - 10}" x2="${n(x)}" y2="${baseY}"/>
      <text class="srdmel" x="${n(lx)}" y="${padT - 14}" text-anchor="${anchor}">YOU · ${fmtNum(sr)}</text>`;
  }

  const aria =
    place != null
      ? `Skill Rating distribution of ${fmtNum(dist.total)} ranked players from ${fmtNum(lo)} to ${fmtNum(hi)}; this player is at ${fmtNum(sr)}, ahead of ${place.percentile}% of them`
      : `Skill Rating distribution of ${fmtNum(dist.total)} ranked players from ${fmtNum(lo)} to ${fmtNum(hi)}`;

  return `
    <svg class="srchart srdchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">
      <line class="srgrid" x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}"/>
      <text class="sraxl" x="${padL - 7}" y="${padT}" text-anchor="end" dominant-baseline="middle">${fmtNum(maxC)}</text>
      ${bars}
      ${median}
      ${marker}
      <line class="srdaxis" x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}"/>
      <text class="sraxd" x="${padL}" y="${H - 6}" text-anchor="start">${fmtNum(lo)}</text>
      <text class="sraxd" x="${W - padR}" y="${H - 6}" text-anchor="end">${fmtNum(hi)}</text>
    </svg>`;
}

function renderSrDist(dist, place, sr, standing) {
  if (!dist || !dist.total || !dist.buckets || !dist.buckets.length)
    return `<div class="srdist-note">No ratings on the board yet.</div>`;

  const minMaps = dist.minMaps || 0;
  // Two different reasons to have no place on the curve, and they need different
  // advice: not enough maps yet (say how many are left), or maps that no-one else
  // has raced so nothing qualifies.
  const toGo = standing && standing.srMapsToRank ? standing.srMapsToRank : 0;
  const head =
    place == null
      ? `<div class="srdist-head"><div class="srdist-sub">${
          toGo > 0
            ? `Not rated yet — a Skill Rating starts at <b>${fmtNum(minMaps)}</b> finished maps, so there ${toGo === 1 ? "is" : "are"} <b>${fmtNum(toGo)}</b> to go. Below that the number would be mostly the starting rating rather than your runs.`
            : `Not on the rating board yet — set a time on a map two other players have raced and a rating (and a place on this curve) starts building.`
        }</div></div>`
      : `<div class="srdist-head">
          <div class="srdist-pct"><div class="n">${place.percentile.toFixed(1)}<span class="sfx">th</span></div><div class="l">percentile</div></div>
          <div class="srdist-sub">Ahead of <b>${place.percentile.toFixed(1)}%</b> of the ${fmtNum(place.total)} ranked players
            <span class="sep">·</span> <b>#${fmtNum(place.rank)}</b> by rating
            <span class="sep">·</span> top <b>${(100 - place.percentile).toFixed(1)}%</b></div>
        </div>`;

  return `${head}
    ${srDistChart(dist, place, sr)}
    <div class="srdist-cap">Every rated player${
      minMaps ? ` (${fmtNum(minMaps)}+ finished maps)` : ""
    }, bucketed by rating: each bar is a rating band and its height is how many players sit in it. Hover a bar for the count.</div>`;
}

// Fetched after the profile renders (the percentile itself is already on screen
// from the profile payload, so this only fills in the picture).
async function wireSrDistribution(d) {
  const host = document.getElementById("srdist");
  if (!host) return;
  // An unranked player has no marker to place: their stored sr is a
  // placeholder, so drawing "YOU" at it would put them on a curve they are
  // deliberately not counted in.
  const ranked = !d.standing || d.standing.srRanked !== false;
  const sr = d.standing && ranked ? d.standing.sr : null;
  try {
    host.innerHTML = renderSrDist(await api("/sr/distribution"), d.srPlace || null, sr, d.standing);
  } catch (e) {
    host.innerHTML = `<div class="srdist-note">Couldn't load the rating distribution (${esc(e.message)}).</div>`;
  }
}

// Air-strafe quality trend: the by-day average accel efficiency (how close the
// player stays to the ideal strafe angle) over the rolling window, mirroring the
// SR-history card but themed distinctly and formatted as a percentage.
function strafeQualityCard(history) {
  // Always render (like the Skill Rating card), even before any strafe data:
  // an empty history shows the tracking state rather than hiding the card.
  const pts = history || [];
  const latest = pts.length ? pts[pts.length - 1] : null;
  const pct = (v) => `${(Math.round(v * 10) / 10).toFixed(1)}%`;
  const enough = pts.length >= 2;
  if (!enough)
    return `
    <div class="page-title" style="font-size:20px">STRAFE QUALITY <span class="accent">·</span> tracking</div>
    <div class="panel srhist"><div class="srhist-empty">Now tracking your air-strafe quality — how close your acceleration stays to the ideal strafe angle, measured while you are actually strafing (forward + left or right) at 600&nbsp;ups or more. A daily average, high and low appear here once you've finished runs on a couple of different days.${latest ? ` Latest <b>${pct(latest.quality)}</b>.` : ""}</div></div>`;
  const delta = latest.quality - history[0].quality;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
  const disp = (delta > 0 ? "+" : "") + (Math.round(delta * 10) / 10).toFixed(1) + "%";
  return `
    <div class="page-title" style="font-size:20px">STRAFE QUALITY <span class="accent">·</span> last 30 days</div>
    <div class="panel srhist">
      <div class="srhist-head">
        <div class="srhist-now"><div class="n">${pct(latest.quality)}</div><div class="l">latest avg</div></div>
        <div class="srhist-now"><div class="n">${pct(latest.max)}</div><div class="l">day high</div></div>
        <div class="srhist-now"><div class="n">${pct(latest.min)}</div><div class="l">day low</div></div>
        <div class="srhist-delta ${trend}" title="Change in daily average over the ${history.length} days tracked">${arrow} ${disp}<span class="l">30-day change</span></div>
      </div>
      ${trendSparkline(history, {
        get: (p) => p.quality,
        band: { lo: (p) => p.min, hi: (p) => p.max },
        fmtAxis: (v) => Math.round(v) + "%",
        minBand: 8,
        chartClass: "strafechart",
        ariaLabel: `Air-strafe quality over the last 30 days (daily average line with min–max band), ${history[0].day} to ${latest.day}`,
      })}
    </div>`;
}

/* ---- achievements (profile badges + progress + directory) --------------- */
const ACH_TIER_ORDER = ["legend", "gold", "silver", "bronze"];
const ACH_WINDOW_TEXT = {
  lifetime: "all-time",
  month: "each calendar month",
  day: "in a single day",
  rolling30: "over a rolling 30 days",
};

/* Format a progress/award value by the server's display hint. */
function achValue(v, format) {
  if (v == null) return "—";
  if (format === "pct-bp") return (v / 100).toFixed(1) + "%"; // basis points
  if (format === "ms") return fmtTime(v);
  if (format === "rank") return "#" + fmtNum(v);
  if (format === "ups") return fmtNum(v) + " ups";
  return fmtNum(v);
}

/* Progress fraction 0..100. better:'low' rules (beat a time, reach a rank)
 * count down toward the target instead of up. */
function achPct(p) {
  if (p.value == null || !p.target) return 0;
  if (p.better === "low") return p.value <= p.target ? 100 : Math.max(0, Math.min(100, (p.target / p.value) * 100));
  return Math.max(0, Math.min(100, (p.value / p.target) * 100));
}

/* Earned badges ride the main profile payload; progress toward the rest is
 * fetched lazily on first open (same shape as the SR breakdown dropdown). */
function achievementsCard(list) {
  const earned = list || [];
  const pills = earned
    .map((a) => {
      const when = a.awarded_at ? new Date(a.awarded_at * 1000).toISOString().slice(0, 10) : "";
      const tip = `${a.description || a.title}${a.period ? ` · ${a.period}` : ""}${when ? ` · earned ${when}` : ""}`;
      return `<span class="ach ${esc(a.tier)}" title="${esc(tip)}">${esc(a.title)}</span>`;
    })
    .join("");
  return `
    <div class="page-title" style="font-size:20px">ACHIEVEMENTS <span class="accent">·</span> ${earned.length ? fmtNum(earned.length) + " earned" : "none yet"}</div>
    <div class="panel achpanel">
      ${earned.length
        ? `<div class="achlist">${pills}</div>`
        : `<div class="srhist-empty">No achievements earned yet — <a data-nav="#/achievements">see what's up for grabs</a>.</div>`}
      <details class="srbd" id="achbd">
        <summary><span class="srbd-caret">▸</span> Progress toward the rest</summary>
        <div class="srbd-body"><div class="srbd-note">Loading…</div></div>
      </details>
    </div>`;
}

function renderAchProgress(d) {
  const items = (d && d.progress) || [];
  if (!items.length)
    return `<div class="srbd-note">Nothing left to chase — every visible achievement is earned, or none are defined yet. <a data-nav="#/achievements">Browse the directory</a>.</div>`;
  return items
    .map((p) => {
      const pct = achPct(p);
      return `
      <div class="achprog">
        <div class="achprog-head">
          <span class="ach ${esc(p.tier)} sm">${esc(p.title)}</span>
          <span class="achprog-nums">${achValue(p.value, p.format)} <span class="muted">/ ${achValue(p.target, p.format)}</span></span>
        </div>
        ${p.description ? `<div class="achprog-desc muted">${esc(p.description)}</div>` : ""}
        <div class="achbar"><div class="achbar-fill" style="width:${pct.toFixed(1)}%"></div></div>
      </div>`;
    })
    .join("");
}

// Lazy-load on first open; a failed fetch stays retryable (close + reopen).
function wireAchievements(playerId) {
  const det = document.getElementById("achbd");
  if (!det) return;
  let loaded = false;
  det.addEventListener("toggle", async () => {
    if (!det.open || loaded) return;
    loaded = true;
    track("View achievements progress");
    const body = det.querySelector(".srbd-body");
    try {
      body.innerHTML = renderAchProgress(await api(`/players/${playerId}/achievements`));
    } catch (e) {
      loaded = false;
      body.innerHTML = `<div class="srbd-note">Couldn't load progress (${esc(e.message)}). Close and reopen to retry.</div>`;
    }
  });
}

/* ---- generic sortable header ---- */
function th(label, key, state, extraClass = "") {
  const active = state.sort === key;
  const arr = active ? (state.order === "asc" ? "▲" : "▼") : "";
  return `<th class="sortable ${extraClass}" data-sort="${key}">${esc(label)} <span class="arr">${arr}</span></th>`;
}

const PAGE = 50;

// Weapon tags a map's .bsp was scanned for (see server scan-map-weapons.js);
// mirrors web/weapons.js. Used for the maps-page weapon/strafe filter + badges.
const WEAPON_LABELS = {
  gb: "Gunblade", mg: "Machinegun", rg: "Riotgun", gl: "Grenade Launcher",
  rl: "Rocket Launcher", pg: "Plasmagun", lg: "Lasergun", eb: "Electrobolt", ig: "Instagun",
};
const WEAPON_FILTER_OPTS = [
  ["", "All maps"],
  ["strafe", "Strafe (no weapons)"],
  ["slick", "Slick (icy floors)"],
  ["rl", "Rocket Launcher"], ["pg", "Plasmagun"], ["gl", "Grenade Launcher"],
  ["rg", "Riotgun"], ["lg", "Lasergun"], ["eb", "Electrobolt"],
  ["mg", "Machinegun"], ["ig", "Instagun"], ["gb", "Gunblade"],
];

// A SLICK pill for maps with icy floors, carrying how much of the map is slick
// (measured from the .bsp — see bsp.js parseSlick). Shown whenever there is any
// slick at all, so a map with a slick SECTION is still discoverable, but only
// maps over the threshold are counted as slick maps by the filter and the pill
// is dimmed below it.
function slickBadge(m) {
  const pct = m.slick_pct | 0;
  if (pct <= 0) return "";
  const minor = m.is_slick ? "" : " minor";
  const title = m.is_slick
    ? `Slick map — ${pct}% of this map's floor is icy`
    : `Has some slick floor (${pct}%), but not enough to count as a slick map`;
  return ` <span class="wpn slick${minor}" title="${esc(title)}">SLICK ${pct}%</span>`;
}

// Little badges after a map name: a STRAFE pill for no-weapon maps, otherwise
// one code chip per weapon (the gunblade everyone spawns with is not shown).
// The slick pill is independent — a map can be both strafe and slick.
function weaponBadges(m) {
  const slick = slickBadge(m);
  if (m.is_strafe) return ` <span class="wpn strafe" title="No weapons — strafe map">STRAFE</span>${slick}`;
  const codes = Array.isArray(m.weapons) ? m.weapons.filter((c) => c !== "gb") : [];
  return (codes.length
    ? " " + codes.map((c) => `<span class="wpn" title="${esc(WEAPON_LABELS[c] || c)}">${esc(c.toUpperCase())}</span>`).join("")
    : "") + slick;
}

async function viewMaps(params) {
  loading();
  const state = {
    q: params.q || "",
    weapon: params.weapon || "",
    sort: params.sort || "races",
    order: params.order || (params.sort === "name" ? "asc" : "desc"),
    offset: parseInt(params.offset || "0", 10) || 0,
  };
  const data = await api(
    "/maps" + buildQuery({ q: state.q, weapon: state.weapon, sort: state.sort, order: state.order, limit: PAGE, offset: state.offset })
  );

  app.innerHTML = `
    <div class="page-title"><span class="accent">MAPS</span> DATABASE</div>
    <p class="page-sub">Browse every race map, sorted and searchable. Click a map for its full leaderboard and world-record splits.</p>
    <div class="toolbar">
      <input class="filter" id="mfilter" placeholder="Filter maps by name…" value="${esc(state.q)}">
      <select class="filter version" id="mweapon" title="Filter by weapon or strafe">
        ${WEAPON_FILTER_OPTS.map(([v, l]) => `<option value="${v}"${state.weapon === v ? " selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      <span class="count">${fmtNum(data.total)} maps</span>
    </div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          ${th("Map", "name", state)}
          ${th("Records", "records", state, "num")}
          ${th("Finishes", "finishes", state, "num")}
          ${th("World Record", "wr_time", state, "num")}
          <th>Record Holder</th>
          ${th("Last Played", "played", state, "num")}
        </tr></thead>
        <tbody>
          ${data.rows.map((m) => `
            <tr class="clickable" data-nav="#/map/${m.id}">
              <td class="mapname">${mapNameHtml(m.name)}
                <a class="extlink" href="/map/${m.id}/padpork" target="_blank" rel="noopener external" title="${esc(baseMapName(m.name))} on padpork.org">↗</a>${weaponBadges(m)}
              </td>
              <td class="num">${fmtNum(m.records != null ? m.records : m.races)}</td>
              <td class="num">${fmtNum(m.finishes != null ? m.finishes : m.races)}</td>
              <td class="num"><span class="time">${m.wr_time != null ? fmtTime(m.wr_time) : "—"}</span></td>
              <td>${m.wr_name ? wname(m.wr_name) : '<span class="pill">no runs</span>'}</td>
              <td class="num"><span class="muted">${m.last_played != null ? fmtAgo(m.last_played) : "—"}</span></td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No maps match ${state.q ? `“${esc(state.q)}”` : "that filter"}.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, data, "#/maps")}</div>`;

  wireFilter("mfilter", "#/maps", state);
  const wsel = document.getElementById("mweapon");
  if (wsel) wsel.addEventListener("change", () => {
    go("#/maps" + buildQuery({ ...pageParams(state), weapon: wsel.value, offset: 0 }));
  });
  wireSort("#/maps", state);
}

// Demo directory index: maps that have recorded demos, newest activity first.
// Click a map to reach its per-player download list (viewDemosMap).
async function viewDemos(params) {
  loading();
  const state = { q: params.q || "", offset: parseInt(params.offset, 10) || 0 };
  const data = await api("/demos" + buildQuery({ q: state.q, offset: state.offset || undefined }));
  app.innerHTML = `
    <div class="page-title"><span class="accent">DEMO</span> DIRECTORY</div>
    <p class="page-sub">Every map with a downloadable run. Open a map to grab individual demo files — each is one player's personal best. To watch one, drop the file in your Warsow <span class="mono">racemod/demos</span> folder and run <span class="mono">demo &lt;file&gt;</span> in the console.</p>
    <div class="toolbar">
      <input class="filter" id="dfilter" placeholder="Filter maps by name…" value="${esc(state.q)}">
      <span class="count">${fmtNum(data.total)} maps</span>
    </div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          <th>Map</th>
          <th class="num">Demos</th>
          <th class="num">Fastest</th>
          <th class="num">Newest</th>
        </tr></thead>
        <tbody>
          ${data.rows.map((m) => `
            <tr class="clickable" data-nav="#/demo/${m.id}">
              <td class="mapname">${mapNameHtml(m.name)}</td>
              <td class="num">${fmtNum(m.demos)}</td>
              <td class="num"><span class="time">${m.fastest != null ? fmtTime(m.fastest) : "—"}</span></td>
              <td class="num"><span class="muted">${m.latest != null ? fmtAgo(m.latest) : "—"}</span></td>
            </tr>`).join("") || `<tr><td colspan="4" class="empty">No demos ${state.q ? `match “${esc(state.q)}”` : "recorded yet"}.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, data, "#/demo")}</div>`;
  wireFilter("dfilter", "#/demo", state);
}

// One map's demos: per-player PBs, fastest first, each with its own download
// link. Mirrors the leaderboard's ⬇ demo affordance but as a focused list.
async function viewDemosMap(id) {
  loading();
  const d = await api("/demos/" + id);
  const anyDl = d.demos.some((x) => x.url);
  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/demo">Demos</a> / ${esc(baseMapName(d.map.name))}${isReversedMap(d.map.name) ? " (reverse)" : ""}</div>
    <div class="page-title" style="font-size:34px">${mapNameHtml(d.map.name)}</div>
    <p class="page-sub">${fmtNum(d.demos.length)} demo${d.demos.length === 1 ? "" : "s"} — one per player, their personal best. <a data-nav="#/map/${d.map.id}">Open the full leaderboard ↗</a></p>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          <th>#</th><th>Player</th><th class="num">Time</th><th class="num">Size</th><th class="num">Recorded</th><th class="num">Demo</th>
        </tr></thead>
        <tbody>
          ${d.demos.map((x, i) => `
            <tr>
              <td class="rankcell ${rankClass(i + 1)}">${i + 1}</td>
              <td class="clickable" data-nav="#/player/${x.playerId}">${wname(x.name)}</td>
              <td class="num"><span class="time">${fmtTime(x.time)}</span></td>
              <td class="num"><span class="muted">${fmtBytes(x.bytes)}</span></td>
              <td class="num"><span class="muted">${x.captured_at != null ? fmtAgo(x.captured_at) : "—"}</span></td>
              <td class="num">${x.url ? `<a class="replay-badge demo" href="${esc(x.url)}" download rel="noopener" title="Download this demo">⬇ demo</a>` : `<span class="muted">—</span>`}</td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No demos for this map.</td></tr>`}
        </tbody>
      </table>
    </div></div>
    ${anyDl ? `<details class="demo-help"><summary>How to watch a demo in Warsow</summary>
      <p>Download the file into your Warsow <span class="mono">racemod/demos</span> folder, then in the console run
      <span class="mono">demo &lt;filename&gt;</span> — or launch <span class="mono">warsow +demo &lt;filename&gt;</span>. It plays the run start&#8209;to&#8209;finish.</p></details>` : ""}`;
}

async function viewPlayers(params) {
  loading();
  const state = {
    q: params.q || "",
    sort: params.sort || "points",
    order: params.order || (params.sort === "name" ? "asc" : "desc"),
    offset: parseInt(params.offset || "0", 10) || 0,
  };
  const data = await api(
    "/players" + buildQuery({ q: state.q, sort: state.sort, order: state.order, limit: PAGE, offset: state.offset })
  );

  app.innerHTML = `
    <div class="page-title"><span class="accent">PLAYER</span> RANKINGS</div>
    <p class="page-sub">Ranked by race points (top-15 finish on each map). Sort by <b>SR</b> for the skill board — how close your strongest runs get to each world record, against the strength of the field. Search by name and sort by any column, or <a data-nav="#/compare">compare two players head-to-head ⚔</a>.</p>
    <div class="toolbar">
      <input class="filter" id="pfilter" placeholder="Search players by name…" value="${esc(state.q)}">
      <span class="count">${fmtNum(data.total)} players</span>
    </div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          ${th("#", "rank", state)}
          ${th("Player", "name", state)}
          ${th("Points", "points", state, "num")}
          ${th("SR", "sr", state, "num")}
          ${th("WRs", "wr", state, "num")}
          ${th("Podiums", "podium", state, "num")}
          ${th("Maps", "maps", state, "num")}
          ${th("Last raced", "active", state, "num")}
        </tr></thead>
        <tbody>
          ${data.rows.map((p) => `
            <tr class="clickable" data-nav="#/player/${p.id}">
              <td class="rankcell ${rankClass(p.rank)}">${p.rank}</td>
              <td>${wname(p.name)}</td>
              <td class="num">${fmtNum(p.points)}</td>
              <td class="num">${srCell(p)}</td>
              <td class="num">${fmtNum(p.wr)}</td>
              <td class="num">${fmtNum(p.podium)}</td>
              <td class="num">${fmtNum(p.maps)}</td>
              <td class="num">${p.last_active != null ? fmtAgo(p.last_active) : "—"}</td>
            </tr>`).join("") || `<tr><td colspan="8" class="empty">No players match “${esc(state.q)}”.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, data, "#/players")}</div>`;

  wireFilter("pfilter", "#/players", state);
  wireSort("#/players", state);
}

// Leaderboard cells for the two per-PB run facts. Both are null for runs set
// before the measurement existed (or by a server that never reported it), and
// null renders as an em dash — NOT 0%, which would read as a real, terrible
// number. Banding mirrors the achievement cuts (90% near-perfect, 80% smooth
// operator) so the colours agree with the badges players already know.
function strafeCell(q) {
  if (q == null) return `<span class="muted" title="No strafe measurement for this run">—</span>`;
  const tier = q >= 90 ? "elite" : q >= 80 ? "good" : q >= 65 ? "ok" : "low";
  return `<span class="sq ${tier}" title="Air-strafe quality of this record run">${(Math.round(q * 10) / 10).toFixed(1)}%</span>`;
}
function triesCell(n) {
  if (n == null) return `<span class="muted" title="Attempt count not recorded for this run">—</span>`;
  return `<span class="tries" title="${fmtNum(n)} attempt${n === 1 ? "" : "s"} on this map up to the run that set this record">${fmtNum(n)}</span>`;
}

async function viewMap(id) {
  loading();
  // limit=10000 = "everyone": the leaderboard lists every player's PR on the
  // map (the busiest map has ~180), not a top-100 cut.
  const d = await api(`/maps/${id}?limit=10000`);
  track("View map", { map: d.name });
  const wr = d.wr;

  // WR splits as absolute -> per-segment deltas for a fair compare to perfect.
  const wrDeltas = [];
  if (wr && wr.splits && wr.splits.length) {
    let prev = 0;
    for (const t of wr.splits) { wrDeltas.push(t - prev); prev = t; }
    wrDeltas.push(wr.time - prev); // final segment to the finish
  }

  let splitsHtml = "";
  if (wr && wr.splits && wr.splits.length) {
    splitsHtml = `<div class="splits">${wr.splits
      .map((t, i) => `<div class="split"><span class="cpn">CP${i + 1}</span> <b>${fmtTime(t)}</b></div>`)
      .join("")}</div>`;
  }

  const p = d.perfect;
  let perfectHtml = "";
  if (p && p.complete) {
    perfectHtml = `
      <div class="perfect-banner">
        <div class="pb-head">
          <div>
            <div class="kicker teal">◇ Perfect Run · sum of best splits</div>
            <div class="pf-time time">${fmtTime(p.time)}</div>
          </div>
          ${p.savingVsWr != null && p.savingVsWr > 0 ? `<div class="pf-save"><b>-${fmtTime(p.savingVsWr)}</b><span>vs world record</span></div>` : ""}
        </div>
        <div class="splits">
          ${p.segments.map((s) => {
            const label = s.seg === p.segments.length - 1 ? "FIN" : "S" + (s.seg + 1);
            const beatsWr = wrDeltas.length && s.delta != null && wrDeltas[s.seg] != null && s.delta < wrDeltas[s.seg];
            return `<div class="split ${beatsWr ? "beat" : ""}" title="${esc(s.simplified || "")}">
              <span class="cpn">${label}</span> <b>${fmtTime(s.delta)}</b>
              ${s.simplified ? `<span class="seg-by">${wname(s.name)}</span>` : ""}
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/maps">Maps</a> / ${esc(baseMapName(d.name))}${isReversedMap(d.name) ? " (reverse)" : ""}</div>
    ${wr ? `
      <div class="wr-banner">
        <div class="kicker">◆ World Record</div>
        <div class="wr-time time">${fmtTime(wr.time)}</div>
        <div class="holder">by ${wname(wr.name)} <span class="pill v1">${esc(wr.versionName || "")}</span></div>
        ${splitsHtml}
        ${wr.ghost || (wr.demo && wr.demo.url) ? `
        <div class="replay-actions">
          ${wr.ghost ? `<button class="btn replay-watch" data-nav="#/replay/${id}">▶ Watch replay${wr.ghost.isWr ? "" : " (" + fmtTime(wr.ghost.time) + ")"}</button>` : ""}
          ${wr.demo && wr.demo.url ? `<a class="btn replay-demo" href="${esc(wr.demo.url)}" download rel="noopener">⬇ Download demo</a>` : ""}
        </div>
        ${wr.demo && wr.demo.url ? `<details class="demo-help"><summary>How to watch the demo in Warsow</summary>
          <p>Download the file into your Warsow <code>racemod/demos</code> folder, then in the console run
          <code>demo &lt;filename&gt;</code> — or launch <code>warsow +demo &lt;filename&gt;</code>. It plays the record run start&#8209;to&#8209;finish.</p></details>` : ""}
        ` : ""}
      </div>` : ""}
    ${perfectHtml}

    <div class="page-title">${mapNameHtml(d.name)}</div>
    ${isReversedMap(d.name) ? `<p class="page-sub reverse-note">Reverse route of <b>${esc(baseMapName(d.name))}</b> — start at the finish line, run the checkpoints backward to the start. Separate leaderboard from the normal map. <a data-nav="#/about">How reverse mode works ↗</a></p>` : ""}
    <p class="page-sub">${fmtNum(d.records != null ? d.records : d.races)} ranked times · ${fmtNum(d.finishes != null ? d.finishes : d.races)} finishes · ${fmtNum(d.players)} players on the board
      · <a class="extlink" href="/map/${d.id}/padpork" target="_blank" rel="noopener external">padpork.org ↗</a></p>

    <div class="map-hero">
      <div class="map-hero-main">
        <div class="table-wrap"><div class="tscroll">
          <table class="data">
            <thead><tr><th>#</th><th>Player</th><th class="num">Time</th><th class="num">Behind</th><th class="num">Gap</th><th class="num" title="Air-strafe quality of this record run — how close the acceleration stayed to the ideal strafe angle">Strafe</th><th class="num" title="Attempts on this map up to and including the run that set this record">Tries</th><th>Version</th></tr></thead>
            <tbody>
              ${d.leaderboard.map((r, i) => `
                <tr class="clickable" data-nav="#/player/${r.playerId}">
                  <td class="rankcell ${rankClass(r.pos)}">${r.pos}</td>
                  <td>${wname(r.name)}${r.ghost ? ` <span class="replay-badge" data-nav="#/replay/${id}/${r.playerId}" title="Watch this run in the browser">▶ replay</span>` : ""}${r.demo && r.demo.url ? ` <a class="replay-badge demo" href="${esc(r.demo.url)}" download rel="noopener" title="Download this run's demo">⬇ demo</a>` : ""}</td>
                  <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
                  <td class="num"><span class="time">${r.pos === 1 ? "—" : "+" + fmtTime(r.time - d.leaderboard[0].time)}</span></td>
                  <td class="num"><span class="time muted">${i === 0 ? "—" : "+" + fmtTime(r.time - d.leaderboard[i - 1].time)}</span></td>
                  <td class="num">${strafeCell(r.strafeQuality)}</td>
                  <td class="num">${triesCell(r.attempts)}</td>
                  <td><span class="pill ${r.version === 1 ? "v1" : ""}">${esc(r.versionName || "")}</span></td>
                </tr>`).join("") || `<tr><td colspan="8" class="empty">No runs recorded.</td></tr>`}
            </tbody>
          </table>
        </div></div>
      </div>
      ${d.heatmap ? `
      <div class="map-heat map-hero-viz">
        <div class="kicker orange">◭ ${d.heatmap.mapBase ? "Map + traffic heatmap" : "Traffic heatmap"} · top-down</div>
        <div class="map-heat-img"><img src="${esc(d.heatmap.url)}" width="${d.heatmap.width || ""}" height="${d.heatmap.height || ""}"
          alt="Top-down ${d.heatmap.mapBase ? "map of " : "heatmap of where players have raced on "}${esc(baseMapName(d.name))}${d.heatmap.mapBase ? " with a traffic heatmap of where players have raced" : ""}" loading="lazy"></div>
        <p class="map-heat-cap">Every ranked player's fastest line through <b>${esc(baseMapName(d.name))}</b>, seen from above${d.heatmap.mapBase ? " over the map's layout, with the start ⬤, checkpoints ①② and finish ▣ marked" : ""} — brighter means busier.
          ${fmtNum(d.heatmap.players)} run${d.heatmap.players === 1 ? "" : "s"} · refreshed nightly.</p>
      </div>` : ""}
    </div>

    ${d.recentFinishes && d.recentFinishes.length ? `
    <div class="page-title" style="font-size:20px">RECENT FINISHES <span class="accent">·</span> every run</div>
    <div class="panel" style="margin-bottom:24px">${finishFeed(d.recentFinishes, { showMap: false, showPlayer: true })}</div>` : ""}

    <div class="mapflag" id="mapflag">
      <button class="flag-toggle" type="button">⚑ Flag this map for review</button>
      <form class="flag-form" hidden>
        <div class="flag-title">Report a problem with this map</div>
        <label class="flag-label" for="flag-reason">Reason</label>
        <select id="flag-reason" class="flag-reason">
          ${FLAG_REASONS_UI.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}
        </select>
        <label class="flag-label" for="flag-note">Details <span class="flag-opt">(optional)</span></label>
        <textarea id="flag-note" class="flag-note" rows="2" maxlength="500"
          placeholder="What's wrong? (max 500 characters)"></textarea>
        <div class="flag-actions">
          <button class="flag-submit btn" type="submit">Submit report</button>
          <button class="flag-cancel btn" type="button">Cancel</button>
          <span class="flag-msg" role="status" aria-live="polite"></span>
        </div>
      </form>
    </div>`;

  wireFlag(id);
}

// Wire the "flag this map" control rendered by viewMap. Kept out of the
// delegated data-nav dispatch because it POSTs and manages its own inline
// status, rather than routing.
function wireFlag(id) {
  const root = document.getElementById("mapflag");
  if (!root) return;
  const toggle = root.querySelector(".flag-toggle");
  const form = root.querySelector(".flag-form");
  const note = root.querySelector(".flag-note");
  const msg = root.querySelector(".flag-msg");
  const submit = root.querySelector(".flag-submit");
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) root.querySelector(".flag-reason").focus();
  });
  root.querySelector(".flag-cancel").addEventListener("click", () => {
    form.hidden = true;
    msg.textContent = "";
    msg.className = "flag-msg";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = root.querySelector(".flag-reason").value;
    submit.disabled = true;
    msg.className = "flag-msg";
    msg.textContent = "Sending…";
    try {
      const r = await apiPost(`/maps/${id}/flag`, { reason, note: note.value.trim() });
      msg.textContent = r.duplicate ? "You've already reported this map — thanks!" : "Thanks — flagged for review.";
      msg.classList.add("ok");
      note.value = "";
      toggle.textContent = "⚑ Reported — thank you";
      setTimeout(() => { form.hidden = true; }, 1500);
    } catch (err) {
      msg.classList.add("err");
      msg.textContent = /429/.test(String(err && err.message)) ? "Too many reports — try again later." : "Couldn't submit — please try again.";
    } finally {
      submit.disabled = false;
    }
  });
}

/* ------------------------------ replay view ------------------------------ */
// The 3D viewer is a lazily-imported ES module (three.js). It returns a
// cleanup function we must call when leaving the route to free the WebGL
// context and animation loop.
let disposeReplay = null;
function stopReplay() {
  if (disposeReplay) {
    try { disposeReplay(); } catch (e) { /* ignore */ }
    disposeReplay = null;
  }
}

// Replay a specific player's run (playerId) or, when omitted, the map's fastest
// recorded run (the WR replay). The ghost JSON carries the holder + time, so we
// fetch it for the header; the endpoint is cached, so mountReplay's own fetch of
// the same URL is served from the browser cache (no double download).
async function viewReplay(id, playerId = null) {
  loading();
  const d = await api(`/maps/${id}?limit=1`);
  const ghostUrl = `/api/maps/${id}/ghost${playerId ? `?player=${playerId}` : ""}`;
  let ghost = null;
  try {
    const r = await fetch(ghostUrl);
    if (r.ok) ghost = await r.json();
  } catch { /* fall through to the empty state */ }
  if (!ghost) {
    app.innerHTML = `<div class="crumbs"><a data-nav="#/map/${id}">${esc(d.name)}</a> / Replay</div>
      <div class="empty">No in-browser replay for this run yet.<br><small>A ghost is captured the next time this run's player sets a personal best here.</small></div>`;
    return;
  }
  const isWr = d.wr && ghost.time === d.wr.time;
  // Only the WR replay shows a demo button here; per-run demos live on the
  // leaderboard / player-profile rows.
  const demo = !playerId && d.wr && d.wr.demo && d.wr.demo.url ? d.wr.demo : null;
  track("Watch replay", { map: d.name, kind: isWr ? "wr" : "pb" });
  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/maps">Maps</a> / <a data-nav="#/map/${id}">${esc(d.name)}</a> / Replay</div>
    <div class="replay-head">
      <div class="page-title" style="font-size:24px">${esc(d.name)} <span class="accent">·</span> Replay</div>
      <div class="replay-sub">by ${wname(ghost.player)}
        <span class="pill ${isWr ? "wr" : "v1"}">${isWr ? "WORLD RECORD" : "personal best"}</span>
        <span class="time">${fmtTime(ghost.time)}</span>
        ${!isWr && d.wr ? `<span class="muted">· map WR is ${fmtTime(d.wr.time)}</span>` : ""}
        ${demo ? `<a class="btn replay-demo" href="${esc(demo.url)}" download rel="noopener">⬇ Download demo</a>` : ""}
      </div>
    </div>
    <div id="replay-root" class="replay-root"></div>`;
  const root = document.getElementById("replay-root");
  try {
    const mod = await import("/assets/js/replay.js" + (REPLAY_V ? "?v=" + REPLAY_V : ""));
    disposeReplay = await mod.mountReplay(root, { mapId: id, mapName: d.name, wr: { ghost: { url: ghostUrl } } });
  } catch (e) {
    root.innerHTML = `<div class="empty">Replay failed to load<br><small>${esc(e.message || e)}</small></div>`;
  }
}

async function viewPlayer(id, params) {
  loading();
  const state = {
    q: params.q || "",
    version: params.version || "",
    sort: params.sort || "time",
    order: params.order || "asc",
    offset: parseInt(params.offset || "0", 10) || 0,
  };
  const d = await api(
    `/players/${id}` +
      buildQuery({ q: state.q, version: state.version, sort: state.sort, order: state.order, limit: PAGE, offset: state.offset })
  );
  const s = d.standing;
  track("View player", { player: (d.name || "").replace(/\^[0-9]/g, "") });
  const rec = d.records;
  const hasAttempts = d.attempts != null; // legacy DBs have no attempts column
  const cols = 5 + (hasAttempts ? 1 : 0); // Map, Time, Rank, Version, Replay (+Attempts)

  const versionOpts =
    `<option value="">All versions</option>` +
    (d.versions || [])
      .map(
        (v) =>
          `<option value="${v.id}" ${String(state.version) === String(v.id) ? "selected" : ""}>${esc(v.name)} (${fmtNum(v.count)})</option>`
      )
      .join("");

  const aliasHtml =
    d.aliases && d.aliases.length
      ? `<div class="aliases">also raced as ${d.aliases
          .slice(0, 12)
          .map((a) => wname(a.name))
          .join('<span class="sep">·</span>')}${d.aliases.length > 12 ? ` <span class="muted">+${d.aliases.length - 12} more</span>` : ""}</div>`
      : "";

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/players">Players</a> / ${esc(d.simplified)}</div>
    <div class="page-title" style="font-size:34px">${wname(d.name)}<span class="cmp-cta" data-nav="#/compare?a=${d.id}" title="Compare this player head-to-head with another">⚔ Compare</span></div>
    <p class="page-sub">${s.rank ? "Overall rank #" + s.rank : "Unranked"}${d.login ? " · login: " + esc(d.login) : ""}</p>
    ${aliasHtml}

    <div class="statrow">
      <div class="s hl"><div class="n">${fmtNum(s.points)}</div><div class="l">Points</div></div>
      ${s.srRanked === false
        ? `<div class="s hl" title="A Skill Rating needs ${fmtNum(s.srMinMaps)} finished maps — below that the number would be mostly the starting rating rather than your runs. ${fmtNum(s.srMapsToRank)} to go."><div class="n sr-unranked">—</div><div class="l">Skill Rating · ${fmtNum(s.srMapsToRank)} map${s.srMapsToRank === 1 ? "" : "s"} to go</div></div>`
        : `<div class="s hl" title="Skill Rating — how close your strongest runs get to the world record, against real fields (0–1000)"><div class="n">${fmtNum(s.sr)}</div><div class="l">Skill Rating</div></div>`}
      <div class="s"><div class="n">${fmtNum(s.wr)}</div><div class="l">World Records</div></div>
      <div class="s"><div class="n">${fmtNum(s.podium)}</div><div class="l">Podiums</div></div>
      <div class="s"><div class="n">${fmtNum(s.maps)}</div><div class="l">Maps Raced</div></div>
      ${d.finishes != null ? `<div class="s"><div class="n">${fmtNum(d.finishes)}</div><div class="l">Finishes</div></div>` : ""}
      ${d.attempts != null ? `<div class="s"><div class="n">${fmtNum(d.attempts)}</div><div class="l">Attempts</div></div>` : ""}
    </div>

    ${d.metrics ? `
    <div class="statrow" title="Movement events counted during races (approximate)">
      <div class="s"><div class="n">${fmtNum(d.metrics.wallJumps)}</div><div class="l">Wall Jumps</div></div>
      <div class="s"><div class="n">${fmtNum(d.metrics.dashes)}</div><div class="l">Dashes</div></div>
      <div class="s"><div class="n">${fmtNum(d.metrics.prejumpFailures)}</div><div class="l">Prejump Fails</div></div>
      <div class="s"><div class="n">${fmtNum(d.metrics.restarts)}</div><div class="l">Restarts</div></div>
      ${d.metrics.strafeQuality != null ? `<div class="s" title="Average accel efficiency across your finished runs — how close your strafing stays to the ideal angle, sampled only while actually strafing (forward + left or right) at 600+ ups (higher is better)"><div class="n">${(Math.round(d.metrics.strafeQuality * 10) / 10).toFixed(1)}%</div><div class="l">Strafe Quality</div></div>` : ""}
      ${d.metrics.distance ? `<div class="s" title="Total distance travelled while racing, in game units"><div class="n">${fmtDist(d.metrics.distance)}</div><div class="l">Distance Raced</div></div>` : ""}
      ${d.metrics.strafes ? `<div class="s" title="Air-strafe segments counted while racing — genuine strafing (forward + left or right, mouse turning with it) at 600+ ups"><div class="n">${fmtNum(d.metrics.strafes)}</div><div class="l">Strafes</div></div>` : ""}
      ${d.metrics.maxSpeed ? `<div class="s" title="Fastest speed hit in any finished run (ups)"><div class="n">${fmtNum(d.metrics.maxSpeed)}</div><div class="l">Top Speed</div></div>` : ""}
    </div>` : ""}

    <div class="grid-2">
      <div>${srHistoryCard(d.srHistory, d.id)}</div>
      <div>${strafeQualityCard(d.strafeHistory)}</div>
    </div>

    ${srDistCard()}

    ${trophiesCard(d.trophies)}

    ${achievementsCard(d.achievements)}

    ${d.recentFinishes && d.recentFinishes.length ? `
    <div class="page-title" style="font-size:20px">RECENT FINISHES <span class="accent">·</span> last 5</div>
    <div class="panel" style="margin-bottom:24px">${finishFeed(d.recentFinishes, { showMap: true, showPlayer: false })}</div>` : ""}

    <div class="page-title" style="font-size:20px">RECORDS <span class="accent">·</span> ${fmtNum(rec.total)}</div>
    <div class="toolbar">
      <input class="filter" id="rfilter" placeholder="Search this player's maps…" value="${esc(state.q)}">
      <select class="filter version" id="rversion" title="Filter by game version">${versionOpts}</select>
      <span class="count">${fmtNum(rec.total)} records</span>
    </div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          ${th("Map", "map", state)}
          ${th("Time", "time", state, "num")}
          ${th("Global Rank", "rank", state, "num")}
          <th>Version</th>
          ${hasAttempts ? th("Attempts", "attempts", state, "num") : ""}
          <th>Replay</th>
        </tr></thead>
        <tbody>
          ${rec.rows.map((r) => `
            <tr class="clickable" data-nav="#/map/${r.map_id}">
              <td class="mapname">${mapNameHtml(r.map_name)}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num ${rankClass(r.rank)}">${r.rank === 1 ? '<span class="pill wr">WR</span> ' : ""}#${fmtNum(r.rank)}</td>
              <td><span class="pill ${r.version === 1 ? "v1" : ""}">${esc(r.versionName || "")}</span></td>
              ${hasAttempts ? `<td class="num"><span class="muted">${fmtNum(r.attempts)}</span></td>` : ""}
              <td class="replaycell">${r.ghost ? `<span class="replay-badge" data-nav="#/replay/${r.map_id}/${d.id}" title="Watch this run in the browser">▶ replay</span>` : ""}${r.demo && r.demo.url ? ` <a class="replay-badge demo" href="${esc(r.demo.url)}" download rel="noopener" title="Download this run's demo">⬇ demo</a>` : ""}</td>
            </tr>`).join("") || `<tr><td colspan="${cols}" class="empty">${state.q || state.version ? "No records match those filters." : "No records."}</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, rec, `#/player/${id}`)}</div>`;

  wireFilter("rfilter", `#/player/${id}`, state);
  const vsel = document.getElementById("rversion");
  if (vsel)
    vsel.addEventListener("change", () =>
      go(`#/player/${id}` + buildQuery({ ...pageParams(state), version: vsel.value, offset: 0 }))
    );
  wireSort(`#/player/${id}`, state, ["map", "time", "rank", "attempts"]);
  wireSrBreakdown(d.id); // canonical id — the breakdown endpoint resolves either, but keep the link stable
  wireSrDistribution(d);
  wireAchievements(d.id);
  // (The address bar is already the clean /player/<id> path from pushState —
  // where the server-rendered OG tags for Discord/social unfurls live.)
}

/* ---------------------------- compare view ------------------------------- */
// Head-to-head: two players side by side. Deep-linkable as /compare?a=&b=; each
// slot is a search-picker so either player can be swapped without losing the
// other. The "who's better" call leans on the direct record on shared maps.
async function viewCompare(params) {
  loading();
  const aId = parseInt(params.a, 10) || null;
  const bId = parseInt(params.b, 10) || null;

  // Both slots chosen -> fetch the comparison; otherwise just render the
  // pickers (with whichever slot is already filled shown as its card).
  let cmp = null;
  if (aId && bId) {
    try { cmp = await api(`/compare${buildQuery({ a: aId, b: bId })}`); }
    catch (e) { return errorView(e); }
  }

  // A slot's current player label for the picker's filled state. When we have a
  // comparison its own a/b are authoritative (they're already canonical);
  // otherwise resolve the lone filled slot from the player endpoint.
  async function slotName(id) {
    if (!id) return null;
    try { const d = await api(`/players/${id}?limit=1`); return { id: d.id, name: d.name, simplified: d.simplified }; }
    catch { return null; }
  }
  const [aCard, bCard] = cmp && !cmp.same
    ? [cmp.a, cmp.b]
    : await Promise.all([slotName(aId), slotName(bId)]);

  const picker = (slot, card, other) => `
    <div class="cmp-slot">
      <div class="cmp-slot-head">Player ${slot.toUpperCase()}</div>
      ${card
        ? `<div class="cmp-picked" data-nav="#/player/${card.id}">${wname(card.name)}</div>`
        : `<div class="cmp-picked empty">— pick a player —</div>`}
      <div class="gsearch cmp-search">
        <input id="cmp-${slot}" placeholder="Search a player…" autocomplete="off">
        <div class="results" id="cmp-${slot}-res"></div>
      </div>
    </div>`;

  const cmpHtml = cmp && !cmp.same ? renderCompare(cmp) : cmp && cmp.same
    ? `<div class="empty">That's the same player on both sides — pick two different players.</div>`
    : `<div class="empty cmp-hint">Pick a player on each side to see who comes out ahead — overall standings and their record on every map they've both raced.</div>`;

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/players">Players</a> / Compare</div>
    <div class="page-title"><span class="accent">COMPARE</span> PLAYERS</div>
    <p class="page-sub">Put two racers head to head: overall Points &amp; Skill Rating, world records, and their direct record on every shared map.</p>
    <div class="cmp-pickers">
      ${picker("a", aCard, bId)}
      <div class="cmp-vs">vs</div>
      ${picker("b", bCard, aId)}
    </div>
    ${cmpHtml}`;

  wireComparePicker("a", { a: aId, b: bId });
  wireComparePicker("b", { a: aId, b: bId });
}

// The A-side is coloured `a`, B-side `b`; a cell wins by carrying the .win class.
function renderCompare(cmp) {
  const { a, b, summary: sm, head } = cmp;
  const nameA = `<span class="cmp-name a">${wname(a.name)}</span>`;
  const nameB = `<span class="cmp-name b">${wname(b.name)}</span>`;

  const verdict = sm.leader
    ? `<div class="cmp-verdict ${sm.leader}">
         ${sm.leader === "a" ? nameA : nameB} <b>comes out ahead</b>
         <span class="cmp-basis">${
           sm.basis === "head-to-head"
             ? `faster on ${sm.leader === "a" ? sm.aWins : sm.bWins} of ${sm.shared} shared map${sm.shared === 1 ? "" : "s"}`
             : sm.basis === "sr" ? "higher Skill Rating (no head-to-head split it)"
             : "more Points (dead heat everywhere else)"
         }</span>
       </div>`
    : `<div class="cmp-verdict tie">Dead even — nothing separates these two.</div>`;

  const row = (label, av, bv, winner, fmt = fmtNum, hint = "") => `
    <tr>
      <td class="num cmp-a ${winner === "a" ? "win" : ""}">${fmt(av)}</td>
      <td class="cmp-metric">${label}${hint ? ` <span class="cmp-mhint">${hint}</span>` : ""}</td>
      <td class="num cmp-b ${winner === "b" ? "win" : ""}">${fmt(bv)}</td>
    </tr>`;

  const statTable = `
    <div class="panel cmp-stats">
      <table class="data cmp-table">
        <thead><tr><th class="num">${nameA}</th><th class="cmp-metric">Metric</th><th class="num">${nameB}</th></tr></thead>
        <tbody>
          ${row("Points", a.standing.points, b.standing.points, sm.metrics.points)}
          ${row("Skill Rating", a.standing.sr, b.standing.sr, sm.metrics.sr)}
          ${row("World Records", a.standing.wr, b.standing.wr, sm.metrics.wr)}
          ${row("Podiums", a.standing.podium, b.standing.podium, sm.metrics.podium)}
          ${row("Maps Raced", a.standing.maps, b.standing.maps, sm.metrics.maps)}
          <tr class="cmp-h2h">
            <td class="num cmp-a ${sm.aWins > sm.bWins ? "win" : ""}">${fmtNum(sm.aWins)}</td>
            <td class="cmp-metric">Head-to-head wins <span class="cmp-mhint">${fmtNum(sm.shared)} shared${sm.ties ? ` · ${fmtNum(sm.ties)} tied` : ""}</span></td>
            <td class="num cmp-b ${sm.bWins > sm.aWins ? "win" : ""}">${fmtNum(sm.bWins)}</td>
          </tr>
        </tbody>
      </table>
      ${sm.shared && sm.relMargin != null
        ? `<div class="cmp-margin">On shared maps, ${Math.abs(sm.relMargin) < 0.0005
             ? "the two are level on average."
             : `${(sm.relMargin > 0 ? nameA : nameB)} is <b>${(Math.abs(sm.relMargin) * 100).toFixed(1)}%</b> faster on average.`}</div>`
        : ""}
    </div>`;

  const h2hTable = sm.shared
    ? `<div class="page-title" style="font-size:20px">SHARED MAPS <span class="accent">·</span> ${fmtNum(sm.shared)}</div>
       <p class="page-sub">Most competitive first (both near the top). ${head.length < sm.shared ? `Showing the top ${fmtNum(head.length)}.` : ""}</p>
       <div class="table-wrap"><div class="tscroll">
         <table class="data cmp-maps">
           <thead><tr>
             <th>Map</th>
             <th class="num">${nameA}</th>
             <th class="num">${nameB}</th>
             <th class="num">Gap</th>
           </tr></thead>
           <tbody>
             ${head.map((h) => `
               <tr class="clickable" data-nav="#/map/${h.mapId}">
                 <td class="mapname">${mapNameHtml(h.name)}</td>
                 <td class="num cmp-a ${h.winner === "a" ? "win" : ""}"><span class="time">${fmtTime(h.aTime)}</span> <span class="cmp-rk ${rankClass(h.aRank)}">#${fmtNum(h.aRank)}</span></td>
                 <td class="num cmp-b ${h.winner === "b" ? "win" : ""}"><span class="time">${fmtTime(h.bTime)}</span> <span class="cmp-rk ${rankClass(h.bRank)}">#${fmtNum(h.bRank)}</span></td>
                 <td class="num"><span class="time muted">${h.winner === "tie" ? "—" : "+" + fmtTime(h.delta)}</span></td>
               </tr>`).join("")}
           </tbody>
         </table>
       </div></div>`
    : `<div class="empty">These two have no maps in common yet — the verdict above is based on overall standings.</div>`;

  return verdict + statTable + h2hTable;
}

// One compare slot's search-picker. Selecting a result re-navigates to
// /compare with that slot updated, preserving the other slot.
function wireComparePicker(slot, cur) {
  const input = document.getElementById(`cmp-${slot}`);
  const box = document.getElementById(`cmp-${slot}-res`);
  if (!input || !box) return;
  let timer, inflight;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.remove("show"); box.innerHTML = ""; inflight?.abort(); return; }
    timer = setTimeout(async () => {
      try {
        inflight?.abort();
        inflight = new AbortController();
        const res = await fetch("/api/search?q=" + encodeURIComponent(q), { signal: inflight.signal });
        if (!res.ok) return;
        const d = await res.json();
        box.innerHTML = d.players.length
          ? d.players.map((p) => `
              <div class="ritem" data-cmp-pick="${p.id}">
                <span>${wname(p.name)}</span><small>#${p.rank} · ${fmtNum(p.points)} pts</small>
              </div>`).join("")
          : `<div class="ritem"><small>No players match.</small></div>`;
        box.classList.add("show");
      } catch (e) { /* aborted / network — ignore */ }
    }, 250);
  });
  box.addEventListener("click", (e) => {
    const item = e.target.closest("[data-cmp-pick]");
    if (!item) return;
    const picked = parseInt(item.getAttribute("data-cmp-pick"), 10);
    go("#/compare" + buildQuery({ ...cur, [slot]: picked }));
  });
}

/* ------------------------------- live view ------------------------------- */
/* Auto-refreshing "who's in the servers right now" page. The backend polls
   the game servers over UDP on its own cadence; we just re-fetch its cached
   snapshot while the tab is visible. */
const LIVE_REFRESH_MS = 5000;
let liveTimer = null;

function stopLiveRefresh() {
  clearInterval(liveTimer);
  liveTimer = null;
}

// Do a peer's map and this server's map refer to the same map? The peer map is
// lowercased + truncated to 16 chars on publish (RACE_MeshStatusClean), so
// compare case-insensitively and allow a truncated peer value to prefix-match.
function meshSameMap(peerMap, myMap) {
  if (!peerMap || !myMap) return false;
  const p = peerMap.toLowerCase();
  const m = myMap.toLowerCase();
  return p.length >= 16 ? m.startsWith(p) : p === m;
}

// Cross-server mesh line(s) for a live card. The meaningful state is "a linked
// server is on the SAME map right now": those players appear in-game as
// translucent ghosts you race alongside. Peers sharing this card's map (and
// actually populated) get a highlighted "racing together" row; the rest are
// shown as a compact "linked" list so it's obvious the servers are joined
// without re-dumping each sibling card's full state.
function renderMesh(s) {
  if (!s.mesh || !s.mesh.length) return "";
  const here = [];
  const linked = [];
  for (const p of s.mesh) {
    if (p.players > 0 && meshSameMap(p.map, s.map)) here.push(p);
    else linked.push(p);
  }
  const rows = [];
  if (here.length) {
    const ghosts = here.reduce((n, p) => n + p.players, 0);
    const who = here.map((p) => esc(p.tag)).join(" + ");
    rows.push(`<div class="mesh-row active"
        title="${here.length} linked server${here.length === 1 ? " is" : "s are"} on this map right now. Those players appear in-game as translucent ghosts — you race alongside them and never collide.">
        <span class="mesh-ico">⇄</span>
        <span class="mesh-txt">Racing together on <b>${esc(s.map || "this map")}</b> · <b>+${ghosts}</b> ghost${ghosts === 1 ? "" : "s"} from ${who}</span>
      </div>`);
  }
  if (linked.length) {
    const chips = linked.map((p) => `
        <span class="mesh-peer" title="${esc(p.tag)}${p.map ? ` is on ${esc(p.map)}` : ""} · ${p.players} player${p.players === 1 ? "" : "s"}">
          <span class="mesh-tag">${esc(p.tag)}</span>
          ${p.map ? `<span class="mesh-map">▸ ${esc(p.map)}</span>` : ""}
          ${p.players > 0 ? `<span class="mesh-num">${fmtNum(p.players)}</span>` : ""}
        </span>`).join("");
    rows.push(`<div class="mesh-row"
        title="These servers are joined into one race mesh. Whenever two are on the same map, their players race together as cross-server ghosts.">
        <span class="mesh-ico">⇄</span>
        <span class="mesh-lbl">Linked</span>
        ${chips}
      </div>`);
  }
  return `<div class="live-mesh">${rows.join("")}</div>`;
}

function liveServerCard(s) {
  const head = `
    <h3>
      <span class="dot ${s.online ? "teal" : ""}"></span>
      <span class="srvname clickable" data-nav="#/server/${s.id}">${esc(s.name)}</span>
      <span class="pill ${s.online ? "ok" : ""}">${s.online ? "online" : "offline"}</span>
      ${s.online && s.maxclients ? `<span class="live-count">${s.players.length}/${s.maxclients}</span>` : ""}
      ${s.stream && s.stream.hls ? `<span class="watch-badge clickable" data-nav="#/server/${s.id}" title="Watch the live stream"><span class="livedot"></span> WATCH</span>` : ""}
    </h3>`;
  if (!s.online) {
    return `<div class="panel live-srv off">${head}
      <div class="muted">Not responding to queries right now.</div></div>`;
  }
  const meta = `
    <div class="live-meta">
      ${s.hostname ? wname(s.hostname) : ""}
      ${s.map ? `<span class="live-map ${s.mapId ? "clickable" : ""}" ${s.mapId ? `data-nav="#/map/${s.mapId}"` : ""}>▸ ${esc(s.map)}</span>` : ""}
      ${s.address ? `<button type="button" class="live-connect mono" data-copy="connect ${esc(s.address)}" title="Click to copy — paste into the Warsow console (~) to join"><span class="live-connect-cmd">connect ${esc(s.address)}</span><span class="live-connect-tag"></span></button>` : ""}
    </div>`;
  // Cross-server mesh: peers this node currently hears (rs_mesh_status). Renders
  // nothing when mirroring is off or no peers are up. See renderMesh.
  const mesh = renderMesh(s);
  const players = s.players.length
    ? `<table class="data">
        <thead><tr><th>Player</th><th class="num">Ping</th></tr></thead>
        <tbody>
          ${s.players.map((p) => `
            <tr class="clickable" data-nav="#/players?q=${encodeURIComponent(p.simplified)}">
              <td>${wname(p.name)}</td>
              <td class="num">${fmtNum(p.ping)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`
    : `<div class="muted live-empty">Server is empty — hop in and set a record.</div>`;
  return `<div class="panel live-srv">${head}${meta}${mesh}${players}</div>`;
}

// Warfork servers are named "... Warfork"; everything else is Warsow.
const isWarforkServer = (s) => /warfork/i.test(s.name || "");

async function renderLive() {
  const d = await api("/live");
  // The API orders servers by last_seen_at, so cards reshuffle as boxes check
  // in. Pin a stable display order: Warsow first, then Warfork, id-tiebroken.
  const servers = d.servers
    .slice()
    .sort((a, b) => (isWarforkServer(a) - isWarforkServer(b)) || (a.id - b.id));
  const online = d.servers.filter((s) => s.online);
  const total = online.reduce((n, s) => n + s.players.length, 0);
  const maint = d.maintenance && d.maintenance.active
    ? `<div class="maint-banner">🛠 Maintenance in progress — ${esc((d.maintenance.message || "").replace(/\^[0-9]/g, ""))}</div>`
    : "";
  // Explain the ⇄ that shows up on meshed cards, but only when a mesh is live.
  const meshNote = online.some((s) => s.mesh && s.mesh.length)
    ? `<p class="live-mesh-note"><span class="mesh-ico">⇄</span> The servers are <b>linked into one mesh</b> — when 2 or more servers share the same map, players race alongside each other as ghosts across the Atlantic.</p>`
    : "";
  const html = `
    ${maint}
    <div class="page-title">LIVE <span class="livedot big"></span></div>
    <p class="page-sub">
      ${d.servers.length
        ? `${total} player${total === 1 ? "" : "s"} in game across ${online.length} of ${d.servers.length} server${d.servers.length === 1 ? "" : "s"}`
        : "Who's racing right now, on this server and every server feeding records here."}
      ${d.updatedAt ? ` · updated ${fmtAgo(d.updatedAt)}` : ""}
    </p>
    ${meshNote}
    ${d.servers.length
      ? `<div class="live-grid">${servers.map(liveServerCard).join("")}</div>`
      : `<div class="empty">No live-enabled servers yet.<br><small>The site admin can add one with <span class="mono">node admin.js address &lt;serverId&gt; &lt;host:port&gt;</span>.</small></div>`}`;
  // Only touch the DOM when something changed — no 5s flicker.
  if (app.dataset.liveHtml !== html) {
    app.dataset.liveHtml = html;
    app.innerHTML = html;
  }
}

async function viewLive() {
  loading();
  delete app.dataset.liveHtml;
  await renderLive();
  stopLiveRefresh();
  liveTimer = setInterval(() => {
    if (document.hidden || parseRoute().path !== "/live") return;
    renderLive().catch(() => {}); // transient fetch errors: keep last snapshot
  }, LIVE_REFRESH_MS);
}

/* ---------------------------- single server ------------------------------ */
// A server's live video stream (when one is configured) lives in its OWN
// element, kept OUTSIDE the 5s body refresh so the <video> is never torn down
// mid-watch. hls.js is vendored (CSP blocks CDNs) and lazily loaded only when a
// server page actually has a stream.
let serverHls = null;
let hlsLoading = null;

function loadHlsJs() {
  if (window.Hls) return Promise.resolve();
  if (hlsLoading) return hlsLoading;
  hlsLoading = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "/assets/vendor/hls/hls.min.js";
    sc.onload = resolve;
    sc.onerror = reject;
    document.head.appendChild(sc);
  }).catch((e) => { hlsLoading = null; throw e; });
  return hlsLoading;
}

function mountHls(video, url) {
  if (!video || !url) return;
  // Safari / iOS play HLS natively; everyone else via hls.js (MSE).
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    return;
  }
  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ liveSyncDurationCount: 3, backBufferLength: 30 });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return; // transient (a rolled segment) — hls.js self-heals
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else { hls.destroy(); if (serverHls === hls) serverHls = null; }
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    serverHls = hls;
  }
}

function stopServerStream() {
  if (serverHls) { try { serverHls.destroy(); } catch { /* ignore */ } serverHls = null; }
}

function streamAreaHtml(stream, address) {
  if (!stream || !stream.hls) return "";
  const pov = stream.pov ? `<span class="srv-pov">watching ${esc(stream.pov)}</span>` : "";
  // Let viewers jump in: show the GAME server's connect string (click to copy).
  const connect = address
    ? `<div class="srv-connect">Jump in — open the Warsow console (<span class="mono">~</span>) and run
         <button type="button" class="connect-copy mono" data-copy="connect ${esc(address)}"
           title="Click to copy">connect ${esc(address)}</button></div>`
    : "";
  return `
    <div class="srv-stream panel">
      <div class="srv-stream-head"><span class="livedot"></span> LIVE STREAM ${pov}</div>
      <video id="srvVideo" class="live-video" controls autoplay muted playsinline></video>
      ${connect}
    </div>`;
}

function serverBodyHtml(s) {
  const li = s.live || { online: false, players: [] };
  const statusPill = `<span class="pill ${li.online ? "ok" : ""}">${li.online ? "online" : "offline"}</span>`;
  const meta = li.online
    ? `<div class="live-meta">
        ${li.hostname ? wname(li.hostname) : ""}
        ${li.map ? `<span class="live-map ${li.mapId ? "clickable" : ""}" ${li.mapId ? `data-nav="#/map/${li.mapId}"` : ""}>▸ ${esc(li.map)}</span>` : ""}
        ${s.address ? `<button type="button" class="live-connect mono" data-copy="connect ${esc(s.address)}" title="Click to copy — paste into the Warsow console (~) to join"><span class="live-connect-cmd">connect ${esc(s.address)}</span><span class="live-connect-tag"></span></button>` : ""}
      </div>`
    : `<div class="live-meta"><span class="muted">Not responding to queries right now.</span></div>`;
  const players = li.online
    ? (li.players.length
        ? `<div class="tscroll"><table class="data">
            <thead><tr><th>Player</th><th class="num">Ping</th></tr></thead>
            <tbody>
              ${li.players.map((p) => `
                <tr class="clickable" data-nav="#/players?q=${encodeURIComponent(p.simplified)}">
                  <td>${wname(p.name)}</td><td class="num">${fmtNum(p.ping)}</td>
                </tr>`).join("")}
            </tbody></table></div>`
        : `<div class="muted live-empty">Server is empty — hop in and set a record.</div>`)
    : "";

  return `
    <div class="crumbs"><a data-nav="#/live">Live</a> / ${esc(s.name)}</div>
    <div class="page-title" style="font-size:32px">
      <span class="livedot ${li.online ? "" : "off"}"></span> ${esc(s.name)} ${statusPill}
    </div>
    <p class="page-sub">${li.online && li.maxclients ? `${li.players.length} / ${li.maxclients} playing · ` : ""}${s.updatedAt ? `updated ${fmtAgo(s.updatedAt)}` : ""}</p>

    <div class="panel live-srv">${meta}${players}</div>

    <div class="statrow" style="margin-top:20px">
      <div class="s hl"><div class="n">${fmtNum(s.records)}</div><div class="l">Records Contributed</div></div>
      <div class="s"><div class="n">${s.last_seen_at ? fmtAgo(s.last_seen_at) : "—"}</div><div class="l">Last Record</div></div>
      <div class="s"><div class="n">${s.status}</div><div class="l">Status</div></div>
      ${s.created_at ? `<div class="s"><div class="n">${new Date(s.created_at * 1000).toISOString().slice(0, 10)}</div><div class="l">Enrolled</div></div>` : ""}
    </div>`;
}

// Refresh only the body (stats/players); the stream player above is untouched.
async function renderServerBody(id) {
  const s = await api(`/servers/${id}`);
  const body = document.getElementById("srvBody");
  if (!body) return s;
  const html = serverBodyHtml(s);
  if (body.dataset.html !== html) { body.dataset.html = html; body.innerHTML = html; }
  return s;
}

async function viewServer(id) {
  loading();
  stopServerStream();
  const s = await api(`/servers/${id}`);
  const stream = s.stream && s.stream.hls ? s.stream : null;
  const bodyHtml = serverBodyHtml(s);
  app.innerHTML = `${streamAreaHtml(stream, s.address)}<div id="srvBody"></div>`;
  const body = document.getElementById("srvBody");
  body.dataset.html = bodyHtml;
  body.innerHTML = bodyHtml;
  if (stream) {
    try { await loadHlsJs(); } catch { /* leave a bare <video> if hls.js won't load */ }
    if (parseRoute().path === `/server/${id}`) mountHls(document.getElementById("srvVideo"), stream.hls);
  }
  stopLiveRefresh();
  liveTimer = setInterval(() => {
    if (document.hidden || parseRoute().path !== `/server/${id}`) return;
    renderServerBody(id).catch(() => {});
  }, LIVE_REFRESH_MS);
}

/* ------------------------------- about ----------------------------------- */
// Static reference page: what Racesow is, how to connect, the in-game command
// list (mirrors server/racemod/.../hrace/commands.as + the mesh commands in
// mirror.as / meshvote.as) and an FAQ. Kept data-driven so the command tables
// and FAQ stay easy to edit as the gametype changes.
const ABOUT_SERVERS = [
  { name: "Racesow · EU Central", region: "Frankfurt, DE", connect: "eu.frankfurt.racesow.org:44400" },
  { name: "Racesow · US East", region: "US East", connect: "us.east.racesow.org:44400" },
];

const ABOUT_CMDS = [
  {
    title: "Racing",
    rows: [
      ["/kill", "Cancel your run and respawn at the start. Your timer resets. (alias /racerestart)"],
      ["/top", "List the fastest recorded times on the current map."],
      ["/maplist <*|pattern> [page]", "Search the maps this server has. Use * for everything, or a keyword."],
      ["/callvote map <name>", "Put a specific map to a vote."],
      ["/callvote randmap <*|pattern>", "Vote for a random map from the matching pool."],
    ],
  },
  {
    title: "Your saved start",
    note: "Pick where you begin a map and keep it. Your start is saved per map and comes back the next time you join the server — normal and reverse races each keep their own.",
    rows: [
      ["/savestart", "Save your current spot and facing as your personal start for this map. You'll spawn here on join, /kill and restarts instead of the map's default start. In reverse mode it saves your reverse start."],
      ["/clearstart", "Forget your saved start for this map (in the direction you're in) and go back to the map's default spawn."],
    ],
  },
  {
    title: "Practice mode",
    note: "Times are NOT recorded while any of these are in effect. Use /kill to get back to a clean start and race for real.",
    rows: [
      ["/practicemode", "Toggle practice mode on/off."],
      ["/noclip", "Fly through the world to line things up (practice mode only)."],
      ["/position save", "Save your current spot and weapons as your spawn point."],
      ["/position load", "Teleport back to your saved spot."],
      ["/position speed <value>", "Spawn carrying this much speed, e.g. 1000. Use 0 to reset."],
      ["/position clear", "Reset your saved spot and weapons to defaults."],
    ],
  },
  {
    title: "Recall — rewind your run",
    note:
      "While you race (not in practice mode) the server snapshots your position, speed and weapons twice a second. Afterwards you can step back through those snapshots and restart the run from any one of them, so you can drill the jump you keep missing instead of running the map from the start every time. The loop: race until you mess up → /practicemode → /noclip → hold attack to enter recall → rewind to just before the mistake → /kill, and you respawn right there with your speed, weapons and race clock intact. In recall, forward/back step one snapshot, left/right jump five, attack leaves again; the screen shows which snapshot you're on, the run time, checkpoint and speed. Around 6½ minutes of a run is kept.",
    rows: [
      ["attack (in noclip)", "Enter recall, and press it again to leave and go back where you were."],
      ["forward / back", "Step one snapshot later / earlier in the run."],
      ["left / right", "Jump five snapshots at a time."],
      ["/kill", "Restart the run from the snapshot you're on, with its speed, weapons and clock."],
      ["/position recall <offset>", "Step this many snapshots (negative goes back, e.g. -10). Enters recall too, so it works without the noclip keys — handy to bind to a key."],
      ["/position recall start | end", "Jump to the first / last snapshot of the run."],
      ["/position recall cpX", "Jump to just after checkpoint X, e.g. cp2."],
      ["/position recall rl | pg | gl", "Jump to the first snapshot where you were carrying that weapon."],
      ["/position recall exit", "Leave recall and go back to where you were before you entered."],
      ["/position recall best [player]", "Recall your best run this session instead of your last one. With a name, recall that player's best run — the easiest way to learn a route someone faster is using."],
      ["/position recall current <player>", "Same, but takes the run that player is in the middle of right now."],
      ["/position recall steal", "While spectating someone, take the run they're on. No name needed."],
      ["/position recall extend on|off", "When on, retrying from a recalled spot records over the rest of the run, so the snapshots follow your improved line. Off by default."],
      ["/position recall interval <ms|auto>", "Milliseconds between snapshots (500 by default; lower is a finer rewind but covers less of the run, as 800 are kept). 'auto' spreads them over your best time."],
      ["/position recall delay <n>", "Frames you stay frozen after respawning into a recalled spot (20 by default), so walljump and dash timing is identical every retry."],
      ["/position recall fake <ms>", "Advanced: treat your hand-saved position as if it came from a run at this time, so restarting from it starts the clock there."],
    ],
  },
  {
    title: "Reverse mode",
    note: "Race the map backwards. Cross the FINISH line to start your timer, run the checkpoints in reverse, and cross the START line to finish. Prejump rules still apply. Your time is saved on a separate “<map>-reversed” leaderboard (shown with a REVERSE badge on this site) and never mixes with the normal times.",
    rows: [
      ["/reverse", "Race the map backwards. Teleports you to your saved reverse start (or the finish line, if you haven't saved one with /savestart) and drops you into noclip to fine-tune the spot; leave noclip (/noclip, or /reverse again) to lock it in as your spawn. Then cross the finish to start."],
      ["/showtriggers", "Toggle markers at the start and finish trigger planes so you can see where to cross. Only you see them."],
      ["/showslick", "Toggle an outline around the slick (icy) floor near you, so you can see exactly where you lose grip. Off by default; only you see it."],
      ["/reverse off", "Leave reverse mode and go back to a normal run. /kill and restarts return you to your saved reverse start."],
    ],
  },
  {
    title: "Chat & players",
    rows: [
      ["/m <name> <message>", "Private-message a player (partial name matches). Reply with /m + part of their name."],
    ],
  },
  {
    title: "Cross-server mesh",
    note: "The servers above are linked. On the same map you'll see players from the other server as translucent ghosts, and their chat arrives with a [TAG] prefix.",
    rows: [
      ["/who", "List who's playing on every linked server right now."],
      ["/watch <name>", "Lock your spectator camera onto a player on another server to study their route."],
      ["/meshvote <map>", "Start a vote to switch every linked server to a map together. (alias /mv)"],
      ["/mv yes | no | status | cancel", "Cast your vote, show the live tally, or (as starter) cancel it."],
    ],
  },
  {
    title: "Report a bad map",
    note: "Broken, unfinishable, offensive, or a duplicate? Flag it. Moderators review flagged maps and can pull one from the vote pool and map cycle.",
    rows: [
      ["/flag [reason]", "Flag the map you're currently on for review. Optional reason: broken, offensive, wrong_name, duplicate. One flag per player per map."],
    ],
  },
];

const ABOUT_FAQ = [
  ["What is Racesow?",
    "Racesow is Warsow's race gametype: no fighting, just you against the clock. Rocket-jump, plasma-climb, strafe and bunny-hop from the start line to the finish as fast as you can. Every map keeps its own leaderboard and world record."],
  ["How do I join?",
    "Grab the <a class=\"extlink\" href=\"https://warsow.net/\" target=\"_blank\" rel=\"noopener external\">Warsow</a> 2.1 client, open the in-game console with the <b>~</b> key, and type one of the <b>connect</b> strings above. Any maps you don't already have download automatically from the server when you join."],
  ["Why aren't my old racemod binds and settings here?",
    "This server's mod folder is called <span class=\"mono\">racemod</span>, but the old livesow / mgxrace servers ran under <span class=\"mono\">racemod_2.1</span>. Warsow keeps each mod's binds, configs and texture packs in its own folder, so your old setup doesn't carry over on its own. To bring it across, open your Warsow game folder, go into the old <span class=\"mono\">racemod_2.1</span> folder, and copy your config files (e.g. <span class=\"mono\">config.cfg</span> / autoexec) and any texture or HUD packs into the <span class=\"mono\">racemod</span> folder. Restart Warsow, reconnect, and your binds will be back."],
  ["Why wasn't my time saved?",
    "Times only count in a clean race-mode run. If you toggled <span class=\"mono\">/practicemode</span>, <span class=\"mono\">/noclip</span>, or used <span class=\"mono\">/position</span>, that run won't be recorded. Use <span class=\"mono\">/kill</span> to get back to the start and race it straight through."],
  ["What is reverse mode?",
    "Reverse mode lets you race a map <b>backwards</b>. Type <span class=\"mono\">/reverse</span> to turn it on: it teleports you to just outside the map's <b>finish</b> line — your reverse start — and drops you into noclip to fine-tune the exact spot. Leave noclip (<span class=\"mono\">/noclip</span>, or <span class=\"mono\">/reverse</span> again) to lock it in as your spawn — <span class=\"mono\">/kill</span> and restarts return you there. Then run through the finish line to start the clock, run the checkpoints in reverse, and cross the <b>start</b> line to finish. Prejump rules still apply. Use <span class=\"mono\">/showtriggers</span> to see where the planes are. Reverse times live on their own separate leaderboard — the map appears here as <span class=\"mono\">&lt;map&gt;-reversed</span> with a <span class=\"pill rev\">REVERSE</span> badge — and never mix with the normal times. Use <span class=\"mono\">/reverse off</span> to go back to a normal run."],
  ["What are the ghosts I keep seeing?",
    "The EU and US servers are meshed. Players on the other server show up as translucent, non-solid ghosts whenever you're on the same map, so you can race alongside them across the Atlantic. You never collide with them. Use <span class=\"mono\">/who</span> to see who's who, and <span class=\"mono\">/watch</span> to follow one."],
  ["Who's the ghost racing the world record?",
    "On any map that has a record, the current world-record run can replay in-game as a translucent ghost you can pace yourself against — this one's the record, separate from the cross-server player ghosts above. You never collide with it and it's never timed. It's hidden by default: to see it, open <span class=\"mono\">Race Options</span> (the gametype menu, bound to <span class=\"mono\">gametypemenu</span>) and tick <b>Show world-record ghost</b> — the <span class=\"mono\">cg_raceShowWorldRecord</span> setting. That shows it for you only; it doesn't change anyone else's view, and your times are unaffected."],
  ["How do records end up on this site?",
    "Each server reports finished runs to the central database here. New personal bests and world records appear within seconds, along with a downloadable demo and an in-browser replay ghost you can scrub through."],
  ["Can I watch a record?",
    "Yes. Open any map and look for a <b>▶ replay</b> badge to watch the ghost right in your browser, or <b>⬇ demo</b> to download it. To play a demo back in Warsow, drop the file in your <span class=\"mono\">racemod/demos</span> folder and run <span class=\"mono\">demo &lt;file&gt;</span> in the console."],
  ["How is the ranking worked out?",
    "Two scores, side by side. <b>Points</b> is the classic board: you earn points for a top-15 finish on each map (100 for a WR down to 32 for 15th), and your overall rank is the <b>sum</b> across every map you've raced — so it rewards showing up on a lot of maps. <b>SR (Skill Rating)</b> is the skill board: on each map it measures how close your time is to the world record, weighted by how many players you beat, and your rating is the average across <b>50 map slots</b> on a 0–1000 scale, filled by your strongest maps. Everyone is measured on the same 50, so a deep catalog and a short one are compared like for like — but that also means all 50 count: a slow run inside them pulls the number down, and it's worth going back to improve your weakest. Any slot you haven't filled yet sits at the starting rating, so a short catalog climbs as you race more maps. Because every run is measured against the current world record, your SR can also drift down even when you haven't raced. If someone lowers a record on one of your best maps, you sit a little further from the top. Only contested maps count (you and at least two other players with a time on it). Any profile's Skill Rating card has a <b>“Which maps make up this rating?”</b> dropdown that lists exactly which maps went into the number, in order, and a <b>“where you stand”</b> chart underneath that plots every ranked player's rating so you can see which percentile yours falls in. World records and podium finishes are tracked separately on your profile."],
  ["A map is broken or shouldn't be here — what do I do?",
    "Flag it for review. In-game, type <span class=\"mono\">/flag</span> while you're on the map (add a reason if you like, e.g. <span class=\"mono\">/flag broken</span>). Or open the map on this site and hit <b>⚑ Flag this map for review</b>. Moderators check flagged maps and can pull a bad one from the vote pool and map cycle."],
];

async function viewAbout() {
  // Render every registered, joinable server (any with a connect address) rather
  // than a hardcoded pair, so new boxes — e.g. the Warfork nodes — show up here
  // automatically. Same set + order as the Live page. Falls back to the static
  // list if the API is unreachable so the section is never empty.
  let joinServers;
  try {
    const { servers } = await api("/servers");
    joinServers = (servers || [])
      .filter((s) => s.address)
      .sort((a, b) => (isWarforkServer(a) - isWarforkServer(b)) || (a.id - b.id))
      .map((s) => ({ name: s.name, region: isWarforkServer(s) ? "Warfork" : "Warsow", connect: s.address }));
    if (!joinServers.length) joinServers = ABOUT_SERVERS;
  } catch {
    joinServers = ABOUT_SERVERS;
  }

  app.innerHTML = `
    <div class="crumbs">Racesow / About</div>
    <div class="page-title"><span class="accent">ABOUT</span> RACESOW</div>
    <p class="page-sub">Warsow race: go from the start line to the finish as fast as movement will carry you. This is the network, the commands, and the answers to the usual questions.</p>

    <div class="about">
      <div class="panel about-donate">
        <h3><span class="dot gold"></span> Support the servers</h3>
        <div class="about-body donate-body">
          <p>Racesow runs on rented EU + US game servers and this stats site, paid out of pocket. If it's brought you some fun, buying a coffee helps keep the lights on — thank you.</p>
          <a class="bmc-cta" href="https://buymeacoffee.com/streed" target="_blank" rel="noopener external">☕ Buy me a coffee</a>
        </div>
      </div>

      <div class="panel about-lead">
        <h3><span class="dot"></span> What this is</h3>
        <div class="about-body">
          <p>This is a rebuilding of the old <b>livesow</b> and <b>mgxrace</b> servers. It gives older players a place to keep playing, and new players a place to learn.</p>
          <p>Along the way, new additions and features have been added to improve the experience for more people: a live record book, downloadable demos, in-browser replays, and a cross-server mesh that links the servers together.</p>
        </div>
      </div>

      <div class="panel">
        <h3><span class="dot teal"></span> Learn the basics</h3>
        <div class="about-body">
          <p>New to race? Aelwi's tutorial walks through the mode's fundamentals — how a run works and how to build the speed the leaderboards are made of. Everything applies on both the Warsow and Warfork servers.</p>
          <iframe class="about-video" src="https://www.youtube-nocookie.com/embed/bhkkDmhFL68"
            title="Warfork Race Tutorial by Aelwi" loading="lazy"
            allow="encrypted-media; fullscreen; picture-in-picture" allowfullscreen
            referrerpolicy="strict-origin-when-cross-origin"></iframe>
          <p class="muted about-fineprint">Player not loading? <a class="extlink" href="https://www.youtube.com/watch?v=bhkkDmhFL68" target="_blank" rel="noopener external">Watch it on YouTube ↗</a></p>
        </div>
      </div>

      <div class="panel">
        <h3><span class="dot teal"></span> Join a server</h3>
        <div class="about-body">
          <p>Open the Warsow console with <b>~</b> and paste a connect line. Missing maps download from the server on join.</p>
          <div class="srv-cards">
            ${joinServers.map((s) => `
              <div class="srv-card">
                <div class="srv-name">${esc(s.name)}</div>
                <div class="srv-region muted">${esc(s.region)}</div>
                <div class="connect-row">
                  <code class="connect mono">connect ${esc(s.connect)}</code>
                  <button class="copy-btn" data-copy="connect ${esc(s.connect)}" title="Copy to clipboard">copy</button>
                </div>
              </div>`).join("")}
          </div>
          <p class="muted about-fineprint">The servers are meshed: whenever two share the same map you'll see players on the others as ghosts and can race them across the Atlantic. See <b>/who</b>, <b>/watch</b> and <b>/meshvote</b> below.</p>
        </div>
      </div>

      <div class="panel" id="db-download">
        <h3><span class="dot"></span> Download the database</h3>
        <div class="about-body">
          <p>The whole public race database is published as a downloadable PostgreSQL dump so you can run your own racesow server or dig into the data yourself. It's a full mirror — every record and finish, all checkpoint splits, players, maps, replays, Skill-Rating history and the weapon index — refreshed weekly. Private data (accounts, API tokens, server IPs, moderation reports) is stripped out.</p>
          <div id="db-download-meta" class="db-meta muted">Loading the latest snapshot…</div>
          <p class="muted about-fineprint">Restore into an empty PostgreSQL 16 database: <span class="mono">createdb racesow</span>, unzip the archive, then <span class="mono">psql racesow &lt; racesow-db-*.sql</span> — and point a fresh racesow instance at it. Each archive includes a README with full steps and a <span class="mono">manifest.json</span> listing exactly what's in and out.</p>
        </div>
      </div>

      <div class="page-title about-h2">IN-GAME <span class="accent">COMMANDS</span></div>
      <p class="page-sub">Type these in chat or the console. Run <span class="mono">/help</span> in game for the built-in list, or <span class="mono">/help &lt;cmd&gt;</span> for detail on one.</p>
      <div class="cmd-groups">
        ${ABOUT_CMDS.map((g) => `
          <div class="panel cmd-group">
            <h3><span class="dot"></span> ${esc(g.title)}</h3>
            ${g.note ? `<p class="cmd-note muted">${esc(g.note)}</p>` : ""}
            <table class="data cmd-table">
              <tbody>
                ${g.rows.map(([cmd, desc]) => `
                  <tr>
                    <td class="cmd"><code class="mono">${esc(cmd)}</code></td>
                    <td class="cmd-desc">${esc(desc)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>`).join("")}
      </div>

      <div class="page-title about-h2"><span class="accent">FAQ</span></div>
      <div class="faq">
        ${ABOUT_FAQ.map(([q, a]) => `
          <details class="faq-item">
            <summary>${esc(q)}</summary>
            <div class="faq-a">${a}</div>
          </details>`).join("")}
      </div>

      <div class="panel about-who">
        <h3><span class="dot"></span> Who runs it</h3>
        <div class="about-body">
          <p>Racesow is built and run by <b>elchupa</b>. The stats site, the game servers, the cross-server mesh and the in-browser replay viewer are all custom-built.</p>
          <p>None of this starts from scratch. The race gametype is built on the work of <b>hettoo</b> and <b>DenMSC</b>, whose <span class="mono">wsw-race</span> racemod is the foundation everything here runs on. Their repos: <a class="extlink" href="https://github.com/hettoo/wsw-race/tree/racemod" target="_blank" rel="noopener external">hettoo/wsw-race</a> and <a class="extlink" href="https://github.com/DenMSC/wsw-race/tree/racemod" target="_blank" rel="noopener external">DenMSC/wsw-race</a>. This project extends what they already made.</p>
          <p class="muted">The record book and maps are seeded from the historical <a class="extlink" href="http://livesow.net/race" target="_blank" rel="noopener external">livesow.net</a> race database, and grow live from the servers above. Every map page links out to <a class="extlink" href="https://padpork.org/maps" target="_blank" rel="noopener external">padpork.org</a> for more information on that map. <a class="extlink" href="https://warsow.net/" target="_blank" rel="noopener external">Warsow</a> itself is made by the Warsow team.</p>
        </div>
      </div>
    </div>`;

  // Copy-to-clipboard for the connect strings. Falls back silently where the
  // Clipboard API is unavailable (non-secure context / old browser).
  app.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.getAttribute("data-copy"));
        const prev = btn.textContent;
        btn.textContent = "copied";
        btn.classList.add("ok");
        setTimeout(() => { btn.textContent = prev; btn.classList.remove("ok"); }, 1200);
      } catch (e) { /* clipboard blocked — the string is still selectable */ }
    });
  });

  // Fill the DB-download panel from the live backup manifest (/api/backup):
  // a working download button + snapshot stats, or a graceful note if no
  // backup exists yet (a fresh instance before the sidecar's first run).
  (async () => {
    const box = document.getElementById("db-download-meta");
    if (!box) return;
    try {
      const b = await api("/backup");
      const gen = b.generated_at ? new Date(b.generated_at) : null;
      const rc = b.row_counts || {};
      const stat = (n, lbl) => (n != null ? `<span>${fmtNum(n)} ${lbl}</span>` : "");
      box.classList.remove("muted");
      box.innerHTML = `
        <a class="btn db-dl-btn" href="${esc(b.download_url || "/backup/racesow-db-latest.zip")}" download rel="noopener">⬇ Download database${b.bytes != null ? ` (${esc(fmtBytes(b.bytes))} zip)` : ""}</a>
        <div class="db-stats">
          ${gen ? `<span title="${esc(gen.toISOString())}">Updated ${esc(gen.toISOString().slice(0, 10))}</span>` : ""}
          ${stat(rc.race, "records")}
          ${stat(rc.finish, "finishes")}
          ${stat(rc.player, "players")}
          ${stat(rc.map, "maps")}
        </div>
        ${b.sha256 ? `<div class="db-sha mono" title="SHA-256 of the zip">sha256 ${esc(b.sha256)}</div>` : ""}`;
    } catch (e) {
      box.textContent = "The public snapshot is being generated — check back shortly.";
    }
  })();
}

/* --------------------------- shared widgets ------------------------------ */
function pager(state, data, base) {
  const from = data.offset + 1;
  const to = Math.min(data.offset + data.limit, data.total);
  const prevOff = Math.max(0, state.offset - data.limit);
  const nextOff = state.offset + data.limit;
  const hasPrev = state.offset > 0;
  const hasNext = nextOff < data.total;
  const link = (off) => base + buildQuery({ ...pageParams(state), offset: off });
  if (data.total <= data.limit) return "";
  return `<div class="pager">
    <button ${hasPrev ? `data-nav="${link(prevOff)}"` : "disabled"}>‹ Prev</button>
    <span class="info">${fmtNum(from)}–${fmtNum(to)} of ${fmtNum(data.total)}</span>
    <button ${hasNext ? `data-nav="${link(nextOff)}"` : "disabled"}>Next ›</button>
  </div>`;
}

function pageParams(state) {
  const p = {};
  if (state.q) p.q = state.q;
  if (state.weapon) p.weapon = state.weapon;
  if (state.sort) p.sort = state.sort;
  if (state.order) p.order = state.order;
  if (state.version) p.version = state.version;
  return p;
}

function wireSort(base, state, allowed) {
  app.querySelectorAll("th.sortable").forEach((thEl) => {
    thEl.addEventListener("click", () => {
      const key = thEl.getAttribute("data-sort");
      if (allowed && !allowed.includes(key)) {
        // still allow; allowed is advisory
      }
      let order = "desc";
      if (state.sort === key) order = state.order === "asc" ? "desc" : "asc";
      else order = key === "name" || key === "map" || key === "rank" ? "asc" : "desc";
      go(base + buildQuery({ ...pageParams(state), sort: key, order, offset: 0 }));
    });
  });
}

function wireFilter(inputId, base, state) {
  const el = document.getElementById(inputId);
  if (!el) return;
  let timer;
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const q = el.value.trim();
      if (q === (state.q || "")) return; // unchanged -> no refetch/re-render
      go(base + buildQuery({ ...pageParams(state), q, offset: 0 }));
    }, 350);
  });
  // keep focus + caret after re-render (preventScroll so the page doesn't
  // jump to the toolbar on initial load — matters on the tall player page)
  const v = el.value;
  el.focus({ preventScroll: true });
  el.setSelectionRange(v.length, v.length);
}

/* --------------------------- global search ------------------------------- */
function initGlobalSearch() {
  const input = document.getElementById("gsearch");
  const box = document.getElementById("gresults");
  // Debounced + cancellable: one in-flight request at a time (typing aborts
  // the previous fetch, so fast typing can't stack requests or render a
  // stale result over a newer one), and single characters never query — a
  // 1-char LIKE scan is the most expensive search the API can run.
  let timer;
  let inflight = null;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { box.classList.remove("show"); box.innerHTML = ""; inflight?.abort(); return; }
    timer = setTimeout(async () => {
      try {
        inflight?.abort();
        inflight = new AbortController();
        const res = await fetch("/api/search?q=" + encodeURIComponent(q), { signal: inflight.signal });
        if (!res.ok) return;
        const d = await res.json();
        let html = "";
        if (d.players.length) {
          html += `<div class="rgroup-title">Players</div>`;
          html += d.players.map((p) => `
            <div class="ritem" data-nav="#/player/${p.id}">
              <span>${wname(p.name)}</span><small>#${p.rank} · ${fmtNum(p.points)} pts</small>
            </div>`).join("");
        }
        if (d.maps.length) {
          html += `<div class="rgroup-title">Maps</div>`;
          html += d.maps.map((m) => `
            <div class="ritem" data-nav="#/map/${m.id}">
              <span class="mapname">${mapNameHtml(m.name)}</span><small>${fmtNum(m.finishes != null ? m.finishes : m.races)} finishes</small>
            </div>`).join("");
        }
        box.innerHTML = html || `<div class="ritem"><small>No matches.</small></div>`;
        box.classList.add("show");
      } catch (e) { /* aborted or network error — ignore */ }
    }, 300);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      track("Search", { q: input.value.trim() });
      go("#/maps" + buildQuery({ q: input.value.trim() }));
      box.classList.remove("show");
      input.blur();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".gsearch")) box.classList.remove("show");
  });
}

/* ------------------------------ dispatch --------------------------------- */
// Delegated navigation for any [data-nav] element.
document.addEventListener("click", (e) => {
  // Let the browser handle modified clicks natively (open-in-new-tab etc.) so
  // the anchors' real path hrefs work; only hijack a plain left click.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  // Real links (e.g. the padpork ↗ chips) inside clickable rows keep their
  // native behaviour instead of being hijacked by the row's data-nav.
  // Click-to-copy (e.g. the stream page's `connect <addr>` chip).
  const copyEl = e.target.closest("[data-copy]");
  if (copyEl) {
    e.preventDefault();
    const txt = copyEl.getAttribute("data-copy");
    track("Copy connect", { server: txt.replace(/^connect\s+/, "") });
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => {
        copyEl.classList.add("copied");
        setTimeout(() => copyEl.classList.remove("copied"), 1200);
      })
      .catch(() => {});
    return;
  }
  const link = e.target.closest("a[href]");
  if (link) {
    // Real links keep their native behaviour (below), but note the action first:
    // a download (demo/DB export) or a click off-site to a different origin.
    const href = link.getAttribute("href") || "";
    if (link.hasAttribute("download")) {
      track("Download demo", { url: href });
    } else if (/^https?:\/\//i.test(href)) {
      try {
        const u = new URL(href, location.origin);
        if (u.origin !== location.origin) track("Outbound", { url: u.hostname + u.pathname });
      } catch (err) { /* malformed href — ignore */ }
    }
  }
  if (link && !link.hasAttribute("data-nav")) return;
  const el = e.target.closest("[data-nav]");
  if (el) {
    e.preventDefault();
    go(el.getAttribute("data-nav"));
    document.getElementById("gresults")?.classList.remove("show");
    const gs = document.getElementById("gsearch");
    if (gs && el.closest(".gsearch")) {
      gs.value = "";
      // Picking a hit from the global search dropdown — record what type.
      const nav = el.getAttribute("data-nav") || "";
      track("Search result click", {
        type: nav.startsWith("#/player") ? "player" : nav.startsWith("#/map") ? "map" : "other",
      });
    }
  }
});

// Warsow name/color tester. Type "^" + a digit 0-9 to colour the text that
// follows; this renders it live exactly as it appears in-game, reusing wname()
// (the same renderer the leaderboards use) and the .wc0-.wc9 palette. Handy for
// players building a coloured name and for admins composing coloured /admin
// announcement messages. Pure client-side — no API call, so no loading().
function viewColors() {
  const example = "^1R^2a^3c^4e^5s^6o^7w";
  const examples = ["^1Nova^7Racer", "^3speed^7demon", "^4B^5l^6u^7e^7Shift", "^2go ^7fast ^1!!"];
  app.innerHTML = `
    <div class="crumbs">Racesow / Colors</div>
    <div class="page-title"><span class="accent">NAME</span> COLORS</div>
    <p class="page-sub">Warsow colours your name and chat with <b>^</b> codes: type <code>^</code> then a digit <b>0–9</b>. Build a name below and watch it render exactly as it shows in-game, then copy it into your Warsow <code>name</code> setting (open the console with <b>~</b>, or Options → Player).</p>

    <div class="panel colors-card">
      <h3><span class="dot"></span> Your name</h3>
      <div class="about-body">
        <input id="cinput" type="text" value="${esc(example)}" maxlength="200" spellcheck="false"
          aria-label="Text with ^ colour codes" />
        <div class="cprev-label muted">Preview</div>
        <div id="cpreview" class="cpreview"></div>
        <div class="cactions">
          <button id="ccopy" type="button" class="cbtn">Copy</button>
          <button id="cclear" type="button" class="cbtn ghost">Clear</button>
          <span id="ccopied" class="muted"></span>
        </div>
      </div>
    </div>

    <div class="panel colors-card">
      <h3><span class="dot teal"></span> Palette</h3>
      <div class="about-body">
        <div id="cpalette" class="cpalette"></div>
        <p class="muted cpal-note">Click a swatch to append its code. <code>^7</code> is the default white; <code>^0</code> is black (shown with a faint outline so it stays legible).</p>
      </div>
    </div>

    <div class="panel colors-card">
      <h3><span class="dot"></span> Examples</h3>
      <div class="about-body" id="cexamples"></div>
    </div>`;

  const input = document.getElementById("cinput");
  const preview = document.getElementById("cpreview");
  const copied = document.getElementById("ccopied");
  const render = () => {
    preview.innerHTML = input.value ? wname(input.value) : `<span class="muted">(empty)</span>`;
  };
  input.addEventListener("input", render);
  render();

  document.getElementById("cpalette").innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map((n) => `<button type="button" class="cswatch wc${n}" data-code="^${n}">^${n}</button>`)
    .join("");
  document.querySelectorAll("#cpalette .cswatch").forEach((b) =>
    b.addEventListener("click", () => {
      input.value += b.dataset.code;
      input.focus();
      render();
    })
  );

  document.getElementById("cexamples").innerHTML = examples
    .map((e) => `<div class="cexrow"><code>${esc(e)}</code><span class="cexarrow muted">→</span>${wname(e)}</div>`)
    .join("");

  document.getElementById("ccopy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      copied.textContent = "Copied!";
    } catch {
      copied.textContent = "Select the text and press Ctrl+C";
    }
    setTimeout(() => (copied.textContent = ""), 2000);
  });
  document.getElementById("cclear").addEventListener("click", () => {
    input.value = "";
    input.focus();
    render();
  });
}

/* ============================ WHEN PEOPLE PLAY ============================
 * /stats — the servers' weekly rhythm: an hour-of-week heatmap plus hour-of-day
 * and day-of-week breakdowns, each splittable by the region of the server a run
 * was set on.
 *
 * The metric is completed runs (the finish log is the only activity history the
 * DB keeps — nothing samples who is merely CONNECTED), which the page says out
 * loud rather than implying it counts players online.
 *
 * Colour: the heatmap is magnitude, so it is one hue light->dark and keeps that
 * hue whatever the region filter says — the title carries the filter. Region is
 * identity, so the split charts use the fixed categorical order below; a region
 * with no runs is dropped without shifting anyone else's hue. "Players" is
 * never stacked: distinct people don't add up across regions (the API counts
 * the all-regions total separately for exactly this reason).
 */
const DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STAT_WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
  { days: 0, label: "All time" },
];
// Cube cache keyed by what the API actually varies on (window + zone), so the
// region and metric toggles — which are URL params, so they stay shareable and
// survive Back — re-render from memory instead of refetching.
const statsCube = new Map();

function browserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// "Europe/Berlin" -> "Berlin"; the zone is shown next to a time, where the
// continent adds width and no information.
function tzShort(tz) {
  const tail = String(tz).split("/").pop();
  return tail.replace(/_/g, " ");
}

const hourLabel = (h) => String(h).padStart(2, "0") + ":00";
const slotLabel = (dow, hour) => `${DOW_SHORT[dow]} ${hourLabel(hour)}`;

// The viewer's current hour-of-week IN the displayed zone, so "now" can be
// marked on the grid. Returns null if the zone isn't one Intl can format.
function nowSlot(tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const hr = parts.find((p) => p.type === "hour")?.value;
    const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd);
    // "24" is how en-GB h23 spells midnight in some ICU builds.
    const hour = parseInt(hr, 10) % 24;
    return dow < 0 || Number.isNaN(hour) ? null : { dow, hour };
  } catch {
    return null;
  }
}

async function viewStats(params) {
  const days = STAT_WINDOWS.some((w) => String(w.days) === params.days) ? parseInt(params.days, 10) : 90;
  // No ?tz= means "the zone this browser is in": the useful default for
  // "when should I show up", and the response echoes back what the server
  // actually used so a zone Postgres rejects is visible rather than silent.
  const tz = params.tz || browserTz();
  const metric = params.metric === "players" ? "players" : "runs";
  const cubeKey = `${days}|${tz}`;

  let hit = statsCube.get(cubeKey);
  // Matched to the API's own cache TTL: toggling region/metric must not refetch,
  // but a tab left open all afternoon must not keep redrawing this morning.
  if (hit && Date.now() - hit.at > 300_000) hit = null;
  if (!hit) {
    loading();
    hit = { at: Date.now(), d: await api("/stats/playtimes" + buildQuery({ days, tz })) };
    statsCube.set(cubeKey, hit);
  }
  const d = hit.d;
  const known = (d.regions || []).map((r) => r.key);
  const region = known.includes(params.region) ? params.region : "ALL";
  const state = { days, tz: params.tz || "", region, metric };
  const link = (over) => "#/stats" + buildQuery({ ...state, ...over, tz: (over.tz ?? state.tz) || "" });

  if (!d.total.runs) {
    app.innerHTML = `
      ${statsHeader(d, state)}
      <div class="empty">No finishes recorded in this window — try a longer one.</div>`;
    return;
  }

  const cells = statsIndex(d);
  const at = (dow, hour) => cellVal(cells, region, dow, hour, metric);
  const unit = metric === "players" ? "players" : "runs";

  // Peaks are read off the CURRENT slice, so every headline matches the charts
  // under it rather than describing the unfiltered whole. Day and hour figures
  // are the API's own rollups (dow/hour = -1), never sums of the grid: distinct
  // players don't add up across the cells of a day.
  let peak = { dow: 0, hour: 0, v: -1 };
  for (let dow = 0; dow < 7; dow++)
    for (let hour = 0; hour < 24; hour++) {
      const v = at(dow, hour);
      if (v > peak.v) peak = { dow, hour, v };
    }
  const byDay = Array.from({ length: 7 }, (_, i) => at(i, -1));
  const byHour = Array.from({ length: 24 }, (_, i) => at(-1, i));
  const total = at(-1, -1);
  const topDay = byDay.indexOf(Math.max(...byDay));
  const topHour = byHour.indexOf(Math.max(...byHour));
  // A share only means anything for runs, which partition the window. The same
  // arithmetic on players would divide by a number nobody is counted in twice.
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const ofTotal =
    metric === "runs"
      ? { day: `${pct(byDay[topDay])}% of the week's runs`, hour: `${pct(byHour[topHour])}% of runs, any day` }
      : {
          day: `${fmtNum(byDay[topDay])} different players`,
          hour: `${fmtNum(byHour[topHour])} different players, any day`,
        };
  const weekendRuns = at(5, -1) + at(6, -1);

  app.innerHTML = `
    ${statsHeader(d, state)}

    <div class="tiles">
      ${statTile(slotLabel(peak.dow, peak.hour), "busiest hour of the week", `${fmtNum(peak.v)} ${unit}`, "accent")}
      ${statTile(DOW_LONG[topDay], "busiest day", ofTotal.day)}
      ${statTile(hourLabel(topHour), "busiest hour of the day", ofTotal.hour)}
      ${
        metric === "runs"
          ? statTile(pct(weekendRuns) + "%", "falls on the weekend", "Saturday + Sunday")
          : statTile(fmtNum(total), "players in this window", "counted once, however often they raced")
      }
    </div>

    <div class="page-title" style="font-size:20px">THE WEEK <span class="accent">·</span> ${esc(
      region === "ALL" ? "all servers" : regionLabel(d, region)
    )}</div>
    <div class="panel statpanel">
      <div class="statctl">
        <div class="segbar" role="group" aria-label="Region">
          <a class="seg ${region === "ALL" ? "on" : ""}" data-nav="${link({ region: "" })}" href="${navHref(link({ region: "" }))}">All servers</a>
          ${(d.regions || [])
            .map(
              (r) =>
                `<a class="seg ${region === r.key ? "on" : ""}" data-nav="${link({ region: r.key })}" href="${navHref(link({ region: r.key }))}">${esc(r.label)}</a>`
            )
            .join("")}
        </div>
        <div class="segbar" role="group" aria-label="Metric">
          <a class="seg ${metric === "runs" ? "on" : ""}" data-nav="${link({ metric: "runs" })}" href="${navHref(link({ metric: "runs" }))}">Runs</a>
          <a class="seg ${metric === "players" ? "on" : ""}" data-nav="${link({ metric: "players" })}" href="${navHref(link({ metric: "players" }))}">Players</a>
        </div>
      </div>
      ${statsHeatmap(cells, { region, metric, tz: d.tz, label: region === "ALL" ? "all servers" : regionLabel(d, region) })}
      <div class="statcap">Each cell is one hour of the week in ${esc(tzShort(d.tz))} time${
        metric === "players" ? ", counting how many different players finished a run in it" : ", counting finished runs"
      }. Darker is busier.</div>
    </div>

    <div class="grid-2">
      <div class="panel statpanel">
        <h3><span class="dot"></span>By hour of day</h3>
        ${statsBars(d, cells, { metric, region, kind: "hour" })}
      </div>
      <div class="panel statpanel">
        <h3><span class="dot teal"></span>By day of week</h3>
        ${statsBars(d, cells, { metric, region, kind: "day" })}
      </div>
    </div>

    ${statsRegionPanel(d, cells, metric)}`;
}

// Page title + the window/zone toolbar. Rendered on the empty state too, so a
// window with no runs can still be switched away from.
function statsHeader(d, state) {
  const link = (over) => "#/stats" + buildQuery({ ...state, ...over, tz: (over.tz ?? state.tz) || "" });
  const zones = [
    { tz: "", label: "Your time" },
    { tz: "UTC", label: "UTC" },
    ...(d.regions || []).filter((r) => r.tz !== "UTC").map((r) => ({ tz: r.tz, label: tzShort(r.tz) })),
  ];
  const span =
    d.first && d.last
      ? `${fmtUtc(d.first, { time: false })} – ${fmtUtc(d.last, { time: false })}`
      : "no runs in this window";
  // A zone the API refused — one this browser knows but Postgres or the API's
  // allow-list doesn't — has to be visible: the grid would otherwise quietly be
  // UTC while the picker claims otherwise. Compared against what THIS page
  // asked for, which also catches a hand-typed ?tz=.
  const asked = state.tz || browserTz();
  const fellBack = asked !== d.tz;
  return `
    <div class="page-title">WHEN PEOPLE <span class="accent">PLAY</span></div>
    <div class="page-sub">
      ${fmtNum(d.total.runs)} finished runs by ${fmtNum(d.total.players)} players · ${esc(span)} ·
      times in <b>${esc(d.tz)}</b>${fellBack ? ` <span class="muted">(${esc(asked)} is not a zone this server knows)</span>` : ""}
    </div>
    <div class="statbar">
      <div class="segbar" role="group" aria-label="Window">
        ${STAT_WINDOWS.map(
          (w) =>
            `<a class="seg ${w.days === state.days ? "on" : ""}" data-nav="${link({ days: w.days })}" href="${navHref(link({ days: w.days }))}">${w.label}</a>`
        ).join("")}
      </div>
      <div class="segbar" role="group" aria-label="Time zone">
        ${zones
          .map((z) => {
            const on = (state.tz || "") === z.tz;
            return `<a class="seg ${on ? "on" : ""}" data-nav="${link({ tz: z.tz })}" href="${navHref(link({ tz: z.tz }))}">${esc(z.label)}</a>`;
          })
          .join("")}
      </div>
    </div>`;
}

// A stat tile whose value is a word or a time, not a number to be formatted.
function statTile(value, label, sub = "", variant = "") {
  return `<div class="tile ${variant}">
    <div class="num stat-word">${esc(value)}</div>
    <div class="lbl">${esc(label)}</div>
    ${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ""}
  </div>`;
}

function regionLabel(d, key) {
  const r = (d.regions || []).find((x) => x.key === key);
  return r ? r.label : key;
}

function statsIndex(d) {
  const m = new Map();
  for (const c of d.cells || []) m.set(`${c.region}|${c.dow}|${c.hour}`, c);
  return m;
}
const cellVal = (cells, region, dow, hour, metric) => {
  const c = cells.get(`${region}|${dow}|${hour}`);
  return c ? c[metric] : 0;
};

/* ---- hour-of-week heatmap ----------------------------------------------- *
 * 7 rows x 24 cells, one sequential hue in six steps (the empty step included),
 * with the scale legend beside it — magnitude is the whole message, so nothing
 * here encodes identity. The current hour is ringed rather than recoloured, so
 * the "now" marker can't be mistaken for a value. */
function statsHeatmap(cells, { region, metric, tz, label }) {
  const W = 660, padL = 34, padR = 8, padT = 6, padB = 20, CH = 21;
  const cw = (W - padL - padR) / 24;
  const H = padT + 7 * CH + padB;
  const n = (v) => v.toFixed(1);
  let max = 0;
  for (let dw = 0; dw < 7; dw++) for (let h = 0; h < 24; h++) max = Math.max(max, cellVal(cells, region, dw, h, metric));
  // 5 filled steps: the value's share of the busiest cell, so the darkest step
  // is always reached and a quiet week doesn't render as a blank grid.
  const step = (v) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)));
  const now = nowSlot(tz);
  const unit = metric === "players" ? "players" : "runs";

  let rects = "";
  for (let dw = 0; dw < 7; dw++) {
    for (let h = 0; h < 24; h++) {
      const v = cellVal(cells, region, dw, h, metric);
      const isNow = now && now.dow === dw && now.hour === h;
      rects += `<rect class="hmc s${step(v)}${isNow ? " now" : ""}" x="${n(padL + h * cw + 1.5)}" y="${n(padT + dw * CH + 1.5)}"
        width="${n(cw - 3)}" height="${CH - 3}" rx="2"><title>${esc(
        `${DOW_LONG[dw]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} · ${fmtNum(v)} ${unit}${isNow ? " · happening now" : ""}`
      )}</title></rect>`;
    }
  }
  const dayLabels = DOW_SHORT.map(
    (d, i) => `<text class="hmax" x="${padL - 8}" y="${padT + i * CH + CH / 2}" text-anchor="end" dominant-baseline="middle">${d}</text>`
  ).join("");
  const hourLabels = [0, 3, 6, 9, 12, 15, 18, 21]
    .map(
      (h) => `<text class="hmax" x="${n(padL + h * cw + cw / 2)}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, "0")}</text>`
    )
    .join("");

  const swatches = [0, 1, 2, 3, 4, 5]
    .map((s) => `<span class="hmkey s${s}"></span>`)
    .join("");
  return `
    <div class="hmlegend">
      <span class="muted">quiet</span>${swatches}<span class="muted">busy · up to ${fmtNum(max)} ${unit}/hour</span>
      ${now ? `<span class="hmnow-key"><span class="hmkey now"></span>now</span>` : ""}
    </div>
    <div class="hmscroll">
      <svg class="hmap" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
        `${unit} by hour of the week on ${label}, busiest hour ${fmtNum(max)} ${unit}`
      )}">
        ${dayLabels}${rects}${hourLabels}
      </svg>
    </div>`;
}

/* ---- hour-of-day / day-of-week columns ----------------------------------- *
 * Stacked by region when the metric is runs and no region is selected (runs
 * partition cleanly); a single series otherwise, because distinct players
 * counted per region do not sum to the distinct players overall. */
function statsBars(d, cells, { metric, region, kind }) {
  const slots = kind === "hour" ? 24 : 7;
  const stack = metric === "runs" && region === "ALL" && (d.regions || []).length > 1;
  const series = stack ? d.regions.map((r) => ({ key: r.key, label: r.label })) : [{ key: region, label: null }];
  // The API's own rollup for the axis being collapsed (-1), so a "players" bar
  // is the distinct players in that hour/day rather than a sum of cells that
  // counts a regular several times over.
  const at = (key, i) => (kind === "hour" ? cellVal(cells, key, -1, i, metric) : cellVal(cells, key, i, -1, metric));
  const totals = Array.from({ length: slots }, (_, i) => series.reduce((a, s) => a + at(s.key, i), 0));
  const max = Math.max(1, ...totals);
  const peakIdx = totals.indexOf(Math.max(...totals));

  const W = 500, H = kind === "hour" ? 180 : 170, padL = 30, padR = 10, padT = 22, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slotW = plotW / slots, barW = Math.max(3, slotW - (kind === "hour" ? 3 : 10));
  const base = H - padB;
  const n = (v) => v.toFixed(1);
  const unit = metric === "players" ? "players" : "runs";

  let bars = "";
  for (let i = 0; i < slots; i++) {
    const x = padL + i * slotW + (slotW - barW) / 2;
    let y = base;
    series.forEach((s) => {
      const v = at(s.key, i);
      if (!v) return;
      const h = (v / max) * plotH;
      // 2px of surface between stacked segments: adjacent fills never touch.
      const drawn = Math.max(1, h - (stack ? 2 : 0));
      y -= h;
      bars += `<rect class="stbar r-${esc(s.key)}" x="${n(x)}" y="${n(y)}" width="${n(barW)}" height="${n(drawn)}" rx="2"
        ><title>${esc(
          `${kind === "hour" ? hourLabel(i) : DOW_LONG[i]}${s.label ? " · " + s.label : ""} · ${fmtNum(v)} ${unit}`
        )}</title></rect>`;
    });
  }

  // Direct labels: every bar when there are 7, only the peak when there are 24
  // (a number on each of 24 columns is noise, and they collide).
  const labels = Array.from({ length: slots }, (_, i) => {
    if (kind === "hour" && i !== peakIdx) return "";
    if (!totals[i]) return "";
    const x = padL + i * slotW + slotW / 2;
    const y = base - (totals[i] / max) * plotH - 5;
    return `<text class="stval${i === peakIdx ? " peak" : ""}" x="${n(x)}" y="${n(y)}" text-anchor="middle">${fmtNum(totals[i])}</text>`;
  }).join("");

  const ticks =
    kind === "hour"
      ? [0, 6, 12, 18, 23].map(
          (i) => `<text class="hmax" x="${n(padL + i * slotW + slotW / 2)}" y="${H - 6}" text-anchor="middle">${String(i).padStart(2, "0")}</text>`
        )
      : DOW_SHORT.map(
          (dn, i) => `<text class="hmax" x="${n(padL + i * slotW + slotW / 2)}" y="${H - 6}" text-anchor="middle">${dn}</text>`
        );

  const legend = stack
    ? `<div class="stlegend">${series
        .map((s) => `<span class="stkey"><span class="sw r-${esc(s.key)}"></span>${esc(s.label)}</span>`)
        .join("")}</div>`
    : "";

  return `${legend}
    <svg class="stchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
      `${unit} by ${kind === "hour" ? "hour of day" : "day of week"}, peak ${fmtNum(totals[peakIdx])}`
    )}">
      <line class="srgrid" x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}"/>
      <text class="hmax" x="${padL - 6}" y="${padT}" text-anchor="end" dominant-baseline="middle">${fmtNum(max)}</text>
      ${bars}${labels}
      <line class="srdaxis" x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}"/>
      ${ticks.join("")}
    </svg>`;
}

/* ---- the region breakdown ------------------------------------------------ */
function statsRegionPanel(d, cells, metric) {
  const regions = d.regions || [];
  if (!regions.length) return "";
  const totalRuns = regions.reduce((a, r) => a + r.runs, 0);
  const rows = regions
    .map((r) => {
      let peak = { dow: 0, hour: 0, v: -1 };
      for (let dw = 0; dw < 7; dw++)
        for (let h = 0; h < 24; h++) {
          const v = cellVal(cells, r.key, dw, h, metric);
          if (v > peak.v) peak = { dow: dw, hour: h, v };
        }
      const byDay = Array.from({ length: 7 }, (_, i) => cellVal(cells, r.key, i, -1, metric));
      const topDay = byDay.indexOf(Math.max(...byDay));
      const localPeak = r.localHours.indexOf(Math.max(...r.localHours));
      const share = totalRuns ? Math.round((r.runs / totalRuns) * 100) : 0;
      return `<tr>
        <td><span class="rdot r-${esc(r.key)}"></span>${esc(r.label)}
          <div class="muted rsrv">${r.servers.length ? esc(r.servers.join(" · ")) : "no enrolled server"}</div></td>
        <td class="num">${fmtNum(r.runs)}</td>
        <td class="num">${share}%</td>
        <td class="num">${fmtNum(r.players)}</td>
        <td>${esc(DOW_LONG[topDay])}</td>
        <td class="mono">${esc(slotLabel(peak.dow, peak.hour))}</td>
        <td class="mono">${esc(hourLabel(localPeak))} <span class="muted">${esc(tzShort(r.tz))}</span></td>
      </tr>`;
    })
    .join("");
  return `
    <div class="page-title" style="font-size:20px">BY <span class="accent">REGION</span></div>
    <div class="panel statpanel">
      <div class="table-wrap"><div class="tscroll">
        <table class="data">
          <thead><tr>
            <th>Region</th><th class="num">Runs</th><th class="num">Share</th><th class="num">Players</th>
            <th>Busiest day</th><th>Peak hour <span class="muted">(${esc(tzShort(d.tz))})</span></th>
            <th>Peak hour <span class="muted">(region local)</span></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div></div>
      <div class="statcap">
        A run counts towards the region of the server it was set on — derived from the server's address
        (<span class="mono">eu.*</span> / <span class="mono">us.*</span>), not from where the player is.
        Player counts are per region and are not added up: someone who races on both sides is one player in each.
        ${
          metric === "players"
            ? "Busiest day and peak hour follow the metric you picked above (players)."
            : "Busiest day and peak hour follow the metric you picked above (runs)."
        }
      </div>
    </div>`;
}

/* ------------------------- achievements directory ------------------------ */
// Every active achievement with rarity + recent earners. Hidden achievements
// show as a masked card until somebody earns them.
async function viewAchievements() {
  loading();
  const d = await api("/achievements");
  const groups = ACH_TIER_ORDER.map((tier) => ({
    tier,
    items: (d.achievements || []).filter((a) => a.tier === tier),
  })).filter((g) => g.items.length);

  const card = (a) => {
    const rarity = a.earners
      ? `earned by ${fmtNum(a.earners)} of ${fmtNum(d.players)} ranked players (${(a.rarity * 100).toFixed(1)}%)`
      : "nobody has earned this yet";
    if (a.hidden)
      return `<div class="panel achdir">
        <div class="achdir-head"><span class="ach ${esc(a.tier)}">???</span><span class="muted achdir-meta">${rarity}</span></div>
        <div class="muted">Hidden achievement — earn it to reveal what it is.</div>
      </div>`;
    const recent = (a.recent || [])
      .map((r) => `<a data-nav="#/player/${r.id}">${wname(r.name)}</a>`)
      .join('<span class="sep">·</span>');
    return `<div class="panel achdir">
      <div class="achdir-head"><span class="ach ${esc(a.tier)}">${esc(a.title)}</span><span class="muted achdir-meta">${rarity}</span></div>
      ${a.description ? `<div class="achdir-desc">${esc(a.description)}</div>` : ""}
      <div class="muted achdir-meta">${esc(ACH_WINDOW_TEXT[a.window] || "all-time")}${a.repeatable ? " · repeatable" : ""}</div>
      ${recent ? `<div class="achdir-recent muted">recently earned by ${recent}</div>` : ""}
    </div>`;
  };

  app.innerHTML = `
    <div class="page-title">ACHIEVEMENTS</div>
    <p class="page-sub">Awards earned automatically as you race, across every server. Earned badges show on your player profile, along with your progress toward the rest.</p>
    ${groups.length
      ? groups
          .map(
            (g) => `
        <div class="page-title" style="font-size:20px">${g.tier.toUpperCase()}</div>
        <div class="achdir-grid">${g.items.map(card).join("")}</div>`
          )
          .join("")
      : `<div class="empty">No achievements have been defined yet — check back soon.</div>`}`;
}

/* ============================== tournaments ============================== */
/* A tournament is a time window plus a map pool; a registered entrant's
 * finishes on those maps inside that window score for its board as well as the
 * normal leaderboard. Everything below derives the PHASE from the `now` the
 * server stamped into the payload rather than the browser's clock: the response
 * is edge-cached for up to ~60s, and a client clock that disagreed would show
 * "starts in 3 minutes" for a tournament that started an hour ago (or worse,
 * hide the Join button on a live one). */

const TPHASE_LABEL = {
  upcoming: "Upcoming",
  live: "Live now",
  ended: "Finished",
  finalized: "Final",
  cancelled: "Cancelled",
  draft: "Draft",
};

function tPhase(t, now) {
  if (!t) return null;
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "finalized") return "finalized";
  if (t.status === "draft") return "draft";
  if (now < t.starts_at) return "upcoming";
  if (now < t.ends_at) return "live";
  return "ended";
}

/* Epoch seconds -> "5 Aug 2026, 18:00 UTC". Always UTC and always absolute:
 * tournament windows are set in UTC by admins and read by players in a dozen
 * zones, so a local-time rendering would have two people disagree about when
 * the thing they are both racing actually ends. */
const TMONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtUtc(ts, { time = true } = {}) {
  if (ts == null) return "—";
  const d = new Date(Number(ts) * 1000);
  const date = `${d.getUTCDate()} ${TMONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!time) return date;
  return `${date}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/* Signed span in seconds -> "3d 4h" / "12m". Coarse on purpose: this is used for
 * "starts in" / "ends in", where a ticking second counter would just be a
 * promise the 30s cache cannot keep. */
function fmtSpan(secs) {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return "moments";
}

/* One line of human context under a tournament's title. */
function tWhen(t, now) {
  const phase = tPhase(t, now);
  if (phase === "live") return `Ends in ${fmtSpan(t.ends_at - now)} · ${fmtUtc(t.ends_at)}`;
  if (phase === "upcoming") return `Starts in ${fmtSpan(t.starts_at - now)} · ${fmtUtc(t.starts_at)}`;
  return `${fmtUtc(t.starts_at, { time: false })} – ${fmtUtc(t.ends_at, { time: false })}`;
}

function tCard(t, now) {
  const phase = tPhase(t, now);
  return `<a class="panel tcard tphase-${phase}" data-nav="#/tournaments/${esc(t.slug)}" href="/tournaments/${esc(t.slug)}">
    <div class="tcard-head">
      <span class="tname">${esc(t.name)}</span>
      <span class="tbadge ${phase}">${TPHASE_LABEL[phase]}</span>
    </div>
    <div class="tcard-when muted">${esc(tWhen(t, now))}</div>
    <div class="tcard-meta muted">${fmtNum(t.maps || 0)} map${t.maps === 1 ? "" : "s"}
      <span class="sep">·</span> ${fmtNum(t.entrants || 0)} entrant${t.entrants === 1 ? "" : "s"}
      ${t.scoring === "time_sum" ? '<span class="sep">·</span> total time' : ""}</div>
  </a>`;
}

/* The schedule strip: a proportional timeline of everything running or due,
 * from now to the last scheduled end.
 *
 * A timeline rather than a month grid on purpose — these tournaments run for
 * days to weeks, so a grid would be a wall of identical full-week rows that
 * answers "what's on, and when does it end?" worse than a single axis does.
 * Bars are positioned by percentage of the whole span, so overlapping
 * tournaments (which the admin form discourages but permits) are immediately
 * visible as bars sharing horizontal space. */
function tTimeline(list, now) {
  if (!list.length) return "";
  const from = now;
  const to = Math.max(...list.map((t) => t.ends_at));
  const span = Math.max(1, to - from);
  // Tick every week, or every day when the whole span is short.
  const step = span > 21 * 86400 ? 7 * 86400 : span > 3 * 86400 ? 86400 : 3600 * 6;
  // Axis labels are built from the parts rather than regex-stripped out of
  // fmtUtc, so a sub-day step keeps its clock and a multi-day one doesn't
  // repeat the year across every tick.
  const tickLabel = (ts) => {
    const dt = new Date(ts * 1000);
    const day = `${dt.getUTCDate()} ${TMONTHS[dt.getUTCMonth()]}`;
    return step < 86400 ? `${String(dt.getUTCHours()).padStart(2, "0")}:00` : day;
  };
  const ticks = [];
  for (let ts = Math.ceil(from / step) * step; ts <= to && ticks.length < 14; ts += step) {
    ticks.push({ pct: ((ts - from) / span) * 100, label: tickLabel(ts) });
  }
  return `
    <div class="ttimeline">
      <div class="ttl-axis">
        ${ticks.map((t) => `<span class="ttl-tick" style="left:${t.pct.toFixed(2)}%"><i></i><b>${esc(t.label)}</b></span>`).join("")}
      </div>
      ${list
        .map((t) => {
          const phase = tPhase(t, now);
          // A tournament already under way starts at the left edge — the past
          // part of its window is not what anyone is looking for here.
          const l = (Math.max(0, t.starts_at - from) / span) * 100;
          const w = Math.max(1.5, ((Math.min(t.ends_at, to) - Math.max(t.starts_at, from)) / span) * 100);
          return `<div class="ttl-row">
            <a class="ttl-bar ${phase}" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"
               data-nav="#/tournaments/${esc(t.slug)}" href="/tournaments/${esc(t.slug)}"
               title="${esc(`${t.name} · ${fmtUtc(t.starts_at)} → ${fmtUtc(t.ends_at)}`)}"><span>${esc(t.name)}</span></a>
          </div>`;
        })
        .join("")}
      <div class="ttl-now" title="now"></div>
    </div>`;
}

/* The calendar page: the schedule strip, then live / upcoming / finished. */
async function viewTournaments() {
  loading();
  const d = await api("/tournaments");
  const now = d.now || Math.floor(Date.now() / 1000);
  const rows = (d.rows || []).filter((t) => t.status !== "draft");
  const group = (p) => rows.filter((t) => tPhase(t, now) === p);
  const live = group("live");
  const upcoming = group("upcoming").sort((a, b) => a.starts_at - b.starts_at);
  const past = rows.filter((t) => ["ended", "finalized", "cancelled"].includes(tPhase(t, now)));
  const scheduled = live.concat(upcoming);

  const section = (title, list, empty) =>
    `<div class="page-title" style="font-size:20px">${title}${list.length ? ` <span class="accent">·</span> ${fmtNum(list.length)}` : ""}</div>
     ${list.length ? `<div class="tgrid">${list.map((t) => tCard(t, now)).join("")}</div>` : `<div class="empty">${empty}</div>`}`;

  app.innerHTML = `
    <div class="page-title">TOURNAMENTS</div>
    <p class="page-sub">Time-boxed competitions on a fixed pool of maps. Enter once, then just race —
      every run you set on a pool map while it's open counts for the tournament board
      <em>and</em> the normal leaderboard. Top three take a trophy for their profile.</p>
    ${scheduled.length ? `<div class="page-title" style="font-size:20px">SCHEDULE</div>${tTimeline(scheduled, now)}` : ""}
    ${section("LIVE NOW", live, "Nothing running right now — check what's coming up below.")}
    ${section("COMING UP", upcoming, "Nothing scheduled yet.")}
    ${past.length ? section("FINISHED", past, "") : ""}`;
}

/* The per-map boards on a detail page, one collapsible panel per pool map. */
function tMapBoards(d, maps) {
  const boards = d.boards || {};
  return maps
    .map((m) => {
      const rowsFor = boards[m.id] || [];
      return `<details class="panel tmapboard">
        <summary><span class="srbd-caret">▸</span> <span class="mapname">${esc(m.name)}</span>
          <span class="muted">${rowsFor.length ? `${fmtNum(rowsFor.length)} entrant${rowsFor.length === 1 ? "" : "s"} · best ${fmtTime(rowsFor[0].time)}` : "no times yet"}</span></summary>
        ${rowsFor.length
          ? `<div class="tscroll"><table class="data"><thead><tr><th>#</th><th>Player</th><th class="num">Time</th><th class="num">Points</th></tr></thead><tbody>${rowsFor
              .map(
                (r) => `<tr class="clickable" data-nav="#/player/${r.id}">
                  <td class="num ${rankClass(r.rank)}">${r.rank}</td>
                  <td>${wname(r.name)}</td>
                  <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
                  <td class="num muted">${fmtNum(r.points)}</td></tr>`
              )
              .join("")}</tbody></table></div>`
          : `<div class="srbd-note">Nobody registered has finished this map inside the window yet.</div>`}
      </details>`;
    })
    .join("");
}

async function viewTournament(slug) {
  loading();
  let d;
  try {
    d = await api(`/tournaments/${encodeURIComponent(slug)}`);
  } catch (e) {
    // Only a genuine "no such tournament" gets the friendly dead-end; anything
    // else (a 500, a network drop) must surface as an error, not be disguised
    // as a missing page.
    const missing = /^(404|400)\b/.test(e.message || "");
    app.innerHTML = missing
      ? `<div class="empty">No such tournament.<br><small><a data-nav="#/tournaments" href="/tournaments">Back to the calendar</a></small></div>`
      : `<div class="empty">Couldn't load that tournament<br><small>${esc(e.message || e)}</small></div>`;
    return;
  }
  const t = d.tournament;
  const now = d.now || Math.floor(Date.now() / 1000);
  const phase = tPhase(t, now);
  const timeSum = t.scoring === "time_sum";
  track("View tournament", { tournament: t.slug });

  const standings = d.standings || [];
  const board = standings.length
    ? `<div class="table-wrap"><div class="tscroll"><table class="data">
        <thead><tr>
          <th class="num">#</th><th>Player</th>
          ${timeSum ? '<th class="num">Total time</th>' : '<th class="num">Points</th>'}
          <th class="num">Maps</th><th class="num">Map wins</th>
          ${timeSum ? "" : '<th class="num">Total time</th>'}
        </tr></thead>
        <tbody>${standings
          .map(
            (s) => `<tr class="clickable ${timeSum && s.complete === false ? "tincomplete" : ""}" data-nav="#/player/${s.id}" title="${
              timeSum && s.complete === false ? "Hasn't finished every pool map, so not ranked" : ""
            }">
              <td class="num ${rankClass(s.place)}">${s.place <= 3 ? `<span class="trophy p${s.place}">${["🥇", "🥈", "🥉"][s.place - 1]}</span> ` : ""}${s.place}</td>
              <td>${wname(s.name)}</td>
              ${timeSum ? `<td class="num"><span class="time">${fmtTime(s.totalTime)}</span></td>` : `<td class="num"><b>${fmtNum(s.points)}</b></td>`}
              <td class="num">${fmtNum(s.mapsPlayed)}<span class="muted">/${fmtNum(d.maps.length)}</span></td>
              <td class="num">${fmtNum(s.mapWins)}</td>
              ${timeSum ? "" : `<td class="num muted"><span class="time">${fmtTime(s.totalTime)}</span></td>`}
            </tr>`
          )
          .join("")}</tbody></table></div></div>
        ${timeSum ? `<div class="muted tnote">Greyed-out rows haven't finished every map yet, so they aren't ranked.</div>` : ""}`
    : `<div class="empty">${
        phase === "upcoming"
          ? "Hasn't started yet — the board fills in as people race."
          : "Nobody registered has set a time yet. Be first."
      }</div>`;

  const joinPanel = t.joinOpen
    ? `<div class="panel tjoin" id="tjoin">
        <div class="tjoin-head">Enter this tournament</div>
        <p class="muted">Take a code here, then type <code>/tournament &lt;code&gt;</code> on any Racesow server to
          link it to the name you play under. Already in-game? <code>/tournament join</code> does both at once.</p>
        <div class="tjoin-row">
          <input id="tjoin-name" type="text" maxlength="64" placeholder="Your in-game name (optional)" autocomplete="off">
          <button class="btn primary" id="tjoin-go" type="button">Get my code</button>
        </div>
        <div class="tjoin-out" id="tjoin-out"></div>
      </div>`
    : `<div class="panel tjoin closed muted">${
        phase === "upcoming" || phase === "live"
          ? "Entries are closed for this tournament."
          : "This tournament is over — entries are closed."
      }</div>`;

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/tournaments" href="/tournaments">Tournaments</a> / ${esc(t.name)}</div>
    <div class="page-title" style="font-size:34px">${esc(t.name)} <span class="tbadge ${phase}">${TPHASE_LABEL[phase]}</span></div>
    <p class="page-sub">${esc(tWhen(t, now))} <span class="sep">·</span>
      ${fmtUtc(t.starts_at)} → ${fmtUtc(t.ends_at)}</p>
    ${t.description ? `<div class="panel tdesc tdesc-raw">${esc(t.description)}</div>` : ""}

    <div class="statrow">
      <div class="s hl"><div class="n">${fmtNum(d.maps.length)}</div><div class="l">Maps</div></div>
      <div class="s hl"><div class="n">${fmtNum(d.entrants.length)}</div><div class="l">Entrants</div></div>
      <div class="s"><div class="n">${fmtNum(standings.length)}</div><div class="l">On the board</div></div>
      <div class="s"><div class="n">${timeSum ? "Total time" : "Points"}</div><div class="l">Scoring</div></div>
    </div>

    ${joinPanel}

    <div class="page-title" style="font-size:20px">STANDINGS${
      phase === "finalized" ? ' <span class="accent">·</span> final' : phase === "live" ? ' <span class="accent">·</span> live' : ""
    }</div>
    ${board}

    <div class="page-title" style="font-size:20px">MAP POOL <span class="accent">·</span> ${fmtNum(d.maps.length)}</div>
    ${d.maps.length ? tMapBoards(d, d.maps) : `<div class="empty">No maps in the pool yet.</div>`}

    <div class="page-title" style="font-size:20px">HOW IT WORKS</div>
    <div class="panel tdesc">
      <p>Enter any time before it ends — <b>every run you set inside the window counts</b>, including runs you
        set before you entered. Your times also go to the normal leaderboard exactly as they always do;
        a tournament never changes how a run is recorded.</p>
      <p>${
        timeSum
          ? "Scoring is <b>total time</b>: your best time on each pool map, added up. Only players who finish <em>every</em> map are ranked."
          : "Scoring is <b>placement points</b>: on each pool map your best time is ranked against the other entrants, and the top 15 score 100 / 85 / 75 / … points. Your total is the sum across the pool."
      }</p>
      <p>In-game: <code>/tournament</code> shows what's on, <code>/tmaps</code> lists the pool numbered, and
        <code>/tourneyvote &lt;number&gt;</code> calls the vote to move the server onto one of them
        (no argument picks a random pool map).</p>
    </div>`;

  wireTournamentJoin(t.slug);
}

/* The join form: POSTs for a code and shows it. Deliberately does not reload
 * the page — the code is the whole result and a re-render would throw it away
 * before the player could copy it. */
function wireTournamentJoin(slug) {
  const btn = document.getElementById("tjoin-go");
  if (!btn) return;
  const out = document.getElementById("tjoin-out");
  const nameEl = document.getElementById("tjoin-name");
  const submit = async () => {
    btn.disabled = true;
    out.innerHTML = `<span class="muted">Taking your entry…</span>`;
    try {
      const r = await apiPost(`/tournaments/${encodeURIComponent(slug)}/join`, { name: nameEl.value.trim() });
      track("Tournament join", { tournament: slug });
      out.innerHTML = `<div class="tcode-wrap">
        <div class="tcode">${esc(r.formatted)}</div>
        <div class="muted">Now type <code>/tournament ${esc(r.formatted)}</code> on any Racesow server.
          Case and the dash don't matter. Keep this code — it's your entry.</div>
      </div>`;
      // Deliberately leave the button disabled: a second click would mint a
      // second unclaimed code and push the first one off screen.
      btn.textContent = "Code issued";
    } catch (e) {
      btn.disabled = false;
      out.innerHTML = `<span class="tjoin-err">${esc(e.message || "Could not take your entry.")}</span>`;
    }
  };
  btn.addEventListener("click", submit);
  nameEl.addEventListener("keydown", (e) => {
    // Same lock as the button: Enter must not mint a second code and push the
    // first one off screen before the player has copied it.
    if (e.key === "Enter" && !btn.disabled) submit();
  });
}

/* Profile trophy shelf. Rides the main profile payload (trophies are rare and
 * usually an empty array, so a lazy endpoint would cost a round trip to render
 * nothing) and renders nothing at all when there are none. */
function trophiesCard(list) {
  const t = list || [];
  if (!t.length) return "";
  const medal = (p) => (p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : "🎖");
  const place = (p) => (p === 1 ? "Winner" : p === 2 ? "2nd place" : p === 3 ? "3rd place" : "Took part");
  return `
    <div class="page-title" style="font-size:20px">TROPHIES <span class="accent">·</span> ${fmtNum(t.length)}</div>
    <div class="panel trophycase">
      ${t
        .map(
          (x) => `<a class="trophy-item p${x.place}" data-nav="#/tournaments/${esc(x.slug)}" href="/tournaments/${esc(x.slug)}"
            title="${esc(`${place(x.place)} in ${x.name} · ${fmtUtc(x.startsAt, { time: false })} – ${fmtUtc(x.endsAt, { time: false })}${x.field ? ` · field of ${x.field}` : ""}`)}">
            <span class="trophy-medal">${medal(x.place)}</span>
            <span class="trophy-body">
              <span class="trophy-name">${esc(x.name)}</span>
              <span class="trophy-sub muted">${esc(place(x.place))}${x.field ? ` of ${fmtNum(x.field)}` : ""} · ${esc(fmtUtc(x.endsAt, { time: false }))}</span>
            </span>
          </a>`
        )
        .join("")}
    </div>`;
}

/* ------------------------------ /blog ------------------------------------ *
 * Site updates: what changed and when. The list renders teasers the API derives
 * server-side (it never ships post bodies), and a post's HTML is rendered by
 * the server's markdown-lite renderer — the client only inserts it.
 *
 * That insertion is the one innerHTML on this page that is not built from esc()
 * output, which is exactly why the rendering lives on the server: web/blog.js
 * escapes the author's text before re-introducing its own fixed tag vocabulary,
 * so `html` here can never contain markup an author typed. */

// "20 Aug 2026" — posts are dated, not relative: "3d ago" is useless on a
// changelog you are reading to find out when something shipped.
function blogDate(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

const blogTagPill = (post) =>
  `<span class="pill blogtag ${esc(post.tag || "update")}">${esc(post.tagLabel || "Update")}</span>`;

async function viewBlog(params) {
  loading();
  const state = { offset: Math.max(0, parseInt(params.offset, 10) || 0) };
  const d = await api("/blog" + buildQuery({ limit: 10, offset: state.offset || "" }));
  const posts = d.posts || [];
  const list = posts.length
    ? posts
        .map(
          (p) => `<article class="panel blogcard">
            <div class="blogcard-head">
              ${blogTagPill(p)}
              <time datetime="${esc(new Date((p.publishedAt || 0) * 1000).toISOString())}">${esc(blogDate(p.publishedAt))}</time>
            </div>
            <h2><a data-nav="#/blog/${encodeURIComponent(p.slug)}" href="/blog/${encodeURIComponent(p.slug)}">${esc(p.title)}</a></h2>
            <p class="blogteaser">${esc(p.teaser)}</p>
            <a class="blogmore" data-nav="#/blog/${encodeURIComponent(p.slug)}" href="/blog/${encodeURIComponent(p.slug)}">Read more →</a>
          </article>`
        )
        .join("")
    : `<div class="empty">No updates posted yet.</div>`;

  app.innerHTML = `
    <div class="page-title"><span class="accent">SITE</span> UPDATES</div>
    <p class="page-sub">New maps, site changes and server news.
      <a href="/blog.xml" class="rsslink" target="_blank" rel="noopener">RSS feed</a></p>
    <div class="bloglist">${list}</div>
    ${pager(state, { offset: d.offset, limit: d.limit, total: d.total }, "#/blog")}`;
}

async function viewBlogPost(slug) {
  loading();
  let d;
  try {
    d = await api("/blog/" + encodeURIComponent(slug));
  } catch (e) {
    // A draft, a deleted post, or a typo'd link: say so on the page rather than
    // dropping the reader into the generic error view.
    app.innerHTML = `<div class="crumbs"><a data-nav="#/blog">Updates</a></div>
      <div class="empty">That update doesn't exist (any more).<br>
        <small><a data-nav="#/blog">See all updates</a></small></div>`;
    return;
  }
  const nav = [
    d.prev ? `<a class="blognav prev" data-nav="#/blog/${encodeURIComponent(d.prev.slug)}" href="/blog/${encodeURIComponent(d.prev.slug)}">← ${esc(d.prev.title)}</a>` : `<span></span>`,
    d.next ? `<a class="blognav next" data-nav="#/blog/${encodeURIComponent(d.next.slug)}" href="/blog/${encodeURIComponent(d.next.slug)}">${esc(d.next.title)} →</a>` : `<span></span>`,
  ].join("");

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/blog">Updates</a> / ${esc(d.title)}</div>
    <article class="panel blogpost">
      <div class="blogcard-head">
        ${blogTagPill(d)}
        <time datetime="${esc(new Date((d.publishedAt || 0) * 1000).toISOString())}">${esc(blogDate(d.publishedAt))}</time>
      </div>
      <h1 class="blogtitle">${esc(d.title)}</h1>
      <div class="blogbody">${d.html || ""}</div>
    </article>
    <div class="blognavrow">${nav}</div>`;
}

async function router() {
  stopLiveRefresh();
  stopReplay();
  stopServerStream();
  // Legacy "#/…" URL (old shared link / bookmark): rewrite to the clean path
  // once, so the address bar never keeps a "#".
  if (location.hash) {
    history.replaceState(null, "", navHref(location.hash));
  }
  const { path, params } = parseRoute();
  setActiveNav(path);
  window.scrollTo(0, 0);
  try {
    if (path === "/") await viewOverview();
    else if (path === "/maps") await viewMaps(params);
    else if (path === "/demo") await viewDemos(params);
    else if (path.startsWith("/demo/")) await viewDemosMap(parseInt(path.split("/")[2], 10));
    else if (path === "/players") await viewPlayers(params);
    else if (path === "/compare") await viewCompare(params);
    else if (path === "/achievements") await viewAchievements();
    else if (path === "/stats") await viewStats(params);
    // Exact match first, same as /tournaments: "/blog" is the index,
    // "/blog/<slug>" one post.
    else if (path === "/blog") await viewBlog(params);
    else if (path.startsWith("/blog/")) await viewBlogPost(decodeURIComponent(path.slice(6)));
    // Exact match first: "/tournaments" is the calendar, "/tournaments/<slug>"
    // one tournament. Both share a stem so setActiveNav's startsWith highlights
    // the header link on either.
    else if (path === "/tournaments") await viewTournaments();
    else if (path.startsWith("/tournaments/")) await viewTournament(decodeURIComponent(path.slice(13)));
    else if (path === "/live") await viewLive();
    else if (path === "/about") await viewAbout();
    else if (path === "/colors") viewColors();
    else if (path.startsWith("/server/")) await viewServer(parseInt(path.split("/")[2], 10));
    else if (path.startsWith("/replay/")) await viewReplay(parseInt(path.split("/")[2], 10), parseInt(path.split("/")[3], 10) || null);
    else if (path.startsWith("/map/")) await viewMap(parseInt(path.split("/")[2], 10));
    else if (path.startsWith("/player/")) await viewPlayer(parseInt(path.split("/")[2], 10), params);
    else app.innerHTML = `<div class="empty">Page not found.</div>`;
  } catch (e) {
    errorView(e);
  }
}

window.addEventListener("popstate", router);
window.addEventListener("DOMContentLoaded", async () => {
  initGlobalSearch();
  router();
  try {
    const d = await overview();
    if (d.lastUpdate) {
      const dt = new Date(d.lastUpdate * 1000).toISOString().slice(0, 10);
      document.getElementById("foot-updated").textContent = "Updated: " + dt;
    }
  } catch (e) { /* ignore */ }
});
