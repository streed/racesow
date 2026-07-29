// Unit tests for the map-name -> pk3 lookup table (web/mapindex.js) and the
// loadMapGeometry pack resolution it feeds (web/bsp.js). The whole point of the
// table is the pool's recurring mismatch — a map's .bsp lives in a pack whose
// FILENAME is not the map name (e.g. bug70_slick-wjfix.bsp inside bug70-wjfix.pk3)
// — so every fixture here is built with that mismatch and asserts we still find,
// index, and parse the geometry. Hermetic: builds its own zips + a minimal BSP,
// no pool on disk, no Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { listBspNames, buildMapIndex, getMapIndex, rebuildMapIndex, poolSignature, clearMapIndexCache } from "../mapindex.js";
import { loadMapGeometry } from "../bsp.js";
import { generateMap } from "../heatmap.js";

// --- fixtures ---------------------------------------------------------------

// A minimal but real IBSP (Q3, v46): 3 verts forming one floor triangle, 3 elems,
// 1 planar face. Enough that parseBsp returns geometry (1 tri) — so a base render
// counts as present. Strides/offsets match bsp.js parseBsp (vertex 44, face 104).
function makeMinimalBsp() {
  const HEADER = 8 + 17 * 8; // magic+version + 17 lump dir entries
  const V_STRIDE = 44, F_STRIDE = 104;
  const nVerts = 3, nElems = 3, nFaces = 1;
  const vOff = HEADER, eOff = vOff + nVerts * V_STRIDE, fOff = eOff + nElems * 4;
  const b = Buffer.alloc(fOff + nFaces * F_STRIDE);
  b.write("IBSP", 0, "latin1");
  b.writeInt32LE(46, 4);
  const setLump = (i, off, len) => { b.writeInt32LE(off, 8 + i * 8); b.writeInt32LE(len, 8 + i * 8 + 4); };
  setLump(10, vOff, nVerts * V_STRIDE); // L_VERTS
  setLump(11, eOff, nElems * 4);        // L_ELEMS
  setLump(13, fOff, nFaces * F_STRIDE); // L_FACES
  const verts = [[0, 0, 0], [100, 0, 0], [0, 100, 0]]; // flat -> up=1 -> floor
  verts.forEach((v, i) => { const o = vOff + i * V_STRIDE; b.writeFloatLE(v[0], o); b.writeFloatLE(v[1], o + 4); b.writeFloatLE(v[2], o + 8); });
  for (let i = 0; i < 3; i++) b.writeInt32LE(i, eOff + i * 4);
  b.writeInt32LE(1, fOff + 8);  // type = 1 (planar)
  b.writeInt32LE(0, fOff + 12); // firstVert
  b.writeInt32LE(3, fOff + 16); // numVerts
  b.writeInt32LE(0, fOff + 20); // firstElem
  b.writeInt32LE(3, fOff + 24); // numElems
  return b;
}

// Build a store-method (uncompressed) zip from [{ name, data }]. Byte layout
// matches what bsp.js extractBsp + mapindex.js listBspNames read. An optional
// `comment` (up to 65535 bytes) pushes the central directory >64KB before EOF,
// forcing listBspNames onto its separate-read (else) branch.
function makeZip(entries, comment = Buffer.alloc(0)) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameB = Buffer.from(name, "latin1");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // method 0 (store)
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const local = Buffer.concat([lh, nameB, data]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); // method 0
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameB]));
    locals.push(local);
    offset += local.length;
  }
  const localsBuf = Buffer.concat(locals);
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localsBuf.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localsBuf, cdBuf, eocd, comment]);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mapindex-"));
}

// --- listBspNames -----------------------------------------------------------

test("listBspNames reads bsp basenames from the central directory, lowercased", () => {
  const dir = tmpDir();
  const pk3 = path.join(dir, "some-pack.pk3");
  fs.writeFileSync(pk3, makeZip([
    { name: "maps/Bug70_Slick-WJfix.bsp", data: Buffer.from("x") },
    { name: "scripts/whatever.shader", data: Buffer.from("y") },
    { name: "maps/second.bsp", data: Buffer.from("z") },
  ]));
  assert.deepEqual(listBspNames(pk3).sort(), ["bug70_slick-wjfix", "second"]);
});

test("listBspNames ignores a corrupt (under-reported) cdSize on its separate-read branch", () => {
  const dir = tmpDir();
  const pk3 = path.join(dir, "big-comment.pk3");
  // A 65535-byte comment pushes the central directory >64KB before EOF, forcing
  // listBspNames onto the else-branch that reads the CD separately.
  const zip = makeZip([
    { name: "maps/alpha.bsp", data: Buffer.from("a") },
    { name: "maps/beta.bsp", data: Buffer.from("b") },
    { name: "maps/gamma.bsp", data: Buffer.from("c") },
  ], Buffer.alloc(65535, 0x20));
  // Corrupt the EOCD's cdSize field (12 bytes before the 22-byte EOCD + comment)
  // down to a value covering only the first entry — the old code trusted this and
  // dropped beta+gamma; the fix bounds the read by the file span instead.
  const eocdOff = zip.length - 22 - 65535;
  zip.writeUInt32LE(20, eocdOff + 12); // absurdly small cdSize
  fs.writeFileSync(pk3, zip);
  assert.deepEqual(listBspNames(pk3).sort(), ["alpha", "beta", "gamma"]);
});

test("listBspNames returns [] for a non-zip / missing file (never throws)", () => {
  const dir = tmpDir();
  const junk = path.join(dir, "not-a-zip.pk3");
  fs.writeFileSync(junk, Buffer.from("this is not a zip archive at all"));
  assert.deepEqual(listBspNames(junk), []);
  assert.deepEqual(listBspNames(path.join(dir, "does-not-exist.pk3")), []);
});

// --- buildMapIndex ----------------------------------------------------------

test("buildMapIndex maps the map name to the pack whose FILENAME differs from it", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bug70-wjfix.pk3"),
    makeZip([{ name: "maps/bug70_slick-wjfix.bsp", data: makeMinimalBsp() }]));
  const index = buildMapIndex(dir);
  assert.deepEqual(index.get("bug70_slick-wjfix"), ["bug70-wjfix.pk3"]);
});

test("buildMapIndex orders duplicate packs last-sorted-first (VFS precedence)", () => {
  const dir = tmpDir();
  for (const f of ["arena_a.pk3", "arena_b.pk3", "arena_c.pk3"]) {
    fs.writeFileSync(path.join(dir, f), makeZip([{ name: "maps/arena.bsp", data: makeMinimalBsp() }]));
  }
  const index = buildMapIndex(dir);
  assert.deepEqual(index.get("arena"), ["arena_c.pk3", "arena_b.pk3", "arena_a.pk3"]);
});

// --- loadMapGeometry: the bug and the fix -----------------------------------

test("loadMapGeometry misses a mismatched pack WITHOUT the index, finds it WITH", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bug70-wjfix.pk3"),
    makeZip([{ name: "maps/bug70_slick-wjfix.bsp", data: makeMinimalBsp() }]));

  // Old behaviour: derive `${name}.pk3`, which does not exist -> no base.
  assert.equal(loadMapGeometry(dir, "bug70_slick-wjfix"), null);

  // With the resolver the real pack is found and its geometry parses.
  const index = buildMapIndex(dir);
  const geom = loadMapGeometry(dir, "bug70_slick-wjfix", (n) => index.get(n));
  assert.ok(geom && geom.tris.length >= 1, "geometry parsed from the mismatched pack");
});

test("loadMapGeometry strips -reversed and resolves the base map's pack", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "weird-name.pk3"),
    makeZip([{ name: "maps/coolmap.bsp", data: makeMinimalBsp() }]));
  const index = buildMapIndex(dir);
  const geom = loadMapGeometry(dir, "coolmap-reversed", (n) => index.get(n));
  assert.ok(geom && geom.tris.length >= 1);
});

test("loadMapGeometry falls through a corrupt pack to a good one", () => {
  const dir = tmpDir();
  // Two packs carry maps/dup.bsp: the last-sorted (tried first) is corrupt.
  fs.writeFileSync(path.join(dir, "pack_a_good.pk3"),
    makeZip([{ name: "maps/dup.bsp", data: makeMinimalBsp() }]));
  fs.writeFileSync(path.join(dir, "pack_z_bad.pk3"),
    makeZip([{ name: "maps/dup.bsp", data: Buffer.from("IBSP not really a bsp") }]));
  const index = buildMapIndex(dir);
  assert.deepEqual(index.get("dup"), ["pack_z_bad.pk3", "pack_a_good.pk3"]);
  const geom = loadMapGeometry(dir, "dup", (n) => index.get(n));
  assert.ok(geom && geom.tris.length >= 1, "fell through the corrupt pack to the good one");
});

// --- getMapIndex: persistence + caching -------------------------------------

test("getMapIndex persists mapindex.json and reuses it while the pool is unchanged", () => {
  clearMapIndexCache();
  const dir = tmpDir();
  const cacheDir = tmpDir();
  fs.writeFileSync(path.join(dir, "bug70-wjfix.pk3"),
    makeZip([{ name: "maps/bug70_slick-wjfix.bsp", data: makeMinimalBsp() }]));

  const index = getMapIndex(dir, cacheDir);
  assert.deepEqual(index.get("bug70_slick-wjfix"), ["bug70-wjfix.pk3"]);

  const table = JSON.parse(fs.readFileSync(path.join(cacheDir, "mapindex.json"), "utf8"));
  assert.equal(table.signature, poolSignature(dir));
  assert.deepEqual(table.maps["bug70_slick-wjfix"], ["bug70-wjfix.pk3"]);
  assert.equal(table.count, 1);

  // A cached second call returns the same object (no rebuild).
  assert.equal(getMapIndex(dir, cacheDir), index);
});

test("poolSignature changes on an in-place same-filename pk3 rewrite (getMapIndex rebuilds)", () => {
  clearMapIndexCache();
  const dir = tmpDir();
  const cacheDir = tmpDir();
  const pk3 = path.join(dir, "pack.pk3"); // one stable filename, swapped in place
  fs.writeFileSync(pk3, makeZip([{ name: "maps/alpha.bsp", data: makeMinimalBsp() }]));
  const sig1 = poolSignature(dir);
  assert.deepEqual(getMapIndex(dir, cacheDir).get("alpha"), ["pack.pk3"]);

  // Overwrite the SAME filename with different content — this does not bump the
  // directory mtime, so a count+dir-mtime signature would miss it.
  fs.writeFileSync(pk3, makeZip([{ name: "maps/beta.bsp", data: makeMinimalBsp() }]));
  assert.notEqual(poolSignature(dir), sig1, "signature reflects the content swap");
  const index2 = getMapIndex(dir, cacheDir);
  assert.equal(index2.get("alpha"), undefined, "stale mapping gone");
  assert.deepEqual(index2.get("beta"), ["pack.pk3"], "rebuilt to the new content");
});

test("rebuildMapIndex force-rewrites a stale mapindex.json even when its signature matches", () => {
  clearMapIndexCache();
  const dir = tmpDir();
  const cacheDir = tmpDir();
  fs.writeFileSync(path.join(dir, "arena.pk3"), makeZip([{ name: "maps/arena.bsp", data: makeMinimalBsp() }]));

  // Hand-poison the persisted table with a WRONG mapping but the CURRENT signature,
  // the exact state getMapIndex would blindly trust.
  const cachePath = path.join(cacheDir, "mapindex.json");
  fs.writeFileSync(cachePath, JSON.stringify({ signature: poolSignature(dir), maps: { arena: ["WRONG.pk3"] } }));
  assert.deepEqual(getMapIndex(dir, cacheDir).get("arena"), ["WRONG.pk3"], "getMapIndex trusts the matching-signature file");

  // The escape hatch must overwrite it regardless of the matching signature.
  clearMapIndexCache();
  const rebuilt = rebuildMapIndex(dir, cacheDir);
  assert.deepEqual(rebuilt.get("arena"), ["arena.pk3"]);
  const onDisk = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.deepEqual(onDisk.maps.arena, ["arena.pk3"], "stale file was rewritten");
});

// --- end to end: generateMap flips mapBase true via the index ---------------

test("generateMap renders a base for a map whose pack filename differs (mapBase=true)", () => {
  clearMapIndexCache();
  const root = tmpDir();
  const ghostDir = path.join(root, "ghosts");
  const outDir = path.join(root, "heatmaps");
  const mapsDir = path.join(root, "maps");
  fs.mkdirSync(path.join(ghostDir, "993"), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(mapsDir, { recursive: true });

  // Pack filename != map name — the mismatch the old code missed.
  fs.writeFileSync(path.join(mapsDir, "bug70-wjfix.pk3"),
    makeZip([{ name: "maps/bug70_slick-wjfix.bsp", data: makeMinimalBsp() }]));

  // A ghost whose XY footprint overlaps the bsp so both share sane bounds.
  const ghost = { time: 1234, frames: [[0, 0, 0], [50, 50, 8], [100, 100, 0]] };
  fs.writeFileSync(path.join(ghostDir, "993", "7.json.gz"), zlib.gzipSync(Buffer.from(JSON.stringify(ghost))));

  const meta = generateMap(993, "bug70_slick-wjfix", { ghostDir, outDir, mapsDir, size: 256 });
  assert.ok(meta, "heatmap generated");
  assert.equal(meta.mapBase, true, "map outline rendered from the correctly-resolved pack");
  assert.ok(fs.existsSync(path.join(outDir, "993.png")), "png written");
  // And the persisted lookup table landed alongside the images.
  assert.ok(fs.existsSync(path.join(outDir, "mapindex.json")), "mapindex.json written next to images");
});
