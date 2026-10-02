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

// The property that matters, and it is per-tier: whatever a control can send,
// pulled into a band by fix(), is accepted by the validator for THAT band.
// Mixing the two would be meaningless — the open band exists precisely to
// hold values the strict one refuses.
test("anything a control can set, fixed, is accepted", () => {
  const rand = rng(20261002);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  for (let n = 0; n < 8000; n++) {
    const rules = pick(["strict", "open"]);
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
      angle: pick([45, 90, 135, 180, 60, 37]),
      direction: pick(["left", "right", "none"]),
      height: Math.round(rand() * 5000),
      gate: Math.round(rand() * 900),
      ledge_width: Math.round(rand() * 800),
      spacing: Math.round(rand() * 5000),
      curve: Math.round(rand() * 800 - 400),
      shift: Math.round(rand() * 9000 - 4500),
      rotate: Math.round(rand() * 400 - 200),
      open: rand() < 0.3, ice: rand() < 0.3, shortcut: rand() < 0.3,
    };
    const seg = fix(mg.normalize({ segments: [raw] }).segments[0], w, rules);
    // A shortcut needs long straights both sides; the course here has them.
    const spec = between(seg, w);
    const problems = mg.validate(spec, rules);
    assert.deepEqual(problems, [],
      `case ${n} (${rules}): ${JSON.stringify(raw)} -> ${JSON.stringify(seg)} at ${w}`);
    // And every field sits inside the limits that band's control shows.
    const L = limits(seg, w, rules);
    for (const [k, [lo, hi]] of Object.entries(L)) {
      // A nudge a piece never asked for is absent, not zero.
      if (mg.NUDGE.includes(k) && !(k in seg)) continue;
      assert.ok(seg[k] >= lo && seg[k] <= hi,
        `case ${n} (${rules}): ${k}=${seg[k]} outside [${lo}, ${hi}]`);
    }
  }
});

test("dependent ranges follow the field they depend on", () => {
  const S = (seg, w = 384) => limits(seg, w, "strict");
  assert.equal(S({ type: "gap", drop: 0 }).length[1], Math.floor(mg.maxGap(0)));
  assert.ok(S({ type: "gap", drop: 256 }).length[1] > S({ type: "gap", drop: 0 }).length[1]);
  assert.equal(S({ type: "ramp", length: 512 }).rise[1], Math.floor(mg.maxRampSlope() * 512));
  assert.equal(S({ type: "turn" }, 512).radius[0], mg.turnRadiusMin(512));
  // A steeper ramp than its new length allows is flattened, not rejected.
  assert.equal(fix({ type: "ramp", length: 256, rise: -1000 }, 384, "strict").rise,
    -Math.floor(mg.maxRampSlope() * 256));
  // Narrowing the corridor widens a turn that would pinch.
  assert.equal(fix({ type: "turn", direction: "left", angle: 90, radius: 200 }, 768, "strict").radius,
    mg.turnRadiusMin(768));
  // Flags a piece cannot carry are dropped.
  assert.deepEqual(fix({ type: "beam", length: 512, beam_width: 64, ice: true, open: true }, 384),
    { type: "beam", length: 512, beam_width: 64 });
  assert.equal(fix({ type: "turn", direction: "left", angle: 90, radius: 512, shortcut: true }, 384).shortcut, undefined);
  // The shape pieces' own dependencies.
  assert.equal(S({ type: "stairs", count: 8 }).length[0], Math.max(mg.STRAIGHT_MIN, mg.STAIR_TREAD_MIN * 8));
  assert.equal(S({ type: "stairs", count: 4 }).rise[1], Math.floor(mg.STEP_SIZE * 4));
  assert.ok(S({ type: "platforms", count: 6 }).length[0] > S({ type: "platforms", count: 2 }).length[0]);
  assert.equal(S({ type: "pinch" }, 448).gate[1], 448 - 2 * mg.PINCH_BITE);
  assert.equal(S({ type: "ledge" }, 448).ledge_width[1], 448 - mg.LEDGE_CLEAR);
  assert.ok(S({ type: "bumps", count: 2, length: 1024 }).rise[1]
    > S({ type: "bumps", count: 8, length: 1024 }).rise[1]);
});

test("the open band is wider than the strict one, and both are offered", () => {
  const widerOrEqual = (a, b) => a[0] <= b[0] && a[1] >= b[1];
  let widened = 0;
  for (const kind of mg.SEGMENT_TYPES) {
    const seg = PIECES[kind].make(448);
    const strict = limits(seg, 448, "strict");
    const open = limits(seg, 448, "open");
    for (const k of Object.keys(strict)) {
      assert.ok(widerOrEqual(open[k], strict[k]),
        `${kind}.${k}: open [${open[k]}] is not at least strict [${strict[k]}]`);
      if (open[k][0] < strict[k][0] || open[k][1] > strict[k][1]) widened++;
    }
  }
  assert.ok(widened > 20, `only ${widened} fields widen in the open band`);
  // And the piece you get by clicking is the sane one: inside the strict band.
  for (const kind of mg.SEGMENT_TYPES) {
    const seg = PIECES[kind].make(448);
    if (PIECES[kind].needs && PIECES[kind].needs(448)) continue;
    assert.deepEqual(mg.validate(between(seg, 448), "strict"), [], `${kind} default is not strict-clean`);
  }
});

test("a nudge is kept, bounded, and flips when the piece is mirrored", () => {
  assert.equal(fix({ type: "straight", length: 512, shift: 200 }, 384, "strict").shift, 200);
  // Past the strict band it is pulled back; the open band keeps it.
  assert.equal(fix({ type: "straight", length: 512, shift: 1200 }, 384, "strict").shift, mg.STRICT_SHIFT_MAX);
  assert.equal(fix({ type: "straight", length: 512, shift: 1200 }, 384, "open").shift, 1200);
  // A piece with no nudge does not grow one.
  assert.equal("shift" in fix({ type: "straight", length: 512 }, 384), false);
  assert.equal("rotate" in fix({ type: "straight", length: 512 }, 384), false);
  // Mirroring reverses the side a nudge pushes to, and a pad run's curve.
  assert.deepEqual(mirror({ type: "straight", length: 512, shift: 200, rotate: -15 }),
    { type: "straight", length: 512, shift: -200, rotate: 15 });
  assert.deepEqual(mirror({ type: "strafepads", count: 4, spacing: 256, curve: 60 }),
    { type: "strafepads", count: 4, spacing: 256, curve: -60 });
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
  assert.equal(s.width, mg.tier("open").width[1]);
  assert.equal(s.title, "Slick Hill");
  // adopt repairs into the EDITOR's band, not the generator's, because this
  // is also how the editor reloads its own saved draft: pulling a deliberate
  // wide value back to the strict band would destroy work on every reload.
  const openSlope = mg.tier("open").slope;
  assert.deepEqual(s.segments, [{ type: "ramp", length: 512, rise: -Math.floor(openSlope * 512), ice: true }]);
  assert.equal(notes.length, 2, notes.join(" | "));
  assert.throws(() => adopt([]), /segments/);
});

test("a draft survives a reload with its wide values intact", () => {
  // The editor reloads its draft through adopt(), so anything a person could
  // deliberately set has to come back unchanged — this is the regression that
  // would quietly eat someone's course.
  const wide = { name: "gen_wide", title: "Wide", width: 1200, segments: [
    { type: "straight", length: 9000, shift: 1200, rotate: 120 },
    { type: "turn", direction: "left", angle: 37, radius: 6000 },
    { type: "gap", length: 4000, drop: 2000 },
    { type: "strafepads", count: 40, spacing: 2000, curve: 200 },
    { type: "tunnel", length: 5000, height: 3000 },
  ] };
  const [back] = adopt(wide);
  assert.equal(back.width, 1200);
  assert.deepEqual(back.segments, wide.segments);
  // ...and it is still a course the editor's own tier will build.
  assert.deepEqual(mg.validate({ name: "gen_wide", title: "Wide", ...back }, "open"), []);
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

test("the hotbar is a stable subset, each piece with its own key", () => {
  // There are more pieces than number keys, so the hotbar is deliberately a
  // subset — the eleven already in people's fingers. What it must not be is
  // ambiguous: one key each, every entry a real piece, and every piece
  // reachable from the palette whether or not it has a key.
  assert.equal(new Set(HOTBAR).size, HOTBAR.length, "a piece twice on the hotbar");
  assert.equal(new Set(HOTKEYS).size, HOTBAR.length, "a key without its own piece");
  for (const k of HOTBAR) assert.ok(mg.SEGMENT_TYPES.includes(k), `${k} is not a piece`);
  const palette = new Set(GROUPS.flatMap(([, ks]) => ks));
  for (const k of mg.SEGMENT_TYPES) assert.ok(palette.has(k), `${k} is in no palette group`);
  assert.equal(palette.size, mg.SEGMENT_TYPES.length, "a palette entry that is not a piece");
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
