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
  const nVerts = Math.floor(lv.length / V_STRIDE);
  const nElems = Math.floor(le.length / 4);
  const nFaces = Math.floor(lf.length / F_STRIDE);
  if (nVerts < 3 || nFaces < 1 || lv.offset + lv.length > buf.length || lf.offset + lf.length > buf.length) return null;

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

// Convenience: pk3 path + map name -> parsed map geometry, or null. Strips a
// "-reversed" suffix (reverse maps reuse the base map's .bsp/.pk3).
export function loadMapGeometry(mapsDir, mapName) {
  const base = String(mapName || "").replace(/-reversed$/, "");
  if (!base || !/^[a-z0-9_.-]+$/i.test(base)) return null;
  const bsp = extractBsp(`${mapsDir}/${base}.pk3`, base);
  return bsp ? parseBsp(bsp) : null;
}
