/* Racesow stats — vanilla-JS single-page app over the /api backend. */
"use strict";

const app = document.getElementById("app");

/* ----------------------------- helpers ----------------------------------- */
async function api(path) {
  const res = await fetch("/api" + path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
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

/* External link to a map's page on padpork.org (map downloads/info). */
function padporkUrl(mapName) {
  return "https://padpork.org/maps/" + encodeURIComponent(mapName);
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
  const path = location.pathname || "/";
  const params = {};
  new URLSearchParams(location.search).forEach((v, k) => (params[k] = v));
  return { path: path || "/", params };
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
  const d = await api("/overview");
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
          <thead><tr><th>#</th><th>Player</th><th class="num">Points</th><th class="num">WRs</th><th class="num">Maps</th></tr></thead>
          <tbody>
            ${d.hallOfFame.map((p) => `
              <tr class="clickable" data-nav="#/player/${p.id}">
                <td class="rankcell ${rankClass(p.rank)}">${p.rank}</td>
                <td>${wname(p.name)}</td>
                <td class="num">${fmtNum(p.points)}</td>
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
                  <span class="fi-map">${esc(r.map)}</span>
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
        <div class="panel">
          <h3><span class="dot"></span> Most-Raced Maps</h3>
          <div class="tscroll"><table class="data most-raced">
            <thead><tr><th>Map</th><th class="num">Records</th><th class="num">Finishes</th></tr></thead>
            <tbody>
              ${d.topMaps.map((m) => `
                <tr class="clickable" data-nav="#/map/${m.id}">
                  <td class="mapname">${esc(m.name)}</td>
                  <td class="num">${fmtNum(m.records != null ? m.records : m.races)}</td>
                  <td class="num">${fmtNum(m.finishes != null ? m.finishes : m.races)}</td>
                </tr>`).join("")}
            </tbody>
          </table></div>
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

  // Fill the Hall of Fame to exactly the right column's height: the API
  // sends more rows than ever fit and the excess is trimmed against the
  // measured layout, so the panel ends flush — no scrollbar, no dead gap —
  // whatever the recent/servers panels happen to contain. (In the stacked
  // single-column layout the right column sits below, so nothing trims.)
  // The top-20 Hall of Fame is the fixed reference; the right column trims
  // trailing Most-Raced Maps rows (served with spares) until it ends flush
  // with it. Two-column layout only — stacked columns need no matching.
  // NB: measure the right column's last PANEL, not the column div — the grid
  // stretches the column container to the row height, so the container's own
  // bottom never moves as rows are removed.
  if (window.matchMedia("(min-width: 821px)").matches) {
    const hof = app.querySelector(".panel.hof");
    const rightEnd = hof && hof.nextElementSibling && hof.nextElementSibling.lastElementChild;
    const mostRaced = app.querySelector("table.most-raced tbody");
    if (hof && rightEnd && mostRaced) {
      const hofBottom = hof.getBoundingClientRect().bottom;
      const rows = [...mostRaced.querySelectorAll("tr")];
      while (rows.length > 3 && rightEnd.getBoundingClientRect().bottom > hofBottom + 2) {
        rows.pop().remove();
      }
    }
  }
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
              <td class="mapname">${esc(m.name)}
                <a class="extlink" href="${padporkUrl(m.name)}" target="_blank" rel="noopener external" title="${esc(m.name)} on padpork.org">↗</a>
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
    <p class="page-sub">Ranked by race points (top-15 finish on each map). Search by name and sort by any column.</p>
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
              <td class="num">${fmtNum(p.wr)}</td>
              <td class="num">${fmtNum(p.podium)}</td>
              <td class="num">${fmtNum(p.maps)}</td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No players match “${esc(state.q)}”.</td></tr>`}
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
    <div class="crumbs"><a data-nav="#/maps">Maps</a> / ${esc(d.name)}</div>
    ${wr ? `
      <div class="wr-banner">
        <div class="kicker">◆ World Record</div>
        <div class="wr-time time">${fmtTime(wr.time)}</div>
        <div class="holder">by ${wname(wr.name)} <span class="pill v1">${esc(wr.versionName || "")}</span></div>
        ${splitsHtml}
        ${wr.ghost || (wr.demo && wr.demo.url) ? `
        <div class="replay-actions">
          ${wr.ghost ? `<button class="btn replay-watch" data-nav="#/replay/${id}">▶ Watch in browser</button>` : ""}
          ${wr.demo && wr.demo.url ? `<a class="btn replay-demo" href="${esc(wr.demo.url)}" download rel="noopener">⬇ Download demo</a>` : ""}
        </div>
        ${wr.demo && wr.demo.url ? `<details class="demo-help"><summary>How to watch the demo in Warsow</summary>
          <p>Download the file into your Warsow <code>racemod/demos</code> folder, then in the console run
          <code>demo &lt;filename&gt;</code> — or launch <code>warsow +demo &lt;filename&gt;</code>. It plays the record run start&#8209;to&#8209;finish.</p></details>` : ""}
        ` : ""}
      </div>` : ""}
    ${perfectHtml}

    <div class="page-title">${esc(d.name)}</div>
    <p class="page-sub">${fmtNum(d.records != null ? d.records : d.races)} ranked times · ${fmtNum(d.finishes != null ? d.finishes : d.races)} finishes · ${fmtNum(d.players)} players on the board
      · <a class="extlink" href="${padporkUrl(d.name)}" target="_blank" rel="noopener external">padpork.org ↗</a></p>

    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr><th>#</th><th>Player</th><th class="num">Time</th><th class="num">Behind</th><th class="num">Gap</th><th>Version</th></tr></thead>
        <tbody>
          ${d.leaderboard.map((r, i) => `
            <tr class="clickable" data-nav="#/player/${r.playerId}">
              <td class="rankcell ${rankClass(r.pos)}">${r.pos}</td>
              <td>${wname(r.name)}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num"><span class="time">${r.pos === 1 ? "—" : "+" + fmtTime(r.time - d.leaderboard[0].time)}</span></td>
              <td class="num"><span class="time muted">${i === 0 ? "—" : "+" + fmtTime(r.time - d.leaderboard[i - 1].time)}</span></td>
              <td><span class="pill ${r.version === 1 ? "v1" : ""}">${esc(r.versionName || "")}</span></td>
            </tr>`).join("") || `<tr><td colspan="6" class="empty">No runs recorded.</td></tr>`}
        </tbody>
      </table>
    </div></div>`;
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

async function viewReplay(id) {
  loading();
  const d = await api(`/maps/${id}?limit=1`);
  const wr = d.wr;
  if (!wr || !wr.ghost) {
    app.innerHTML = `<div class="crumbs"><a data-nav="#/map/${id}">${esc(d.name)}</a> / Replay</div>
      <div class="empty">No in-browser replay for this map yet.<br><small>A ghost is captured the next time a world record is set here.</small></div>`;
    return;
  }
  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/maps">Maps</a> / <a data-nav="#/map/${id}">${esc(d.name)}</a> / Replay</div>
    <div class="replay-head">
      <div class="page-title" style="font-size:24px">${esc(d.name)} <span class="accent">·</span> WR Replay</div>
      <div class="replay-sub">by ${wname(wr.name)} <span class="pill wr">WR</span> <span class="time">${fmtTime(wr.time)}</span>
        ${wr.demo && wr.demo.url ? `<a class="btn replay-demo" href="${esc(wr.demo.url)}" download rel="noopener">⬇ Download demo</a>` : ""}
      </div>
    </div>
    <div id="replay-root" class="replay-root"></div>`;
  const root = document.getElementById("replay-root");
  try {
    const mod = await import("/assets/js/replay.js");
    disposeReplay = await mod.mountReplay(root, { mapId: id, mapName: d.name, wr });
  } catch (e) {
    root.innerHTML = `<div class="empty">Replay failed to load<br><small>${esc(e.message || e)}</small></div>`;
  }
}

async function viewPlayer(id, params) {
  loading();
  const state = {
    sort: params.sort || "time",
    order: params.order || "asc",
    offset: parseInt(params.offset || "0", 10) || 0,
  };
  const d = await api(
    `/players/${id}` + buildQuery({ sort: state.sort, order: state.order, limit: PAGE, offset: state.offset })
  );
  const s = d.standing;
  const rec = d.records;
  const hasAttempts = d.attempts != null; // legacy DBs have no attempts column

  const aliasHtml =
    d.aliases && d.aliases.length
      ? `<div class="aliases">also raced as ${d.aliases
          .slice(0, 12)
          .map((a) => wname(a.name))
          .join('<span class="sep">·</span>')}${d.aliases.length > 12 ? ` <span class="muted">+${d.aliases.length - 12} more</span>` : ""}</div>`
      : "";

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/players">Players</a> / ${esc(d.simplified)}</div>
    <div class="page-title" style="font-size:34px">${wname(d.name)}</div>
    <p class="page-sub">${s.rank ? "Overall rank #" + s.rank : "Unranked"}${d.login ? " · login: " + esc(d.login) : ""}</p>
    ${aliasHtml}

    <div class="statrow">
      <div class="s hl"><div class="n">${fmtNum(s.points)}</div><div class="l">Points</div></div>
      <div class="s"><div class="n">${fmtNum(s.wr)}</div><div class="l">World Records</div></div>
      <div class="s"><div class="n">${fmtNum(s.podium)}</div><div class="l">Podiums</div></div>
      <div class="s"><div class="n">${fmtNum(s.maps)}</div><div class="l">Maps Raced</div></div>
      ${d.finishes != null ? `<div class="s"><div class="n">${fmtNum(d.finishes)}</div><div class="l">Finishes</div></div>` : ""}
      ${d.attempts != null ? `<div class="s"><div class="n">${fmtNum(d.attempts)}</div><div class="l">Attempts</div></div>` : ""}
    </div>

    <div class="page-title" style="font-size:20px">RECORDS <span class="accent">·</span> ${fmtNum(rec.total)}</div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          ${th("Map", "map", state)}
          ${th("Time", "time", state, "num")}
          ${th("Global Rank", "rank", state, "num")}
          ${hasAttempts ? th("Attempts", "attempts", state, "num") : ""}
        </tr></thead>
        <tbody>
          ${rec.rows.map((r) => `
            <tr class="clickable" data-nav="#/map/${r.map_id}">
              <td class="mapname">${esc(r.map_name)}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num ${rankClass(r.rank)}">${r.rank === 1 ? '<span class="pill wr">WR</span> ' : ""}#${fmtNum(r.rank)}</td>
              ${hasAttempts ? `<td class="num"><span class="muted">${fmtNum(r.attempts)}</span></td>` : ""}
            </tr>`).join("") || `<tr><td colspan="${hasAttempts ? 4 : 3}" class="empty">No records.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, rec, `#/player/${id}`)}</div>`;

  wireSort(`#/player/${id}`, state, ["map", "time", "rank", "attempts"]);
  // (The address bar is already the clean /player/<id> path from pushState —
  // where the server-rendered OG tags for Discord/social unfurls live.)
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
  const html = `
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
async function renderServer(id) {
  const s = await api(`/servers/${id}`);
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

  const html = `
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
  if (app.dataset.srvHtml !== html) {
    app.dataset.srvHtml = html;
    app.innerHTML = html;
  }
}

async function viewServer(id) {
  loading();
  delete app.dataset.srvHtml;
  await renderServer(id);
  stopLiveRefresh();
  liveTimer = setInterval(() => {
    if (document.hidden || parseRoute().path !== `/server/${id}`) return;
    renderServer(id).catch(() => {});
  }, LIVE_REFRESH_MS);
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
      go(base + buildQuery({ q, sort: state.sort, order: state.order, offset: 0 }));
    }, 350);
  });
  // keep focus + caret after re-render
  const v = el.value;
  el.focus();
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
              <span class="mapname">${esc(m.name)}</span><small>${fmtNum(m.finishes != null ? m.finishes : m.races)} finishes</small>
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
    else if (path === "/live") await viewLive();
    else if (path.startsWith("/server/")) await viewServer(parseInt(path.split("/")[2], 10));
    else if (path.startsWith("/replay/")) await viewReplay(parseInt(path.split("/")[2], 10));
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
    const d = await api("/overview");
    if (d.lastUpdate) {
      const dt = new Date(d.lastUpdate * 1000).toISOString().slice(0, 10);
      document.getElementById("foot-updated").textContent = "Updated: " + dt;
    }
  } catch (e) { /* ignore */ }
});
