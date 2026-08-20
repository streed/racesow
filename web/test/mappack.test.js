// Tests for the streamed full map pack (web/mappack.js).
//
// The archive is generated on the fly from a directory of .pk3 files, so the
// things that can break it are: a wrong byte count somewhere in the layout (the
// Content-Length would lie and every download would truncate), a bad Range walk
// (resumes would stitch the wrong bytes together), and the ZIP64 records that
// only kick in past 4 GB — which no small fixture reaches, so that branch is
// checked by reading the emitted records directly.
//
// The end-to-end case writes a real archive and hands it to `unzip`, i.e. an
// independent implementation, rather than trusting our own parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { mkdtemp, rm, writeFile, readFile, mkdir, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  buildLayout,
  readRange,
  crc32File,
  dosStamp,
  createMapPack,
  pk3MapNames,
  basePackMapName,
  README_NAME,
} from "../mappack.js";

const haveUnzip = (() => {
  try {
    execFileSync("sh", ["-c", "command -v unzip"]);
    return true;
  } catch {
    return false;
  }
})();

const QUIET = { log() {}, warn() {}, error() {} };

async function fixtureDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mappack-"));
  const packs = {
    // Deliberately out of alphabetical order on disk. `4and#2.pk3` and
    // `17++.pk3` are real pack names from the mirror: punctuation must ride
    // along, since those maps are as playable as any other.
    "zzz-last.pk3": crypto.randomBytes(4096),
    "aaa_first.pk3": crypto.randomBytes(65_536),
    "base_tex.pk3": crypto.randomBytes(1024),
    "4and#2.pk3": crypto.randomBytes(2048),
    "with space.pk3": crypto.randomBytes(512),
  };
  for (const [name, body] of Object.entries(packs)) {
    await writeFile(path.join(dir, name), body);
    // Fixed mtime: the layout (and therefore the ETag) must be reproducible.
    await utimes(path.join(dir, name), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  }
  // Things that must NOT end up in the archive: not a pack, names an extractor
  // could not write on Windows, names that would extract as hidden/option-like
  // files, and a directory that happens to end in .pk3.
  await writeFile(path.join(dir, "notes.txt"), "ignore me");
  await writeFile(path.join(dir, "bad?name.pk3"), "ignore me");
  await writeFile(path.join(dir, ".hidden.pk3"), "ignore me");
  await writeFile(path.join(dir, "-dashed.pk3"), "ignore me");
  await mkdir(path.join(dir, "subdir.pk3"));
  return { dir, packs };
}

async function collect(layout, start = 0, end = layout.size - 1) {
  const chunks = [];
  for await (const c of readRange(layout, start, end)) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

async function indexed(dir, extra = {}) {
  const pack = createMapPack({
    dir,
    indexPath: path.join(dir, "index.json"),
    log: QUIET,
    ...extra,
  });
  await pack.refresh();
  return pack;
}

test("indexes only well-named .pk3 files, sorted, with a README", async (t) => {
  const { dir, packs } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pack = await indexed(dir);
  const s = pack.status();
  assert.equal(s.ready, true);
  assert.equal(s.packs, 5, "notes.txt, the unwritable/hidden names and the directory are excluded");
  assert.equal(s.files, 6, "the generated README rides along as one more entry");
  assert.equal(
    s.pack_bytes,
    Object.values(packs).reduce((n, b) => n + b.length, 0)
  );

  const names = pack.layout.entries.map((e) => e.name);
  assert.deepEqual(names, [
    "4and#2.pk3",
    "README.txt",
    "aaa_first.pk3",
    "base_tex.pk3",
    "with space.pk3",
    "zzz-last.pk3",
  ]);
});

test("the archive is a valid zip whose entries are byte-identical to the packs", async (t) => {
  if (!haveUnzip) return t.skip("unzip not on PATH");
  const { dir, packs } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pack = await indexed(dir);
  const bytes = await collect(pack.layout);
  assert.equal(bytes.length, pack.layout.size, "Content-Length would have lied");

  const zipPath = path.join(dir, "out.zip");
  await writeFile(zipPath, bytes);
  // -t verifies every entry's CRC against its stored bytes.
  const report = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  assert.match(report, /No errors detected in compressed data/);

  for (const [name, body] of Object.entries(packs)) {
    const got = execFileSync("unzip", ["-p", zipPath, name], { maxBuffer: 1 << 24 });
    assert.equal(Buffer.compare(got, body), 0, `${name} round-tripped unchanged`);
  }
  const readme = execFileSync("unzip", ["-p", zipPath, README_NAME], { encoding: "utf8" });
  assert.match(readme, /Racesow map pack/);
  assert.match(readme, /5 map packs/);

  // Stored, not deflated: re-compressing an already-compressed pk3 is pure
  // CPU cost, and the whole streaming design depends on method 0.
  const listing = execFileSync("unzip", ["-v", zipPath], { encoding: "utf8" });
  assert.equal(/Defl/.test(listing), false, listing);
});

test("layout offsets and CRCs match a byte-level read of the archive", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pack = await indexed(dir);
  const bytes = await collect(pack.layout);
  for (const e of pack.layout.entries) {
    // Find this entry's local header and check the payload that follows it is
    // the file itself (this is what a Range resume relies on being true).
    const seg = pack.layout.segments.find((s) => s.name === e.name);
    if (!seg) continue; // the README carries its bytes inline
    const body = bytes.subarray(seg.off, seg.off + seg.len);
    assert.equal(body.length, e.size);
    assert.equal(zlib.crc32(body) >>> 0, e.crc, `${e.name} CRC`);
    assert.equal(Buffer.compare(body, await readFile(path.join(dir, e.name))), 0);
  }
});

test("range reads return exactly the bytes the full archive has there", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pack = await indexed(dir);
  const full = await collect(pack.layout);
  const size = pack.layout.size;
  const cases = [
    [0, 0],
    [0, 41],
    [17, 5000],
    [size - 1, size - 1],
    [size - 300, size - 1], // the central directory + end records
    [Math.floor(size / 2), size - 1],
  ];
  for (const [start, end] of cases) {
    const slice = await collect(pack.layout, start, end);
    assert.equal(slice.length, end - start + 1, `length of ${start}-${end}`);
    assert.equal(Buffer.compare(slice, full.subarray(start, end + 1)), 0, `bytes of ${start}-${end}`);
  }
});

test("a changed pack is re-hashed and the ETag moves; an unchanged one is not", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const pack = await indexed(dir);
  const before = pack.layout.etag;
  await pack.refresh();
  assert.equal(pack.layout.etag, before, "a no-op refresh must not move the validator");

  await writeFile(path.join(dir, "aaa_first.pk3"), crypto.randomBytes(2048));
  await pack.refresh();
  assert.notEqual(pack.layout.etag, before);
  assert.equal(pack.layout.entries.find((e) => e.name === "aaa_first.pk3").size, 2048);

  // The index is persisted, so a fresh instance serves without re-hashing.
  const reopened = createMapPack({ dir, indexPath: path.join(dir, "index.json"), log: QUIET });
  await reopened.refresh();
  assert.equal(reopened.layout.etag, pack.layout.etag);
});

test("ZIP64 records appear once the archive passes 4 GiB", () => {
  // A synthetic index: three 3 GB packs. The second entry still fits a 32-bit
  // offset, the third does not — so one archive exercises both branches. No
  // I/O; only the emitted records are inspected.
  const big = 3_000_000_000;
  const entries = ["a.pk3", "b.pk3", "c.pk3"].map((name) => ({
    name,
    size: big,
    crc: 0x12345678,
    mtimeMs: 1_700_000_000_000,
  }));
  const layout = buildLayout(entries, { dir: "/nope" });
  assert.equal(layout.size, 3 * (30 + 5 + big) + tailSize(layout));

  const tail = layout.segments[layout.segments.length - 1].buf;
  // Central directory: the third entry's 32-bit offset slot is sentinel-ed and
  // the real offset rides in a zip64 extra field.
  const secondLocal = 30 + 5 + big;
  const thirdLocal = 2 * (30 + 5 + big);
  assert.ok(secondLocal < 0xffffffff && thirdLocal > 0xffffffff, "one entry each side of the ceiling");
  const cdSize = tail.length - 22 - 56 - 20;
  const cd = tail.subarray(0, cdSize);
  const offsets = [];
  let p = 0;
  while (p < cd.length) {
    assert.equal(cd.readUInt32LE(p), 0x02014b50);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const raw = cd.readUInt32LE(p + 42);
    if (raw === 0xffffffff) {
      assert.equal(extraLen, 12, "zip64 extra field present");
      assert.equal(cd.readUInt16LE(p + 46 + nameLen), 0x0001);
      offsets.push(Number(cd.readBigUInt64LE(p + 46 + nameLen + 4)));
    } else {
      assert.equal(extraLen, 0);
      offsets.push(raw);
    }
    p += 46 + nameLen + extraLen;
  }
  assert.deepEqual(offsets, [0, secondLocal, thirdLocal]);

  // Zip64 EOCD + locator + EOCD, in that order, with the classic record's
  // overflowed fields sentinel-ed.
  const z64 = tail.subarray(cdSize, cdSize + 56);
  assert.equal(z64.readUInt32LE(0), 0x06064b50);
  assert.equal(Number(z64.readBigUInt64LE(32)), 3, "total entries");
  assert.equal(Number(z64.readBigUInt64LE(40)), cdSize, "central directory size");
  assert.equal(Number(z64.readBigUInt64LE(48)), 3 * (30 + 5 + big), "central directory offset");
  const loc = tail.subarray(cdSize + 56, cdSize + 76);
  assert.equal(loc.readUInt32LE(0), 0x07064b50);
  assert.equal(Number(loc.readBigUInt64LE(8)), 3 * (30 + 5 + big) + cdSize);
  const eocd = tail.subarray(cdSize + 76);
  assert.equal(eocd.readUInt32LE(0), 0x06054b50);
  assert.equal(eocd.readUInt16LE(10), 3);
  assert.equal(eocd.readUInt32LE(16), 0xffffffff, "central directory offset is sentinel-ed");

  function tailSize(l) {
    return l.segments[l.segments.length - 1].len;
  }
});

test("small archives stay on the plain 2.0 end record", () => {
  const layout = buildLayout([{ name: "a.pk3", size: 10, crc: 1, mtimeMs: 1_700_000_000_000 }], {
    dir: "/nope",
  });
  const tail = layout.segments[layout.segments.length - 1].buf;
  assert.equal(tail.readUInt32LE(tail.length - 22), 0x06054b50);
  assert.equal(tail.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), false, "no zip64 EOCD");
});

test("DOS timestamps are read in UTC so both web replicas emit the same bytes", () => {
  // 2023-11-14T22:13:20Z — TZ-dependent code would land on a different day in
  // half the world, and the two replicas would then disagree byte-for-byte.
  const { time, date } = dosStamp(1_700_000_000_000);
  assert.equal((date >> 9) + 1980, 2023);
  assert.equal((date >> 5) & 0xf, 11);
  assert.equal(date & 0x1f, 14);
  assert.equal(time >> 11, 22);
  assert.equal((time >> 5) & 0x3f, 13);
  // Pre-1980 clamps instead of wrapping into a nonsense date.
  assert.deepEqual(dosStamp(0), { time: 0, date: (1 << 5) | 1 });
});

test("crc32File matches hashing the whole buffer at once", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "aaa_first.pk3");
  assert.equal(await crc32File(file), zlib.crc32(await readFile(file)) >>> 0);
});

/* ------------------------------ HTTP surface ----------------------------- */

// Minimal Express-shaped response recorder: enough of the surface the handler
// touches (set/status/end/json + the writable stream side) to assert on
// headers and body without standing up a server.
function fakeRes() {
  const chunks = [];
  const res = {
    headers: {},
    statusCode: 200,
    finished: false,
    set(k, v) {
      res.headers[k.toLowerCase()] = String(v);
      return res;
    },
    removeHeader(k) {
      delete res.headers[k.toLowerCase()];
    },
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(o) {
      res.body = o;
      res.finished = true;
      return res;
    },
    write(c, _enc, cb) {
      chunks.push(Buffer.from(c));
      cb?.();
      return true;
    },
    end(c, _enc, cb) {
      if (c) chunks.push(Buffer.from(c));
      res.finished = true;
      cb?.();
      res.emit?.("finish");
      return res;
    },
    destroy() {
      res.destroyed = true;
    },
    on() {},
    once() {},
    emit() {},
    removeListener() {},
    get bytes() {
      return Buffer.concat(chunks);
    },
  };
  return res;
}

// stream.pipeline needs a real writable, so wrap the recorder in one.
async function request(pack, { method = "GET", headers = {} } = {}) {
  const { Writable } = await import("node:stream");
  const chunks = [];
  const res = fakeRes();
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  // Give the recorder the writable's behaviour for the streaming path.
  for (const k of ["write", "end", "on", "once", "emit", "removeListener", "destroy"]) {
    res[k] = sink[k].bind(sink);
  }
  await pack.handle({ method, headers }, res);
  await new Promise((r) => setImmediate(r));
  return { res, body: Buffer.concat(chunks) };
}

test("serves the whole archive with a real Content-Length and an ETag", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pack = await indexed(dir);

  const { res, body } = await request(pack);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["accept-ranges"], "bytes");
  assert.equal(res.headers["content-type"], "application/zip");
  assert.match(res.headers["content-disposition"], /filename="racesow-maps\.zip"/);
  assert.equal(res.headers["content-length"], String(pack.layout.size));
  assert.equal(res.headers.etag, pack.layout.etag);
  assert.equal(body.length, pack.layout.size);
  assert.equal(Buffer.compare(body, await collect(pack.layout)), 0);
});

test("HEAD answers with the headers and no body", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pack = await indexed(dir);
  const { res, body } = await request(pack, { method: "HEAD" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-length"], String(pack.layout.size));
  assert.equal(body.length, 0);
});

test("resumes: 206 + Content-Range, suffix ranges, 416, If-Range, If-None-Match", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pack = await indexed(dir);
  const size = pack.layout.size;
  const full = await collect(pack.layout);

  const mid = await request(pack, { headers: { range: `bytes=1000-1999` } });
  assert.equal(mid.res.statusCode, 206);
  assert.equal(mid.res.headers["content-range"], `bytes 1000-1999/${size}`);
  assert.equal(mid.res.headers["content-length"], "1000");
  assert.equal(Buffer.compare(mid.body, full.subarray(1000, 2000)), 0);

  // Open-ended range: the shape `curl -C -` sends.
  const tail = await request(pack, { headers: { range: `bytes=${size - 10}-` } });
  assert.equal(tail.res.statusCode, 206);
  assert.equal(Buffer.compare(tail.body, full.subarray(size - 10)), 0);

  // Suffix range: how a zip reader grabs the end record.
  const suffix = await request(pack, { headers: { range: "bytes=-22" } });
  assert.equal(suffix.res.statusCode, 206);
  assert.equal(suffix.res.headers["content-range"], `bytes ${size - 22}-${size - 1}/${size}`);
  assert.equal(Buffer.compare(suffix.body, full.subarray(size - 22)), 0);

  const past = await request(pack, { headers: { range: `bytes=${size}-` } });
  assert.equal(past.res.statusCode, 416);
  assert.equal(past.res.headers["content-range"], `bytes */${size}`);

  const junk = await request(pack, { headers: { range: "bytes=abc" } });
  assert.equal(junk.res.statusCode, 416);

  // A resume against a DIFFERENT archive falls back to a full transfer rather
  // than stitching two layouts together.
  const stale = await request(pack, {
    headers: { range: "bytes=1000-1999", "if-range": '"nope"' },
  });
  assert.equal(stale.res.statusCode, 200);
  assert.equal(stale.body.length, size);

  const fresh = await request(pack, {
    headers: { range: "bytes=1000-1999", "if-range": pack.layout.etag },
  });
  assert.equal(fresh.res.statusCode, 206);

  const cached = await request(pack, { headers: { "if-none-match": pack.layout.etag } });
  assert.equal(cached.res.statusCode, 304);
});

test("refuses politely while the index is still being built", async () => {
  const pack = createMapPack({ dir: "/nonexistent-mappack-dir", indexPath: "/nonexistent/i.json", log: QUIET });
  const { res } = await request(pack);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "300");
  assert.equal(pack.status().ready, false);
});

test("caps concurrent streams instead of letting the uplink be drowned", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pack = await indexed(dir, { maxStreams: 1 });

  // Hold one stream open by never draining it, then ask for a second.
  const { Writable } = await import("node:stream");
  const held = new Writable({ highWaterMark: 1, write() { /* never calls back */ } });
  for (const k of ["set", "status", "removeHeader"]) held[k] = fakeRes()[k];
  const heldRes = fakeRes();
  for (const k of ["write", "end", "on", "once", "emit", "removeListener", "destroy"]) {
    heldRes[k] = held[k].bind(held);
  }
  const first = pack.handle({ method: "GET", headers: {} }, heldRes);
  await new Promise((r) => setImmediate(r));

  const { res } = await request(pack);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers["retry-after"], "120");
  assert.equal(res.headers["content-length"], undefined, "the refusal must not claim a body length");

  held.destroy();
  await first.catch(() => {});
});

/* --------------------------- map name -> pack ---------------------------- */

// A .pk3 IS a zip, so the module's own writer builds the fixtures: entries with
// inline bytes, stored, exactly like a real pack.
async function makePk3(file, names) {
  const entries = names.map((name) => {
    const data = Buffer.from(`payload of ${name}`);
    return { name, size: data.length, crc: zlib.crc32(data) >>> 0, mtimeMs: 1_700_000_000_000, data };
  });
  const layout = buildLayout(entries);
  const chunks = [];
  for await (const c of readRange(layout, 0, layout.size - 1)) chunks.push(Buffer.from(c));
  await writeFile(file, Buffer.concat(chunks));
}

test("a pack's map list comes from its central directory", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mappack-pk3-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "somepack.pk3");
  await makePk3(file, [
    "maps/Alpha.bsp", // the in-game name is lowercased everywhere else
    "maps/beta.bsp",
    "maps/beta.aas", // not a bsp
    "textures/x.tga",
    "maps/deep/nested.bsp", // not a top-level map
  ]);
  assert.deepEqual(await pk3MapNames(file), ["alpha", "beta"]);

  // Anything that is not a readable zip is "no maps", never a throw.
  const junk = path.join(dir, "junk.pk3");
  await writeFile(junk, crypto.randomBytes(512));
  assert.deepEqual(await pk3MapNames(junk), []);
  assert.deepEqual(await pk3MapNames(path.join(dir, "missing.pk3")), []);
});

test("packFor resolves a map to the pack that carries it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mappack-per-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // `bundle.pk3` carries three maps under a name of its own; `coldrun.pk3`
  // carries coldrun AND is named after it, so it wins the tie.
  await makePk3(path.join(dir, "bundle.pk3"), ["maps/coldrun.bsp", "maps/hangtime.bsp"]);
  await makePk3(path.join(dir, "coldrun.pk3"), ["maps/coldrun.bsp"]);
  const pack = await indexed(dir);

  const cold = pack.packFor("coldrun");
  assert.equal(cold.filename, "coldrun.pk3", "the pack named after the map wins");
  assert.equal(cold.url, "/download/map/coldrun.pk3");
  assert.ok(cold.bytes > 0);

  const hang = pack.packFor("hangtime");
  assert.equal(hang.filename, "bundle.pk3");
  assert.deepEqual(hang.maps, ["coldrun", "hangtime"], "the other maps riding along");

  // Case, and a reverse map, both resolve to the forward pack.
  assert.equal(pack.packFor("ColdRun").filename, "coldrun.pk3");
  assert.equal(pack.packFor("coldrun-reversed").filename, "coldrun.pk3");
  assert.equal(basePackMapName("Foo-reversed"), "foo");
  assert.equal(pack.packFor("not-installed"), null);
  assert.equal(pack.packFor(""), null);
  assert.equal(pack.packFor(null), null);
});

test("a per-map download hands back the pack file, named as the pack", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mappack-one-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makePk3(path.join(dir, "bundle.pk3"), ["maps/hangtime.bsp"]);
  const pack = await indexed(dir);

  const sent = [];
  const res = {
    headers: {},
    code: 200,
    set(k, v) { res.headers[k.toLowerCase()] = v; return res; },
    status(c) { res.code = c; return res; },
    json(o) { res.body = o; return res; },
    sendFile(file, opts) { sent.push({ file, opts }); return res; },
  };
  pack.handleMap({ params: { name: "hangtime" } }, res);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].file, path.join(dir, "bundle.pk3"));
  assert.match(sent[0].opts.headers["Content-Disposition"], /filename="bundle\.pk3"/);
  assert.equal(sent[0].opts.headers["Content-Type"], "application/zip");

  // The URL form the map page links to (map name + .pk3) resolves the same way.
  pack.handleMap({ params: { name: "hangtime.pk3" } }, res);
  assert.equal(sent.length, 2);

  pack.handleMap({ params: { name: "nothing-here" } }, res);
  assert.equal(res.code, 404);
  assert.equal(sent.length, 2);
});

test("an index written before per-map downloads existed is backfilled, not re-hashed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mappack-upg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await makePk3(path.join(dir, "bundle.pk3"), ["maps/hangtime.bsp"]);
  const indexPath = path.join(dir, "index.json");

  const first = await indexed(dir, { indexPath });
  const stored = JSON.parse(await readFile(indexPath, "utf8"));
  // Strip the map lists, as an index from the previous build would look.
  for (const e of stored.entries) delete e.maps;
  await writeFile(indexPath, JSON.stringify(stored));

  const second = createMapPack({ dir, indexPath, log: QUIET });
  await second.refresh();
  assert.equal(second.packFor("hangtime").filename, "bundle.pk3");
  assert.equal(second.layout.etag, first.layout.etag, "the archive itself is unchanged");
  assert.ok(JSON.parse(await readFile(indexPath, "utf8")).entries[0].maps.length, "written back");
});

test("the indexing lock keeps two replicas from hashing the same mirror at once", async (t) => {
  const { dir } = await fixtureDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const indexPath = path.join(dir, "index.json");

  // A replica that finds a fresh lock does NOT hash: it serves whatever the
  // persisted index covers (here: nothing yet) and retries later.
  await writeFile(`${indexPath}.lock`, String(Date.now()));
  const loser = createMapPack({ dir, indexPath, log: QUIET });
  await loser.refresh();
  t.after(() => loser.stop());
  assert.equal(loser.status().ready, false, "no layout — it did not do the winner's work");
  assert.equal(existsSync(indexPath), false, "and it did not write an index");

  // Once the winner publishes and drops the lock, the next pass is cheap.
  const winner = createMapPack({ dir, indexPath: path.join(dir, "winner.json"), log: QUIET });
  await winner.refresh();
  await writeFile(indexPath, await readFile(path.join(dir, "winner.json")));
  await rm(`${indexPath}.lock`);
  await loser.refresh();
  assert.equal(loser.status().ready, true);
  assert.equal(loser.layout.etag, winner.layout.etag);

  // A lock left behind by a replica that died mid-scan goes stale rather than
  // blocking indexing forever.
  const other = path.join(dir, "stale.json");
  await writeFile(`${other}.lock`, "held");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(`${other}.lock`, old, old);
  const afterStale = createMapPack({ dir, indexPath: other, log: QUIET });
  await afterStale.refresh();
  t.after(() => afterStale.stop());
  assert.equal(afterStale.status().ready, true, "a stale lock is broken, not obeyed");
});
