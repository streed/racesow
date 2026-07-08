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

/* --------------------------- hash routing -------------------------------- */
function parseHash() {
  let h = location.hash.slice(1) || "/";
  const [path, qs] = h.split("?");
  const params = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => (params[k] = v));
  return { path: path || "/", params };
}

function go(hash) {
  location.hash = hash;
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
  const maxV = Math.max(...d.versions.map((v) => v.races), 1);

  app.innerHTML = `
    <section class="hero">
      <h1>WORLD RECORDS<br>OF <b>WARSOW RACE</b></h1>
      <p>Every strafe, ramp-slide and rocket-jump in the livesow database —
         ${fmtNum(t.races)} recorded runs across ${fmtNum(t.maps)} maps. Chase the clock.</p>
    </section>

    <div class="tiles">
      ${tile(t.worldRecords, "World Records")}
      ${tile(t.maps, "Maps")}
      ${tile(t.rankedPlayers, "Ranked Players")}
      ${tile(t.races, "Total Runs")}
      ${tile(t.checkpoints, "Checkpoints")}
    </div>

    <div class="grid-2">
      <div class="panel">
        <h3><span class="dot"></span> Hall of Fame</h3>
        <div class="tscroll"><table class="data">
          <thead><tr><th class="num">#</th><th>Player</th><th class="num">Points</th><th class="num">WRs</th><th class="num">Maps</th></tr></thead>
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
          <h3><span class="dot"></span> Runs by Version</h3>
          <div class="vbars">
            ${d.versions.map((v) => `
              <div class="vbar">
                <div class="top"><b>${esc(v.name)}</b><span>${fmtNum(v.races)}</span></div>
                <div class="track"><div class="fill" style="width:${(v.races / maxV) * 100}%"></div></div>
              </div>`).join("")}
          </div>
        </div>
        <div class="panel">
          <h3><span class="dot"></span> Most-Run Maps</h3>
          <div class="tscroll"><table class="data">
            <thead><tr><th>Map</th><th class="num">Runs</th></tr></thead>
            <tbody>
              ${d.topMaps.slice(0, 10).map((m) => `
                <tr class="clickable" data-nav="#/map/${m.id}">
                  <td class="mapname">${esc(m.name)}</td>
                  <td class="num">${fmtNum(m.races)}</td>
                </tr>`).join("")}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>`;
}

function tile(num, lbl) {
  return `<div class="tile"><div class="num">${fmtNum(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;
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
          ${th("Runs", "races", state, "num")}
          ${th("World Record", "wr_time", state, "num")}
          <th>Record Holder</th>
        </tr></thead>
        <tbody>
          ${data.rows.map((m) => `
            <tr class="clickable" data-nav="#/map/${m.id}">
              <td class="mapname">${esc(m.name)}</td>
              <td class="num">${fmtNum(m.races)}</td>
              <td class="num"><span class="time">${m.wr_time != null ? fmtTime(m.wr_time) : "—"}</span></td>
              <td>${m.wr_name ? wname(m.wr_name) : '<span class="pill">no runs</span>'}</td>
            </tr>`).join("") || `<tr><td colspan="4" class="empty">No maps match “${esc(state.q)}”.</td></tr>`}
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
          ${th("#", "rank", state, "num")}
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
  const d = await api(`/maps/${id}?limit=100`);
  const wr = d.wr;
  let splitsHtml = "";
  if (wr && wr.splits && wr.splits.length) {
    splitsHtml = `<div class="splits">${wr.splits
      .map((t, i) => `<div class="split"><span class="cpn">CP${i + 1}</span> <b>${fmtTime(t)}</b></div>`)
      .join("")}</div>`;
  }

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/maps">Maps</a> / ${esc(d.name)}</div>
    ${wr ? `
      <div class="wr-banner">
        <div class="kicker">◆ World Record</div>
        <div class="wr-time time">${fmtTime(wr.time)}</div>
        <div class="holder">by ${wname(wr.name)} <span class="pill v1">${esc(wr.versionName || "")}</span></div>
        ${splitsHtml}
      </div>` : ""}

    <div class="page-title">${esc(d.name)}</div>
    <p class="page-sub">${fmtNum(d.races)} recorded runs · ${fmtNum(d.leaderboard.length)} players on the board</p>

    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr><th class="num">#</th><th>Player</th><th class="num">Time</th><th class="num">Behind</th><th>Version</th></tr></thead>
        <tbody>
          ${d.leaderboard.map((r) => `
            <tr class="clickable" data-nav="#/player/${r.playerId}">
              <td class="rankcell ${rankClass(r.pos)}">${r.pos}</td>
              <td>${wname(r.name)}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num"><span class="time">${r.pos === 1 ? "—" : "+" + fmtTime(r.time - d.leaderboard[0].time)}</span></td>
              <td><span class="pill ${r.version === 1 ? "v1" : ""}">${esc(r.versionName || "")}</span></td>
            </tr>`).join("") || `<tr><td colspan="5" class="empty">No runs recorded.</td></tr>`}
        </tbody>
      </table>
    </div></div>`;
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

  app.innerHTML = `
    <div class="crumbs"><a data-nav="#/players">Players</a> / ${esc(d.simplified)}</div>
    <div class="page-title" style="font-size:34px">${wname(d.name)}</div>
    <p class="page-sub">${s.rank ? "Overall rank #" + s.rank : "Unranked"}${d.login ? " · login: " + esc(d.login) : ""}</p>

    <div class="statrow">
      <div class="s hl"><div class="n">${fmtNum(s.points)}</div><div class="l">Points</div></div>
      <div class="s"><div class="n">${fmtNum(s.wr)}</div><div class="l">World Records</div></div>
      <div class="s"><div class="n">${fmtNum(s.podium)}</div><div class="l">Podiums</div></div>
      <div class="s"><div class="n">${fmtNum(s.maps)}</div><div class="l">Maps Raced</div></div>
    </div>

    <div class="page-title" style="font-size:20px">RECORDS <span class="accent">·</span> ${fmtNum(rec.total)}</div>
    <div class="table-wrap"><div class="tscroll">
      <table class="data">
        <thead><tr>
          ${th("Map", "map", state)}
          ${th("Time", "time", state, "num")}
          ${th("Global Rank", "rank", state, "num")}
        </tr></thead>
        <tbody>
          ${rec.rows.map((r) => `
            <tr class="clickable" data-nav="#/map/${r.map_id}">
              <td class="mapname">${esc(r.map_name)}</td>
              <td class="num"><span class="time">${fmtTime(r.time)}</span></td>
              <td class="num ${rankClass(r.rank)}">${r.rank === 1 ? '<span class="pill wr">WR</span> ' : ""}#${fmtNum(r.rank)}</td>
            </tr>`).join("") || `<tr><td colspan="3" class="empty">No records.</td></tr>`}
        </tbody>
      </table>
    </div>${pager(state, rec, `#/player/${id}`)}</div>`;

  wireSort(`#/player/${id}`, state, ["map", "time", "rank"]);
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
      go(base + buildQuery({ q: el.value.trim(), sort: state.sort, order: state.order, offset: 0 }));
    }, 250);
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
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { box.classList.remove("show"); box.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const d = await api("/search?q=" + encodeURIComponent(q));
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
              <span class="mapname">${esc(m.name)}</span><small>${fmtNum(m.races)} runs</small>
            </div>`).join("");
        }
        box.innerHTML = html || `<div class="ritem"><small>No matches.</small></div>`;
        box.classList.add("show");
      } catch (e) { /* ignore */ }
    }, 200);
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
  const { path, params } = parseHash();
  setActiveNav(path);
  window.scrollTo(0, 0);
  try {
    if (path === "/") await viewOverview();
    else if (path === "/maps") await viewMaps(params);
    else if (path === "/players") await viewPlayers(params);
    else if (path.startsWith("/map/")) await viewMap(parseInt(path.split("/")[2], 10));
    else if (path.startsWith("/player/")) await viewPlayer(parseInt(path.split("/")[2], 10), params);
    else app.innerHTML = `<div class="empty">Page not found.</div>`;
  } catch (e) {
    errorView(e);
  }
}

window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", async () => {
  initGlobalSearch();
  router();
  try {
    const d = await api("/overview");
    if (d.lastUpdate) {
      const dt = new Date(d.lastUpdate * 1000).toISOString().slice(0, 10);
      document.getElementById("foot-updated").textContent = "Snapshot: " + dt;
    }
  } catch (e) { /* ignore */ }
});
