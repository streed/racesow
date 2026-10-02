// The map editor's piece model (public/assets/js/mapgen-pieces.js).
//
// The editor's promise is that its controls cannot produce a spec the
// generator refuses on ranges: every slider is bounded by limits(), and every
// edit goes through fix(). That is checked here against the generator's own
// rules (mapgen-course.js, itself pinned to tools/mapgen by
// mapgen-course.test.js): thousands of random edits, each fixed, each laid out
// between two straights, must come back with no problems at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as mg from "../public/assets/js/mapgen-course.js";
import { PIECES, GROUPS, limits, fix, slug, STARTERS, adopt, chipLabel, HOTBAR, HOTKEYS, mirror, courseKey } from "../public/assets/js/mapgen-pieces.js";

const WIDTHS = [256, 320, 384, 448, 512, 640, 768];
const between = (seg, width) => ({
  name: "gen_test", title: "Test", width,
  segments: [{ type: "straight", length: 512 }, seg, { type: "straight", length: 512 }],
});

// A tiny deterministic generator, so a failure names a reproducible case.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

test("the palette lists every piece the spec has, once", () => {
  const listed = GROUPS.flatMap(([, keys]) => keys).sort();
  assert.deepEqual(listed, [...mg.SEGMENT_TYPES].sort());
  assert.deepEqual(Object.keys(PIECES).sort(), [...mg.SEGMENT_TYPES].sort());
});

test("every new piece is buildable at every width it allows", () => {
  for (const w of WIDTHS) {
    for (const [kind, p] of Object.entries(PIECES)) {
      if (p.needs && p.needs(w)) continue;
      for (const ice of [false, true]) {
        const seg = fix({ ...p.make(w), ...(ice ? { ice: true } : {}) }, w);
        const { problems } = mg.build(between(seg, w));
        assert.deepEqual(problems, [], `${kind} at width ${w}${ice ? " on ice" : ""}: ${JSON.stringify(seg)}`);
        assert.equal(!!seg.ice, ice && mg.ICEABLE.includes(kind), `${kind} ice flag`);
      }
    }
  }
});

test("a piece the width cannot hold says so", () => {
  assert.ok(PIECES.split.needs(256));
  assert.equal(PIECES.split.needs(384), null);
  assert.equal(PIECES.slalom.needs(256), null);
});

test("anything a control can set, fixed, is accepted", () => {
  const rand = rng(20261002);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  for (let n = 0; n < 4000; n++) {
    const w = pick(WIDTHS);
    const kind = pick(mg.SEGMENT_TYPES);
    if (PIECES[kind].needs && PIECES[kind].needs(w)) continue;
    // Wild values, including out-of-range ones a typed number box can send.
    const raw = {
      type: kind,
      length: Math.round(rand() * 6000 - 500),
      rise: Math.round(rand() * 2400 - 1200),
      drop: Math.round(rand() * 1600 - 400),
      radius: Math.round(rand() * 3000),
      count: Math.round(rand() * 14 - 1),
      beam_width: Math.round(rand() * 800),
      angle: pick([45, 90, 135, 180, 60]),
      direction: pick(["left", "right", "none"]),
      open: rand() < 0.3, ice: rand() < 0.3, shortcut: rand() < 0.3,
    };
    const seg = fix(mg.normalize({ segments: [raw] }).segments[0], w);
    // A shortcut needs long straights both sides; the course here has them.
    const spec = between(seg, w);
    const problems = mg.validate(spec);
    assert.deepEqual(problems, [], `case ${n}: ${JSON.stringify(raw)} -> ${JSON.stringify(seg)} at ${w}`);
    // And every field sits inside the limits the slider shows.
    const L = limits(seg, w);
    for (const [k, [lo, hi]] of Object.entries(L)) {
      assert.ok(seg[k] >= lo && seg[k] <= hi, `case ${n}: ${k}=${seg[k]} outside [${lo}, ${hi}]`);
    }
  }
});

test("dependent ranges follow the field they depend on", () => {
  assert.equal(limits({ type: "gap", drop: 0 }, 384).length[1], Math.floor(mg.maxGap(0)));
  assert.ok(limits({ type: "gap", drop: 256 }, 384).length[1] > limits({ type: "gap", drop: 0 }, 384).length[1]);
  assert.equal(limits({ type: "ramp", length: 512 }, 384).rise[1], Math.floor(mg.maxRampSlope() * 512));
  assert.equal(limits({ type: "turn" }, 512).radius[0], mg.turnRadiusMin(512));
  // A steeper ramp than its new length allows is flattened, not rejected.
  assert.equal(fix({ type: "ramp", length: 256, rise: -1000 }, 384).rise, -Math.floor(mg.maxRampSlope() * 256));
  // Narrowing the corridor widens a turn that would pinch.
  assert.equal(fix({ type: "turn", direction: "left", angle: 90, radius: 200 }, 768).radius, mg.turnRadiusMin(768));
  // Flags a piece cannot carry are dropped.
  assert.deepEqual(fix({ type: "beam", length: 512, beam_width: 64, ice: true, open: true }, 384),
    { type: "beam", length: 512, beam_width: 64 });
  assert.equal(fix({ type: "turn", direction: "left", angle: 90, radius: 512, shortcut: true }, 384).shortcut, undefined);
});

test("the starter courses build", () => {
  for (const [k, s] of Object.entries(STARTERS)) {
    const { problems } = mg.build({ name: slug(s.title), ...s });
    assert.deepEqual(problems, [], k);
  }
  assert.ok(STARTERS.ice_run.segments.some((s) => s.ice));
});

test("adopt takes a model reply as it comes", () => {
  const flat = { type: "ramp", length: 512, direction: "none", angle: 0, radius: 0, rise: -9999,
    drop: 0, shortcut: false, count: 0, beam_width: 0, open: false, ice: true };
  const [s, notes] = adopt({ name: "gen_x", title: "Slick Hill", width: 9000,
    segments: [flat, { type: "teleporter" }] });
  assert.equal(s.width, mg.WIDTH_MAX);
  assert.equal(s.title, "Slick Hill");
  assert.deepEqual(s.segments, [{ type: "ramp", length: 512, rise: -Math.floor(mg.maxRampSlope() * 512), ice: true }]);
  assert.equal(notes.length, 2, notes.join(" | "));
  assert.throws(() => adopt([]), /segments/);
  assert.throws(() => adopt({ title: "x" }), /segments/);
  const [blank] = adopt({ segments: [] });
  assert.equal(blank.segments.length, 1);
  assert.equal(blank.title, "My Course");
});

test("names come from titles", () => {
  assert.equal(slug("Glacier Run!"), "gen_glacier_run");
  assert.equal(slug("?"), "gen_my_course");
  assert.match(slug("A".repeat(40)), mg.NAME_RE);
});

test("chips read at a glance", () => {
  assert.equal(chipLabel({ type: "turn", direction: "right", angle: 135 }), "R 135°");
  assert.equal(chipLabel({ type: "ramp", rise: -256 }), "↓ 256");
  assert.equal(chipLabel({ type: "gap", length: 128, drop: -20 }), "128 ↑20");
});

test("the hotbar covers every piece once, each with its own key", () => {
  assert.deepEqual([...HOTBAR].sort(), [...mg.SEGMENT_TYPES].sort());
  assert.equal(new Set(HOTKEYS).size, HOTBAR.length);
});

test("mirroring flips sides and nothing else, and twice is the identity", () => {
  const t = { type: "turn", direction: "left", angle: 90, radius: 512, ice: true };
  assert.deepEqual(mirror(t), { ...t, direction: "right" });
  assert.deepEqual(mirror(mirror(t)), t);
  assert.deepEqual(mirror({ type: "straight", length: 512 }), { type: "straight", length: 512 });
  // A mirrored course is still buildable, and turns the other way.
  const s = STARTERS.first_light;
  const m = { ...s, segments: s.segments.map(mirror) };
  const a = mg.build({ name: "gen_aa", ...s }).course, b = mg.build({ name: "gen_aa", ...m }).course;
  assert.ok(Math.abs(a.length - b.length) < 1e-6);
  const end = (c) => c.route[c.route.length - 1];
  assert.ok(Math.abs(end(a)[1] + end(b)[1]) < 1e-6, "the route ends reflected across the start line");
});

test("a course's key changes with any piece, not with its title", () => {
  const s = STARTERS.first_light;
  assert.equal(courseKey(s), courseKey({ ...s, title: "Another" }));
  assert.notEqual(courseKey(s), courseKey({ ...s, segments: [...s.segments, { type: "straight", length: 128 }] }));
  assert.notEqual(courseKey(s), courseKey({ ...s, width: 400 }));
});
