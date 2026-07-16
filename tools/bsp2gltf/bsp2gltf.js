#!/usr/bin/env node
// bsp2gltf — convert a Warsow/Quake3 BSP world into a flat, textureless .glb
// mesh for the in-browser replay viewer (web/public/assets/js/replay.js).
//
// Handles both formats present in server/maps:
//   * IBSP v46  (stock Quake 3)      vertex 44B, face 104B
//   * FBSP v1   (Warsow/qfusion)     vertex 80B, face 148B (MAX_LIGHTMAPS=4)
// Struct layouts are from the engine source (qcommon/qfiles.h: dvertex_t,
// rdvertex_t, dface_t, rdface_t). Only world geometry is emitted — POSITION +
// triangle indices, no normals/UVs/shaders — so the viewer computes flat
// normals and draws the level as a neutral backdrop behind the ghost.
//
// Coordinates are converted Quake (Z-up, X fwd, Y left) -> glTF (Y-up):
//   gl = (qx, qz, -qy). The viewer applies the SAME transform to ghost
//   trajectory points so the ghost lines up inside the geometry.
//
// Usage:
//   node bsp2gltf.js <map.pk3|map.bsp> <out.glb>
//   node bsp2gltf.js --dir <mapsDir> <outDir> [--limit N]   (batch .pk3 -> .glb)
//
// Dependency-free (Node built-ins only): a minimal ZIP reader pulls the .bsp
// out of a .pk3 in memory; a minimal glb writer emits binary glTF 2.0.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---- ZIP (.pk3) reader: return the first member matching an extension. ------
function readZipMember(buf, wantExt) {
  let i = buf.length - 22;
  for (; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) break; // EOCD
  if (i < 0) throw new Error("not a zip / EOCD not found");
  const cdOff = buf.readUInt32LE(i + 16);
  const cdCount = buf.readUInt16LE(i + 10);
  let p = cdOff;
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central dir header
    const comp = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("latin1", p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.toLowerCase().endsWith(wantExt)) {
      const ln = buf.readUInt16LE(lho + 26);
      const le = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + ln + le;
      const raw = buf.subarray(start, start + csize);
      return { name, data: comp === 0 ? raw : zlib.inflateRawSync(raw) };
    }
  }
  return null;
}

// ---- BSP format table -------------------------------------------------------
const FORMATS = {
  "IBSP46": { vtxStride: 44, faceStride: 104, patchCpOff: 96 },
  "FBSP1": { vtxStride: 80, faceStride: 148, patchCpOff: 140 },
};

const LUMP_SHADERS = 1;
const LUMP_VERTS = 10;
const LUMP_ELEMS = 11;
const LUMP_FACES = 13;
const SHADERREF_SIZE = 72; // char name[64] + int flags + int contents
const SURF_NODRAW = 0x80;
const NODRAW_NAMES = [
  "common/caulk", "common/nodraw", "common/trigger", "common/clip",
  "common/weapclip", "common/playerclip", "common/hint", "common/skip",
  "common/areaportal", "common/donotenter", "common/nodrawnonsolid",
  "common/full_clip", "common/invisible", "common/origin", "common/nolightmap",
];

const PATCH_LEVEL = 8; // bezier subdivisions per 3x3 sub-patch

// Quake -> glTF axis swap.
function push3(arr, qx, qy, qz) {
  arr.push(qx, qz, -qy);
}

function parseBsp(data) {
  const magic = data.toString("latin1", 0, 4);
  const version = data.readInt32LE(4);
  const key = magic + version;
  const fmt = FORMATS[key];
  if (!fmt) throw new Error(`unsupported BSP: ${magic} v${version}`);

  const lump = (idx) => {
    const o = 8 + idx * 8;
    return { off: data.readInt32LE(o), len: data.readInt32LE(o + 4) };
  };
  const Lv = lump(LUMP_VERTS), Le = lump(LUMP_ELEMS), Lf = lump(LUMP_FACES), Ls = lump(LUMP_SHADERS);

  // Shaders: flag + name so we can drop caulk/nodraw/clip/trigger surfaces.
  const shaders = [];
  for (let o = Ls.off; o + SHADERREF_SIZE <= Ls.off + Ls.len; o += SHADERREF_SIZE) {
    let end = o;
    while (end < o + 64 && data[end] !== 0) end++;
    const name = data.toString("latin1", o, end).toLowerCase().replace(/\\/g, "/");
    const flags = data.readInt32LE(o + 64);
    shaders.push({ name, flags });
  }
  const drawable = (shadernum) => {
    const s = shaders[shadernum];
    if (!s) return true;
    if (s.flags & SURF_NODRAW) return false;
    return !NODRAW_NAMES.some((n) => s.name.includes(n));
  };

  // Vertex positions (Quake coords; transformed at emit time).
  const vtxCount = Math.floor(Lv.len / fmt.vtxStride);
  const vpos = (i) => {
    const o = Lv.off + i * fmt.vtxStride;
    return [data.readFloatLE(o), data.readFloatLE(o + 4), data.readFloatLE(o + 8)];
  };
  // Elements (meshverts): 4-byte indices, offset from a face's firstvert.
  const elemCount = Math.floor(Le.len / 4);
  const elem = (i) => data.readUInt32LE(Le.off + i * 4);

  const positions = []; // flat gl-space xyz
  const indices = [];
  const stats = { planar: 0, trisurf: 0, patch: 0, skipped: 0, dropped: 0 };

  // Emit a gl-space vertex, return its index.
  const emit = (q) => {
    const idx = positions.length / 3;
    push3(positions, q[0], q[1], q[2]);
    return idx;
  };

  const faceCount = Math.floor(Lf.len / fmt.faceStride);
  for (let f = 0; f < faceCount; f++) {
    const o = Lf.off + f * fmt.faceStride;
    const shadernum = data.readInt32LE(o + 0);
    const facetype = data.readInt32LE(o + 8);
    const firstvert = data.readInt32LE(o + 12);
    const numverts = data.readInt32LE(o + 16);
    const firstelem = data.readUInt32LE(o + 20);
    const numelems = data.readInt32LE(o + 24);

    if (!drawable(shadernum)) { stats.dropped++; continue; }

    if (facetype === 1 || facetype === 3) {
      // Planar / trisurf: triangle list via elems into the vertex range.
      const baseVert = positions.length / 3;
      for (let v = 0; v < numverts; v++) emit(vpos(firstvert + v));
      for (let e = 0; e < numelems; e++) indices.push(baseVert + elem(firstelem + e));
      stats[facetype === 1 ? "planar" : "trisurf"]++;
    } else if (facetype === 2) {
      // Bezier patch: numverts control points in a cpW x cpH grid.
      const cpW = data.readInt32LE(o + fmt.patchCpOff);
      const cpH = data.readInt32LE(o + fmt.patchCpOff + 4);
      if (cpW >= 3 && cpH >= 3 && cpW * cpH === numverts) {
        tessellatePatch(cpW, cpH, (i) => vpos(firstvert + i), emit, indices);
        stats.patch++;
      } else {
        stats.skipped++;
      }
    } else {
      stats.skipped++; // flare/foliage/bad — not world geometry
    }
  }

  return { key, magic, version, vtxCount, faceCount, positions, indices, stats };
}

// Q3 biquadratic bezier patch tessellation. The cpW x cpH control grid is a set
// of overlapping 3x3 sub-patches (steps of 2); each is subdivided PATCH_LEVEL
// times in u and v. Emits its own vertices (no cross-patch sharing).
function tessellatePatch(cpW, cpH, cp, emit, indices) {
  const at = (r, c) => cp(r * cpW + c);
  const bez = (t, a, b, c) => {
    const it = 1 - t;
    const w0 = it * it, w1 = 2 * t * it, w2 = t * t;
    return [
      a[0] * w0 + b[0] * w1 + c[0] * w2,
      a[1] * w0 + b[1] * w1 + c[1] * w2,
      a[2] * w0 + b[2] * w1 + c[2] * w2,
    ];
  };
  for (let pr = 0; pr + 2 < cpH; pr += 2) {
    for (let pc = 0; pc + 2 < cpW; pc += 2) {
      const g = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) g.push(at(pr + r, pc + c));
      const L = PATCH_LEVEL;
      const grid = [];
      for (let iu = 0; iu <= L; iu++) {
        const u = iu / L;
        // interpolate the 3 rows in u, giving 3 column control points
        const col0 = bez(u, g[0], g[3], g[6]);
        const col1 = bez(u, g[1], g[4], g[7]);
        const col2 = bez(u, g[2], g[5], g[8]);
        const row = [];
        for (let iv = 0; iv <= L; iv++) row.push(emit(bez(iv / L, col0, col1, col2)));
        grid.push(row);
      }
      for (let iu = 0; iu < L; iu++) {
        for (let iv = 0; iv < L; iv++) {
          const a = grid[iu][iv], b = grid[iu + 1][iv], c = grid[iu][iv + 1], d = grid[iu + 1][iv + 1];
          indices.push(a, b, c, c, b, d);
        }
      }
    }
  }
}

// ---- minimal glb (binary glTF 2.0) writer -----------------------------------
function writeGlb(positions, indices, outPath) {
  const idx = Uint32Array.from(indices);
  const pos = Float32Array.from(positions);
  const idxBytes = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength);
  const posBytes = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) { min.fill(0); max.fill(0); }

  const bin = Buffer.concat([idxBytes, posBytes]);
  const gltf = {
    asset: { version: "2.0", generator: "bsp2gltf" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: idxBytes.length, target: 34963 },
      { buffer: 0, byteOffset: idxBytes.length, byteLength: posBytes.length, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5125, count: idx.length, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max },
    ],
  };

  const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonChunk.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binChunk.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4); // "BIN\0"

  fs.writeFileSync(outPath, Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk]));
  return total;
}

function loadBsp(inputPath) {
  const buf = fs.readFileSync(inputPath);
  if (inputPath.toLowerCase().endsWith(".pk3")) {
    const m = readZipMember(buf, ".bsp");
    if (!m) throw new Error(`no .bsp inside ${inputPath}`);
    return m.data;
  }
  return buf;
}

function convertOne(inputPath, outPath) {
  const data = loadBsp(inputPath);
  const r = parseBsp(data);
  if (r.indices.length === 0) throw new Error("no drawable geometry produced");
  const bytes = writeGlb(r.positions, r.indices, outPath);
  return { ...r, outBytes: bytes, tris: r.indices.length / 3, outVerts: r.positions.length / 3 };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--dir") {
    const dir = argv[1], outDir = argv[2];
    const limIdx = argv.indexOf("--limit");
    const limit = limIdx >= 0 ? parseInt(argv[limIdx + 1], 10) : Infinity;
    if (!dir || !outDir) { console.error("usage: --dir <mapsDir> <outDir> [--limit N]"); process.exit(2); }
    fs.mkdirSync(outDir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pk3"));
    let ok = 0, fail = 0;
    for (const f of files) {
      if (ok >= limit) break;
      const base = f.replace(/\.pk3$/i, "");
      try {
        const r = convertOne(path.join(dir, f), path.join(outDir, base + ".glb"));
        ok++;
        console.log(`OK  ${base}: ${r.key} ${r.tris} tris, ${(r.outBytes / 1024).toFixed(0)}KB (patches:${r.stats.patch})`);
      } catch (e) {
        fail++;
        console.log(`ERR ${base}: ${e.message}`);
      }
    }
    console.log(`\n${ok} converted, ${fail} failed of ${files.length} .pk3`);
    return;
  }

  const [input, out] = argv;
  if (!input || !out) {
    console.error("usage: node bsp2gltf.js <map.pk3|map.bsp> <out.glb>");
    console.error("       node bsp2gltf.js --dir <mapsDir> <outDir> [--limit N]");
    process.exit(2);
  }
  const r = convertOne(input, out);
  console.log(`${path.basename(input)}: ${r.magic} v${r.version}`);
  console.log(`  source: ${r.vtxCount} verts, ${r.faceCount} faces`);
  console.log(`  faces:  planar=${r.stats.planar} trisurf=${r.stats.trisurf} patch=${r.stats.patch} dropped=${r.stats.dropped} skipped=${r.stats.skipped}`);
  console.log(`  output: ${r.outVerts} verts, ${r.tris} tris, ${(r.outBytes / 1024).toFixed(0)}KB -> ${out}`);
}

main();
