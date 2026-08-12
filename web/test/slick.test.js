// Tests for slick (icy floor) map tagging: the bsp.js brushside measurement and
// the weapons.js slick token/threshold helpers.
//
// The BSPs here are synthesised rather than read from a real .pk3 so the suite
// stays hermetic. They are built to exercise the things that actually broke
// during development: the IBSP-vs-raven brushside stride, sky/trigger/nodraw
// sides inflating the denominator, and the coincident slick overlay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlick } from "../bsp.js";
import { tokenToCode, isSlick, isStrafe, SLICK_CODE, SLICK_MIN_FRAC } from "../weapons.js";

const SURF_SLICK = 0x2, SURF_SKY = 0x4, SURF_NODRAW = 0x80;
const CONTENTS_SOLID = 1, CONTENTS_TRIGGER = 0x40000000;

// Build a BSP carrying only the lumps parseSlick reads: 1 (shaderrefs),
// 2 (planes), 8 (brushes), 9 (brushsides).
//
//   shaders: [{ name, flags, contents }]
//   boxes:   [{ x0,y0,z0, x1,y1,z1, top, side }]  shader index for the top face
//                                                 and for the other five
//   magic:   "IBSP" (8-byte brushsides) or "FBSP" (12-byte, BSP_RAVEN)
function makeBsp({ shaders, boxes, magic = "IBSP" }) {
  const BS_STRIDE = magic === "IBSP" ? 8 : 12;
  const HEADER = 8 + 18 * 8;

  // Each box contributes 6 outward-facing planes, in the order the sides use.
  const planes = [];
  const sides = [];   // { planenum, shadernum }
  const brushes = [];
  for (const b of boxes) {
    const first = sides.length;
    const faces = [
      { n: [1, 0, 0], d: b.x1, sh: b.side },
      { n: [-1, 0, 0], d: -b.x0, sh: b.side },
      { n: [0, 1, 0], d: b.y1, sh: b.side },
      { n: [0, -1, 0], d: -b.y0, sh: b.side },
      { n: [0, 0, 1], d: b.z1, sh: b.top },   // the walkable top face
      { n: [0, 0, -1], d: -b.z0, sh: b.side },
    ];
    for (const f of faces) {
      sides.push({ planenum: planes.length, shadernum: f.sh });
      planes.push(f);
    }
    brushes.push({ first, count: faces.length, shadernum: 0 });
  }

  const shOff = HEADER;
  const plOff = shOff + shaders.length * 72;
  const brOff = plOff + planes.length * 16;
  const bsOff = brOff + brushes.length * 12;
  const buf = Buffer.alloc(bsOff + sides.length * BS_STRIDE);

  buf.write(magic, 0, "latin1");
  buf.writeInt32LE(magic === "IBSP" ? 46 : 1, 4);
  const setLump = (i, off, len) => {
    buf.writeInt32LE(off, 8 + i * 8);
    buf.writeInt32LE(len, 8 + i * 8 + 4);
  };
  setLump(1, shOff, shaders.length * 72);
  setLump(2, plOff, planes.length * 16);
  setLump(8, brOff, brushes.length * 12);
  setLump(9, bsOff, sides.length * BS_STRIDE);

  shaders.forEach((s, i) => {
    const o = shOff + i * 72;
    buf.write(s.name.slice(0, 63), o, "latin1");
    buf.writeInt32LE(s.flags, o + 64);
    buf.writeInt32LE(s.contents, o + 68);
  });
  planes.forEach((p, i) => {
    const o = plOff + i * 16;
    buf.writeFloatLE(p.n[0], o);
    buf.writeFloatLE(p.n[1], o + 4);
    buf.writeFloatLE(p.n[2], o + 8);
    buf.writeFloatLE(p.d, o + 12);
  });
  brushes.forEach((b, i) => {
    const o = brOff + i * 12;
    buf.writeInt32LE(b.first, o);
    buf.writeInt32LE(b.count, o + 4);
    buf.writeInt32LE(b.shadernum, o + 8);
  });
  sides.forEach((s, i) => {
    const o = bsOff + i * BS_STRIDE;
    buf.writeInt32LE(s.planenum, o);
    buf.writeInt32LE(s.shadernum, o + 4);
    if (BS_STRIDE === 12) buf.writeInt32LE(0, o + 8); // rdbrushside_t surfacenum
  });
  return buf;
}

const SOLID = { name: "textures/base/floor", flags: 0, contents: CONTENTS_SOLID };
const SLICK = { name: "textures/common/slick", flags: SURF_SLICK | SURF_NODRAW, contents: CONTENTS_SOLID };
const CAULK = { name: "textures/common/caulk", flags: SURF_NODRAW, contents: CONTENTS_SOLID };
const SKY = { name: "textures/skies/sky", flags: SURF_SKY, contents: CONTENTS_SOLID };
const TRIGGER = { name: "textures/common/trigger", flags: SURF_NODRAW, contents: CONTENTS_TRIGGER };

const box = (x0, x1, top, side = 0) => ({ x0, y0: 0, z0: 0, x1, y1: 128, z1: 16, top, side });

test("a fully slick floor measures 100%", () => {
  const r = parseSlick(makeBsp({ shaders: [SOLID, SLICK], boxes: [box(0, 128, 1)] }));
  assert.equal(r.frac, 1);
  assert.equal(r.brushes, 1);
});

test("a floor with no slick measures 0%", () => {
  const r = parseSlick(makeBsp({ shaders: [SOLID, SLICK], boxes: [box(0, 128, 0)] }));
  assert.equal(r.frac, 0);
  assert.equal(r.brushes, 0);
});

test("half a floor slick measures about half", () => {
  const r = parseSlick(makeBsp({
    shaders: [SOLID, SLICK],
    boxes: [box(0, 128, 1), box(128, 256, 0)],
  }));
  assert.ok(Math.abs(r.frac - 0.5) < 0.02, `expected ~0.5, got ${r.frac}`);
});

// The raven stride is the trap: FBSP/RBSP brushsides carry an extra surfacenum,
// so reading them at IBSP's 8-byte stride garbles every shadernum.
test("FBSP (raven) brushside stride reads the same as IBSP", () => {
  const shaders = [SOLID, SLICK];
  const boxes = [box(0, 128, 1), box(128, 256, 0)];
  const ibsp = parseSlick(makeBsp({ shaders, boxes, magic: "IBSP" }));
  const fbsp = parseSlick(makeBsp({ shaders, boxes, magic: "FBSP" }));
  assert.equal(fbsp.frac, ibsp.frac);
  assert.ok(fbsp.frac > 0);
});

// A nodraw slick brush laid exactly on top of the visible floor is how mappers
// actually build these. Counting both surfaces would halve the score.
test("a coincident slick overlay does not dilute the floor it covers", () => {
  const overlay = { x0: 0, y0: 0, z0: 0, x1: 128, y1: 128, z1: 16, top: 1, side: 1 };
  const floor = box(0, 128, 0);
  const r = parseSlick(makeBsp({ shaders: [SOLID, SLICK], boxes: [floor, overlay] }));
  assert.equal(r.frac, 1, "the overlaid floor should read fully slick");
});

test("sky, trigger and caulk faces are not counted as floor", () => {
  // One slick box plus three same-size boxes of pure scaffolding alongside it.
  // If any of those counted, the fraction would drop well below 1.
  const r = parseSlick(makeBsp({
    shaders: [SOLID, SLICK, CAULK, SKY, TRIGGER],
    boxes: [box(0, 128, 1), box(128, 256, 2), box(256, 384, 3), box(384, 512, 4)],
  }));
  assert.equal(r.frac, 1);
});

test("a vertical slick wall is not floor", () => {
  // Slick on the SIDE faces only; the top is plain. Nothing walkable is slick.
  const r = parseSlick(makeBsp({
    shaders: [SOLID, SLICK],
    boxes: [{ x0: 0, y0: 0, z0: 0, x1: 128, y1: 128, z1: 16, top: 0, side: 1 }],
  }));
  assert.equal(r.frac, 0);
});

test("parseSlick rejects non-BSP and truncated buffers instead of throwing", () => {
  assert.equal(parseSlick(null), null);
  assert.equal(parseSlick(Buffer.alloc(0)), null);
  assert.equal(parseSlick(Buffer.from("not a bsp at all, really")), null);
  const good = makeBsp({ shaders: [SOLID, SLICK], boxes: [box(0, 128, 1)] });
  // A lump directory pointing past EOF is a real thing in this map pool.
  const corrupt = Buffer.from(good);
  corrupt.writeInt32LE(0x7ffffff0, 8 + 9 * 8);
  assert.equal(parseSlick(corrupt), null);
});

test("slick tokens resolve to the sl tag", () => {
  for (const tok of ["sl", "slick", "SLICK", "ice", "icy"]) {
    assert.equal(tokenToCode(tok), SLICK_CODE, `${tok} should resolve to sl`);
  }
  assert.equal(tokenToCode("rl"), "rl");
  assert.equal(tokenToCode("nonsense"), null);
});

test("isSlick thresholds on the measured fraction", () => {
  assert.equal(isSlick(0), false);
  assert.equal(isSlick(SLICK_MIN_FRAC - 0.001), false);
  assert.equal(isSlick(SLICK_MIN_FRAC), true);
  assert.equal(isSlick(1), true);
  assert.equal(isSlick(null), false);
  assert.equal(isSlick(undefined), false);
});

// The sl tag rides in the same code list as the weapons, so the strafe rule has
// to ignore it — otherwise every slick map silently drops out of randmap strafe.
test("the slick tag does not stop a map being a strafe map", () => {
  assert.equal(isStrafe([]), true);
  assert.equal(isStrafe(["gb"]), true);
  assert.equal(isStrafe([SLICK_CODE]), true);
  assert.equal(isStrafe(["gb", SLICK_CODE]), true);
  assert.equal(isStrafe(["rl", SLICK_CODE]), false);
});
