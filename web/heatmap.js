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
import { spawnSync } from "node:child_process";
import { loadMapGeometry, renderMapBase, makeProject, fillBg, drawGrid, drawMarkers, THEME } from "./bsp.js";
import { getMapIndex, rebuildMapIndex } from "./mapindex.js";

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
// How many never-rendered maps to draw per cycle. Bounded because the first
// run over the whole pool would otherwise render thousands of 1000x1000 PNGs
// back to back; at this rate the pool fills in over a day or so while a map
// published minutes ago still gets its plan on the next cycle (newest first).
const BASE_BUDGET = clampInt(process.env.HEATMAP_BASE_BUDGET, 25, 0, 5000);
// How many missing replay meshes to convert per cycle (see ensureMeshes).
// Zero turns it off. Some maps convert to tens of MB, so this is deliberately
// a trickle rather than a sweep; MESH_DIR unset also turns it off.
const MESH_BUDGET = clampInt(process.env.MESH_BUDGET, 10, 0, 5000);
const MESH_DIR = process.env.MESH_DIR || "";
const BSP2GLTF = process.env.BSP2GLTF || "/opt/tools/bsp2gltf/bsp2gltf.js";

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
// Frame a world-space XY extent into the standardized SQUARE canvas: pad it,
// then fit-centre it with the aspect preserved. Shared by the heatmap (which
// frames the traffic) and the base-only render (which frames the geometry), so
// a map that has no runs yet is drawn in the same place it will be once it does.
export function frameBounds(minX, minY, maxX, maxY, size = SIZE) {
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const pad = Math.max(spanX, spanY) * 0.04 + 32;
  minX -= pad; maxX += pad; minY -= pad; maxY += pad;
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  let fw, fh;
  if (worldW >= worldH) { fw = size; fh = Math.max(64, Math.round(size * (worldH / worldW))); }
  else { fh = size; fw = Math.max(64, Math.round(size * (worldW / worldH))); }
  const ox = Math.round((size - fw) / 2), oy = Math.round((size - fh) / 2);
  return {
    bounds: { minX, minY, maxX, maxY, worldW, worldH },
    fit: { ox, oy, fw, fh },
    scale: { sx: (fw - 1) / worldW, sy: (fh - 1) / worldH },
  };
}

// The XY extent of a parsed BSP's drawable geometry, or null if it has none.
export function geometryBounds(geom) {
  if (!geom || !geom.vx || !geom.vx.length) return null;
  const { vx, vy } = geom;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < vx.length; i++) {
    const x = +vx[i], y = +vy[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX > maxX ? null : { minX, minY, maxX, maxY };
}

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

  // Pad so the hottest cells near the extremes aren't clipped by the blur, a
  // degenerate axis (everyone on one line) still gets a sane extent, and the
  // map is fit-centred in a standardized SQUARE canvas. fw/fh = the fit
  // rectangle, ox/oy its offset — the map base + markers reuse these (via the
  // returned `fit`) so they align with the traffic.
  const W = size, H = size;
  const framed = frameBounds(minX, minY, maxX, maxY, size);
  ({ minX, minY, maxX, maxY } = framed.bounds);
  const { worldW, worldH } = framed.bounds;
  const { ox, oy, fw, fh } = framed.fit;
  const { sx, sy } = framed.scale;

  // Pass 2: accumulate density with a bilinear splat, each player weighted 1
  // total (1/frameCount per frame) so presence — not run length — drives heat.
  const grid = new Float32Array(W * H);
  for (const g of ghosts) {
    if (!g || !Array.isArray(g.frames) || g.frames.length === 0) continue;
    const wgt = 1 / g.frames.length;
    for (const f of g.frames) {
      const x = +f[0], y = +f[1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const fx = ox + (x - minX) * sx;
      const fy = oy + (fh - 1) - (y - minY) * sy; // flip: +Y world is up in the image
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
    fit: { ox, oy, fw, fh }, // fit rectangle inside the square, for base+markers
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
// Parse a map's world geometry, via the pool index (a pack's FILENAME routinely
// differs from the map/bsp name, so the index is what finds it). Returns the
// geometry and its XY extent, or null when no pack parses — a missing or
// corrupt pack is a reason to draw less, never to fail.
function loadGeometry(mapsDir, name, outDir, mapId) {
  if (!mapsDir || !name) return null;
  try {
    const index = getMapIndex(mapsDir, outDir);
    const geom = loadMapGeometry(mapsDir, name, (n) => index.get(n));
    if (!geom) return null;
    const min = geometryBounds(geom);
    return min ? { geom, min } : null;
  } catch (e) {
    log(`map geometry unavailable for ${mapId} (${name}): ${e.message}`);
    return null;
  }
}

export function generateMap(mapId, name = null, { ghostDir = GHOST_DIR, outDir = HEATMAP_DIR, size = SIZE, mapsDir = MAPS_DIR } = {}) {
  const ghosts = loadGhostsForMap(mapId, ghostDir);
  const pngPath = path.join(outDir, `${mapId}.png`);
  const metaPath = path.join(outDir, `${mapId}.json`);

  // A map nobody has finished yet has no traffic to draw, but it still has a
  // floor plan, and that is the more useful half: it is what tells someone
  // looking at a brand-new map what the course looks like. Frame the geometry
  // instead of the traffic and draw the base alone. (Before this, such a map
  // got no image at all and any earlier one was deleted.)
  const built = ghosts.length ? buildHeatmap(ghosts, { size }) : null;
  const geomOnly = built ? null : loadGeometry(mapsDir, name, outDir, mapId);
  if (!built && !geomOnly) {
    for (const p of [pngPath, metaPath]) try { fs.unlinkSync(p); } catch {}
    return null;
  }

  // Compose the final SQUARE image: themed background + blueprint grid, the map's
  // top-down geometry (when its .pk3 parses), the traffic heatmap over it, and
  // start / finish / checkpoint markers taken from the fastest run. Any map-base
  // failure (missing pack / unknown BSP) just leaves the heatmap on the themed bg.
  // Where the traffic exists it decides the framing; with no traffic the
  // geometry does.
  const frame = built || (() => {
    const f = frameBounds(geomOnly.min.minX, geomOnly.min.minY,
                          geomOnly.min.maxX, geomOnly.min.maxY, size);
    return { width: size, height: size, bounds: f.bounds, fit: f.fit, players: 0, points: 0 };
  })();

  const S = frame.width;
  const canvas = new Uint8Array(S * S * 4);
  fillBg(canvas, THEME.bg[0], THEME.bg[1], THEME.bg[2]);
  drawGrid(canvas, S);
  let mapBase = false;
  const geom = geomOnly ? geomOnly.geom : (mapsDir && name ? loadGeometry(mapsDir, name, outDir, mapId)?.geom : null);
  if (geom) {
    try {
      renderMapBase(canvas, S, frame.bounds, frame.fit, geom);
      mapBase = true;
    } catch (e) {
      log(`map-base render failed for ${mapId} (${name}): ${e.message}`);
    }
  }
  if (built) compositeOver(canvas, built.rgba); // traffic heatmap over the map
  if (built) try {
    const P = makeProject(frame.bounds, frame.fit);
    const fast = ghosts
      .filter((g) => g && Array.isArray(g.frames) && g.frames.length)
      .sort((a, b) => (a.time || Infinity) - (b.time || Infinity))[0];
    if (fast) {
      const fr = fast.frames, at = (i) => P(+fr[i][0], +fr[i][1]);
      const cps = (Array.isArray(fast.cps) ? fast.cps : [])
        .filter((i) => Number.isInteger(i) && i >= 0 && i < fr.length)
        .map(at);
      drawMarkers(canvas, S, { start: at(0), finish: at(fr.length - 1), cps });
    }
  } catch (e) {
    log(`marker render failed for ${mapId} (${name}): ${e.message}`);
  }
  const png = encodePNG(S, S, canvas);

  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    mapId,
    name,
    width: frame.width,
    height: frame.height,
    players: frame.players,
    points: frame.points,
    bounds: frame.bounds,
    mapBase,
    // false on a map nobody has finished yet: the image is its floor plan
    // alone, with no traffic and no start/finish markers.
    heat: Boolean(built),
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
    // Bounded waits: a hung (packet-dropping) Postgres must stall one cycle,
    // not wedge the daemon forever. The queries here are all tiny.
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    statement_timeout: 60_000,
  });
  await client.connect();
  // The connection stays open across minutes of CPU-bound rendering; a backend
  // error in that window emits 'error', which is fatal without a listener.
  client.on("error", (e) => log(`pg connection error (cycle will retry): ${e?.message ?? e}`));
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
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
      "SELECT map_id, MAX(created_at) AS last_pb FROM race WHERE created_at IS NOT NULL AND created_at >= $1 GROUP BY map_id",
      [since]
    );
    for (const row of r.rows) {
      // Re-render only when a PB landed since the image was last written —
      // re-rendering every active map every cycle burned CPU for identical
      // output (the heatmap's inputs only change on a new PB/ghost). The
      // 5-minute slack covers a PB that arrived mid-render.
      let renderedAt = 0;
      try {
        renderedAt = Math.floor(fs.statSync(path.join(HEATMAP_DIR, `${row.map_id}.png`)).mtimeMs / 1000);
      } catch { /* no image yet -> render */ }
      if (Number(row.last_pb) >= renderedAt - 300) ids.add(Number(row.map_id));
    }
    // Bootstrap: any map with ghosts but no rendered image yet.
    for (const id of ghostDirMapIds()) {
      if (!fs.existsSync(path.join(HEATMAP_DIR, `${id}.png`))) ids.add(id);
    }
    // ...and any map with no image at all, whether or not anyone has finished
    // it. A map nobody has raced has no ghosts and no PBs, so neither pass
    // above would ever pick it up, and it showed an empty panel on its page
    // for good -- which is exactly the state a freshly generated map is in.
    // Newest first, so a map published minutes ago gets its floor plan on the
    // next cycle, and capped so the first run over a 4,900-map pool spreads
    // itself over many cycles instead of pinning a core for an hour.
    for (const id of await mapsWithoutImage(client, BASE_BUDGET)) ids.add(id);
  }
  return [...ids];
}

// Maps with no rendered image, newest first, at most `limit`.
async function mapsWithoutImage(client, limit) {
  if (limit <= 0) return [];
  const r = await client.query(
    `SELECT m.id FROM map m
      WHERE NOT EXISTS (SELECT 1 FROM map_block b WHERE b.map_id = m.id)
      ORDER BY m.id DESC`
  );
  const out = [];
  for (const row of r.rows) {
    const id = Number(row.id);
    if (fs.existsSync(path.join(HEATMAP_DIR, `${id}.png`))) continue;
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
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

// Convert map packs that have no replay mesh yet into web/public/maps/<name>.glb,
// which the in-browser replay viewer loads to draw the real level around the
// ghost (web/public/assets/js/replay.js; without it the run plays over a bare
// path). Nothing produced these for new maps: the whole 5,000-mesh set was a
// hand-run command, so every map published since had no level to fly through.
//
// The converter is tools/bsp2gltf, run in its own process in --dir mode, which
// already walks the pool and SKIPS any pack whose mesh exists -- so this is the
// same code path as a full backfill, just with a budget on how much it does per
// cycle. Run as a child so a malformed pack that crashes the parser costs one
// mesh, not the whole sidecar.
function ensureMeshes() {
  if (!MESH_DIR || MESH_BUDGET <= 0 || !MAPS_DIR) return 0;
  if (!fs.existsSync(BSP2GLTF)) {
    log(`mesh conversion skipped: ${BSP2GLTF} is not mounted`);
    return 0;
  }
  let out;
  try {
    fs.mkdirSync(MESH_DIR, { recursive: true });
    out = spawnSync(process.execPath,
                    [BSP2GLTF, "--dir", MAPS_DIR, MESH_DIR, "--limit", String(MESH_BUDGET)],
                    { encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    log(`mesh conversion failed to start: ${e.message}`);
    return 0;
  }
  if (out.error) {
    log(`mesh conversion failed: ${out.error.message}`);
    return 0;
  }
  const lines = String(out.stdout || "").split("\n").filter(Boolean);
  const made = lines.filter((l) => l.startsWith("OK  "));
  const failed = lines.filter((l) => l.startsWith("ERR "));
  for (const l of made) log(`mesh ${l.slice(4)}`);
  // A pack that cannot be converted is reported once per cycle and then tried
  // again next time; the viewer falls back to the bare path meanwhile.
  if (failed.length) log(`mesh conversion: ${failed.length} pack(s) failed, first: ${failed[0].slice(4)}`);
  if (made.length) log(`mesh conversion: ${made.length} new mesh(es)`);
  return made.length;
}

async function runOnce({ all = false, only = null } = {}) {
  return withPg(async (client) => {
    const ids = only ? only : await mapsToRegenerate(client, { all });
    if (!ids.length) {
      log("no maps due for regeneration");
      // Meshes are on their own schedule: a pool whose plans are all drawn can
      // still be missing thousands of them, which is the normal state on a box
      // that has been running since before they were generated at all.
      ensureMeshes();
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
    ensureMeshes();
    return ok;
  });
}

// Self-scheduling daemon: generate on boot (bootstrapping any missing images),
// then refresh maps that saw a finish in the past ACTIVE_WINDOW every CHECK
// seconds, guaranteeing at least one full nightly pass per INTERVAL.
// Liveness marker for the container healthcheck. This sidecar reuses the web
// image, whose HEALTHCHECK probes /api/health — an endpoint a batch loop never
// serves — so without a check of its own the container sits "unhealthy" forever
// and a genuine stall is indistinguishable from the false alarm (it ran up a
// 617-cycle failing streak that way). Touched after EVERY cycle, including one
// that threw: the loop caught it and will retry, which is still alive. A stale
// marker therefore means the cycle HUNG — precisely the failure the try/catch
// around runOnce cannot see.
function touchHeartbeat() {
  try {
    fs.mkdirSync(HEATMAP_DIR, { recursive: true });
    fs.writeFileSync(path.join(HEATMAP_DIR, ".heartbeat"), `${Math.floor(Date.now() / 1000)}\n`);
  } catch (e) {
    log(`heartbeat write failed (not fatal): ${e.message}`);
  }
}

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
      await runOnce({ all: full });
      if (full) lastFull = now;
    } catch (e) {
      log(`cycle FAILED (will retry): ${e.stack || e.message}`);
    }
    touchHeartbeat();
    if (stop) break;
    await nap(CHECK_SECONDS);
  }
  process.exit(0);
}

// CLI. Importing this module (tests, server.js) runs nothing.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--reindex")) {
    // Build (or rebuild) the name -> pk3 lookup table and report how many maps
    // ship in a pack whose filename differs from the map name (the ones the old
    // ${name}.pk3 guess missed). Writes HEATMAP_DIR/mapindex.json when MAPS_DIR
    // is set; a bare dump otherwise.
    if (!MAPS_DIR) { log("MAPS_DIR is unset — nothing to index"); process.exit(1); }
    // Force a fresh rebuild + rewrite (ignores any existing same-signature file),
    // so this is a true escape hatch even after an in-place pack swap.
    const index = rebuildMapIndex(MAPS_DIR, HEATMAP_DIR);
    let mismatch = 0, multi = 0;
    for (const [name, packs] of index) {
      if (packs.length > 1) multi++;
      // Case-insensitive: a capitalized pack filename that matches the (lowercased)
      // map name only by case is NOT a differently-named pack — it still resolves.
      if (!packs.some((p) => p.toLowerCase() === `${name}.pk3`)) mismatch++;
    }
    log(`indexed ${index.size} maps; ${mismatch} live only in a differently-named pack (base render would miss these), ${multi} appear in multiple packs -> ${path.join(HEATMAP_DIR, "mapindex.json")}`);
    process.exit(0);
  } else if (args.includes("--loop")) {
    runLoop();
  } else if (args.includes("--all")) {
    runOnce({ all: true }).then(
      (n) => process.exit(n >= 0 ? 0 : 1),
      (e) => { log(e.stack || e.message); process.exit(1); }
    );
  } else {
    const ids = args.map((a) => parseInt(a, 10)).filter((n) => Number.isInteger(n));
    runOnce(ids.length ? { only: ids } : {}).then(() => process.exit(0), (e) => { log(e.stack || e.message); process.exit(1); });
  }
}
