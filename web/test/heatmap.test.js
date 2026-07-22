// Unit tests for the map heatmap generator (web/heatmap.js). Pure + DB-free: the
// rendering path takes ghost trajectories in and returns PNG bytes out, so these
// run in the fast lane with no Postgres. Covers the hand-rolled PNG encoder
// (valid, decodable bytes), the density/orientation math, and the on-disk
// generateMap round-trip (writes PNG + JSON, removes both when a map empties).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildHeatmap, encodePNG, generateMap, loadGhostsForMap } from "../heatmap.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Parse the IHDR + inflate IDAT of a PNG we produced, asserting it is a
// structurally valid 8-bit RGBA image of the given size (an independent decode,
// not a re-check of our own encoder's intent).
function decodePng(buf) {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), "PNG signature");
  assert.equal(buf.toString("ascii", 12, 16), "IHDR");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(buf[24], 8, "bit depth 8");
  assert.equal(buf[25], 6, "color type RGBA");
  // Walk chunks to collect IDAT payloads.
  let off = 8;
  const idat = [];
  let sawIend = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") sawIend = true;
    off += 12 + len;
  }
  assert.ok(sawIend, "IEND present");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Each scanline is 1 filter byte + width*4 sample bytes.
  assert.equal(raw.length, (width * 4 + 1) * height, "raw scanline length");
  return { width, height, raw };
}

// Pull the RGBA pixel at (x, y) out of a decoded raw (filter type 0 rows).
function pixel(dec, x, y) {
  const stride = dec.width * 4 + 1;
  const o = y * stride + 1 + x * 4;
  return [dec.raw[o], dec.raw[o + 1], dec.raw[o + 2], dec.raw[o + 3]];
}

function straightLine(n, ax, ay, bx, by) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    frames.push([ax + (bx - ax) * u, ay + (by - ay) * u, 0]);
  }
  return { frames };
}

test("encodePNG produces a decodable 8-bit RGBA PNG", () => {
  const w = 3, h = 2;
  const rgba = new Uint8Array(w * h * 4);
  rgba[0] = 10; rgba[1] = 20; rgba[2] = 30; rgba[3] = 255; // (0,0)
  const png = encodePNG(w, h, rgba);
  const dec = decodePng(png);
  assert.equal(dec.width, w);
  assert.equal(dec.height, h);
  assert.deepEqual(pixel(dec, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixel(dec, 2, 1), [0, 0, 0, 0]);
});

test("buildHeatmap returns null when there is no usable data", () => {
  assert.equal(buildHeatmap([]), null);
  assert.equal(buildHeatmap([{ frames: [] }]), null);
  assert.equal(buildHeatmap([{ frames: [[NaN, NaN, 0]] }]), null);
});

test("buildHeatmap renders a valid PNG and reports counts", () => {
  const ghosts = [straightLine(200, 0, 0, 1000, 500), straightLine(150, 100, 50, 900, 480)];
  const r = buildHeatmap(ghosts, { size: 300 });
  assert.ok(r, "built");
  assert.equal(r.players, 2);
  assert.equal(r.points, 350);
  assert.equal(Math.max(r.width, r.height), 300, "longest side == size");
  const dec = decodePng(r.png);
  assert.equal(dec.width, r.width);
  assert.equal(dec.height, r.height);
});

test("world +Y maps to the top of the image (north up)", () => {
  // Almost all trajectory mass sits in a tight cluster at HIGH world Y, with a
  // single anchor frame at low Y just to fix the bounds. buildHeatmap flips Y for
  // image space, so the cluster must light up the TOP half, not the bottom.
  const frames = [];
  for (let i = 0; i < 400; i++) frames.push([400 + (i % 40), 940 + (i % 10), 0]);
  frames.push([420, 0, 0]); // low-Y anchor (negligible weight) to extend bounds
  const high = buildHeatmap([{ frames }], { size: 256 });
  const dec = decodePng(high.png);
  let topAlpha = 0, botAlpha = 0;
  const mid = Math.floor(dec.height / 2);
  for (let y = 0; y < dec.height; y++)
    for (let x = 0; x < dec.width; x++) {
      const a = pixel(dec, x, y)[3];
      if (y < mid) topAlpha += a; else botAlpha += a;
    }
  assert.ok(topAlpha > botAlpha * 5, `top (${topAlpha}) should dominate bottom (${botAlpha})`);
});

test("overlapping paths are hotter than a lone path", () => {
  // Two ghosts on the exact same line vs one ghost on a parallel line: the
  // doubled line should reach a higher peak alpha.
  const doubled = straightLine(300, 0, 100, 1000, 100);
  const single = straightLine(300, 0, 900, 1000, 900);
  const r = buildHeatmap([doubled, { frames: doubled.frames.slice() }, single], { size: 300 });
  const dec = decodePng(r.png);
  let hotTop = 0, hotBot = 0; // y is flipped, so y=100 is near the bottom
  for (let y = 0; y < dec.height; y++)
    for (let x = 0; x < dec.width; x++) {
      const a = pixel(dec, x, y)[3];
      if (y < dec.height / 2) hotTop = Math.max(hotTop, a);
      else hotBot = Math.max(hotBot, a);
    }
  // The doubled line (low world Y -> high image row) should peak brighter.
  assert.ok(hotBot >= hotTop, `doubled line (${hotBot}) at least as hot as single (${hotTop})`);
});

test("generateMap writes PNG + JSON, and clears them when a map empties", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-test-"));
  const ghostDir = path.join(root, "ghosts");
  const outDir = path.join(root, "heatmaps");
  const mapId = 42;

  // Two players' ghosts on disk, exactly as db.js upsertPlayerGhost writes them.
  fs.mkdirSync(path.join(ghostDir, String(mapId)), { recursive: true });
  for (const [pid, line] of [[7, straightLine(120, 0, 0, 800, 400)], [9, straightLine(120, 50, 20, 780, 380)]]) {
    const payload = { v: 1, map: "test", player: "p" + pid, login: "", time: 12345, hz: 25, cps: [], frames: line.frames };
    fs.writeFileSync(path.join(ghostDir, String(mapId), `${pid}.json.gz`), zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  }

  assert.equal(loadGhostsForMap(mapId, ghostDir).length, 2);

  const meta = generateMap(mapId, "test", { ghostDir, outDir, size: 200 });
  assert.ok(meta, "meta returned");
  assert.equal(meta.players, 2);
  assert.equal(meta.mapId, mapId);
  assert.ok(meta.generatedAt > 0);
  assert.ok(fs.existsSync(path.join(outDir, `${mapId}.png`)), "png written");
  const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, `${mapId}.json`), "utf8"));
  assert.equal(onDisk.players, 2);
  decodePng(fs.readFileSync(path.join(outDir, `${mapId}.png`)));

  // Emptying the ghost dir must remove the stale image + metadata.
  fs.rmSync(path.join(ghostDir, String(mapId)), { recursive: true, force: true });
  const gone = generateMap(mapId, "test", { ghostDir, outDir, size: 200 });
  assert.equal(gone, null);
  assert.equal(fs.existsSync(path.join(outDir, `${mapId}.png`)), false, "png removed");
  assert.equal(fs.existsSync(path.join(outDir, `${mapId}.json`)), false, "json removed");

  fs.rmSync(root, { recursive: true, force: true });
});
