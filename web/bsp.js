// Top-down map geometry for the heatmaps: pull a map's .bsp out of its .pk3,
// parse the walkable geometry, and render a floor-plan base that the heatmap
// draws on top of (so you see WHERE on the map the traffic is). Zero external
// deps — a .pk3 is a zip, and Node's zlib inflates the entries.
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

// --- render the map base into an RGBA buffer, aligned to given bounds --------
// Draws a height-shaded floor (z-buffered so upper platforms win) plus dark wall
// edges that trace rooms/corridors, using the SAME bounds + size the heatmap
// used — so the traffic composited on top lands in the right place. Mutates
// `rgba` in place (expected transparent on entry).
export function renderMapBase(rgba, W, H, bounds, geom) {
  const { minX, minY, maxX, maxY } = bounds;
  const { vx, vy, vz, tris, kinds } = geom;
  const sx = (W - 1) / (maxX - minX), sy = (H - 1) / (maxY - minY);
  const px = (x) => (x - minX) * sx;
  const py = (y) => (H - 1) - (y - minY) * sy;

  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] === "wall") continue;
    for (const idx of tris[i]) { if (vz[idx] < minZ) minZ = vz[idx]; if (vz[idx] > maxZ) maxZ = vz[idx]; }
  }
  const zbuf = new Float32Array(W * H).fill(-Infinity);
  const ramp = (t) => {
    t = Math.max(0, Math.min(1, t));
    return [70 + 80 * t, 82 + 83 * t, 104 + 91 * t];
  };
  const blend = (p, r, g, b, a) => {
    const ia = a / 255, na = 1 - ia;
    rgba[p] = r * ia + rgba[p] * na; rgba[p + 1] = g * ia + rgba[p + 1] * na;
    rgba[p + 2] = b * ia + rgba[p + 2] * na; rgba[p + 3] = Math.max(rgba[p + 3], a);
  };
  const fillTri = (ax, ay, bx, by, cx, cy, z, r, g, b) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(d) < 1e-6) return;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const w0 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
      const w1 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
      if (w0 < -0.001 || w1 < -0.001 || 1 - w0 - w1 < -0.001) continue;
      const i = y * W + x;
      if (z <= zbuf[i]) continue;
      zbuf[i] = z;
      const p = i * 4;
      rgba[p] = r; rgba[p + 1] = g; rgba[p + 2] = b; rgba[p + 3] = 235;
    }
  };
  const line = (x0, y0, x1, y1) => {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sxg = x0 < x1 ? 1 : -1, syg = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) blend((y0 * W + x0) * 4, 12, 16, 24, 70);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sxg; }
      if (e2 < dx) { err += dx; y0 += syg; }
    }
  };

  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] === "wall") continue;
    const [a, b, c] = tris[i];
    const zc = (vz[a] + vz[b] + vz[c]) / 3;
    const [r, g, bl] = ramp((zc - minZ) / Math.max(maxZ - minZ, 1));
    fillTri(px(vx[a]), py(vy[a]), px(vx[b]), py(vy[b]), px(vx[c]), py(vy[c]), zc, r | 0, g | 0, bl | 0);
  }
  for (let i = 0; i < tris.length; i++) {
    if (kinds[i] !== "wall") continue;
    const [a, b, c] = tris[i];
    const ax = px(vx[a]), ay = py(vy[a]), bx = px(vx[b]), by = py(vy[b]), cx = px(vx[c]), cy = py(vy[c]);
    line(ax, ay, bx, by); line(bx, by, cx, cy); line(cx, cy, ax, ay);
  }
}

// Convenience: pk3 path + map name -> rendered map-base geometry, or null.
// Strips a "-reversed" suffix (reverse maps reuse the base map's .bsp/.pk3).
export function loadMapGeometry(mapsDir, mapName) {
  const base = String(mapName || "").replace(/-reversed$/, "");
  if (!base || !/^[a-z0-9_.-]+$/i.test(base)) return null;
  const bsp = extractBsp(`${mapsDir}/${base}.pk3`, base);
  return bsp ? parseBsp(bsp) : null;
}
