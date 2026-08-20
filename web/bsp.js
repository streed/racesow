// Top-down map geometry for the heatmaps: pull a map's .bsp out of its .pk3,
// parse the walkable geometry, and render a "blueprint" floor-plan base that the
// heatmap draws on top of (so you see WHERE on the map the traffic is), plus
// start/finish/checkpoint markers. Zero external deps — a .pk3 is a zip, and
// Node's zlib inflates the entries.
//
// Two BSP formats appear in the map pool and share everything we touch (the
// 17-lump directory, and the face fields type@8 / firstvert@12 / numverts@16 /
// firstelem@20 / numelems@24); only the vertex + face STRIDES differ because
// FBSP (Warsow/qfusion) carries 4 lightmaps per vertex/face:
//   IBSP (Q3, v46):        vertex 44 B, face 104 B
//   FBSP (qfusion, v1):    vertex 80 B, face 148 B
import fs from "node:fs";
import zlib from "node:zlib";
import { isSafeMapName } from "./mapname.js";

// --- .pk3 (zip) extraction ---------------------------------------------------
// Find maps/<mapName>.bsp inside the archive via the central directory and
// inflate just that entry. Returns a Buffer, or null if absent/unreadable.
export function extractBsp(pk3Path, mapName) {
  let buf;
  try {
    buf = fs.readFileSync(pk3Path);
  } catch {
    return null;
  }
  // End of Central Directory: scan backwards for its signature (0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const want = ("maps/" + mapName + ".bsp").toLowerCase();
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const fname = buf.toString("latin1", p + 46, p + 46 + nameLen).toLowerCase();
    if (fname === want) {
      // Local file header: recompute the data start from ITS name+extra lengths.
      // The offset comes from the (untrusted) central directory — bounds-check
      // it before reading or a corrupt pk3 throws RangeError instead of null.
      if (localOff + 30 > buf.length) return null;
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataOff = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataOff, dataOff + compSize);
      try {
        return method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
      } catch {
        return null;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// Scan a .pk3 once and return [{ name, entities, slick }] for every
// maps/<name>.bsp it carries. The map pool is thousands of packs, so this reads
// the archive a single time rather than extractBsp-per-map (which re-reads the
// whole file for each map). `name` is the lowercased bsp basename — the in-game
// map name, which is NOT always the pack filename. `entities` is the raw lump-0
// text (possibly "" for a corrupt/unreadable bsp) and `slick` is parseSlick's
// result (null for one we couldn't read). Returns [] for an unreadable / non-zip
// pack.
//
// Both derive from the same inflated buffer on purpose: inflating the pool twice
// costs ~10 minutes of pure I/O for no benefit.
export function extractMapEntities(pk3Path) {
  let buf;
  try {
    buf = fs.readFileSync(pk3Path);
  } catch {
    return [];
  }
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const out = [];
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const fname = buf.toString("latin1", p + 46, p + 46 + nameLen).toLowerCase();
    const m = fname.match(/^maps\/(.+)\.bsp$/);
    if (m && isSafeMapName(m[1])) {
      // Same untrusted-offset guard as extractBsp: a corrupt central directory
      // must yield "" for this map, never a throw that aborts the whole scan.
      let bsp = null;
      if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataOff = localOff + 30 + lNameLen + lExtraLen;
        const comp = buf.subarray(dataOff, dataOff + compSize);
        try {
          bsp = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
        } catch {
          bsp = null;
        }
      }
      out.push({
        name: m[1],
        entities: bsp ? parseEntities(bsp) : "",
        slick: bsp ? parseSlick(bsp) : null,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// --- BSP parse (IBSP + FBSP) -------------------------------------------------
// Returns { vx, vy, vz, tris:[[a,b,c]...], kinds:["floor"|"wall"|"slope"] } or
// null when the buffer is not a BSP we understand.
export function parseBsp(buf) {
  if (!buf || buf.length < 8 + 17 * 8) return null;
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== "IBSP" && magic !== "FBSP") return null;
  const V_STRIDE = magic === "FBSP" ? 80 : 44;
  const F_STRIDE = magic === "FBSP" ? 148 : 104;
  const lump = (i) => ({ offset: buf.readInt32LE(8 + i * 8), length: buf.readInt32LE(8 + i * 8 + 4) });
  const L_VERTS = 10, L_ELEMS = 11, L_FACES = 13;

  const lv = lump(L_VERTS), le = lump(L_ELEMS), lf = lump(L_FACES);
  // Lump directory is untrusted (corrupt/truncated pk3s exist in the pool):
  // every lump we read must lie fully inside the buffer, and offsets can be
  // negative in a corrupt header — readFloatLE on those throws RangeError.
  const lumpOk = (l) => l.offset >= 0 && l.length >= 0 && l.offset + l.length <= buf.length;
  if (!lumpOk(lv) || !lumpOk(le) || !lumpOk(lf)) return null;
  const nVerts = Math.floor(lv.length / V_STRIDE);
  const nElems = Math.floor(le.length / 4);
  const nFaces = Math.floor(lf.length / F_STRIDE);
  if (nVerts < 3 || nFaces < 1) return null;

  const vx = new Float32Array(nVerts), vy = new Float32Array(nVerts), vz = new Float32Array(nVerts);
  for (let i = 0; i < nVerts; i++) {
    const o = lv.offset + i * V_STRIDE;
    vx[i] = buf.readFloatLE(o); vy[i] = buf.readFloatLE(o + 4); vz[i] = buf.readFloatLE(o + 8);
  }
  const elem = new Int32Array(nElems);
  for (let i = 0; i < nElems; i++) elem[i] = buf.readInt32LE(le.offset + i * 4);

  const tris = [], kinds = [];
  for (let f = 0; f < nFaces; f++) {
    const o = lf.offset + f * F_STRIDE;
    const type = buf.readInt32LE(o + 8);
    if (type !== 1 && type !== 3) continue; // planar/mesh only; skip patches/flares
    const firstVert = buf.readInt32LE(o + 12);
    const firstElem = buf.readInt32LE(o + 20);
    const nElem = buf.readInt32LE(o + 24);
    // A face pointing outside the elems lump would index the typed array out
    // of range (yielding NaN vertices, drawn as garbage) — skip it instead.
    if (firstElem < 0 || nElem < 0 || firstElem + nElem > nElems) continue;
    for (let m = 0; m + 2 < nElem; m += 3) {
      const a = firstVert + elem[firstElem + m];
      const b = firstVert + elem[firstElem + m + 1];
      const c = firstVert + elem[firstElem + m + 2];
      if (a < 0 || b < 0 || c < 0 || a >= nVerts || b >= nVerts || c >= nVerts) continue;
      // per-triangle up-component classifies floor vs wall vs slope
      const ux = vx[b] - vx[a], uy = vy[b] - vy[a], uz = vz[b] - vz[a];
      const wx = vx[c] - vx[a], wy = vy[c] - vy[a], wz = vz[c] - vz[a];
      const nz = ux * wy - uy * wx;
      const nlen = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, nz) || 1;
      const up = Math.abs(nz / nlen);
      tris.push([a, b, c]);
      kinds.push(up > 0.4 ? "floor" : up < 0.35 ? "wall" : "slope");
    }
  }
  if (!tris.length) return null;
  return { vx, vy, vz, tris, kinds };
}

// --- theme + drawing primitives ---------------------------------------------
// Site palette (style.css :root), each [r,g,b]. Dark near-black with an orange
// accent + cyan; markers use green/gold. Shared so the image matches the site.
export const THEME = {
  bg: [10, 11, 15], panel: [21, 24, 36], panel2: [28, 32, 48], line: [38, 43, 61],
  cyan: [34, 211, 238], orange: [255, 106, 26], green: [169, 242, 106], gold: [255, 210, 74],
};

// All primitives take (rgba, S) where S is the (square) canvas side, and clip.
function blend(rgba, S, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const p = (y * S + x) * 4, ia = a / 255, na = 1 - ia;
  rgba[p] = r * ia + rgba[p] * na; rgba[p + 1] = g * ia + rgba[p + 1] * na;
  rgba[p + 2] = b * ia + rgba[p + 2] * na; rgba[p + 3] = Math.max(rgba[p + 3], a);
}
function disc(rgba, S, cx, cy, rad, r, g, b, a = 255) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) {
    const d = Math.hypot(x, y);
    if (d <= rad) blend(rgba, S, cx + x, cy + y, r, g, b, a * Math.min(1, rad - d + 0.5));
  }
}
function ring(rgba, S, cx, cy, rad, th, r, g, b, a = 255) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let y = -rad - th; y <= rad + th; y++) for (let x = -rad - th; x <= rad + th; x++) {
    const d = Math.hypot(x, y);
    if (d >= rad - th && d <= rad + th) blend(rgba, S, cx + x, cy + y, r, g, b, a);
  }
}
function line(rgba, S, x0, y0, x1, y1, r, g, b, a) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx - dy;
  for (;;) {
    blend(rgba, S, x0, y0, r, g, b, a);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 > -dy) { e -= dy; x0 += sx; }
    if (e2 < dx) { e += dx; y0 += sy; }
  }
}
function fillTriZ(rgba, S, zbuf, ax, ay, bx, by, cx, cy, z, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(S - 1, Math.ceil(Math.max(ay, by, cy)));
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(d) < 1e-6) return;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
    const w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
    if (w0 < -0.001 || w1 < -0.001 || 1 - w0 - w1 < -0.001) continue;
    const i = y * S + x;
    if (z <= zbuf[i]) continue;
    zbuf[i] = z;
    blend(rgba, S, x, y, r, g, b, a);
  }
}

// World -> pixel projection into the fit rectangle {ox,oy,fw,fh} centred in the
// square canvas. Shared by the map base and the markers so they align with the
// heatmap (which uses the same bounds + fit).
export function makeProject(bounds, fit) {
  const sx = (fit.fw - 1) / (bounds.maxX - bounds.minX);
  const sy = (fit.fh - 1) / (bounds.maxY - bounds.minY);
  return (x, y) => [fit.ox + (x - bounds.minX) * sx, fit.oy + (fit.fh - 1) - (y - bounds.minY) * sy];
}

// Fill the whole (opaque) themed background, then a subtle blueprint grid.
export function fillBg(rgba, r, g, b) {
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
}
export function drawGrid(rgba, S, step = 50) {
  const [lr, lg, lb] = THEME.line;
  for (let x = 0; x <= S; x += step) for (let y = 0; y < S; y++) blend(rgba, S, x, y, lr, lg, lb, x % 200 === 0 ? 26 : 14);
  for (let y = 0; y <= S; y += step) for (let x = 0; x < S; x++) blend(rgba, S, x, y, lr, lg, lb, y % 200 === 0 ? 26 : 14);
}

// Blueprint map base: faint dark-panel floor (height-shaded, z-buffered so upper
// platforms read on top) + crisp thin cyan wall strokes. Draws into `rgba`
// (assumed already background-filled), aligned to the heatmap's bounds + fit.
export function renderMapBase(rgba, S, bounds, fit, geom) {
  const { vx, vy, vz, tris, kinds } = geom;
  const P = makeProject(bounds, fit);
  const zbuf = new Float32Array(S * S).fill(-1e9);
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] === "wall") continue;
    const [a, b, c] = tris[i]; const z = (vz[a] + vz[b] + vz[c]) / 3;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const zr = maxZ - minZ || 1, T = THEME;
  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] === "wall") continue;
    const [a, b, c] = tris[i];
    const [ax, ay] = P(vx[a], vy[a]), [bx, by] = P(vx[b], vy[b]), [cx, cy] = P(vx[c], vy[c]);
    const z = (vz[a] + vz[b] + vz[c]) / 3, h = (z - minZ) / zr;
    const r = T.panel[0] + (T.panel2[0] - T.panel[0]) * h;
    const g = T.panel[1] + (T.panel2[1] - T.panel[1]) * h;
    const bl = T.panel[2] + (T.panel2[2] - T.panel[2]) * h;
    fillTriZ(rgba, S, zbuf, ax, ay, bx, by, cx, cy, z, r | 0, g | 0, bl | 0, 235);
  }
  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] !== "wall") continue;
    const [a, b, c] = tris[i];
    const [ax, ay] = P(vx[a], vy[a]), [bx, by] = P(vx[b], vy[b]), [cx, cy] = P(vx[c], vy[c]);
    line(rgba, S, ax, ay, bx, by, T.cyan[0], T.cyan[1], T.cyan[2], 150);
    line(rgba, S, bx, by, cx, cy, T.cyan[0], T.cyan[1], T.cyan[2], 150);
    line(rgba, S, cx, cy, ax, ay, T.cyan[0], T.cyan[1], T.cyan[2], 150);
  }
}

// --- markers: start / finish / checkpoints ----------------------------------
// tiny 3x5 pixel font for marker labels (S, F, and digits).
const FONT = {
  S: ["111", "100", "111", "001", "111"], F: ["111", "100", "110", "100", "100"],
  0: ["111", "101", "101", "101", "111"], 1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"], 3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"], 5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"], 7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"], 9: ["111", "101", "111", "001", "111"],
};
function glyph(rgba, S, ch, cx, cy, px, r, g, b, a = 255) {
  const rows = FONT[ch]; if (!rows) return;
  const x0 = Math.round(cx - (3 * px) / 2), y0 = Math.round(cy - (5 * px) / 2);
  for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < 3; rx++) if (rows[ry][rx] === "1")
    for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) blend(rgba, S, x0 + rx * px + dx, y0 + ry * px + dy, r, g, b, a);
}
function label(rgba, S, str, cx, cy, px, r, g, b, a = 255) {
  const gw = 3 * px, gap = px, total = str.length * gw + (str.length - 1) * gap;
  let x = cx - total / 2 + gw / 2;
  for (const ch of str) { glyph(rgba, S, ch, x, cy, px, r, g, b, a); x += gw + gap; }
}
// markers = { start:[px,py], finish:[px,py], cps:[[px,py],...] } in canvas pixels.
export function drawMarkers(rgba, S, markers) {
  const T = THEME, clamp = (p) => [Math.max(14, Math.min(S - 14, p[0])), Math.max(14, Math.min(S - 14, p[1]))];
  (markers.cps || []).forEach((cp, idx) => {
    const [x, y] = clamp(cp);
    disc(rgba, S, x, y, 11, T.bg[0], T.bg[1], T.bg[2], 235);
    ring(rgba, S, x, y, 11, 1, T.gold[0], T.gold[1], T.gold[2], 255);
    disc(rgba, S, x, y, 9, T.gold[0], T.gold[1], T.gold[2], 235);
    label(rgba, S, String(idx + 1), x, y, 3, T.bg[0], T.bg[1], T.bg[2], 255);
  });
  if (markers.start) {
    const [x, y] = clamp(markers.start);
    disc(rgba, S, x, y, 13, T.bg[0], T.bg[1], T.bg[2], 255);
    ring(rgba, S, x, y, 13, 2, T.green[0], T.green[1], T.green[2], 255);
    disc(rgba, S, x, y, 10, T.green[0], T.green[1], T.green[2], 235);
    label(rgba, S, "S", x, y, 3, T.bg[0], T.bg[1], T.bg[2], 255);
  }
  if (markers.finish) {
    const [x, y] = clamp(markers.finish), rad = 13;
    disc(rgba, S, x, y, 13, T.bg[0], T.bg[1], T.bg[2], 255);
    for (let ang = 0; ang < 360; ang += 12) { // checkered accent ring
      const rc = x + Math.cos((ang * Math.PI) / 180) * rad, rs = y + Math.sin((ang * Math.PI) / 180) * rad;
      const col = Math.floor(ang / 12) % 2 === 0 ? [235, 238, 245] : T.orange;
      disc(rgba, S, rc, rs, 2, col[0], col[1], col[2], 255);
    }
    disc(rgba, S, x, y, 10, T.orange[0], T.orange[1], T.orange[2], 235);
    label(rgba, S, "F", x, y, 3, T.bg[0], T.bg[1], T.bg[2], 255);
  }
}

// --- BSP entity lump (lump 0) ------------------------------------------------
// Lump 0 is a plain-text list of `{ "key" "value" ... }` blocks. We only need it
// to discover which weapon_* spawn entities a map carries, so hand back the raw
// text and let the caller scan it. Same untrusted-lump bounds check as parseBsp
// (offset can be negative / past EOF in a corrupt header). Entities are ASCII;
// latin1 maps every byte 1:1 and never throws. Returns "" when the buffer is not
// a BSP or the lump is empty/out of bounds.
export function parseEntities(buf) {
  if (!buf || buf.length < 8 + 17 * 8) return "";
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== "IBSP" && magic !== "FBSP") return "";
  const offset = buf.readInt32LE(8); // lump 0: offset@8, length@12
  const length = buf.readInt32LE(12);
  if (offset < 0 || length < 0 || offset + length > buf.length) return "";
  // Trailing NUL padding is common; strip it so the caller's regex is clean.
  return buf.toString("latin1", offset, offset + length).replace(/\0+$/, "");
}

// --- slick (ice) surfaces ----------------------------------------------------
// How much of a map's walkable floor is slick, for the "Slick" map tag, the
// website filter and `callvote randmap slick` (see scan-map-slick in
// scan-map-weapons.js).
//
// Slick is SURF_SLICK (0x2) on a shaderref, and the collision model takes those
// flags VERBATIM from the bsp — cm_q3bsp.c CMod_LoadSurfaces does
// `out->flags = LittleLong( in->flags )` with no re-derivation from the .shader
// script — so the baked flag IS what makes the player slide. Two consequences
// worth knowing before touching this:
//
//   * It must be read off BRUSHSIDES (lump 9), not the render faces (lump 13)
//     parseBsp uses. textures/common/slick is a NODRAW brush laid over the
//     visible geometry, so it owns no draw face at all: scanning faces finds the
//     shader in the table and zero surfaces using it, scoring every map 0.
//   * Matching shader NAMES does not work. 899 maps in the pool use
//     textures/common/slick, but ~50 other shaders carry the flag too
//     (blxbis/ice_01, gnjstamina/glass_stamina, kabcorp/fzerofloor1, even
//     noshader and common/caulk), and the single slickest map in the pool
//     (srr2k5, 99.6%) names its slick shader textures/cos1/cretebase2_s.
//
// Each side's real extent comes from its winding: start with a huge quad on the
// side's plane and clip it against the brush's other planes (side planes point
// OUTWARD, so the brush interior is dot(n,p) - d <= 0). "Floor" is the engine's
// own walkable test, ISWALKABLEPLANE in gs_public.h: normal[2] >= 0.7.
//
// We do NOT ratio raw 3D areas, because two things break that badly:
//
//   * Slick is a COINCIDENT OVERLAY. A mapper lays a nodraw common/slick brush
//     directly on top of the visible floor brush, so both sides report the exact
//     same area (in snapslick, common/slick and gothic_floor/largerblock3b3dim
//     are both 1,061,683,200 to the byte). Summing them counts one floor twice
//     and roughly halves every map's score.
//   * Sky and trigger volumes swamp the denominator — 56% of srr2k5's walkable
//     area is skybox shell and 28% is common/trigger, neither of which is ground
//     anyone stands on.
//
// So instead we rasterize walkable windings onto an XY grid and count each
// distinct FLOOR LEVEL in each cell once: a cell's (column, height) pair is one
// piece of ground, and it is slick if any surface at that exact height is slick.
// The coincident overlay collapses to a single slick level, while genuinely
// stacked storeys still count separately.
//
// Note "topmost surface per cell" was tried first and is wrong: a ceiling slab's
// TOP face is up-facing too, so a roof over the level (textures/NULL at z=2560
// in snapslick) outranks the floor in every cell and the map reads 0% slick.
const SURF_SLICK = 0x2;
const SURF_SKY = 0x4;
const SURF_NODRAW = 0x80;
const CONTENTS_SOLID = 1;
const CONTENTS_PLAYERCLIP = 0x10000;
const CONTENTS_TRIGGER = 0x40000000;
const WALKABLE_Z = 0.7;
// Grid resolution for the footprint rasterization. 192x192 over the map's
// walkable bounds is ~37k cells — fine to allocate per map, and fine-grained
// enough that a narrow slick strafe pad still registers.
const SLICK_GRID = 192;
// Clipping scratch: bigger than the ±32768 q3map2 world bound, so the starting
// quad always fully contains the real winding.
const WINDING_HUGE = 65536;
const WINDING_EPS = 0.01;

function baseWinding(n, d) {
  // Any vector not parallel to n gives a stable tangent basis; pick the axis the
  // normal leans on least.
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let up = az >= ax && az >= ay ? [1, 0, 0] : [0, 0, 1];
  const dot = up[0] * n[0] + up[1] * n[1] + up[2] * n[2];
  up = [up[0] - n[0] * dot, up[1] - n[1] * dot, up[2] - n[2] * dot];
  const ul = Math.hypot(up[0], up[1], up[2]) || 1;
  up = [up[0] / ul, up[1] / ul, up[2] / ul];
  const rt = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
  const org = [n[0] * d, n[1] * d, n[2] * d];
  const pts = [];
  for (const [su, sr] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
    pts.push([
      org[0] + up[0] * su * WINDING_HUGE + rt[0] * sr * WINDING_HUGE,
      org[1] + up[1] * su * WINDING_HUGE + rt[1] * sr * WINDING_HUGE,
      org[2] + up[2] * su * WINDING_HUGE + rt[2] * sr * WINDING_HUGE,
    ]);
  }
  return pts;
}

// Keep the half of `pts` inside the plane (dot(n,p) - d <= 0), or null if the
// winding is entirely outside / degenerates below a triangle.
function clipWinding(pts, n, d) {
  if (!pts || pts.length < 3) return null;
  const dists = pts.map((p) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - d);
  if (dists.every((x) => x > WINDING_EPS)) return null;
  if (dists.every((x) => x <= WINDING_EPS)) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    if (dists[i] <= WINDING_EPS) out.push(pts[i]);
    if ((dists[i] > WINDING_EPS) !== (dists[j] > WINDING_EPS)) {
      const t = dists[i] / (dists[i] - dists[j]);
      out.push([
        pts[i][0] + t * (pts[j][0] - pts[i][0]),
        pts[i][1] + t * (pts[j][1] - pts[i][1]),
        pts[i][2] + t * (pts[j][2] - pts[i][2]),
      ]);
    }
  }
  return out.length >= 3 ? out : null;
}

// Area of a planar polygon = half the magnitude of its summed edge cross
// products (fan from vertex 0).
function windingArea(pts) {
  let ax = 0, ay = 0, az = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const ux = pts[i][0] - pts[0][0], uy = pts[i][1] - pts[0][1], uz = pts[i][2] - pts[0][2];
    const wx = pts[i + 1][0] - pts[0][0], wy = pts[i + 1][1] - pts[0][1], wz = pts[i + 1][2] - pts[0][2];
    ax += uy * wz - uz * wy;
    ay += uz * wx - ux * wz;
    az += ux * wy - uy * wx;
  }
  return Math.hypot(ax, ay, az) / 2;
}

// Returns { frac, brushes, cells, slickCells } or null when the buffer is not a
// BSP we understand. `frac` is the fraction of the map's walkable footprint
// whose topmost surface is slick, in [0,1] — 0 for a map with no slick at all.
//
// Deliberately NOT filtered for "unreasonably large" sides: an earlier cut
// dropped sides over ~1e7 sq units to suppress skybox shells, which zeroed
// snapslick and worstslick, whose slick floor is legitimately one huge sheet.
export function parseSlick(buf) {
  if (!buf || buf.length < 8 + 18 * 8) return null;
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== "IBSP" && magic !== "FBSP" && magic !== "RBSP") return null;
  // FBSP/RBSP are BSP_RAVEN: rdbrushside_t carries an extra surfacenum, so the
  // stride is 12 rather than dbrushside_t's 8. Reading the wrong one garbles
  // every shadernum.
  const BS_STRIDE = magic === "IBSP" ? 8 : 12;
  const lump = (i) => ({ offset: buf.readInt32LE(8 + i * 8), length: buf.readInt32LE(8 + i * 8 + 4) });
  const lumpOk = (l) => l.offset >= 0 && l.length >= 0 && l.offset + l.length <= buf.length;

  const lSh = lump(1), lPl = lump(2), lBr = lump(8), lBs = lump(9);
  if (!lumpOk(lSh) || !lumpOk(lPl) || !lumpOk(lBr) || !lumpOk(lBs)) return null;

  // lump 1: dshaderref_t { char name[64]; int flags; int contents; }
  const nSh = Math.floor(lSh.length / 72);
  const shFlags = new Int32Array(nSh), shContents = new Int32Array(nSh);
  for (let i = 0; i < nSh; i++) {
    shFlags[i] = buf.readInt32LE(lSh.offset + i * 72 + 64);
    shContents[i] = buf.readInt32LE(lSh.offset + i * 72 + 68);
  }
  // lump 2: dplane_t { float normal[3]; float dist; }
  const nPl = Math.floor(lPl.length / 16);
  const pnx = new Float32Array(nPl), pny = new Float32Array(nPl), pnz = new Float32Array(nPl);
  const pd = new Float32Array(nPl);
  for (let i = 0; i < nPl; i++) {
    const o = lPl.offset + i * 16;
    pnx[i] = buf.readFloatLE(o); pny[i] = buf.readFloatLE(o + 4); pnz[i] = buf.readFloatLE(o + 8);
    pd[i] = buf.readFloatLE(o + 12);
  }
  const nBs = Math.floor(lBs.length / BS_STRIDE);
  const nBr = Math.floor(lBr.length / 12); // dbrush_t { firstside, numsides, shadernum }

  // Pass 1: every walkable side, as an XY polygon plus the plane that gives its
  // height, and the map's walkable XY bounds.
  const surfaces = [];
  let brushes = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let b = 0; b < nBr; b++) {
    const o = lBr.offset + b * 12;
    const firstSide = buf.readInt32LE(o);
    const numSides = buf.readInt32LE(o + 4);
    const brushShader = buf.readInt32LE(o + 8);
    // A brush with fewer than 4 sides encloses nothing; the lump is untrusted,
    // so bounds-check before indexing.
    if (firstSide < 0 || numSides < 4 || firstSide + numSides > nBs) continue;
    if (brushShader < 0 || brushShader >= nSh) continue;
    // Only volumes a player can stand on — skips fog, water and trigger brushes.
    if (!(shContents[brushShader] & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP))) continue;

    const planes = [];
    for (let s = 0; s < numSides; s++) {
      const so = lBs.offset + (firstSide + s) * BS_STRIDE;
      const planenum = buf.readInt32LE(so);
      const shadernum = buf.readInt32LE(so + 4);
      if (planenum < 0 || planenum >= nPl) { planes.push(null); continue; }
      const flags = shadernum >= 0 && shadernum < nSh ? shFlags[shadernum] : 0;
      const contents = shadernum >= 0 && shadernum < nSh ? shContents[shadernum] : 0;
      planes.push({
        n: [pnx[planenum], pny[planenum], pnz[planenum]],
        d: pd[planenum],
        slick: !!(flags & SURF_SLICK),
        // The BRUSH may be solid while an individual SIDE is skinned with sky,
        // trigger or a compile-only helper. None of those are ground: sky and
        // trigger alone are 56% and 28% of srr2k5's walkable area, and caulk /
        // clip / hull faces are invisible scaffolding. Count real, visible
        // ground — plus the slick overlay, which is nodraw by design.
        skip:
          !!(flags & SURF_SKY) ||
          !!(contents & CONTENTS_TRIGGER && !(contents & CONTENTS_SOLID)) ||
          (!!(flags & SURF_NODRAW) && !(flags & SURF_SLICK)),
      });
    }
    let brushSlick = false;
    for (let s = 0; s < numSides; s++) {
      const pl = planes[s];
      if (!pl || pl.skip || pl.n[2] < WALKABLE_Z) continue; // walkable, real ground only
      let w = baseWinding(pl.n, pl.d);
      for (let t = 0; t < numSides && w; t++) {
        if (t !== s && planes[t]) w = clipWinding(w, planes[t].n, planes[t].d);
      }
      if (!w) continue;
      if (!(windingArea(w) > 0)) continue;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of w) {
        if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) { bx0 = Infinity; break; }
        if (p[0] < bx0) bx0 = p[0];
        if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1];
        if (p[1] > by1) by1 = p[1];
      }
      if (!isFinite(bx0)) continue;
      surfaces.push({ w, n: pl.n, d: pl.d, slick: pl.slick, bx0, by0, bx1, by1 });
      if (bx0 < minX) minX = bx0;
      if (by0 < minY) minY = by0;
      if (bx1 > maxX) maxX = bx1;
      if (by1 > maxY) maxY = by1;
      if (pl.slick) brushSlick = true;
    }
    if (brushSlick) brushes++;
  }
  if (!surfaces.length || !(maxX > minX) || !(maxY > minY)) {
    return { frac: 0, brushes, cells: 0, slickCells: 0 };
  }

  // Pass 2: rasterize each footprint and record every distinct (cell, height)
  // level. Keyed on the height rounded to a unit, so the slick overlay and the
  // floor it sits on land on the same key and are counted once.
  const N = SLICK_GRID;
  const cw = (maxX - minX) / N, ch = (maxY - minY) / N;
  const levels = new Map(); // cell*Z_SPAN + quantized height -> is slick
  const Z_SPAN = 1 << 17;   // covers the ±65536 q3map2 world bound
  for (const s of surfaces) {
    if (s.n[2] === 0) continue;
    // Only the cells this surface's bbox touches, clamped to the grid.
    const c0 = Math.max(0, Math.floor((s.bx0 - minX) / cw));
    const c1 = Math.min(N - 1, Math.floor((s.bx1 - minX) / cw));
    const r0 = Math.max(0, Math.floor((s.by0 - minY) / ch));
    const r1 = Math.min(N - 1, Math.floor((s.by1 - minY) / ch));
    for (let r = r0; r <= r1; r++) {
      const y = minY + (r + 0.5) * ch;
      for (let c = c0; c <= c1; c++) {
        const x = minX + (c + 0.5) * cw;
        if (!pointInWindingXY(s.w, x, y)) continue;
        // Height of this plane above (x,y): nx*x + ny*y + nz*z = d.
        const z = (s.d - s.n[0] * x - s.n[1] * y) / s.n[2];
        if (!isFinite(z)) continue;
        const zq = Math.round(z);
        if (zq < -Z_SPAN / 2 || zq > Z_SPAN / 2) continue;
        const key = (r * N + c) * Z_SPAN + (zq + Z_SPAN / 2);
        if (s.slick) levels.set(key, true);
        else if (!levels.has(key)) levels.set(key, false);
      }
    }
  }
  let cells = 0, slickCells = 0;
  for (const slick of levels.values()) {
    cells++;
    if (slick) slickCells++;
  }
  return { frac: cells > 0 ? slickCells / cells : 0, brushes, cells, slickCells };
}

// Point-in-convex-polygon on the XY projection. Windings come out of
// clipWinding convex, so a consistent sign against every edge is enough; the
// winding order depends on the plane, so accept all-left OR all-right.
function pointInWindingXY(w, x, y) {
  let neg = false, pos = false;
  for (let i = 0; i < w.length; i++) {
    const j = (i + 1) % w.length;
    const cross = (w[j][0] - w[i][0]) * (y - w[i][1]) - (w[j][1] - w[i][1]) * (x - w[i][0]);
    if (cross < -1e-6) neg = true;
    else if (cross > 1e-6) pos = true;
    if (neg && pos) return false;
  }
  return true;
}

// Convenience: maps dir + map name -> parsed map geometry, or null. Strips a
// "-reversed" suffix (reverse maps reuse the base map's .bsp/.pk3).
//
// A pack's filename is often NOT the map name (bug70_slick-wjfix.bsp ships in
// bug70-wjfix.pk3), so the map name alone can't name the pack. `resolvePk3s`
// (see mapindex.js getMapIndex) maps a name to the candidate pack FILENAMES that
// actually carry maps/<name>.bsp; we try them in order until one parses. The old
// same-name guess is kept as a final fallback so callers without an index (and
// the common name==filename case) still work.
export function loadMapGeometry(mapsDir, mapName, resolvePk3s = null) {
  const base = String(mapName || "").replace(/-reversed$/, "").toLowerCase();
  if (!isSafeMapName(base)) return null;
  const candidates = [];
  if (resolvePk3s) {
    for (const f of resolvePk3s(base) || []) if (!candidates.includes(f)) candidates.push(f);
  }
  const legacy = `${base}.pk3`;
  if (!candidates.includes(legacy)) candidates.push(legacy);
  for (const f of candidates) {
    const bsp = extractBsp(`${mapsDir}/${f}`, base);
    const geom = bsp ? parseBsp(bsp) : null;
    if (geom) return geom;
  }
  return null;
}
