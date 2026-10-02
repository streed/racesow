// The browser's random_map dealer, pinned to the server's.
//
// /random draws the course a seed produces by dealing it again in the page
// (public/assets/js/random-dealer.js), which is only worth anything if it
// deals the SAME course hrace/metamap.as does. Nothing about that is checkable
// by inspection: the route is a weighted draw off a 32-bit generator whose
// consumption order is the seed, so one extra call, one digit of a different
// cosine, or one tile scored out of deck order silently produces a different
// but perfectly plausible-looking course.
//
// So it is pinned by golden vectors instead. fixtures/random-dealer-golden.json
// was dumped by the Python model of the same dealer (scratchpad sim_new.py,
// written against metamap.as) inside the racesow-mapgen image: 340 seeds at the
// default distance, four of them re-dealt at three others, and the deck manifest
// they were dealt from verbatim, so the fixture pins the file as well as the
// file's reader. Every one of those seeds has to come back piece for piece — a
// single mismatched piece is a failure, never a tolerance — which also means a
// deck rebuild that changes a tile is expected to fail here until the vectors
// are dumped again from the new pack.
//
// THE START PLATFORM IS NOT A PIECE. It is world geometry now, so `pieces` is
// dealt pieces only, pieces[0] stands at the manifest's `begin`, the route
// length starts at the platform's run-up rather than at zero, and the one
// invariant the golden vectors cannot catch on their own — that nothing is ever
// dealt into the platform's box — is asserted structurally below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDeck, dealRoute, xorshift32, exitOf, headingOf, boxesApart,
  F_FINISH, FENCE_MARGIN, MAX_TILES,
} from "../public/assets/js/random-dealer.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/random-dealer-golden.json", import.meta.url), "utf8"));
const deck = parseDeck(golden.deck);

const names = (route) => route.pieces.map((p) => p.tile.name);
const track = (route) => route.pieces.map((p) => [p.at.x, p.at.y, p.at.z, p.step]);

// A deck the new loader accepts whole: one finish tile, a platform, nothing
// else. Used for the cases that need a manifest small enough to read.
const MINIMAL = "deck 1 1 384\n"
  + "play 13312 2560 1536\n"
  + "gate 78 32 208 192\n"
  + "pad -16 -208 -32 1024 208 256\n"
  + "begin 1024 0 0 0\n"
  + "spawn 96 0 32 0\n"
  + "padface start 0 4 0 -192 1024 -192 1024 192 0 192\n";
const MINIMAL_FINISH = "tile 1 16 0 1024 0 0 0 0 -208 -32 1040 208 256 1024 finish finish\n";

test("the manifest reads the way the server's loader reads it", () => {
  assert.equal(deck.version, 1);
  assert.equal(deck.tiles.length, 77, "77 tiles: the start pad left the deck");
  assert.deepEqual(deck.play, { half: 13312, up: 2560, down: 1536 });
  assert.deepEqual(deck.gate, { model: 78, depth: 32, half: 208, height: 192 });

  // Roomiest run-out first: the dealer walks the list, so a route that has
  // painted itself into a corner can still end on the short one.
  assert.equal(deck.finishes.length, 2);
  const outs = deck.finishes.map((i) => deck.tiles[i]);
  assert.ok(outs.every((t) => t.flags & F_FINISH));
  assert.ok(outs[0].route > outs[1].route, "finish tiles must be roomiest first");
});

test("the start platform is read off the manifest, not guessed at", () => {
  // `pad -16 -208 -32 1024 208 256` / `begin 1024 0 0 0` / `spawn 96 0 32 0`.
  // Every number is already a world value: the platform is compiled into
  // worldspawn, so unlike a tile it never moves and never turns.
  const want = golden.platform;
  assert.deepEqual(deck.pad, {
    lo: { x: want.pad[0][0], y: want.pad[0][1], z: want.pad[0][2] },
    hi: { x: want.pad[1][0], y: want.pad[1][1], z: want.pad[1][2] },
  });
  assert.deepEqual(deck.begin, { x: want.begin[0], y: want.begin[1], z: want.begin[2] });
  assert.equal(deck.beginStep, want.beginStep);
  assert.deepEqual(deck.spawn, { x: want.spawn[0], y: want.spawn[1], z: want.spawn[2] });
  assert.equal(deck.spawnStep, want.spawnStep);
  // `begin` is exactly on the platform's far face, which is what lets the first
  // dealt piece touch the platform without overlapping it.
  assert.equal(deck.begin.x, deck.pad.hi.x, "the route starts on the platform's far face");

  // The platform's own footprint, in WORLD units (a tile's face points are
  // local to its tile), and carrying no model token because there is no inline
  // model to name.
  assert.equal(deck.padFaces.length, 1);
  assert.equal(deck.padFaces[0].tex, "start");
  assert.equal(deck.padFaces[0].top, 0, "the platform's walkable top is flush with begin.z");
  assert.deepEqual(deck.padFaces[0].points, [[0, -192], [1024, -192], [1024, 192], [0, 192]]);
  assert.ok(!("model" in deck.padFaces[0]));

  // There is no start tile and no start index. Bit 8 was its flag; it stays
  // retired, and a reader that still knew it would deal whatever wore it from
  // the play box origin, straight through the platform (metamap.as:68).
  assert.equal(deck.start, undefined);
  assert.ok(!Object.hasOwn(deck, "start"), "a start index would be a reader out of step with the engine");
  assert.ok(deck.tiles.every((t) => (t.flags & 8) === 0), "no tile may wear the retired bit 8");
  assert.ok(deck.tiles.every((t) => t.kind !== "start"), "no tile is the start any more");
});

test("every yaw in the deck is a whole 45-degree step", () => {
  // Tiles mate face to face; a fraction of a degree would be a seam a player
  // catches, so the loader treats a yaw off the grid as fatal.
  for (const t of deck.tiles) assert.ok(t.turn >= 0 && t.turn < 8 && Number.isInteger(t.turn), t.name);
  // The manifest below is one the loader would otherwise take whole — the bad
  // yaw is the only thing wrong with it — so this pins the yaw check and not
  // some other refusal arriving first.
  assert.doesNotThrow(() => parseDeck(MINIMAL + MINIMAL_FINISH));
  assert.throws(() => parseDeck(MINIMAL
    + "tile 1 16 0 1024 0 0 30 0 -208 -32 1040 208 256 1024 finish finish\n"), /not a multiple of 45/);
  // ...while `begin`'s and `spawn`'s last token is a STEP, not degrees, so it
  // skips that check entirely and only wraps into [0, 8) (RACE_MetaStep).
  const wrapped = parseDeck(MINIMAL.replace("begin 1024 0 0 0", "begin 1024 0 0 -1") + MINIMAL_FINISH);
  assert.equal(wrapped.beginStep, 7, "a step of -1 is step 7, not a refusal");
});

test("a manifest version the servers would refuse is refused here too", () => {
  // metamap.as aborts the whole load on the version token, which makes the map
  // unplayable. Drawing a route off a manifest a server would not read is the
  // one failure worse than drawing nothing.
  assert.throws(() => parseDeck(golden.deck.replace("deck 1 77 384", "deck 2 77 384")), /version 2/);
});

test("a deck built before the platform moved into the world is refused by name", () => {
  // /api/random/deck is edge-cached for five minutes, so for a few minutes
  // after a deploy this dealer can be handed the PREVIOUS deck — which has a
  // start tile and no `begin`. Both the parser and the dealer have to say so
  // rather than dealing a route of NaNs out of undefined arithmetic.
  const noBegin = MINIMAL.replace("begin 1024 0 0 0\n", "") + MINIMAL_FINISH;
  assert.throws(() => parseDeck(noBegin), /no begin line/);
  const noPad = MINIMAL.replace("pad -16 -208 -32 1024 208 256\n", "") + MINIMAL_FINISH;
  assert.throws(() => parseDeck(noPad), /no pad box/);
  // x and y only, the same two axes metamap.as checks (metamap.as:359).
  const flatPad = MINIMAL.replace("pad -16 -208 -32 1024 208 256", "pad 0 -208 -32 0 208 256") + MINIMAL_FINISH;
  assert.throws(() => parseDeck(flatPad), /no pad box/);
  // A JSON deck never goes through parseDeck at all, so the dealer checks too.
  const stale = { ...deck, begin: null };
  assert.throws(() => dealRoute(stale, 7), /no begin line/);
  const padless = { ...deck, pad: null };
  assert.throws(() => dealRoute(padless, 7), /no pad box/);
  // ...and the spawn is NOT required: RACE_MetaSpawnSpot falls back to the
  // literal (96, 0, 32) for a deck built before the line existed.
  const noSpawn = parseDeck(MINIMAL.replace("spawn 96 0 32 0\n", "") + MINIMAL_FINISH);
  assert.equal(noSpawn.spawn, null);
  assert.equal(noSpawn.spawnStep, 0);
  assert.ok(dealRoute(noSpawn, 7).pieces.length >= 0);
});

test("unknown line heads are ignored, the way the loader ignores them", () => {
  // The head chain in RACE_MetaLoadDeck has no trailing else, which is what
  // lets the manifest grow new line kinds without stranding deployed servers.
  // `face` and `padface` rows are that in practice: the dealer needs none of
  // them, and `padface` is itself a head older servers never knew.
  const withNoise = golden.deck
    + "piece 3 something entirely new\n"
    + "// a comment line yields no first token at all\n"
    + "\n";
  const noisy = parseDeck(withNoise);
  assert.equal(noisy.tiles.length, deck.tiles.length);
  assert.deepEqual(dealRoute(noisy, 7).pieces.map((p) => p.tile.name), names(dealRoute(deck, 7)));

  // Tokens appended past index 16 of a tile line are never read either.
  const line = "tile 3 0 22 384 0 0 0 0 -208 -32 384 208 256 384 straight run_384";
  const wider = parseDeck(golden.deck.replace(line, `${line} 1 2 3`));
  const i = wider.tiles.findIndex((t) => t.name === "run_384");
  assert.ok(i >= 0);
  assert.equal(wider.tiles[i].route, 384);
  assert.deepEqual(wider.tiles[i], deck.tiles[i], "trailing tokens change nothing about the tile");
});

test("the walkable footprints ride along with their tile — and with the platform", () => {
  // The dealer reads none of these — a box is all it takes to fit one piece
  // onto the next — but a plan of a route is drawn from them, so the manifest
  // gets exactly one reader on this side.
  assert.ok(deck.tiles.every((t) => t.faces.length > 0), "every tile publishes a footprint");
  for (const f of deck.tiles[0].faces) {
    assert.ok(f.points.length >= 3);
    assert.ok(f.points.every((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])));
  }
  // The platform's are world coordinates, so they land inside its own box.
  for (const f of deck.padFaces) {
    assert.ok(f.points.length >= 3);
    assert.ok(f.points.every(([x, y]) => x >= deck.pad.lo.x && x <= deck.pad.hi.x
      && y >= deck.pad.lo.y && y <= deck.pad.hi.y), "a padface point is outside the pad box");
    assert.ok(f.top >= deck.pad.lo.z && f.top <= deck.pad.hi.z);
  }
  // The declared point count is what makes a variable-arity line
  // self-checking — and `padface` carries one token fewer than `face`, so its
  // arity is 4 + 2n and the two cannot be read with one branch.
  assert.throws(() => parseDeck(golden.deck + "face 1 floor 0 4 0 0 1 0 1 1\n"), /declares 4 points/);
  assert.throws(() => parseDeck(golden.deck + "padface start 0 4 0 0 1 0 1 1 2\n"), /padface line declares 4 points/);
});

test("xorshift32 reproduces the generator the server runs", () => {
  for (const [seed, want] of Object.entries(golden.rng)) {
    const next = xorshift32(Number(seed));
    const got = Array.from({ length: want.length }, () => next());
    assert.deepEqual(got, want, `seed ${seed}`);
  }
  // Every word is an unsigned 32-bit one: JavaScript's bitwise operators are
  // signed, so a missing >>> 0 shows up as negative numbers here.
  const next = xorshift32(0xdeadbeef);
  for (let i = 0; i < 64; i++) {
    const v = next();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, `${v} is not a uint32`);
  }
});

test("a seed that is not a seed is refused, not dealt", () => {
  // A blank or junk query string arriving as NaN would otherwise deal the one
  // degenerate route xorshift32 has: stuck on zero, every pick the first
  // candidate — a perfectly plausible-looking course for a seed nobody can run.
  for (const bad of [0, -1, NaN, 1.5, 4294967296, "7", null, undefined]) {
    assert.throws(() => dealRoute(deck, bad), /seed must be a whole number/, String(bad));
  }
  // More than one DEALT piece, which no longer counts the start platform.
  assert.ok(dealRoute(deck, 4294967295).pieces.length > 1, "the top of the range is a seed");
});

test("every golden seed deals piece for piece", () => {
  assert.ok(golden.routes.length >= 200, `only ${golden.routes.length} seeds in the golden set`);
  for (const want of golden.routes) {
    const got = dealRoute(deck, want.seed, want.target);
    assert.deepEqual(names(got), want.pieces, `seed ${want.seed}`);
    assert.equal(got.pieces.length, want.count, `seed ${want.seed} piece count`);
    assert.equal(got.length, want.length, `seed ${want.seed} route length`);
    assert.equal(got.rewinds, want.rewinds, `seed ${want.seed} rewinds`);
    assert.equal(got.bare, want.bare, `seed ${want.seed} gate-only finish`);
    assert.equal(got.heading, want.heading, `seed ${want.seed} final heading`);
    // Exact, not near: the cursor is accumulated through the same eight-digit
    // table the engine uses, so "close" would mean a different table.
    assert.deepEqual([got.cursor.x, got.cursor.y, got.cursor.z], want.end, `seed ${want.seed} end of track`);
  }
});

test("the route length starts at the platform's run-up, not at zero", () => {
  // The platform is run-up the player crosses before the clock starts, and as a
  // dealt tile its length counted towards rs_meta_distance. Seeding it keeps
  // that cvar — and the unit count filed with a time — meaning what it meant
  // when the pad was dealt (metamap.as:895).
  const r = dealRoute(deck, 7);
  assert.equal(r.runup, golden.platform.runup);
  assert.equal(r.runup, Math.sqrt(deck.begin.x * deck.begin.x + deck.begin.y * deck.begin.y));
  assert.equal(r.pieces[0].dealtBefore, r.runup, "the first dealt piece starts the count at the run-up");
  assert.equal(r.length, r.pieces.reduce((n, p) => n + p.tile.route, r.runup));
});

test("the target distance is an input to the deal, not a constant", () => {
  // rs_meta_distance is a cvar: a server can run sprints or marathons off the
  // same deck, and the same seed deals a different route at each distance.
  for (const want of golden.targets) {
    const got = dealRoute(deck, want.seed, want.target);
    assert.deepEqual(names(got), want.pieces, `seed ${want.seed} at ${want.target}`);
    assert.equal(got.length, want.length, `seed ${want.seed} at ${want.target}`);
  }
  const short = dealRoute(deck, 7, 6000);
  const long = dealRoute(deck, 7, 40000);
  assert.ok(short.length < long.length);
});

test("the cursor track matches placement for placement", () => {
  for (const want of golden.places) {
    const got = dealRoute(deck, want.seed, want.target);
    assert.deepEqual(track(got), want.places, `seed ${want.seed}`);
  }
  // ...and it starts at `begin`, which is where the model starts it too.
  assert.deepEqual(golden.places[0].places[0],
    [deck.begin.x, deck.begin.y, deck.begin.z, deck.beginStep]);
});

test("the same seed deals the same route twice", () => {
  for (const seed of [1, 7, 4242, 999983, 4294967295]) {
    const a = dealRoute(deck, seed, 16000);
    const b = dealRoute(deck, seed, 16000);
    assert.deepEqual(track(b), track(a), `seed ${seed}`);
    assert.deepEqual(names(b), names(a), `seed ${seed}`);
    assert.equal(b.length, a.length);
    assert.deepEqual(b.cursor, a.cursor);
  }
});

test("a dealt route is one a player could actually run", () => {
  // Structural facts the golden vectors would not catch on their own: pieces
  // that do not mate leave a hole in the floor, and a piece outside the fence
  // is inside the sky shell.
  const fence = deck.play.half - FENCE_MARGIN;
  for (let seed = 1; seed <= 120; seed++) {
    const r = dealRoute(deck, seed, 16000);
    assert.ok(r.pieces.length > 0, `seed ${seed} dealt nothing at all`);
    // The route starts AT `begin` facing `beginStep` — there is no start tile
    // to deal, so the first placement is the first real piece of course.
    assert.deepEqual(r.pieces[0].at, deck.begin, `seed ${seed} does not start at begin`);
    assert.equal(r.pieces[0].step, deck.beginStep, `seed ${seed} does not start facing beginStep`);
    // MAX_TILES counts DEALT pieces now: ending fires at 43 dealt and the
    // run-out makes 44, so the entity budget is still 44 pieces + 2 gates.
    assert.ok(r.pieces.length <= MAX_TILES, `seed ${seed} is over the entity budget`);
    assert.equal(r.bare, !(r.pieces[r.pieces.length - 1].tile.flags & F_FINISH),
      `seed ${seed}: only a gate-only finish ends on something that is not a run-out`);

    let total = r.runup;
    for (let i = 0; i < r.pieces.length; i++) {
      const p = r.pieces[i];
      assert.equal(p.dealtBefore, total, `seed ${seed} piece ${i} route total`);
      total += p.tile.route;
      assert.ok(p.lo.x >= -fence && p.hi.x <= fence && p.lo.y >= -fence && p.hi.y <= fence
        && p.lo.z >= -deck.play.down && p.hi.z <= deck.play.up, `seed ${seed} piece ${i} is outside the fence`);
      // The next piece's entry is this one's exit, turned into its frame.
      const next = i + 1 < r.pieces.length ? r.pieces[i + 1] : { at: r.cursor, step: r.heading };
      assert.deepEqual(next.at, exitOf(p.at, p.tile, p.step), `seed ${seed}: piece ${i + 1} does not mate onto ${i}`);
      assert.equal(next.step, headingOf(p.tile, p.step), `seed ${seed}: piece ${i + 1} faces the wrong way`);
    }
    assert.equal(r.length, total);
  }
});

test("nothing is ever dealt into the start platform", () => {
  // The one invariant that arrived with the platform, and the one the golden
  // vectors cannot catch on their own: the platform is worldspawn, so it is in
  // none of the dealer's placed-piece arrays and its box has to be tested on
  // its own (RACE_MetaBoxClear). Without that, a route folding back over its
  // own start is dealt straight through the floor the player spawns on — and
  // the preview would draw it, because every other check would still pass.
  //
  // Touching is apart, which is exactly what the first piece does: `begin` sits
  // on the platform's far face. So this is the real predicate, not a margin.
  const lo = deck.pad.lo, hi = deck.pad.hi;
  const seeds = golden.routes.map((w) => w.seed);
  for (const seed of seeds) {
    const r = dealRoute(deck, seed, 16000);
    for (let i = 0; i < r.pieces.length; i++) {
      assert.ok(boxesApart(r.pieces[i].lo, r.pieces[i].hi, lo, hi),
        `seed ${seed} piece ${i} (${r.pieces[i].tile.name}) is inside the start platform`);
    }
    // The first piece is flush against it, which is what makes the test above
    // a real one rather than one no route could ever fail.
    assert.equal(r.pieces[0].lo.x, hi.x, `seed ${seed}: the first piece should sit flush on the platform`);
  }
  // And the dealer really is consulting it: a route dealt with the pad shrunk
  // to nothing in front of the cursor is free to take a different line.
  const wide = { ...deck, pad: { lo: { x: -16, y: -208, z: -32 }, hi: { x: 1024, y: 208, z: 4096 } } };
  const differs = golden.routes.some((w) =>
    names(dealRoute(wide, w.seed, 16000)).join(",") !== w.pieces.join(","));
  assert.ok(differs, "a taller platform must change at least one route, or the pad is not being tested");
});

test("both gates sit where the server spawns them", () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    const r = dealRoute(deck, seed, 16000);
    // The start gate sits AT `begin`, the end of the platform, so the clock
    // starts as the player leaves it with the whole platform of run-up behind
    // them. It used to go at the exit of the dealt start pad, which was the
    // same point by construction; now it is the point the manifest names.
    assert.deepEqual(r.startGate.at, deck.begin, `seed ${seed} start gate`);
    assert.equal(r.startGate.step, deck.beginStep);
    // The finish gate goes at the FRONT of the run-out, so the clock stops as
    // the player arrives and the piece catches them — or at the cursor itself
    // when there was no room left for a run-out at all.
    const last = r.pieces[r.pieces.length - 1];
    assert.deepEqual(r.finishGate.at, r.bare ? r.cursor : last.at, `seed ${seed} finish gate`);
    assert.equal(r.finishGate.step, r.bare ? r.heading : last.step);
  }
});

test("a route that ran out of room says so", () => {
  // Two different endings a drawing should be able to tell apart: the dealer
  // reached its distance, or the deck had nothing left that fitted.
  const ends = golden.routes.map((w) => dealRoute(deck, w.seed, w.target));
  assert.ok(ends.every((r) => typeof r.deadEnd === "boolean" && typeof r.bare === "boolean"));
  // The platform is not a piece any more, so "bare" can no longer mean "the pad
  // and a gate": every route deals real course first, and a bare one is a real
  // route that ran out of room for its run-out.
  assert.ok(ends.every((r) => r.pieces.length >= 1), "a route always deals at least one piece");
  assert.ok(ends.some((r) => r.bare), "the golden set should contain gate-only finishes");
  assert.ok(ends.every((r) => !r.bare || r.pieces.length >= 1));
  // Squeezing the distance past the tile ceiling ends routes on room, not on
  // distance, which is exactly when the flag has to fire.
  const squeezed = dealRoute(deck, 3, 1_000_000);
  assert.ok(squeezed.pieces.length >= MAX_TILES - 1 || squeezed.deadEnd,
    "an unreachable target ends on the tile ceiling or on a dead end");
});
