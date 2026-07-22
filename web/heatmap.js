// Map heatmaps: a top-down "where people have been" density image per map.
//
// Every player's fastest recorded run on a map is stored as a ghost trajectory
// (GHOST_DIR/<mapId>/<playerId>.json.gz, see db.js upsertPlayerGhost) — a fixed
// -rate list of frames [x, y, z, ...] in Quake units (X fwd, Y left, Z up). We
// project all of a map's ghosts onto the X/Y plane (top-down), accumulate a
// density grid, blur + colormap it, and write a transparent-background PNG to
// HEATMAP_DIR/<mapId>.png (plus a small <mapId>.json with bounds/counts).
//
// The image reveals the map's played route from above — the racing line, the
// forks players take, where the traffic concentrates. Each PLAYER contributes
// equal weight (a frame's weight is 1/frameCount), so a long slow run doesn't
// outshout a short fast one — the map shows where people go, not how long they
// linger.
//
// Run modes:
//   node heatmap.js                 one-shot: (re)generate stale/active maps, exit
//   node heatmap.js --all           one-shot: regenerate every map that has ghosts
//   node heatmap.js --loop          self-scheduling daemon (the compose sidecar):
//                                    generate on boot, then nightly refresh the maps
//                                    that saw a finish in the past day
//   node heatmap.js <mapId> [...]   one-shot: just these map ids (debug)
//
// Rendering (buildHeatmap/encodePNG) is DB-free and pure so it is unit-testable;
// only the map-selection + scheduling glue touches Postgres.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadMapGeometry, renderMapBase } from "./bsp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same defaults as the web service (docker-compose shares the /data mount), so a
// local `node heatmap.js` and the sidecar read/write the same files.
const GHOST_DIR = process.env.GHOST_DIR || path.join(__dirname, "ghosts");
const HEATMAP_DIR = process.env.HEATMAP_DIR || path.join(__dirname, "heatmaps");
// Directory of map .pk3 packs, so each heatmap can be drawn over a top-down
// render of the map geometry (see bsp.js). Empty/unset = heatmap-only, no base.
const MAPS_DIR = process.env.MAPS_DIR || "";

// Longest side of the output image in pixels (the shorter side follows the map's
// aspect ratio). Clamped so a hostile env var can't ask for a gigapixel canvas.
const SIZE = clampInt(process.env.HEATMAP_SIZE, 1000, 256, 2000);

// Nightly cadence for --loop (like the db-backup sidecar: one long-lived process,
// no host cron). CHECK is how often the daemon re-evaluates; INTERVAL is the
// minimum age before a full active-map refresh runs again.
const INTERVAL_SECONDS = clampInt(process.env.HEATMAP_INTERVAL_SECONDS, 86400, 3600, 7 * 86400);
const CHECK_SECONDS = clampInt(process.env.HEATMAP_CHECK_SECONDS, 3600, 60, 86400);
// A finish this recent (relative to a refresh) marks its map "active" and due for
// regeneration. Defaults to the refresh interval so a nightly run picks up every
// map touched since the previous night.
const ACTIVE_WINDOW_SECONDS = clampInt(process.env.HEATMAP_ACTIVE_WINDOW_SECONDS, INTERVAL_SECONDS, 3600, 30 * 86400);

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function log(...a) {
  console.log(`[heatmap ${new Date().toISOString()}]`, ...a);
}

// ---------------------------------------------------------------------------
// Rendering — pure, no DB, no filesystem beyond reading the passed ghost files.
// ---------------------------------------------------------------------------

// Perceptually-ordered "inferno" colormap stops (t -> [r,g,b]). Looks good on the
// site's dark theme; the low end is nearly transparent (see alpha ramp) so the
// dark colors never muddy the page background.
const COLORMAP = [
  [0.0, [8, 8, 30]],
  [0.15, [40, 11, 84]],
  [0.3, [101, 21, 110]],
  [0.45, [159, 42, 99]],
  [0.6, [212, 72, 66]],
  [0.75, [245, 125, 21]],
  [0.9, [250, 193, 39]],
  [1.0, [252, 255, 164]],
];

function colormap(t) {
  t = t <= 0 ? 0 : t >= 1 ? 1 : t;
  for (let i = 1; i < COLORMAP.length; i++) {
    if (t <= COLORMAP[i][0]) {
      const [t0, c0] = COLORMAP[i - 1];
      const [t1, c1] = COLORMAP[i];
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return COLORMAP[COLORMAP.length - 1][1];
}

// Separable box blur (3 passes ≈ Gaussian). Softens the discrete grid so paths
// read as smooth traffic lanes instead of pixel confetti. In-place on `grid`.
function blur(grid, w, h, radius, passes = 3) {
  if (radius < 1) return grid;
  let src = grid;
  let tmp = new Float32Array(w * h);
  const win = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += src[row + Math.max(0, Math.min(w - 1, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        const add = row + Math.min(w - 1, x + radius + 1);
        const sub = row + Math.max(0, x - radius);
        acc += src[add] - src[sub];
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = acc / win;
        const add = Math.min(h - 1, y + radius + 1) * w + x;
        const sub = Math.max(0, y - radius) * w + x;
        acc += tmp[add] - tmp[sub];
      }
    }
  }
  return src;
}

// The `t`-th quantile of a grid via a coarse histogram — used to pick vmax so a
// single blazing-hot cell doesn't wash the whole map to the low end. Cheap and
// stable vs a full sort of millions of cells.
function quantile(grid, max, q) {
  if (max <= 0) return 0;
  const BINS = 2048;
  const hist = new Int32Array(BINS);
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v <= 0) continue;
    hist[Math.min(BINS - 1, (v / max) * (BINS - 1)) | 0]++;
    total++;
  }
  if (total === 0) return 0;
  let want = q * total;
  for (let b = 0; b < BINS; b++) {
    want -= hist[b];
    if (want <= 0) return (b / (BINS - 1)) * max;
  }
  return max;
}

// Build the RGBA heatmap for one map from its ghost trajectories.
//
//   ghosts: [{ frames: [[x,y,z,...], ...] }, ...]
//
// Returns { png: Buffer, width, height, players, points, bounds } or null when
// there are no usable points. Coordinates: world +X → image right, world +Y →
// image up (north up); frames whose only motion is vertical still register.
export function buildHeatmap(ghosts, opts = {}) {
  const size = opts.size || SIZE;

  // Pass 1: world bounds over every frame of every ghost.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let usable = 0, totalPoints = 0;
  for (const g of ghosts) {
    if (!g || !Array.isArray(g.frames) || g.frames.length === 0) continue;
    usable++;
    for (const f of g.frames) {
      const x = +f[0], y = +f[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      totalPoints++;
    }
  }
  if (!usable || totalPoints === 0 || minX > maxX) return null;

  // Pad so the hottest cells near the extremes aren't clipped by the blur, and a
  // degenerate axis (everyone on one line) still gets a sane extent.
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const pad = Math.max(spanX, spanY) * 0.04 + 32;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const worldW = maxX - minX;
  const worldH = maxY - minY;

  // Grid dimensions: longest side = `size`, other side by aspect. Min 64 so a
  // very thin map still has resolution across its narrow axis.
  let W, H;
  if (worldW >= worldH) {
    W = size;
    H = Math.max(64, Math.round(size * (worldH / worldW)));
  } else {
    H = size;
    W = Math.max(64, Math.round(size * (worldW / worldH)));
  }
  const sx = (W - 1) / worldW;
  const sy = (H - 1) / worldH;

  // Pass 2: accumulate density with a bilinear splat, each player weighted 1
  // total (1/frameCount per frame) so presence — not run length — drives heat.
  const grid = new Float32Array(W * H);
  for (const g of ghosts) {
    if (!g || !Array.isArray(g.frames) || g.frames.length === 0) continue;
    const wgt = 1 / g.frames.length;
    for (const f of g.frames) {
      const x = +f[0], y = +f[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const fx = (x - minX) * sx;
      const fy = (H - 1) - (y - minY) * sy; // flip: +Y world is up in the image
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const dx = fx - x0, dy = fy - y0;
      splat(grid, W, H, x0, y0, wgt * (1 - dx) * (1 - dy));
      splat(grid, W, H, x0 + 1, y0, wgt * dx * (1 - dy));
      splat(grid, W, H, x0, y0 + 1, wgt * (1 - dx) * dy);
      splat(grid, W, H, x0 + 1, y0 + 1, wgt * dx * dy);
    }
  }

  const radius = Math.max(1, Math.round(size / 220));
  blur(grid, W, H, radius);

  // Normalize against the 99th percentile (robust vs a lone hotspot), then a
  // gamma lift so the faint, less-travelled routes stay visible.
  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  const vmax = quantile(grid, max, 0.99) || max || 1;
  const gamma = 0.45;

  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < grid.length; i++) {
    const t = Math.pow(Math.min(1, grid[i] / vmax), gamma);
    if (t <= 0.001) continue; // leave fully transparent
    const [r, gc, b] = colormap(t);
    // Alpha ramps in from ~0 so the coolest visited cells fade rather than edge
    // hard against the page; caps below 255 to keep it a soft overlay.
    const a = Math.round(Math.min(1, Math.max(0, (t - 0.02) / 0.18)) * 225);
    if (a <= 0) continue;
    const o = i * 4;
    rgba[o] = r; rgba[o + 1] = gc; rgba[o + 2] = b; rgba[o + 3] = a;
  }

  return {
    png: encodePNG(W, H, rgba),
    rgba, // raw heatmap layer, so callers can composite it over a map base
    width: W,
    height: H,
    players: usable,
    points: totalPoints,
    bounds: { minX, minY, maxX, maxY },
  };
}

// Composite the transparent heatmap layer OVER an (opaque-ish) map-base layer,
// in place on `base`. Straight source-over alpha blend; where the heatmap is
// transparent the map shows through, where it's hot the traffic colours win.
function compositeOver(base, over) {
  for (let p = 0; p < base.length; p += 4) {
    const a = over[p + 3];
    if (!a) continue;
    const ia = a / 255, na = 1 - ia;
    base[p] = over[p] * ia + base[p] * na;
    base[p + 1] = over[p + 1] * ia + base[p + 1] * na;
    base[p + 2] = over[p + 2] * ia + base[p + 2] * na;
    base[p + 3] = Math.max(base[p + 3], a);
  }
}

function splat(grid, w, h, x, y, v) {
  if (x < 0 || y < 0 || x >= w || y >= h || v === 0) return;
  grid[y * w + x] += v;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (truecolor + alpha, 8-bit). Zero dependencies: PNG's IDAT
// is a raw zlib stream, which zlib.deflateSync produces directly.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None) per scanline
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Filesystem: read a map's ghosts, write its PNG + metadata atomically.
// ---------------------------------------------------------------------------
export function loadGhostsForMap(mapId, ghostDir = GHOST_DIR) {
  const dir = path.join(ghostDir, String(mapId));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz"));
  } catch {
    return []; // no ghost dir for this map yet
  }
  const ghosts = [];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      const obj = JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
      if (obj && Array.isArray(obj.frames)) ghosts.push(obj);
    } catch (e) {
      log(`skip unreadable ghost ${mapId}/${f}: ${e.message}`);
    }
  }
  return ghosts;
}

// Regenerate one map's heatmap files. Returns metadata, or null if the map has no
// usable ghost data (in which case any stale image is removed so a de-populated
// map doesn't keep serving an outdated heatmap).
export function generateMap(mapId, name = null, { ghostDir = GHOST_DIR, outDir = HEATMAP_DIR, size = SIZE, mapsDir = MAPS_DIR } = {}) {
  const ghosts = loadGhostsForMap(mapId, ghostDir);
  const pngPath = path.join(outDir, `${mapId}.png`);
  const metaPath = path.join(outDir, `${mapId}.json`);

  const built = ghosts.length ? buildHeatmap(ghosts, { size }) : null;
  if (!built) {
    for (const p of [pngPath, metaPath]) try { fs.unlinkSync(p); } catch {}
    return null;
  }

  // Draw the heatmap on top of a top-down render of the map geometry when the
  // map's .pk3 is available and parses (bsp.js) — so you see WHERE the traffic
  // is. Any failure (missing pack, unknown BSP) falls back to the heatmap alone.
  let png = built.png;
  let mapBase = false;
  if (mapsDir && name) {
    try {
      const geom = loadMapGeometry(mapsDir, name);
      if (geom) {
        const base = new Uint8Array(built.width * built.height * 4);
        renderMapBase(base, built.width, built.height, built.bounds, geom);
        compositeOver(base, built.rgba);
        png = encodePNG(built.width, built.height, base);
        mapBase = true;
      }
    } catch (e) {
      log(`map-base render failed for ${mapId} (${name}): ${e.message}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    mapId,
    name,
    width: built.width,
    height: built.height,
    players: built.players,
    points: built.points,
    bounds: built.bounds,
    mapBase,
    generatedAt: Math.floor(Date.now() / 1000),
  };
  // Atomic publish (write temp + rename) so the web never serves a half-written
  // PNG mid-regeneration.
  writeAtomic(pngPath, png);
  writeAtomic(metaPath, Buffer.from(JSON.stringify(meta)));
  return meta;
}

function writeAtomic(dest, buf) {
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

// ---------------------------------------------------------------------------
// Map selection + scheduling (the only DB-touching part). pg is imported lazily
// so the pure rendering path (and its tests) never need a database.
// ---------------------------------------------------------------------------
async function withPg(fn) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow",
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function mapName(client, mapId) {
  const r = await client.query("SELECT name FROM map WHERE id = $1", [mapId]);
  return r.rows[0] ? r.rows[0].name : null;
}

// Maps due for regeneration: those with a finish in the past `windowSecs`, PLUS
// any map that has ghost data on disk but no heatmap yet (first-run / new-map
// bootstrap). `all` overrides the window and takes every map that has ghosts.
async function mapsToRegenerate(client, { all = false, windowSecs = ACTIVE_WINDOW_SECONDS } = {}) {
  const ids = new Set();

  if (all) {
    for (const id of ghostDirMapIds()) ids.add(id);
  } else {
    const since = Math.floor(Date.now() / 1000) - windowSecs;
    const r = await client.query(
      "SELECT DISTINCT map_id FROM race WHERE created_at IS NOT NULL AND created_at >= $1",
      [since]
    );
    for (const row of r.rows) ids.add(Number(row.map_id));
    // Bootstrap: any map with ghosts but no rendered image yet.
    for (const id of ghostDirMapIds()) {
      if (!fs.existsSync(path.join(HEATMAP_DIR, `${id}.png`))) ids.add(id);
    }
  }
  return [...ids];
}

// Map ids that have a ghost directory on disk.
function ghostDirMapIds() {
  try {
    return fs
      .readdirSync(GHOST_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name));
  } catch {
    return [];
  }
}

async function runOnce({ all = false, only = null } = {}) {
  return withPg(async (client) => {
    const ids = only ? only : await mapsToRegenerate(client, { all });
    if (!ids.length) {
      log("no maps due for regeneration");
      return 0;
    }
    let ok = 0, empty = 0;
    for (const id of ids) {
      try {
        const meta = generateMap(id, await mapName(client, id));
        if (meta) {
          ok++;
          log(`map ${id} (${meta.name || "?"}): ${meta.players} players, ${meta.points} pts -> ${meta.width}x${meta.height}`);
        } else {
          empty++;
        }
      } catch (e) {
        log(`map ${id} FAILED: ${e.stack || e.message}`);
      }
    }
    log(`done: ${ok} generated, ${empty} empty/removed, ${ids.length} considered`);
    return ok;
  });
}

// Self-scheduling daemon: generate on boot (bootstrapping any missing images),
// then refresh maps that saw a finish in the past ACTIVE_WINDOW every CHECK
// seconds, guaranteeing at least one full nightly pass per INTERVAL.
async function runLoop() {
  log(`loop start (interval=${INTERVAL_SECONDS}s, check=${CHECK_SECONDS}s, window=${ACTIVE_WINDOW_SECONDS}s, size=${SIZE}, out=${HEATMAP_DIR})`);
  let stop = false;
  // The nap timer is deliberately NOT unref'd: between cycles it is the only
  // handle keeping the event loop alive, so unref'ing it made the daemon exit(0)
  // right after the first sleep — and `restart: unless-stopped` then re-ran the
  // whole bootstrap every few seconds. `wake` lets a shutdown signal cut the
  // current nap short so `docker stop` stays prompt (no waiting out CHECK_SECONDS).
  let wake = null;
  const nap = (s) => new Promise((resolve) => {
    const t = setTimeout(resolve, s * 1000);
    wake = () => { clearTimeout(t); resolve(); };
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { log("shutting down"); stop = true; if (wake) wake(); });

  let lastFull = 0;
  while (!stop) {
    const now = Math.floor(Date.now() / 1000);
    try {
      const full = now - lastFull >= INTERVAL_SECONDS;
      await runOnce({ all: false });
      if (full) lastFull = now;
    } catch (e) {
      log(`cycle FAILED (will retry): ${e.stack || e.message}`);
    }
    if (stop) break;
    await nap(CHECK_SECONDS);
  }
  process.exit(0);
}

// CLI. Importing this module (tests, server.js) runs nothing.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--loop")) {
    runLoop();
  } else if (args.includes("--all")) {
    runOnce({ all: true }).then((n) => process.exit(n >= 0 ? 0 : 1));
  } else {
    const ids = args.map((a) => parseInt(a, 10)).filter((n) => Number.isInteger(n));
    runOnce(ids.length ? { only: ids } : {}).then(() => process.exit(0), (e) => { log(e.stack || e.message); process.exit(1); });
  }
}
