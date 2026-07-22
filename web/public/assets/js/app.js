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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

/* External link to a map's page on padpork.org (map downloads/info). Reversed
   variants have no padpork entry, so link to the base map. */
function padporkUrl(mapName) {
  return "https://padpork.org/maps/" + encodeURIComponent(baseMapName(mapName));
}

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
          <thead><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num" title="Skill Rating — competition-weighted closeness to each map's world record">SR</th><th class="num">WRs</th><th class="num">Maps</th></tr></thead>
          <tbody>
            ${d.hallOfFame.map((p) => `
              <tr class="clickable" data-nav="#/player/${p.id}">
                <td class="rankcell ${rankClass(p.rank)}">${p.rank}</td>
                <td>${wname(p.name)}</td>
                <td class="num">${fmtNum(p.points)}</td>
                <td class="num">${fmtNum(p.sr)}</td>
                <td class="num">${fmtNum(p.wr)}</td>
                <td class="num">${fmtNum(p.maps)}</td>
              </tr>`).join("")}
          </tbody>
        </table></div>
      </div>

      <div>
        <div class="panel" style="margin-bottom:20px">
          <h3><span class="dot teal"></span> Recent Records</h3>
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

/* ---- generic sortable header ---- */
function th(label, key, state, extraClass = "") {
  const active = state.sort === key;
  const arr = active ? (state.order === "asc" ? "▲" : "▼") : "";
  return `<th class="sortable ${extraClass}" data-sort="${key}">${esc(label)} <span class="arr">${arr}</span></th>`;
}

const PAGE = 50;

async function viewMaps(params) {
  loading();
  const state = {
    q: params.q || "",
    sort: params.sort || "races",
    order: params.order || (params.sort === "name" ? "asc" : "desc"),
    offset: parseInt(params.offset || "0", 10) || 0,
  };
  const data = await api(
    "/maps" + buildQuery({ q: state.q, sort: state.sort, order: state.order, limit: PAGE, offset: state.offset })
  );

  app.innerHTML = `
    <div class="page-title"><span class="accent">MAPS</span> DATABASE</div>
    <p class="page-sub">Browse every race map, sorted and searchable. Click a map for its full leaderboard and world-record splits.</p>
    <div class="toolbar">
      <input class="filter" id="mfilter" placeholder="Filter maps by name…" value="${esc(state.q)}">
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
        </tr></thead>
        <tbody>
          ${data.rows.map((m) => `
            <tr class="clickable" data-nav="#/map/${m.id}">
              <td class="mapname">${mapNameHtml(m.name)}
                <a class="extlink" href="${padporkUrl(m.name)}" target="_blank" rel="noopener external" title="${esc(baseMapName(m.name))} on padpork.org">↗</a>
              </td>
              <td class="num">${fmtNum(m.records != null ? m.records : m.races)}</td>
              <td class="num">${fmtNum(m.finishes != null ? m.finishes : m.races)}</td>
              <td class="num"><span class="time">${m.wr_time != null ? fmtTime(m.wr_time) : "—"}</span></td>
              <td>${m.wr_name ? wname(m.wr_name) : '<span class="pill">no runs</span>'}</td>
            </tr>`).join("") || `<tr><td colspan="5" class="empty">No maps match “${esc(state.q)}”.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, data, "#/maps")}</div>`;

  wireFilter("mfilter", "#/maps", state);
  wireSort("#/maps", state);
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
    <p class="page-sub">Ranked by race points (top-15 finish on each map). Sort by <b>SR</b> for the skill-weighted board — closeness to each map's world record against the strength of the field. Search by name and sort by any column, or <a data-nav="#/compare">compare two players head-to-head ⚔</a>.</p>
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
        </tr></thead>
        <tbody>
          ${data.rows.map((p) => `
            <tr class="clickable" data-nav="#/player/${p.id}">
              <td class="rankcell ${rankClass(p.rank)}">${p.rank}</td>
              <td>${wname(p.name)}</td>
              <td class="num">${fmtNum(p.points)}</td>
              <td class="num">${fmtNum(p.sr)}</td>
              <td class="num">${fmtNum(p.wr)}</td>
              <td class="num">${fmtNum(p.podium)}</td>
              <td class="num">${fmtNum(p.maps)}</td>
            </tr>`).join("") || `<tr><td colspan="7" class="empty">No players match “${esc(state.q)}”.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, data, "#/players")}</div>`;

  wireFilter("pfilter", "#/players", state);
  wireSort("#/players", state);
}

async function viewMap(id) {
  loading();
  // limit=10000 = "everyone": the leaderboard lists every player's PR on the
  // map (the busiest map has ~180), not a top-100 cut.
  const d = await api(`/maps/${id}?limit=10000`);
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
      · <a class="extlink" href="${padporkUrl(d.name)}" target="_blank" rel="noopener external">padpork.org ↗</a></p>

    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr><th>#</th><th>Player</th><th class="num">Time</th><th class="num">Behind</th><th class="num">Gap</th><th>Version</th></tr></thead>
        <tbody>
          ${d.leaderboard.map((r, i) => `
            <tr class="clickable" data-nav="#/player/${r.playerId}">
              <td class="rankcell ${rankClass(r.pos)}">${r.pos}</td>
              <td>${wname(r.name)}${r.ghost ? ` <span class="replay-badge" data-nav="#/replay/${id}/${r.playerId}" title="Watch this run in the browser">▶ replay</span>` : ""}${r.demo && r.demo.url ? ` <a class="replay-badge demo" href="${esc(r.demo.url)}" download rel="noopener" title="Download this run's demo">⬇ demo</a>` : ""}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num"><span class="time">${r.pos === 1 ? "—" : "+" + fmtTime(r.time - d.leaderboard[0].time)}</span></td>
              <td class="num"><span class="time muted">${i === 0 ? "—" : "+" + fmtTime(r.time - d.leaderboard[i - 1].time)}</span></td>
              <td><span class="pill ${r.version === 1 ? "v1" : ""}">${esc(r.versionName || "")}</span></td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No runs recorded.</td></tr>`}
        </tbody>
      </table>
    </div></div>

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
      <div class="s hl" title="Skill Rating — competition-weighted closeness to each map's world record (0–1000)"><div class="n">${fmtNum(s.sr)}</div><div class="l">Skill Rating</div></div>
      <div class="s"><div class="n">${fmtNum(s.wr)}</div><div class="l">World Records</div></div>
      <div class="s"><div class="n">${fmtNum(s.podium)}</div><div class="l">Podiums</div></div>
      <div class="s"><div class="n">${fmtNum(s.maps)}</div><div class="l">Maps Raced</div></div>
      ${d.finishes != null ? `<div class="s"><div class="n">${fmtNum(d.finishes)}</div><div class="l">Finishes</div></div>` : ""}
      ${d.attempts != null ? `<div class="s"><div class="n">${fmtNum(d.attempts)}</div><div class="l">Attempts</div></div>` : ""}
    </div>

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
      ${s.address ? `<span class="live-addr mono">connect ${esc(s.address)}</span>` : ""}
    </div>`;
  // Cross-server mesh: the peer servers this node currently hears (from its
  // rs_mesh_status serverinfo). Renders nothing when mirroring is off or no
  // peers are up, so non-meshed servers are unaffected.
  const mesh = s.mesh && s.mesh.length
    ? `<div class="live-mesh" title="Cross-server mesh — peers this server is currently linked with">
        <span class="mesh-label">⇄ mesh</span>
        ${s.mesh.map((p) => `
          <span class="mesh-peer" title="${esc(p.tag)}${p.map ? ` on ${esc(p.map)}` : ""} · ${p.players} player${p.players === 1 ? "" : "s"}">
            <span class="mesh-tag">${esc(p.tag)}</span>
            ${p.map ? `<span class="mesh-map">▸ ${esc(p.map)}</span>` : ""}
            <span class="mesh-num">${fmtNum(p.players)}</span>
          </span>`).join("")}
      </div>`
    : "";
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

async function renderLive() {
  const d = await api("/live");
  const online = d.servers.filter((s) => s.online);
  const total = online.reduce((n, s) => n + s.players.length, 0);
  const maint = d.maintenance && d.maintenance.active
    ? `<div class="maint-banner">🛠 Maintenance in progress — ${esc((d.maintenance.message || "").replace(/\^[0-9]/g, ""))}</div>`
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
    ${d.servers.length
      ? `<div class="live-grid">${d.servers.map(liveServerCard).join("")}</div>`
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
        ${s.address ? `<span class="live-addr mono">connect ${esc(s.address)}</span>` : ""}
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
    title: "Practice mode",
    note: "Times are NOT recorded while any of these are in effect. Use /kill to get back to a clean start and race for real.",
    rows: [
      ["/practicemode", "Toggle practice mode on/off."],
      ["/noclip", "Fly through the world to line things up (practice mode only)."],
      ["/position save", "Save your current spot and weapons as your spawn point."],
      ["/position load", "Teleport back to your saved spot."],
      ["/position speed <value>", "Spawn carrying this much speed, e.g. 1000. Use 0 to reset."],
      ["/position clear", "Reset your saved spot and weapons to defaults."],
      ["/position recall best [player]", "Step through the positions from your best run, or a named player's."],
      ["/position recall steal", "Grab the live position of whoever you're spectating."],
      ["/position recall cpX | start | end", "Jump to a checkpoint, or the first / last saved position."],
      ["/position recall rl | pg | gl", "Jump to the first spot you were holding that weapon."],
    ],
  },
  {
    title: "Reverse mode",
    note: "Race the map backwards. Cross the FINISH line to start your timer, run the checkpoints in reverse, and cross the START line to finish. Prejump rules still apply. Your time is saved on a separate “<map>-reversed” leaderboard (shown with a REVERSE badge on this site) and never mixes with the normal times.",
    rows: [
      ["/reverse", "Race the map backwards. Teleports you to the finish line (your reverse start) and drops you into noclip to fine-tune the spot; leave noclip (/noclip, or /reverse again) to lock it in as your spawn. Then cross the finish to start."],
      ["/showtriggers", "Toggle markers at the start and finish trigger planes so you can see where to cross. Only you see them."],
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
    "Two scores, side by side. <b>Points</b> is the classic board: you earn points for a top-15 finish on each map (100 for a WR down to 32 for 15th), and your overall rank is the <b>sum</b> across every map you've raced — so it rewards showing up on a lot of maps. <b>SR (Skill Rating)</b> is the skill board: for each map it measures how close your time is to the world record (WR ÷ your time) and weights it by how many people you beat, then <b>averages</b> that across your maps on a 0–1000 scale — so it rewards being fast against strong fields rather than simply racing more maps. A lone lucky record won't top the SR board until it's backed up across a real sample. World records and podium finishes are tracked separately on your profile."],
  ["A map is broken or shouldn't be here — what do I do?",
    "Flag it for review. In-game, type <span class=\"mono\">/flag</span> while you're on the map (add a reason if you like, e.g. <span class=\"mono\">/flag broken</span>). Or open the map on this site and hit <b>⚑ Flag this map for review</b>. Moderators check flagged maps and can pull a bad one from the vote pool and map cycle."],
];

async function viewAbout() {
  app.innerHTML = `
    <div class="crumbs">Racesow / About</div>
    <div class="page-title"><span class="accent">ABOUT</span> RACESOW</div>
    <p class="page-sub">Warsow race: go from the start line to the finish as fast as movement will carry you. This is the network, the commands, and the answers to the usual questions.</p>

    <div class="about">
      <div class="panel about-lead">
        <h3><span class="dot"></span> What this is</h3>
        <div class="about-body">
          <p>This is a rebuilding of the old <b>livesow</b> and <b>mgxrace</b> servers. It gives older players a place to keep playing, and new players a place to learn.</p>
          <p>Along the way, new additions and features have been added to improve the experience for more people: a live record book, downloadable demos, in-browser replays, and a cross-server mesh that links the servers together.</p>
        </div>
      </div>

      <div class="panel">
        <h3><span class="dot teal"></span> Join a server</h3>
        <div class="about-body">
          <p>Open the Warsow console with <b>~</b> and paste a connect line. Missing maps download from the server on join.</p>
          <div class="srv-cards">
            ${ABOUT_SERVERS.map((s) => `
              <div class="srv-card">
                <div class="srv-name">${esc(s.name)}</div>
                <div class="srv-region muted">${esc(s.region)}</div>
                <div class="connect-row">
                  <code class="connect mono">connect ${esc(s.connect)}</code>
                  <button class="copy-btn" data-copy="connect ${esc(s.connect)}" title="Copy to clipboard">copy</button>
                </div>
              </div>`).join("")}
          </div>
          <p class="muted about-fineprint">The two servers are meshed: you'll see players on the other one as ghosts and can race them across the Atlantic. See <b>/who</b>, <b>/watch</b> and <b>/meshvote</b> below.</p>
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
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => {
        copyEl.classList.add("copied");
        setTimeout(() => copyEl.classList.remove("copied"), 1200);
      })
      .catch(() => {});
    return;
  }
  const link = e.target.closest("a[href]");
  if (link && !link.hasAttribute("data-nav")) return;
  const el = e.target.closest("[data-nav]");
  if (el) {
    e.preventDefault();
    go(el.getAttribute("data-nav"));
    document.getElementById("gresults")?.classList.remove("show");
    const gs = document.getElementById("gsearch");
    if (gs && el.closest(".gsearch")) gs.value = "";
  }
});

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
    else if (path === "/players") await viewPlayers(params);
    else if (path === "/compare") await viewCompare(params);
    else if (path === "/live") await viewLive();
    else if (path === "/about") await viewAbout();
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
