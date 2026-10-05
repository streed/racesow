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
// walls in it is a solid block. `start` is still in the list, but it is now the
// platform's own `padface` rather than any tile: no tile kind `start` is left.
const WALKABLE = ["floor", "start", "finish", "checkpoint", "edge", "trim", "platform", "beam"];

// A minimal deck: the start platform, one piece to deal, one finish to end on,
// one footprint each. Everything the loader insists on and nothing else, so a
// test can break exactly one thing.
//
// There is deliberately NO start tile. The pad stopped being dealt and became
// permanent world geometry, so a deck without one is now CORRECT — what the
// loader refuses instead is a deck with no `begin` (nowhere to start the route)
// or no `pad` (nothing to keep the route out of).
const MINIMAL = [
  "// a deck",
  "deck 1 2 384",
  "play 13312 2560 1536",
  "gate 9 32 208 192",
  "pad -16 -208 -32 1024 208 256",
  "begin 1024 0 0 0",
  "spawn 96 0 32 0",
  "padface start 0 4 0 -192 1024 -192 1024 192 0 192",
  "tile 1 0 10 1024 0 0 0 0 -208 -32 1024 208 256 1024 straight run_1024",
  "tile 2 16 0 1024 0 0 0 0 -208 -32 1040 208 256 1024 finish finish",
  "face 1 floor 0 4 0 -192 1024 -192 1024 192 0 192",
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
  assert.ok(deck.finishes.length);

  // The start platform arrives as four heads of its own rather than as a dealt
  // tile, so there is no start index to look up and nothing wears the retired
  // bit 8 (metamap.as:68 — DECK_FLAGS no longer names it, hence the literal).
  assert.equal(deck.start, undefined, "the deck should carry no start index");
  for (const tile of deck.tiles) assert.equal(tile.flags & 8, 0, `${tile.name} wears the retired START bit`);
  // The numbers tools/mapgen compiles the platform at today. Pinned, not
  // derived: these are world coordinates the engine, the browser dealer and the
  // plan all read literally, so a change here has to be a deliberate one.
  // 341 is tiles.PAD_LEN, a third of the 1024 the platform used to be: the long
  // run-up left room for a second jump before the gate, and a second jump above
  // 325 ups is what the prejump rule rejects (tiles.py, at PAD_LEN). Moving it
  // moves every dealt route, so this pin is the tripwire against doing that by
  // accident rather than a restatement of the generator.
  assert.deepEqual(deck.pad, { lo: { x: -16, y: -208, z: -32 }, hi: { x: 341, y: 208, z: 256 } });
  assert.deepEqual(deck.begin, { x: 341, y: 0, z: 0 });
  assert.equal(deck.beginStep, 0);
  assert.deepEqual(deck.spawn, { x: 96, y: 0, z: 32 });
  assert.equal(deck.spawnStep, 0);
  // `begin` on the platform's far face is what makes the first dealt piece mate
  // flush onto it — and the dealer seeds its route length from `begin`'s
  // distance to the origin (metamap.as:894), which is only the platform's
  // length if the two agree.
  assert.equal(deck.begin.x, deck.pad.hi.x);
  assert.equal(deck.padFaces.length, 1);
  assert.equal(deck.padFaces[0].tex, "start");
  assert.equal(deck.padFaces[0].top, 0, "the platform's floor is flush with begin.z");
  assert.equal(deck.padFaces[0].points.length, 4);
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

test("every tile — and the platform — carries a walkable footprint in its own box", async (t) => {
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

  // The platform's footprint rides in padFaces, with no model token and no tile
  // to belong to. Its points are WORLD coordinates, not local to anything, so
  // they are bounded against the pad box — which is also the check that would
  // catch a `padface` mis-read as a `face` (one token fewer shifts every number
  // along by one, and nothing would land in the box).
  assert.ok(deck.padFaces.length, "the start platform publishes no footprint");
  for (const f of deck.padFaces) {
    assert.ok(WALKABLE.includes(f.tex), `the platform publishes a ${f.tex} face`);
    assert.ok(f.points.length >= 3, `the platform has a ${f.points.length}-point face`);
    for (const [x, y] of f.points) {
      assert.ok(x >= deck.pad.lo.x - 0.5 && x <= deck.pad.hi.x + 0.5, `platform x ${x}`);
      assert.ok(y >= deck.pad.lo.y - 0.5 && y <= deck.pad.hi.y + 0.5, `platform y ${y}`);
    }
    assert.ok(f.top >= deck.pad.lo.z - 0.5 && f.top <= deck.pad.hi.z + 0.5, `platform top ${f.top}`);
  }
});

test("a deck with no start tile is a correct deck", () => {
  // The whole swap, in one test: no start tile is fine, no platform is not.
  const deck = parseDeck(MINIMAL, { log: QUIET });
  assert.ok(deck, "a deck with no start tile must parse");
  assert.equal(deck.start, undefined);
  assert.equal(deck.tiles.filter((tile) => tile.flags & 8).length, 0);
  assert.deepEqual(deck.pad, { lo: { x: -16, y: -208, z: -32 }, hi: { x: 1024, y: 208, z: 256 } });
  assert.deepEqual(deck.begin, { x: 1024, y: 0, z: 0 });
  assert.equal(deck.beginStep, 0);
  assert.deepEqual(deck.spawn, { x: 96, y: 0, z: 32 });
  assert.equal(deck.spawnStep, 0);
  assert.deepEqual(deck.padFaces, [
    { tex: "start", top: 0, points: [[0, -192], [1024, -192], [1024, 192], [0, 192]] },
  ]);

  // A tile wearing the retired bit 8 is just a tile. Nothing may read it back
  // as "this is the start": it would be dealt from the play box origin, through
  // the platform standing there.
  const wearing = parseDeck(MINIMAL.replace("tile 1 0 10", "tile 1 8 10"), { log: QUIET });
  assert.ok(wearing);
  assert.equal(wearing.start, undefined);
  assert.equal(wearing.tiles[0].weight, 10, "it is still a drawable piece");

  // `spawn` is optional: RACE_MetaSpawnSpot falls back to (96, 0, 32) for a deck
  // built before the line existed, so an absent one is null, not a refusal.
  const noSpawn = parseDeck(MINIMAL.replace(/^spawn .*$/m, ""), { log: QUIET });
  assert.ok(noSpawn, "spawn is optional");
  assert.equal(noSpawn.spawn, null);
  assert.equal(noSpawn.spawnStep, 0);
  // So is the footprint — the dealer never reads one, only a plan does.
  const noPadFace = parseDeck(MINIMAL.replace(/^padface .*$/m, ""), { log: QUIET });
  assert.ok(noPadFace, "padface is optional");
  assert.deepEqual(noPadFace.padFaces, []);

  // `begin`'s last token is already a 45-degree STEP, so it is reduced the way
  // RACE_MetaStep reduces it (the long way round, so -1 lands on 7) and NOT put
  // through the multiple-of-45 check a tile's yaw gets — which would refuse it.
  const turned = parseDeck(MINIMAL.replace("begin 1024 0 0 0", "begin 1024 0 0 -1"), { log: QUIET });
  assert.ok(turned);
  assert.equal(turned.beginStep, 7);
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
  assert.equal(bad((s) => s.replace(/^tile 2 16 .*$/m, "")), null); // no finish tile
  // The two that replaced "no start tile". Without `begin` the route would start
  // at the play box origin, inside the platform now standing there; without
  // `pad` a later piece can be dealt through the floor the player spawns on.
  assert.equal(bad((s) => s.replace(/^begin .*$/m, "")), null); // no route origin
  assert.equal(bad((s) => s.replace(/^pad .*$/m, "")), null); // no platform box
  // ...and a pad box with no width is the same failure wearing a line: x and y
  // only, the two axes metamap.as checks.
  assert.equal(bad((s) => s.replace("pad -16 -208 -32 1024 208 256", "pad -16 -208 -32 -16 208 256")), null);
  assert.equal(bad((s) => s.replace("gate 9 32 208 192", "gate 0 32 208 192")), null);
  assert.equal(bad((s) => s.replace("play 13312", "play 0")), null);
  assert.equal(bad((s) => s.replace(" 1024 straight run_1024", " 1024 straight")), null); // short tile line
  assert.equal(bad((s) => s.replace("tile 1 0 10 1024 0 0 0 ", "tile 1 0 10 1024 0 0 30 ")), null); // yaw off the 45 grid
  assert.equal(bad((s) => s.replace("face 1 floor 0 4", "face 1 floor 0 5")), null); // arity self-check
  // padface counts its own points too, and carries one token fewer, so its
  // self-check is a different sum (4 + 2n) that has to be the right one.
  assert.equal(bad((s) => s.replace("padface start 0 4", "padface start 0 5")), null);
  assert.equal(reasons.length, 12, reasons.join(" | "));
  assert.ok(reasons.every((m) => m.startsWith("random deck: ")), reasons.join(" | "));

  assert.ok(parseDeck(MINIMAL, { log: QUIET }), "the unedited fixture must parse");
});

test("tolerates what the engine tolerates: unknown heads, extra tile tokens", () => {
  // metamap.as's head dispatch has no trailing else, which is what let `face`
  // be added to a grammar deployed servers already read. The preview must not
  // be the thing that makes the next addition a breaking change.
  const text = MINIMAL.replace(
    "face 1 floor",
    "piece 1 something new\ntile 2 16 0 1024 0 0 0 0 -208 -32 1040 208 256 1024 finish finish extra 7\nface 1 floor"
  ).replace(/^tile 2 16 .*finish finish$/m, "");
  const deck = parseDeck(text, { log: QUIET });
  assert.ok(deck);
  assert.equal(deck.tiles.length, 2);
  assert.equal(deck.tiles[1].name, "finish");
  // A footprint naming a model no tile line claims is skipped, not fatal.
  const orphan = parseDeck(MINIMAL + "face 99 floor 0 3 0 0 64 0 64 64\n", { log: QUIET });
  assert.ok(orphan);
  assert.equal(orphan.tiles.reduce((n, t) => n + t.faces.length, 0), 1);
  // `padface` is a head of its own and must not fall into the `face` branch: it
  // has no model token, so read as a face it would name model NaN and be counted
  // an orphan — which is a warning on an otherwise clean parse, and a platform
  // missing from the plan.
  const padWarnings = [];
  const padded = parseDeck(MINIMAL, { log: { log() {}, warn: (m) => padWarnings.push(m), error() {} } });
  assert.equal(padded.padFaces.length, 1);
  assert.equal(padded.tiles.reduce((n, tile) => n + tile.faces.length, 0), 1);
  assert.deepEqual(padWarnings, [], "a clean deck warns about nothing");
  // A comment trailing a data line is eaten, the way COM_Parse eats it.
  const commented = parseDeck(MINIMAL.replace("play 13312 2560 1536", "play 13312 2560 1536 // the arena"), {
    log: QUIET,
  });
  assert.equal(commented.play.down, 1536);
});
