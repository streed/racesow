// The browser's copy of the map generator, pinned to the generator.
//
// The map editor (/mapgen/editor) draws a course and lists its problems with
// public/assets/js/mapgen-course.js, a port of tools/mapgen's physics.py,
// spec.py and layout.py. That is only honest while it says what the Python
// says, so fixtures/mapgen-layout-golden.json.gz is dumped by
// tools/mapgen/golden.py: every example course plus hand-made ones that reach
// each piece, each rule and each message. Every case must come back with the
// same problems, word for word, and an accepted course with the same brushes,
// entities, centre line and report facts. Coordinates are compared to the
// fixture's 3 decimals; nothing else has a tolerance.
//
// tools/mapgen/test_mapgen.py runs `golden.py --check`, so the Python side
// cannot change without the fixture (and so this test) noticing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as mg from "../public/assets/js/mapgen-course.js";

const golden = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/mapgen-layout-golden.json.gz", import.meta.url))));

const TOL = 2e-3;
function near(actual, expected, where) {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", `${where}: expected a number, got ${actual}`);
    assert.ok(Math.abs(actual - expected) <= TOL, `${where}: ${actual} != ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: expected a list`);
    assert.equal(actual.length, expected.length, `${where}: length`);
    expected.forEach((e, i) => near(actual[i], e, `${where}[${i}]`));
  } else if (expected && typeof expected === "object") {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${where}: keys`);
    for (const k of Object.keys(expected)) near(actual[k], expected[k], `${where}.${k}`);
  } else {
    assert.equal(actual, expected, where);
  }
}

// The CORNERS, not just the footprint: a rolled or pitched brush is not its
// footprint, and pinning the footprint alone would let the port tilt a piece
// differently — or not at all — and still pass.
const prism = (p) => {
  const [bot, top] = p.corners();
  return [p.tex, p.heading, p.zmin, p.top0, p.gx, p.gy, p.poly.flat(), bot.concat(top).flat()];
};

test("the physics windows match", () => {
  const c = golden.constants;
  assert.deepEqual(mg.WALLCLIMB_RISE, c.WALLCLIMB_RISE);
  assert.deepEqual(mg.WALLGAP_DROP, c.WALLGAP_DROP);
  assert.equal(mg.splitHole(), c.split_hole);
  near(mg.maxRise(), c.max_rise, "max_rise");
  for (const [d, v] of Object.entries(c.max_gap)) near(mg.maxGap(Number(d)), v, `max_gap(${d})`);
  for (const [d, v] of Object.entries(c.wallgap_window)) assert.deepEqual(mg.wallgapWindow(Number(d)), v, `wallgap ${d}`);
  for (const [d, v] of Object.entries(c.dash_window)) assert.deepEqual(mg.dashWindow(Number(d)), v, `dash ${d}`);
});

test("the fixture covers both verdicts", () => {
  const ok = golden.cases.filter((c) => !c.problems.length);
  assert.ok(ok.length >= 10, "accepted courses");
  assert.ok(golden.cases.length - ok.length >= 15, "refused courses");
  assert.ok(ok.some((c) => c.course.world.some((p) => p[0] === "ice")), "an icy course");
});

test("the fixture covers both rule tiers, and what separates them", () => {
  const byTier = (r) => golden.cases.filter((c) => c.rules === r);
  assert.ok(byTier("strict").length >= 20, "strict cases");
  assert.ok(byTier("open").length >= 20, "open cases");
  // Every piece the editor can lay is laid somewhere in here.
  const laid = new Set(golden.cases.flatMap((c) => (c.spec.segments || [])
    .filter((sg) => sg && typeof sg === "object").map((sg) => sg.type)));
  for (const t of mg.SEGMENT_TYPES) assert.ok(laid.has(t), `${t} is never laid`);
  // The nudge fields reach the fixture too.
  const nudged = golden.cases.some((c) => (c.spec.segments || [])
    .some((sg) => sg && (sg.shift || sg.rotate)));
  assert.ok(nudged, "a shifted or rotated piece");
  // ...and the open tier really does accept courses the strict one refuses.
  const strictRefused = new Set(byTier("strict").filter((c) => c.problems.length).map((c) => c.label));
  const openTook = byTier("open").filter((c) => !c.problems.length
    && strictRefused.has(c.label.replace(/^open_/, "")));
  assert.ok(openTook.length >= 3, "courses the open tier takes and the strict one will not");
  // ...and says what it found instead of refusing.
  assert.ok(openTook.some((c) => c.notes && c.notes.length), "a course taken with notes");
});

for (const kase of golden.cases) {
  test(`${kase.label}: ${kase.problems.length ? "refused for the same reasons" : "the same course"}`, () => {
    // Each case names its rule tier: the editor lays out in the open one and
    // the generator in the strict one, and the port has to agree on both.
    const { problems, course, notes } = mg.build(structuredClone(kase.spec), kase.rules);
    assert.deepEqual(problems, kase.problems);
    if (kase.problems.length) return;
    // In the open tier a pieces-fit-together finding becomes a note rather
    // than a refusal, so the notes are part of what has to match.
    assert.deepEqual(notes, kase.notes, "notes");
    const want = kase.course;
    near(course.length, want.length, "length");
    assert.equal(course.world.length, want.world.length, "brush count");
    course.world.forEach((p, i) => near(prism(p), want.world[i], `world[${i}]`));
    assert.equal(course.entities.length, want.entities.length, "entity count");
    course.entities.forEach(([keys, brushes], i) => {
      near(keys, want.entities[i][0], `entity[${i}]`);
      near(brushes.map(prism), want.entities[i][1], `entity[${i}] brushes`);
    });
    near(course.route, want.route, "route");
    near(course.landmarks, want.landmarks, "landmarks");
    near(course.shortcuts, want.shortcuts, "shortcuts");
    near(course.features, want.features, "features");
    near(course.overpasses, want.overpasses, "overpasses");
    near(course.cuts, want.cuts, "cuts");
    near(course.autoCheckpoints, want.auto_checkpoints, "auto checkpoints");
    near(course.bounds, want.bounds, "bounds");
  });
}

test("normalize keeps what a human would write", () => {
  const flat = { type: "turn", length: 0, direction: "left", angle: 90, radius: 512, rise: 0, drop: 0,
    shortcut: false, count: 0, beam_width: 0, open: false, ice: true };
  assert.deepEqual(mg.normalize({ name: "gen_x", title: "X", width: 384, segments: [flat] }), {
    name: "gen_x", title: "X", width: 384,
    segments: [{ type: "turn", direction: "left", angle: 90, radius: 512, ice: true }],
  });
});

test("preview draws while the words are still being typed", () => {
  const spec = { name: "", title: "", width: 384, segments: [{ type: "straight", length: 512 }] };
  assert.ok(mg.build(spec).problems.length);
  const p = mg.preview(spec);
  assert.deepEqual(p.problems, []);
  assert.ok(p.course.world.length > 0);
  // Every brush the walk laid knows its segment (-1 = start room), so the
  // editor can pick a piece by clicking it; only the sky shell has none.
  assert.ok(p.course.world.every((b) => b.seg !== null || b.tex === "sky"));
  assert.ok(p.course.world.some((b) => b.seg === 0));
});

test("python-isms", () => {
  assert.equal(mg.pyRound(2.5), 2);
  assert.equal(mg.pyRound(3.5), 4);
  assert.equal(mg.pyRound(-0.5), 0);
  assert.equal(mg.pymod(-90, 360), 270);
  assert.equal(mg.pymod(-1e-14, 360), 360, "CPython does not reduce twice");
  assert.equal(mg.pyRepr("it's"), '"it\'s"');
  assert.equal(mg.pyRepr(null), "None");
  assert.equal(mg.pyRepr([1, "a"]), "[1, 'a']");
});
