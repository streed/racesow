// On-the-fly Open Graph card images (1200x630 PNG) for player pages, in the
// site's "going fast" theme. Discord/social crawlers fetch these from
// /og/player/<id>.png (see server.js); the SVG is rasterized with resvg
// using the vendored Fira Sans Condensed faces (og-assets/fonts, SIL OFL),
// so rendering is deterministic — no system fonts involved.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

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

export function playerCardSvg({ name, rank, points, wr, maps, finishes, host }) {
  const visible = String(name).replace(/\^[0-9]/g, "") || "?";
  // Fit the (condensed, bold) name into the card: ~0.5em average advance.
  const nameSize = Math.max(40, Math.min(96, Math.floor(1080 / (0.52 * visible.length))));

  const stats = [
    [rank != null ? `#${rank}` : "—", "overall rank", true],
    [Number(points || 0).toLocaleString("en-US"), "points", false],
    [Number(wr || 0).toLocaleString("en-US"), "world records", false],
    [Number(maps || 0).toLocaleString("en-US"), "maps ranked", false],
    ...(finishes != null ? [[Number(finishes).toLocaleString("en-US"), "finishes", false]] : []),
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

export function renderPlayerCardPng(data) {
  const svg = playerCardSvg(data);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Fira Sans Condensed" },
  });
  return resvg.render().asPng();
}

// Small TTL cache so a burst of crawler hits (or a popular Discord message)
// renders each player at most once every few minutes.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map(); // id -> { buf, exp }

export function playerCardCached(id, makeData) {
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return hit.buf;
  const data = makeData();
  if (!data) return null;
  const buf = renderPlayerCardPng(data);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // drop oldest
  cache.set(id, { buf, exp: Date.now() + CACHE_TTL_MS });
  return buf;
}
