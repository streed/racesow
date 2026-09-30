// A map's two rendered assets: the top-down floor plan on its page, and the
// .glb mesh the in-browser replay viewer flies the ghost through.
//
// Both used to appear only for maps that already had traffic — the plan was
// drawn from ghost trajectories and skipped entirely without them, and the
// meshes were a hand-run command — so a freshly published map had neither.
// These cover the paths that changed: a map with NO runs still gets its plan,
// and the mesh conversion is driven per cycle and is safe to re-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateMap, frameBounds, geometryBounds } from "../heatmap.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BSP2GLTF = path.join(HERE, "..", "..", "tools", "bsp2gltf", "bsp2gltf.js");

// A minimal but real IBSP (Q3, v46): one floor triangle, which is enough for
// parseBsp to return geometry. Strides/offsets match bsp.js (vertex 44, face
// 104); the same fixture shape mapindex.test.js uses.
function makeMinimalBsp(scale = 100) {
  const HEADER = 8 + 17 * 8;
  const V_STRIDE = 44, F_STRIDE = 104;
  const nVerts = 3, nElems = 3, nFaces = 1;
  const vOff = HEADER, eOff = vOff + nVerts * V_STRIDE, fOff = eOff + nElems * 4;
  const b = Buffer.alloc(fOff + nFaces * F_STRIDE);
  b.write("IBSP", 0, "latin1");
  b.writeInt32LE(46, 4);
  const setLump = (i, off, len) => { b.writeInt32LE(off, 8 + i * 8); b.writeInt32LE(len, 8 + i * 8 + 4); };
  setLump(10, vOff, nVerts * V_STRIDE);
  setLump(11, eOff, nElems * 4);
  setLump(13, fOff, nFaces * F_STRIDE);
  const verts = [[0, 0, 0], [scale, 0, 0], [0, scale, 0]];
  verts.forEach((v, i) => {
    const o = vOff + i * V_STRIDE;
    b.writeFloatLE(v[0], o); b.writeFloatLE(v[1], o + 4); b.writeFloatLE(v[2], o + 8);
  });
  for (let i = 0; i < 3; i++) b.writeInt32LE(i, eOff + i * 4);
  b.writeInt32LE(1, fOff + 8);
  b.writeInt32LE(0, fOff + 12);
  b.writeInt32LE(3, fOff + 16);
  b.writeInt32LE(0, fOff + 20);
  b.writeInt32LE(3, fOff + 24);
  return b;
}

function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameB = Buffer.from(name, "latin1");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    locals.push(Buffer.concat([lh, nameB, data]));
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameB]));
    offset += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function sandbox(t, { packs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = {
    maps: path.join(root, "maps"),
    out: path.join(root, "out"),
    ghosts: path.join(root, "ghosts"),
    meshes: path.join(root, "meshes"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const { file, map } of packs) {
    fs.writeFileSync(path.join(dirs.maps, file),
                     makeZip([{ name: `maps/${map}.bsp`, data: makeMinimalBsp() }]));
  }
  return dirs;
}

const opts = (d) => ({ ghostDir: d.ghosts, outDir: d.out, mapsDir: d.maps });

test("a map nobody has raced still gets its floor plan", async (t) => {
  const d = sandbox(t, { packs: [{ file: "newmap.pk3", map: "newmap" }] });

  const meta = generateMap(4242, "newmap", opts(d));

  assert.ok(meta, "a map with geometry must render even with no runs");
  assert.equal(meta.mapBase, true, "the plan is drawn from the map's own geometry");
  assert.equal(meta.heat, false, "there is no traffic to draw");
  assert.equal(meta.players, 0);
  assert.equal(meta.points, 0);
  assert.ok(fs.existsSync(path.join(d.out, "4242.png")), "PNG written");
  assert.ok(fs.existsSync(path.join(d.out, "4242.json")), "metadata written");
});

test("the plan is framed from the geometry, not from nothing", async (t) => {
  const d = sandbox(t, { packs: [{ file: "newmap.pk3", map: "newmap" }] });
  const meta = generateMap(4242, "newmap", opts(d));
  // The fixture triangle spans 0..100 in both axes; the frame must cover it
  // (with padding) rather than collapsing to a point.
  assert.ok(meta.bounds.minX < 0 && meta.bounds.maxX > 100, JSON.stringify(meta.bounds));
  assert.ok(meta.bounds.minY < 0 && meta.bounds.maxY > 100, JSON.stringify(meta.bounds));
  assert.equal(meta.width, meta.height, "the canvas stays square");
});

test("a map with neither runs nor geometry renders nothing, and clears a stale image", async (t) => {
  const d = sandbox(t);   // no packs at all
  const png = path.join(d.out, "77.png");
  const json = path.join(d.out, "77.json");
  fs.writeFileSync(png, "stale");
  fs.writeFileSync(json, "stale");

  assert.equal(generateMap(77, "missingmap", opts(d)), null);
  assert.equal(fs.existsSync(png), false, "a stale image must not be left behind");
  assert.equal(fs.existsSync(json), false);
});

test("an unparseable pack degrades to no image rather than throwing", async (t) => {
  const d = sandbox(t);
  fs.writeFileSync(path.join(d.maps, "broken.pk3"),
                   makeZip([{ name: "maps/broken.bsp", data: Buffer.from("IBSP nonsense") }]));
  assert.equal(generateMap(78, "broken", opts(d)), null);
});

test("frameBounds keeps a degenerate extent usable", () => {
  // Every point on one line: the span must not collapse to zero and divide by it.
  const f = frameBounds(10, 10, 10, 10, 1000);
  assert.ok(f.bounds.worldW > 0 && f.bounds.worldH > 0);
  assert.ok(Number.isFinite(f.scale.sx) && Number.isFinite(f.scale.sy));
  assert.ok(f.fit.fw > 0 && f.fit.fh > 0);
});

test("geometryBounds skips a vertex with any non-finite coordinate", () => {
  // Whole vertex, not just the bad axis: a vertex at (100, Infinity) is not
  // at x=100, it is nowhere, and letting its x widen the frame would push the
  // real geometry into a corner of the image.
  const geom = { vx: [0, 50, NaN, 100], vy: [0, 50, 20, Infinity], vz: [0, 0, 0, 0], tris: [], kinds: [] };
  const b = geometryBounds(geom);
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 50, maxY: 50 });
  assert.equal(geometryBounds({ vx: [], vy: [] }), null);
  assert.equal(geometryBounds(null), null);
});

// --- the replay mesh -------------------------------------------------------
// The sidecar shells out to tools/bsp2gltf in --dir mode; these pin the two
// properties that makes it safe to run on a loop.

test("the mesh converter builds a .glb for a pack that has none", async (t) => {
  const d = sandbox(t, { packs: [{ file: "meshme.pk3", map: "meshme" }] });

  const r = spawnSync(process.execPath, [BSP2GLTF, "--dir", d.maps, d.meshes], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);

  const glb = path.join(d.meshes, "meshme.glb");
  assert.ok(fs.existsSync(glb), r.stdout);
  // A real glTF binary: magic "glTF", version 2.
  const buf = fs.readFileSync(glb);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, "glTF magic");
  assert.equal(buf.readUInt32LE(4), 2, "glTF version 2");
});

test("re-running the converter skips meshes that already exist", async (t) => {
  const d = sandbox(t, { packs: [{ file: "meshme.pk3", map: "meshme" }] });
  spawnSync(process.execPath, [BSP2GLTF, "--dir", d.maps, d.meshes], { encoding: "utf8" });
  const first = fs.statSync(path.join(d.meshes, "meshme.glb")).mtimeMs;

  const r = spawnSync(process.execPath, [BSP2GLTF, "--dir", d.maps, d.meshes], { encoding: "utf8" });
  assert.match(r.stdout, /1 already present/, r.stdout);
  assert.equal(fs.statSync(path.join(d.meshes, "meshme.glb")).mtimeMs, first,
               "an existing mesh must not be rewritten");
});

test("the converter names the mesh after the BSP, not the pack", async (t) => {
  // A pack's filename routinely differs from the map inside it, and the viewer
  // asks for <mapname>.glb.
  const d = sandbox(t);
  fs.writeFileSync(path.join(d.maps, "some-pack-v2.pk3"),
                   makeZip([{ name: "maps/realmapname.bsp", data: makeMinimalBsp() }]));

  spawnSync(process.execPath, [BSP2GLTF, "--dir", d.maps, d.meshes], { encoding: "utf8" });
  assert.ok(fs.existsSync(path.join(d.meshes, "realmapname.glb")));
  assert.equal(fs.existsSync(path.join(d.meshes, "some-pack-v2.glb")), false);
});

test("--limit bounds how much one cycle converts", async (t) => {
  const d = sandbox(t, {
    packs: [{ file: "a.pk3", map: "a" }, { file: "b.pk3", map: "b" }, { file: "c.pk3", map: "c" }],
  });

  const r = spawnSync(process.execPath, [BSP2GLTF, "--dir", d.maps, d.meshes, "--limit", "2"],
                      { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const made = fs.readdirSync(d.meshes).filter((f) => f.endsWith(".glb"));
  assert.equal(made.length, 2, `expected 2, got ${made.join(",")}`);
});
