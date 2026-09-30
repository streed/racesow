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
// was dumped by the Python model of the same dealer (sim.py, written against
// metamap.as) inside the racesow-mapgen image: 340 seeds at the default
// distance, four of them re-dealt at three others, and the deck manifest they
// were dealt from verbatim, so the fixture pins the file as well as the file's
// reader. Every one of those seeds has to come back piece for piece — a single
// mismatched piece is a failure, never a tolerance — which also means a deck
// rebuild that changes a tile is expected to fail here until the vectors are
// dumped again from the new pack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDeck, dealRoute, xorshift32, exitOf, headingOf,
  F_START, F_FINISH, FENCE_MARGIN, MAX_TILES,
} from "../public/assets/js/random-dealer.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/random-dealer-golden.json", import.meta.url), "utf8"));
const deck = parseDeck(golden.deck);

const names = (route) => route.pieces.map((p) => p.tile.name);
const track = (route) => route.pieces.map((p) => [p.at.x, p.at.y, p.at.z, p.step]);

test("the manifest reads the way the server's loader reads it", () => {
  assert.equal(deck.version, 1);
  assert.equal(deck.tiles.length, 78);
  assert.deepEqual(deck.play, { half: 13312, up: 2560, down: 1536 });
  assert.deepEqual(deck.gate, { model: 79, depth: 32, half: 208, height: 192 });

  // `tile 1 8 0 1024 0 0 0 -16 -208 -32 1024 208 256 1024 start start`
  const start = deck.tiles[deck.start];
  assert.equal(start.name, "start");
  assert.equal(start.kind, "start");
  assert.equal(start.model, 1);
  assert.equal(start.flags & F_START, F_START);
  assert.equal(start.weight, 0, "the start is placed by hand, never drawn");
  assert.deepEqual(start.mins, { x: -16, y: -208, z: -32 });
  assert.deepEqual(start.maxs, { x: 1024, y: 208, z: 256 });
  assert.equal(start.route, 1024);
  assert.equal(start.turn, 0);

  // Roomiest run-out first: the dealer walks the list, so a route that has
  // painted itself into a corner can still end on the short one.
  assert.equal(deck.finishes.length, 2);
  const outs = deck.finishes.map((i) => deck.tiles[i]);
  assert.ok(outs.every((t) => t.flags & F_FINISH));
  assert.ok(outs[0].route > outs[1].route, "finish tiles must be roomiest first");
});

test("every yaw in the deck is a whole 45-degree step", () => {
  // Tiles mate face to face; a fraction of a degree would be a seam a player
  // catches, so the loader treats a yaw off the grid as fatal.
  for (const t of deck.tiles) assert.ok(t.turn >= 0 && t.turn < 8 && Number.isInteger(t.turn), t.name);
  assert.throws(() => parseDeck("deck 1 1 384\nplay 1 1 1\ngate 1 1 1 1\n"
    + "tile 1 8 0 1024 0 0 30 0 0 0 1 1 1 1024 start start\n"), /not a multiple of 45/);
});

test("a manifest version the servers would refuse is refused here too", () => {
  // metamap.as aborts the whole load on the version token, which makes the map
  // unplayable. Drawing a route off a manifest a server would not read is the
  // one failure worse than drawing nothing.
  assert.throws(() => parseDeck(golden.deck.replace("deck 1 78 384", "deck 2 78 384")), /version 2/);
});

test("unknown line heads are ignored, the way the loader ignores them", () => {
  // The head chain in RACE_MetaLoadDeck has no trailing else, which is what
  // lets the manifest grow new line kinds without stranding deployed servers.
  // `face` rows are that in practice: the dealer needs none of them.
  const withNoise = golden.deck
    + "piece 3 something entirely new\n"
    + "// a comment line yields no first token at all\n"
    + "\n";
  const noisy = parseDeck(withNoise);
  assert.equal(noisy.tiles.length, deck.tiles.length);
  assert.deepEqual(dealRoute(noisy, 7).pieces.map((p) => p.tile.name), names(dealRoute(deck, 7)));

  // Tokens appended past index 16 of a tile line are never read either.
  const wider = parseDeck(golden.deck.replace(
    "tile 1 8 0 1024 0 0 0 -16 -208 -32 1024 208 256 1024 start start",
    "tile 1 8 0 1024 0 0 0 -16 -208 -32 1024 208 256 1024 start start 1 2 3"));
  assert.equal(wider.tiles[wider.start].name, "start");
  assert.equal(wider.tiles[wider.start].route, 1024);
});

test("the walkable footprints ride along with their tile", () => {
  // The dealer reads none of these — a tile's box is all it takes to fit one
  // piece onto the next — but a plan of a route is drawn from them, so the
  // manifest gets exactly one reader on this side.
  assert.ok(deck.tiles.every((t) => t.faces.length > 0), "every tile publishes a footprint");
  for (const f of deck.tiles[deck.start].faces) {
    assert.ok(f.points.length >= 3);
    assert.ok(f.points.every((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])));
  }
  // The declared point count is what makes a face line self-checking.
  assert.throws(() => parseDeck(golden.deck + "face 1 floor 0 4 0 0 1 0 1 1\n"), /declares 4 points/);
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
    assert.equal(r.pieces[0].index, deck.start, `seed ${seed} starts on the start pad`);
    assert.ok(r.pieces.length <= MAX_TILES, `seed ${seed} is over the entity budget`);
    assert.equal(r.bare, !(r.pieces[r.pieces.length - 1].tile.flags & F_FINISH),
      `seed ${seed}: only a gate-only finish ends on something that is not a run-out`);

    let total = 0;
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

test("both gates sit where the server spawns them", () => {
  for (const seed of [1, 7, 42, 1234, 99999]) {
    const r = dealRoute(deck, seed, 16000);
    // The start gate is at the END of the start pad, so the clock starts as the
    // player leaves it with a full pad of run-up behind them.
    const pad = r.pieces[0];
    assert.deepEqual(r.startGate.at, exitOf(pad.at, pad.tile, pad.step), `seed ${seed} start gate`);
    assert.equal(r.startGate.step, headingOf(pad.tile, pad.step));
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
  assert.ok(ends.every((r) => !r.bare || r.pieces.length > 1), "a route is never bare on the start pad alone");
  // Squeezing the distance past the tile ceiling ends routes on room, not on
  // distance, which is exactly when the flag has to fire.
  const squeezed = dealRoute(deck, 3, 1_000_000);
  assert.ok(squeezed.pieces.length >= MAX_TILES - 1 || squeezed.deadEnd,
    "an unreachable target ends on the tile ceiling or on a dead end");
});
