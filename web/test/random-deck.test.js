// Tests for reading the random_map tile deck out of the compiled pack
// (web/random-deck.js).
//
// The deck is the contract between the servers, which deal a route from it, and
// a web preview that has to draw the SAME route. So the cases that matter are:
// the real shipped pack parses and every piece comes back whole, a manifest the
// servers would refuse is refused here too, a republished pack is noticed
// without a restart, and nothing anywhere throws.
//
// The happy path runs against build/random_map.pk3 — the actual artifact, not a
// hand-written imitation of one. The failure paths use a synthetic pack, since
// a corrupt deck is exactly what a real pack never contains.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { mkdtemp, rm, copyFile, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadDeck, loadDeckText, parseDeck, readPackEntry, DECK_FLAGS, DECK_VERSION } from "../random-deck.js";

// The browser reads the same manifest for itself (the dealer runs client-side),
// so the one thing that must not drift is what the two readers make of it.
// Imported dynamically: the check is worth having, but not at the price of
// this file failing to load at all if that module moves.
const browserReader = await import("../public/assets/js/random-dealer.js").catch(() => null);

const SHIPPED_PACK = fileURLToPath(new URL("../../build/random_map.pk3", import.meta.url));
const QUIET = { log() {}, warn() {}, error() {} };

// Whatever tools/mapgen/tiles.py publishes footprints for (its FLOOR_TEX, which
// is plan_svg's PLAN_TEX): the walkable roles. `wall`, `pylon`, `sky`,
// `trigger` and `origin` are what must NOT be in the file — a plan drawn with
// walls in it is a solid block.
const WALKABLE = ["floor", "start", "finish", "checkpoint", "edge", "trim", "platform", "beam"];

// A minimal deck: one start, one finish, one footprint. Everything the loader
// insists on and nothing else, so a test can break exactly one thing.
const MINIMAL = [
  "// a deck",
  "deck 1 2 384",
  "play 13312 2560 1536",
  "gate 9 32 208 192",
  "tile 1 8 0 1024 0 0 0 -16 -208 -32 1024 208 256 1024 start start",
  "tile 2 16 0 1024 0 0 0 0 -208 -32 1040 208 256 1024 finish finish",
  "face 1 start 0 4 0 -192 1024 -192 1024 192 0 192",
  "",
].join("\n");

// A .pk3 is a zip; these fixtures are small and STOREd, which is enough to
// prove the reader walks a real central directory (the shipped pack's entries
// are deflated, and that path is covered by the happy-path tests).
function makePk3(entries) {
  const locals = [];
  const central = [];
  let off = 0;
  for (const [name, body] of Object.entries(entries)) {
    const n = Buffer.from(name, "utf8");
    const data = Buffer.from(body, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30 + n.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    n.copy(lh, 30);
    const ch = Buffer.alloc(46 + n.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    n.copy(ch, 46);
    locals.push(lh, data);
    central.push(ch);
    off += lh.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "randomdeck-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A pack of our own, so a test can replace it under the loader's feet.
async function writePack(dir, deckText, { mtime } = {}) {
  const file = path.join(dir, "random_map.pk3");
  await writeFile(file, makePk3({ "maps/random_map.deck": deckText }));
  if (mtime) await utimes(file, new Date(mtime), new Date(mtime));
  return file;
}

// The module keeps one cache slot keyed on the pack's path + size + mtime, so
// every test that wants a fresh read uses a directory of its own.
const load = (dir) => loadDeck({ dirs: [dir], log: QUIET });

test("reads the shipped pack and agrees with its own header", async (t) => {
  if (!existsSync(SHIPPED_PACK)) return t.skip("build/random_map.pk3 not built");
  const dir = await tmpDir(t);
  await copyFile(SHIPPED_PACK, path.join(dir, "random_map.pk3"));

  const deck = await load(dir);
  assert.ok(deck, "the shipped pack should parse");
  assert.equal(deck.version, DECK_VERSION);
  assert.equal(deck.source.file, path.join(dir, "random_map.pk3"));

  // `deck <version> <tiles> <width>` promises a count that nothing in the
  // engine checks. Here it is the integrity check on the whole file.
  const raw = (await readPackEntry(SHIPPED_PACK, "maps/random_map.deck")).toString("utf8");
  const header = raw.split("\n").find((l) => l.startsWith("deck "));
  const [, , declared, width] = header.split(/\s+/);
  assert.equal(deck.tiles.length, Number(declared));
  assert.equal(deck.width, Number(width));

  assert.ok(deck.play.half > 0 && deck.play.up > 0 && deck.play.down > 0);
  assert.ok(deck.gate.model > 0);
  assert.ok(deck.tiles[deck.start].flags & DECK_FLAGS.START);
  assert.ok(deck.finishes.length);
  for (const i of deck.finishes) assert.ok(deck.tiles[i].flags & DECK_FLAGS.FINISH);
  // Roomiest finish first: the order the dealer falls down when one will not fit.
  const routes = deck.finishes.map((i) => deck.tiles[i].route);
  assert.deepEqual(routes, [...routes].sort((a, b) => b - a));
  // Every heading is an eighth of a turn, or the preview would deal a route the
  // server does not.
  for (const tile of deck.tiles) assert.ok(Number.isInteger(tile.turn) && tile.turn >= 0 && tile.turn < 8);
});

test("the browser's reader of the same file makes the same deck", async (t) => {
  if (!existsSync(SHIPPED_PACK)) return t.skip("build/random_map.pk3 not built");
  if (!browserReader) return t.skip("public/assets/js/random-dealer.js not present");
  const dir = await tmpDir(t);
  await copyFile(SHIPPED_PACK, path.join(dir, "random_map.pk3"));

  // loadDeckText hands back the manifest as it ships, which is what a page
  // running the dealer client-side is given. Parsed there, it must come out as
  // the object parsed here: a preview that disagreed with itself between the
  // two would draw one route and quote another.
  const mine = { ...(await load(dir)) };
  delete mine.source;
  const text = await loadDeckText({ dirs: [dir], log: QUIET });
  assert.deepEqual(mine, browserReader.parseDeck(text));
});

test("every tile carries a walkable footprint, inside its own box", async (t) => {
  if (!existsSync(SHIPPED_PACK)) return t.skip("build/random_map.pk3 not built");
  const dir = await tmpDir(t);
  await copyFile(SHIPPED_PACK, path.join(dir, "random_map.pk3"));
  const deck = await load(dir);

  for (const tile of deck.tiles) {
    assert.ok(tile.faces.length, `${tile.name} has no footprint`);
    for (const f of tile.faces) {
      assert.ok(WALKABLE.includes(f.tex), `${tile.name} publishes a ${f.tex} face`);
      assert.ok(f.points.length >= 3, `${tile.name} has a ${f.points.length}-point face`);
      // Faces are joined to tiles by inline-model index. A face landing outside
      // the tile's declared box is how a mis-joined manifest would show up —
      // the geometry would be drawn on top of the wrong piece. Half a unit of
      // slack is the whole-unit rounding the manifest ships with.
      for (const [x, y] of f.points) {
        assert.ok(x >= tile.mins.x - 0.5 && x <= tile.maxs.x + 0.5, `${tile.name} x ${x}`);
        assert.ok(y >= tile.mins.y - 0.5 && y <= tile.maxs.y + 0.5, `${tile.name} y ${y}`);
      }
      assert.ok(f.top >= tile.mins.z - 0.5 && f.top <= tile.maxs.z + 0.5, `${tile.name} top ${f.top}`);
    }
  }
});

test("the parse is cached until the pack is republished", async (t) => {
  const dir = await tmpDir(t);
  await writePack(dir, MINIMAL, { mtime: 1_700_000_000_000 });

  const first = await load(dir);
  assert.equal(first.tiles.length, 2);
  // Same bytes, same object: a route handler calling this per request must not
  // re-read the pack every time.
  assert.equal(await load(dir), first);

  // Same size, new mtime — a rebuilt pack that happens to be the same length.
  await utimes(path.join(dir, "random_map.pk3"), new Date(1_700_000_060_000), new Date(1_700_000_060_000));
  const again = await load(dir);
  assert.notEqual(again, first, "a new mtime should re-read");
  assert.deepEqual(again.tiles, first.tiles);

  // A genuinely different deck, dropped in under the same name.
  const grown = MINIMAL.replace("deck 1 2 384", "deck 1 3 384").replace(
    "\nface 1",
    "\ntile 3 0 10 640 0 0 0 0 -208 -32 640 208 256 640 straight run_640\nface 1"
  );
  await writePack(dir, grown, { mtime: 1_700_000_120_000 });
  const fresh = await load(dir);
  assert.equal(fresh.tiles.length, 3);
  assert.equal(fresh.tiles[2].name, "run_640");
});

test("a missing, unreadable or deckless pack returns null", async (t) => {
  const empty = await tmpDir(t);
  assert.equal(await load(empty), null);

  const junk = await tmpDir(t);
  await writeFile(path.join(junk, "random_map.pk3"), Buffer.alloc(4096, 0x41)); // not a zip
  assert.equal(await load(junk), null);

  const truncated = await tmpDir(t);
  const full = makePk3({ "maps/random_map.deck": MINIMAL });
  await writeFile(path.join(truncated, "random_map.pk3"), full.subarray(0, full.length - 40));
  assert.equal(await load(truncated), null);

  const wrongEntry = await tmpDir(t);
  await writeFile(path.join(wrongEntry, "random_map.pk3"), makePk3({ "maps/random_map.bsp": "IBSP" }));
  assert.equal(await load(wrongEntry), null);

  // And the whole way through, not just in the pure parser. The text is
  // withheld too: handing the browser a manifest this side already judged
  // unreadable would only move the failure one hop further out.
  const corrupt = await tmpDir(t);
  await writePack(corrupt, MINIMAL.replace("deck 1 2", "deck 2 2"));
  assert.equal(await load(corrupt), null);
  assert.equal(await loadDeckText({ dirs: [corrupt], log: QUIET }), null);
});

test("refuses a manifest the servers would refuse, and says why", () => {
  const reasons = [];
  const log = { log() {}, warn: (m) => reasons.push(m), error() {} };
  const bad = (edit) => parseDeck(edit(MINIMAL), { log });

  // RACE_MetaLoadDeck aborts the whole load on a version it does not know, so
  // a preview drawn from one would be drawing a map nobody is playing.
  assert.equal(bad((s) => s.replace("deck 1 2", "deck 2 2")), null);
  assert.equal(bad((s) => s.replace("deck 1 2 384", "deck 1 9 384")), null); // count lies
  assert.equal(bad((s) => s.replace(/^tile 1 8 .*$/m, "")), null); // no start tile
  assert.equal(bad((s) => s.replace(/^tile 2 16 .*$/m, "")), null); // no finish tile
  assert.equal(bad((s) => s.replace("gate 9 32 208 192", "gate 0 32 208 192")), null);
  assert.equal(bad((s) => s.replace("play 13312", "play 0")), null);
  assert.equal(bad((s) => s.replace(" 1024 start start", " 1024 start")), null); // short tile line
  assert.equal(bad((s) => s.replace("tile 1 8 0 1024 0 0 0 ", "tile 1 8 0 1024 0 0 30 ")), null); // yaw off the 45 grid
  assert.equal(bad((s) => s.replace("face 1 start 0 4", "face 1 start 0 5")), null); // arity self-check
  assert.equal(reasons.length, 9, reasons.join(" | "));
  assert.ok(reasons.every((m) => m.startsWith("random deck: ")), reasons.join(" | "));

  assert.ok(parseDeck(MINIMAL, { log: QUIET }), "the unedited fixture must parse");
});

test("tolerates what the engine tolerates: unknown heads, extra tile tokens", () => {
  // metamap.as's head dispatch has no trailing else, which is what let `face`
  // be added to a grammar deployed servers already read. The preview must not
  // be the thing that makes the next addition a breaking change.
  const text = MINIMAL.replace(
    "face 1 start",
    "piece 1 something new\ntile 2 16 0 1024 0 0 0 0 -208 -32 1040 208 256 1024 finish finish extra 7\nface 1 start"
  ).replace(/^tile 2 16 .*finish finish$/m, "");
  const deck = parseDeck(text, { log: QUIET });
  assert.ok(deck);
  assert.equal(deck.tiles.length, 2);
  assert.equal(deck.tiles[1].name, "finish");
  // A footprint naming a model no tile line claims is skipped, not fatal.
  const orphan = parseDeck(MINIMAL + "face 99 floor 0 3 0 0 64 0 64 64\n", { log: QUIET });
  assert.ok(orphan);
  assert.equal(orphan.tiles.reduce((n, t) => n + t.faces.length, 0), 1);
  // A comment trailing a data line is eaten, the way COM_Parse eats it.
  const commented = parseDeck(MINIMAL.replace("play 13312 2560 1536", "play 13312 2560 1536 // the arena"), {
    log: QUIET,
  });
  assert.equal(commented.play.down, 1536);
});
