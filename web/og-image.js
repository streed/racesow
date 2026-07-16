// On-the-fly Open Graph card images (1200x630 PNG) for player pages, in the
// site's "going fast" theme. Discord/social crawlers fetch these from
// /og/player/<id>.png (see server.js); the SVG is rasterized with resvg
// using the vendored Fira Sans Condensed faces (og-assets/fonts, SIL OFL),
// so rendering is deterministic — no system fonts involved.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAsync } from "@resvg/resvg-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "og-assets", "fonts");
const FONT_FILES = [
  path.join(FONT_DIR, "FiraSansCondensed-Bold.ttf"),
  path.join(FONT_DIR, "FiraSansCondensed-SemiBold.ttf"),
  path.join(FONT_DIR, "FiraSansCondensed-Regular.ttf"),
];

const W = 1200;
const H = 630;

// Warsow ^0-^9 palette, matching .wc0-.wc9 in style.css. ^0 (black) gets a
// light stroke so it stays legible on the dark card, mirroring the CSS glow.
const WC = ["#1a1a1a", "#ff3d3d", "#4dff5a", "#ffe23d", "#4d74ff", "#35e0ff", "#ff5ce0", "#ffffff", "#ff9a3d", "#9099ad"];

const escXml = (s) =>
  String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// "^1No^7va" -> SVG tspans in Warsow colours.
function colouredTspans(raw) {
  const str = String(raw);
  let out = "";
  let color = "7";
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const stroke = color === "0" ? ' stroke="#8b93ab" stroke-width="1" paint-order="stroke"' : "";
    out += `<tspan fill="${WC[+color]}"${stroke}>${escXml(buf)}</tspan>`;
    buf = "";
  };
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "^" && /[0-9]/.test(str[i + 1] || "")) {
      flush();
      color = str[++i];
    } else {
      buf += str[i];
    }
  }
  flush();
  return out;
}

function statBlock(x, value, label, hl = false) {
  return `
    <g transform="translate(${x} 0)">
      <text x="0" y="0" font-family="Fira Sans Condensed" font-weight="700" font-size="52"
            fill="${hl ? "#ffd24a" : "#e8ebf5"}" transform="skewX(-8)">${escXml(value)}</text>
      <text x="0" y="34" font-family="Fira Sans Condensed" font-weight="600" font-size="17"
            letter-spacing="2.5" fill="#8b93ab">${escXml(label.toUpperCase())}</text>
    </g>`;
}

export function playerCardSvg({ name, rank, points, wr, maps, finishes, attempts, host }) {
  const visible = String(name).replace(/\^[0-9]/g, "") || "?";
  // Fit the (condensed, bold) name into the card: ~0.5em average advance.
  const nameSize = Math.max(40, Math.min(96, Math.floor(1080 / (0.52 * visible.length))));

  const stats = [
    [rank != null ? `#${rank}` : "—", "overall rank", true],
    [Number(points || 0).toLocaleString("en-US"), "points", false],
    [Number(wr || 0).toLocaleString("en-US"), "world records", false],
    [Number(maps || 0).toLocaleString("en-US"), "maps ranked", false],
    ...(finishes != null ? [[Number(finishes).toLocaleString("en-US"), "finishes", false]] : []),
    ...(attempts != null ? [[Number(attempts).toLocaleString("en-US"), "attempts", false]] : []),
  ];
  const step = 1080 / stats.length;
  const blocks = stats.map(([v, l, hl], i) => statBlock(60 + i * step, v, l, hl)).join("");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="82%" cy="-8%" r="75%">
      <stop offset="0%" stop-color="#ff6a1a" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#ff6a1a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cyanglow" cx="-5%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#0a0b0f"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#cyanglow)"/>

  <!-- top + bottom speed streaks (like .streaks) -->
  <g>
    ${[0, 622].map((y) => Array.from({ length: 20 }, (_, i) => {
      const x = i * 62;
      return `<polygon points="${x},${y} ${x + 26},${y} ${x + 18},${y + 8} ${x - 8},${y + 8}" fill="${i % 2 ? "#c14e10" : "#ff6a1a"}"/>`;
    }).join("")).join("")}
  </g>

  <!-- wordmark -->
  <g transform="translate(60 96)">
    <text font-family="Fira Sans Condensed" font-weight="700" font-size="44" transform="skewX(-10)">
      <tspan fill="#e8ebf5">RACE</tspan><tspan fill="#ff6a1a">SOW</tspan>
    </text>
    <text y="30" font-family="Fira Sans Condensed" font-weight="600" font-size="16"
          letter-spacing="4" fill="#8b93ab">GO FAST · RACE RECORDS</text>
  </g>

  <!-- player name (Warsow colours) -->
  <text x="60" y="330" font-family="Fira Sans Condensed" font-weight="700"
        font-size="${nameSize}" transform="skewX(-4)">${colouredTspans(name)}</text>
  <rect x="60" y="360" width="220" height="5" fill="#ff6a1a"/>

  <!-- stats -->
  <g transform="translate(0 480)">${blocks}</g>

  <!-- footer -->
  <text x="${W - 60}" y="588" text-anchor="end" font-family="Fira Sans Condensed" font-weight="600"
        font-size="19" letter-spacing="1.5" fill="#5c637d">${escXml(host || "")}</text>
</svg>`;
}

// renderAsync (not the sync Resvg().render()) so CPU rasterization runs on the
// libuv threadpool instead of blocking the single Node event loop — a burst of
// cold-card renders must not head-of-line-block concurrent API/page requests.
export async function renderPlayerCardPng(data) {
  const img = await renderAsync(playerCardSvg(data), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Fira Sans Condensed" },
  });
  return img.asPng();
}

// Live server-status card: one row per enrolled server (online/offline dot,
// coloured hostname, current map, player count) plus a summary line. Fed from
// the live poller's cached snapshot (see server.js /og/live.png).
export function liveCardSvg({ servers = [], totalPlayers = 0, onlineCount = 0, host = "" }) {
  const shown = servers.slice(0, 4);
  const rowH = 74;
  const rowY0 = 330;
  const rows = shown
    .map((s, i) => {
      const y = rowY0 + i * rowH;
      const dot = s.online ? "#a9f26a" : "#5c637d";
      const label = (s.online && s.hostname) || s.name || "?";
      const count = s.online ? `${s.players ?? 0}${s.maxclients ? " / " + s.maxclients : ""}` : "OFFLINE";
      const countColor = s.online ? "#e8ebf5" : "#5c637d";
      const countSize = s.online ? 42 : 24;
      // Map marker is a drawn triangle, not a glyph: the vendored font has no
      // ▸ (U+25B8), which would rasterize as tofu.
      const mapLine =
        s.online && s.map
          ? `<polygon points="42,15 42,27 52,21" fill="#22d3ee"/>
        <text x="60" y="28" font-family="Fira Sans Condensed" font-weight="600" font-size="19" fill="#22d3ee" letter-spacing="0.5">${escXml(s.map)}</text>`
          : "";
      return `
      <g transform="translate(60 ${y})">
        <circle cx="11" cy="-11" r="10" fill="${dot}"/>
        <text x="42" y="0" font-family="Fira Sans Condensed" font-weight="700" font-size="34" transform="skewX(-4)">${colouredTspans(label)}</text>
        ${mapLine}
        <text x="1080" y="6" text-anchor="end" font-family="Fira Sans Condensed" font-weight="800" font-size="${countSize}" fill="${countColor}" transform="skewX(-4)">${escXml(count)}</text>
      </g>`;
    })
    .join("");
  const more =
    servers.length > shown.length
      ? `<text x="60" y="${rowY0 + shown.length * rowH + 6}" font-family="Fira Sans Condensed" font-weight="600" font-size="21" fill="#8b93ab">+${servers.length - shown.length} more server${servers.length - shown.length === 1 ? "" : "s"}</text>`
      : "";
  const summary = servers.length
    ? `${totalPlayers} player${totalPlayers === 1 ? "" : "s"} in game · ${onlineCount} of ${servers.length} server${servers.length === 1 ? "" : "s"} online`
    : "No live-enabled servers yet";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="82%" cy="-8%" r="75%">
      <stop offset="0%" stop-color="#ff6a1a" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#ff6a1a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="greenglow" cx="-5%" cy="35%" r="60%">
      <stop offset="0%" stop-color="#a9f26a" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="#a9f26a" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#0a0b0f"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#greenglow)"/>

  <g>
    ${[0, 622]
      .map((y) =>
        Array.from({ length: 20 }, (_, i) => {
          const x = i * 62;
          return `<polygon points="${x},${y} ${x + 26},${y} ${x + 18},${y + 8} ${x - 8},${y + 8}" fill="${i % 2 ? "#c14e10" : "#ff6a1a"}"/>`;
        }).join("")
      )
      .join("")}
  </g>

  <g transform="translate(60 96)">
    <text font-family="Fira Sans Condensed" font-weight="700" font-size="44" transform="skewX(-10)">
      <tspan fill="#e8ebf5">RACE</tspan><tspan fill="#ff6a1a">SOW</tspan>
    </text>
    <text y="30" font-family="Fira Sans Condensed" font-weight="600" font-size="16"
          letter-spacing="4" fill="#8b93ab">GO FAST · RACE RECORDS</text>
  </g>

  <!-- LIVE heading with a pulse dot -->
  <text x="60" y="240" font-family="Fira Sans Condensed" font-weight="800" font-style="italic"
        font-size="76" fill="#e8ebf5" transform="skewX(-6)">LIVE</text>
  <circle cx="245" cy="216" r="13" fill="#a9f26a"/>
  <text x="60" y="284" font-family="Fira Sans Condensed" font-weight="600" font-size="25"
        fill="#8b93ab">${escXml(summary)}</text>

  ${rows}
  ${more}

  <text x="${W - 60}" y="596" text-anchor="end" font-family="Fira Sans Condensed" font-weight="600"
        font-size="19" letter-spacing="1.5" fill="#5c637d">${escXml(host || "")}</text>
</svg>`;
}

export async function renderLiveCardPng(data) {
  const img = await renderAsync(liveCardSvg(data), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Fira Sans Condensed" },
  });
  return img.asPng();
}

// Single-server card: the server name, live status line, and its current
// roster (name + ping) — or an empty/offline notice.
export function serverCardSvg({ name, online, map, maxclients, players = [], host = "" }) {
  const visible = String(name).replace(/\^[0-9]/g, "") || "?";
  const nameSize = Math.max(40, Math.min(84, Math.floor(1080 / (0.52 * visible.length))));
  const dot = online ? "#a9f26a" : "#5c637d";
  const statusLine = online
    ? `${players.length}${maxclients ? " / " + maxclients : ""} playing${map ? "  ·  " + map : ""}`
    : "Offline — not responding to queries";

  const shown = players.slice(0, 6);
  const rows = shown
    .map((p, i) => {
      const y = 372 + i * 40;
      return `
      <g transform="translate(60 ${y})">
        <text x="0" y="0" font-family="Fira Sans Condensed" font-weight="700" font-size="28">${colouredTspans(p.name)}</text>
        <text x="1080" y="0" text-anchor="end" font-family="Fira Sans Condensed" font-weight="600" font-size="24" fill="#8b93ab">${escXml(p.ping != null ? p.ping + " ms" : "")}</text>
      </g>`;
    })
    .join("");
  const emptyNote =
    online && !players.length
      ? `<text x="60" y="392" font-family="Fira Sans Condensed" font-weight="600" font-size="26" fill="#8b93ab">Server is empty — hop in and set a record.</text>`
      : "";
  const moreNote =
    players.length > shown.length
      ? `<text x="60" y="${372 + shown.length * 40 + 6}" font-family="Fira Sans Condensed" font-weight="600" font-size="21" fill="#8b93ab">+${players.length - shown.length} more player${players.length - shown.length === 1 ? "" : "s"}</text>`
      : "";

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="82%" cy="-8%" r="75%">
      <stop offset="0%" stop-color="#ff6a1a" stop-opacity="0.22"/>
      <stop offset="60%" stop-color="#ff6a1a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cyanglow" cx="-5%" cy="30%" r="60%">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.10"/>
      <stop offset="60%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0a0b0f"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#cyanglow)"/>
  <g>
    ${[0, 622]
      .map((y) =>
        Array.from({ length: 20 }, (_, i) => {
          const x = i * 62;
          return `<polygon points="${x},${y} ${x + 26},${y} ${x + 18},${y + 8} ${x - 8},${y + 8}" fill="${i % 2 ? "#c14e10" : "#ff6a1a"}"/>`;
        }).join("")
      )
      .join("")}
  </g>
  <g transform="translate(60 96)">
    <text font-family="Fira Sans Condensed" font-weight="700" font-size="44" transform="skewX(-10)">
      <tspan fill="#e8ebf5">RACE</tspan><tspan fill="#ff6a1a">SOW</tspan>
    </text>
    <text y="30" font-family="Fira Sans Condensed" font-weight="600" font-size="16"
          letter-spacing="4" fill="#8b93ab">GO FAST · RACE RECORDS</text>
  </g>

  <!-- server name + status -->
  <circle cx="72" cy="253" r="12" fill="${dot}"/>
  <text x="96" y="268" font-family="Fira Sans Condensed" font-weight="700"
        font-size="${nameSize}" transform="skewX(-4)">${colouredTspans(name)}</text>
  <text x="60" y="316" font-family="Fira Sans Condensed" font-weight="600" font-size="25"
        fill="#8b93ab">${escXml(statusLine)}</text>
  <rect x="60" y="336" width="200" height="4" fill="#ff6a1a"/>

  ${rows}
  ${emptyNote}
  ${moreNote}

  <text x="${W - 60}" y="596" text-anchor="end" font-family="Fira Sans Condensed" font-weight="600"
        font-size="19" letter-spacing="1.5" fill="#5c637d">${escXml(host || "")}</text>
</svg>`;
}

export async function renderServerCardPng(data) {
  const img = await renderAsync(serverCardSvg(data), {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Fira Sans Condensed" },
  });
  return img.asPng();
}

// Per-server cards change with the roster; brief cache keyed by server id.
const serverCache = new Map(); // id -> { buf, exp }
export async function serverCardCached(id, makeData) {
  const hit = serverCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.buf;
  const data = makeData();
  if (!data) return null;
  const buf = await renderServerCardPng(data);
  if (serverCache.size >= 100) serverCache.delete(serverCache.keys().next().value);
  serverCache.set(id, { buf, exp: Date.now() + 30_000 });
  return buf;
}

// The live card changes as players join/leave, so cache it only briefly
// (roughly the live-poll cadence) — enough to absorb a crawler burst.
let liveCache = { buf: null, exp: 0 };
export async function liveCardCached(makeData) {
  if (liveCache.buf && liveCache.exp > Date.now()) return liveCache.buf;
  const buf = await renderLiveCardPng(makeData());
  liveCache = { buf, exp: Date.now() + 30_000 };
  return buf;
}

// Small TTL cache so a burst of crawler hits (or a popular Discord message)
// renders each player at most once every few minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map(); // id -> { buf, exp }

export async function playerCardCached(id, makeData) {
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit.buf;
  const data = makeData();
  if (!data) return null;
  const buf = await renderPlayerCardPng(data);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(id, { buf, exp: Date.now() + CACHE_TTL_MS });
  return buf;
}
