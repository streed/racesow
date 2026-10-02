// The map generator's course rules and geometry, in the browser.
//
// A line-for-line port of tools/mapgen/physics.py, spec.py and layout.py, so
// the map editor (/mapgen/editor) can draw the brushes the generator will
// compile and report the problems it will report, as the course is edited,
// without a round trip. The server uses it too, to refuse an editor spec the
// worker would refuse.
//
// Nothing here is a second opinion: the Python is the generator, and this file
// is only worth anything while it agrees with it. That is pinned the same way
// random-dealer.js is pinned to metamap.as: test/fixtures/mapgen-layout-golden.json
// is dumped by tools/mapgen/golden.py, and test/mapgen-course.test.js lays
// every case out again here and must get the same problems, word for word, and
// the same brushes. tools/mapgen/test_mapgen.py fails if the fixture falls
// behind the Python, so a change to the generator cannot land without this
// file being brought along.
//
// The few places Python and JavaScript disagree are spelled out where they
// bite: % on negatives (pymod), round() to even (pyRound), and repr() in the
// messages (pyRepr).

/* ----------------------------- python-isms ------------------------------ */

const DEG = Math.PI / 180;     // math.radians: x * (pi / 180)
const RAD = 180 / Math.PI;     // math.degrees: x * (180 / pi)
const radians = (x) => x * DEG;
const degrees = (x) => x * RAD;
// a % n for floats, as CPython's float_rem does it: the result takes the
// sign of n, and is NOT reduced again, so -1e-14 % 360.0 is 360.0, not 0.
export function pymod(a, n) {
  let m = a % n;
  if (m !== 0 && (m < 0) !== (n < 0)) m += n;
  return m === 0 ? 0 : m;
}
const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
const int = (x) => Math.trunc(x);

// round(): halves go to the even neighbour.
export function pyRound(x, nd = 0) {
  const m = nd ? x * 10 ** nd : x;
  const f = Math.floor(m);
  const diff = m - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  const out = nd ? r / 10 ** nd : r;
  return out === 0 ? 0 : out;   // Python has no -0 int
}

// repr() of a JSON value, as the Python messages print it.
export function pyRepr(v) {
  if (v === undefined || v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let out = "";
    for (const ch of v) {
      const c = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === q) out += "\\" + q;
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
      else out += ch;
    }
    return q + out + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
}
const pyStr = (v) => (typeof v === "string" ? v : pyRepr(v));
const tupleRepr = (xs) => "(" + xs.map(pyRepr).join(", ") + ")";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const cmpTuple = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
};

/* ------------------------------- physics -------------------------------- */
// tools/mapgen/physics.py; every number there is cited to the engine source.

export const GRAVITY = 850.0;
export const JUMP_SPEED = 280.0;
export const RUN_SPEED = 320.0;
export const STEP_SIZE = 18.0;
export const JUMP_MARGIN = 0.8;
export const MIN_RUNUP = 192.0;
const GRAVITY_COMPENSATE = GRAVITY / 800.0;
export const DASH_SPEED = 451.0;
const DASH_UP = 174.0 * GRAVITY_COMPENSATE;
const WJ_UP = 330.0 * GRAVITY_COMPENSATE;
const WJ_BOUNCE = 0.3;
const DASH_MARGIN = 0.9;

export const jumpApex = () => (JUMP_SPEED * JUMP_SPEED) / (2.0 * GRAVITY);

export function airTime(drop) {
  const disc = JUMP_SPEED * JUMP_SPEED + 2.0 * GRAVITY * drop;
  if (disc < 0) return null;
  return (JUMP_SPEED + Math.sqrt(disc)) / GRAVITY;
}

export function maxGap(drop, speed = RUN_SPEED) {
  const t = airTime(drop);
  return t === null ? 0.0 : JUMP_MARGIN * speed * t;
}

export const maxRise = () => JUMP_MARGIN * jumpApex();
export const maxRampSlope = () => Math.tan(radians(30.0));

function flight(vz, drop) {
  const disc = vz * vz + 2.0 * GRAVITY * drop;
  if (disc < 0) return null;
  return (vz + Math.sqrt(disc)) / GRAVITY;
}

export function jumpReach(drop, speed = RUN_SPEED) {
  const t = flight(JUMP_SPEED, drop);
  return t === null ? 0.0 : speed * t;
}

export function dashReach(drop) {
  const t = flight(DASH_UP, drop);
  return t === null ? 0.0 : DASH_MARGIN * DASH_SPEED * t;
}

const wallJumpSpeed = (speed = RUN_SPEED) => speed / Math.sqrt(1.0 + WJ_BOUNCE * WJ_BOUNCE);

export function wallJumpReach(drop, speed = RUN_SPEED) {
  let best = 0.0;
  const apexT = JUMP_SPEED / GRAVITY;
  const after = wallJumpSpeed(speed);
  for (let i = 1; i < 201; i++) {
    const t1 = (2.0 * apexT * i) / 200;
    const z = JUMP_SPEED * t1 - 0.5 * GRAVITY * t1 * t1;
    const t2 = flight(WJ_UP, drop + z);
    if (t2 !== null) best = Math.max(best, speed * t1 + after * t2);
  }
  return JUMP_MARGIN * best;
}

export const plainClimb = () => jumpApex() + STEP_SIZE;
export const wallClimb = () => JUMP_MARGIN * (jumpApex() + (WJ_UP * WJ_UP) / (2.0 * GRAVITY));

/* --------------------------------- spec --------------------------------- */
// tools/mapgen/spec.py: field ranges.

export const SEGMENT_TYPES = ["straight", "turn", "ramp", "gap", "checkpoint", "slalom", "beam", "split",
  "wallclimb", "wallgap", "dash"];
export const OPENABLE = ["straight", "turn", "ramp", "gap"];
export const ICEABLE = ["straight", "turn", "ramp", "slalom"];
export const TURN_ANGLES = [45, 90, 135, 180];
export const NAME_RE = /^gen_[a-z0-9_]{2,36}$/;
export const TITLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 '&!?,:-]{0,38}[A-Za-z0-9!?'])?$/;
const NAME_RE_SRC = "^gen_[a-z0-9_]{2,36}$";

export const ROUTE_MAX = 40000;
export const WIDTH_MIN = 256, WIDTH_MAX = 768;
export const MAX_SEGMENTS = 64;
export const STRAIGHT_MIN = 128, STRAIGHT_MAX = 4096;
export const RAMP_MIN = 128, RAMP_MAX = 2048;
export const TURN_RADIUS_MAX = 2048;
export const GAP_MIN = 32;
export const DROP_MAX = 512;
export const SHORTCUT_MIN_LEG = 320;
export const SLALOM_GATE = 160;
export const SLALOM_FIN_MIN = 64;
export const SLALOM_SPACING = 256;
export const SLALOM_COUNT = [2, 12];
export const BEAM_MIN = 48;
export const BEAM_WALL_CLEAR = 64;
export const BEAM_MAX_LENGTH = 2048;
export const SPLIT_MOUTH = 160;
export const SPLIT_MEDIAN = 32;
export const SPLIT_LANE_MIN = 176;
const SPLIT_HOLE_FILL = 0.85;
export const SPLIT_RUNWAY = 192;
export const SPLIT_LANDING = 128;
export const SPLIT_COUNT = [1, 6];
export const WALLCLIMB_RISE = [int(plainClimb()) + 8, int(wallClimb())];
export const WALLCLIMB_MIN = 2 * int(MIN_RUNUP);
export const WALLGAP_DROP = [-WALLCLIMB_RISE[1], -WALLCLIMB_RISE[0]];
export const WALLGAP_MIN = 64;
export const WALL_RUNUP = 384;
export const DASH_DROP = [384, 1024];
export const DASH_PAD = 192;
export const GAP_LENGTH_MAX = 4096;

export const wallgapWindow = (drop) => [WALLGAP_MIN, int(wallJumpReach(drop))];
export const dashWindow = (drop) => [int(jumpReach(drop)) + 1, int(dashReach(drop))];

export function routeLength(seg) {
  const t = seg.type;
  if (t === "turn") {
    const a = seg.angle;
    return radians(typeof a === "number" ? a : 0) * (seg.radius ?? 0);
  }
  if (t === "checkpoint") return 0.0;
  const n = seg.length ?? 0;
  return Number(n) + (t === "dash" ? DASH_PAD : 0);
}

export const splitHole = () => int(maxGap(0) * SPLIT_HOLE_FILL);
export const splitMinLength = (count) =>
  2 * SPLIT_MOUTH + count * (SPLIT_RUNWAY + splitHole()) + SPLIT_LANDING;
export const turnRadiusMin = (width) => Math.floor(width / 2) + 64;

const KEEP = {
  straight: ["length", "open", "ice"],
  turn: ["direction", "angle", "radius", "shortcut", "open", "ice"],
  ramp: ["length", "rise", "open", "ice"],
  gap: ["length", "drop", "open"],
  checkpoint: [],
  slalom: ["length", "count", "ice"],
  beam: ["length", "beam_width"],
  split: ["length", "direction", "count"],
  wallclimb: ["length", "rise", "direction"],
  wallgap: ["length", "drop", "direction"],
  dash: ["length", "drop"],
};
// The fields each piece type uses, for the editor's inspector.
export const FIELDS = KEEP;

export function normalize(spec) {
  const out = {};
  for (const k of ["name", "title", "width"]) if (k in spec) out[k] = spec[k];
  out.segments = [];
  for (const seg of spec.segments || []) {
    const t = seg.type;
    const clean = { type: t };
    for (const k of KEEP[t] || []) if (k in seg) clean[k] = seg[k];
    for (const flag of ["shortcut", "open", "ice"]) if (clean[flag] === false) delete clean[flag];
    out.segments.push(clean);
  }
  return out;
}

export function validate(spec) {
  const errs = [];
  if (!isObj(spec)) return ["spec must be a JSON object"];

  const name = spec.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    errs.push(`name ${pyRepr(name)} must match ${NAME_RE_SRC} ` +
      "(lowercase; the gen_ prefix marks generated maps in the pool)");
  }
  const title = spec.title;
  if (typeof title !== "string" || !TITLE_RE.test(title) || title.includes("  ")) {
    errs.push(`title ${pyRepr(title)} must be 1-40 characters of letters, digits, single ` +
      "spaces and ' & ! ? , : - (no other punctuation), naming the course's theme");
  }

  let width = spec.width;
  if (!Number.isInteger(width) || !(WIDTH_MIN <= width && width <= WIDTH_MAX)) {
    errs.push(`width ${pyRepr(width)} must be an integer in [${WIDTH_MIN}, ${WIDTH_MAX}]`);
    width = 384;
  }

  const segs = spec.segments;
  if (!Array.isArray(segs) || !segs.length) {
    errs.push("segments must be a non-empty list");
    return errs;
  }
  if (segs.length > MAX_SEGMENTS) errs.push(`${segs.length} segments; at most ${MAX_SEGMENTS}`);

  let route = 0.0;
  for (const seg of segs) {
    if (!isObj(seg)) continue;
    const v = seg[seg.type === "turn" ? "radius" : "length"];
    if (isNum(v) && v > 0) route += routeLength(seg);
  }
  if (route > ROUTE_MAX) {
    errs.push(`the route is ${int(route)} units long; at most ${ROUTE_MAX} ` +
      `(about ${Math.floor(ROUTE_MAX / 320)} s at 320 ups)`);
  }

  const slope = maxRampSlope();
  segs.forEach((seg, i) => {
    let where = `segment ${i}`;
    if (!isObj(seg)) {
      errs.push(`${where}: must be an object`);
      return;
    }
    const t = seg.type;
    where = `segment ${i} (${pyStr(t)})`;

    const num = (key, lo, hi) => {
      const v = seg[key];
      if (!isNum(v) || !(lo <= v && v <= hi)) {
        errs.push(`${where}: ${key} ${pyRepr(v)} must be in [${lo}, ${hi}]`);
        return null;
      }
      return v;
    };
    const whole = (key, lo, hi) => {
      const v = seg[key];
      if (!Number.isInteger(v) || !(lo <= v && v <= hi)) {
        errs.push(`${where}: ${key} ${pyRepr(v)} must be a whole number in [${lo}, ${hi}]`);
        return null;
      }
      return v;
    };

    if ("open" in seg && typeof seg.open !== "boolean") {
      errs.push(`${where}: open must be true or false`);
    } else if (seg.open && !OPENABLE.includes(t)) {
      errs.push(`${where}: only ${OPENABLE.join(", ")} can be open ` +
        "(the special-move pieces are open already)");
    }
    if ("ice" in seg && typeof seg.ice !== "boolean") {
      errs.push(`${where}: ice must be true or false`);
    } else if (seg.ice && !ICEABLE.includes(t)) {
      errs.push(`${where}: only ${ICEABLE.join(", ")} can be ice ` +
        "(a piece that is jumped from or across keeps its grip)");
    }

    const side = () => {
      if (seg.direction !== "left" && seg.direction !== "right") {
        errs.push(`${where}: direction (the side of the kick wall) must be 'left' or 'right'`);
      }
    };

    if (t === "straight") {
      num("length", STRAIGHT_MIN, STRAIGHT_MAX);
    } else if (t === "turn") {
      if (seg.direction !== "left" && seg.direction !== "right") {
        errs.push(`${where}: direction must be 'left' or 'right'`);
      }
      if (!TURN_ANGLES.includes(seg.angle)) {
        errs.push(`${where}: angle ${pyRepr(seg.angle)} must be one of ${tupleRepr(TURN_ANGLES)}`);
      }
      num("radius", turnRadiusMin(width), TURN_RADIUS_MAX);
      if (seg.shortcut) {
        if (seg.angle !== 180) {
          errs.push(`${where}: a shortcut needs a 180-degree turn, not ${pyRepr(seg.angle)}`);
        }
        for (const [j, sideName] of [[i - 1, "before"], [i + 1, "after"]]) {
          const nb = j >= 0 && j < segs.length ? segs[j] : null;
          if (!isObj(nb) || nb.type !== "straight" || !isNum(nb.length) || nb.length < SHORTCUT_MIN_LEG) {
            errs.push(`${where}: a shortcut needs a straight of at least ` +
              `${SHORTCUT_MIN_LEG} directly ${sideName} the turn`);
          }
        }
      }
    } else if (t === "ramp") {
      const length = num("length", RAMP_MIN, RAMP_MAX);
      const rise = num("rise", -1024, 1024);
      if (length && rise !== null && Math.abs(rise) > slope * length + 1e-6) {
        errs.push(`${where}: rise ${rise} over length ${length} is steeper than ` +
          `30 degrees; |rise| must be <= ${int(slope * length)}`);
      }
    } else if (t === "gap") {
      const drop = num("drop", -int(maxRise()), DROP_MAX);
      const length = num("length", GAP_MIN, GAP_LENGTH_MAX);
      if (drop !== null && length !== null) {
        const reach = maxGap(drop);
        if (length > reach) {
          errs.push(`${where}: a ${length}-unit gap with drop ${drop} is not ` +
            `clearable from a 320 ups run-up; max is ${int(reach)}`);
        }
      }
    } else if (t === "checkpoint") {
      // nothing to check
    } else if (t === "slalom") {
      const length = num("length", STRAIGHT_MIN, STRAIGHT_MAX);
      const count = whole("count", ...SLALOM_COUNT);
      if (width - SLALOM_GATE < SLALOM_FIN_MIN) {
        errs.push(`${where}: a slalom needs width >= ${SLALOM_GATE + SLALOM_FIN_MIN} ` +
          `(a ${SLALOM_GATE}-unit gate beside each fin)`);
      }
      if (length && count && length / (count + 1) < SLALOM_SPACING) {
        errs.push(`${where}: ${count} fins in ${length} units are closer than ` +
          `${SLALOM_SPACING}; length must be >= ${SLALOM_SPACING * (count + 1)}`);
      }
    } else if (t === "beam") {
      num("length", STRAIGHT_MIN, BEAM_MAX_LENGTH);
      num("beam_width", BEAM_MIN, width - 2 * BEAM_WALL_CLEAR);
    } else if (t === "split") {
      if (seg.direction !== "left" && seg.direction !== "right") {
        errs.push(`${where}: direction (the side of the fast lane with the holes) ` +
          "must be 'left' or 'right'");
      }
      const count = whole("count", ...SPLIT_COUNT);
      const length = num("length", STRAIGHT_MIN, STRAIGHT_MAX);
      if ((width - SPLIT_MEDIAN) / 2 < SPLIT_LANE_MIN) {
        errs.push(`${where}: a split needs width >= ${2 * SPLIT_LANE_MIN + SPLIT_MEDIAN} ` +
          `for two ${SPLIT_LANE_MIN}-unit lanes`);
      }
      if (length && count && length < splitMinLength(count)) {
        errs.push(`${where}: ${count} hole(s) need length >= ${splitMinLength(count)}`);
      }
    } else if (t === "wallclimb") {
      side();
      num("length", WALLCLIMB_MIN, STRAIGHT_MAX);
      whole("rise", ...WALLCLIMB_RISE);
    } else if (t === "wallgap") {
      side();
      const drop = whole("drop", ...WALLGAP_DROP);
      const length = num("length", GAP_MIN, GAP_LENGTH_MAX);
      if (drop !== null && length !== null) {
        const [lo, hi] = wallgapWindow(drop);
        if (!(lo <= length && length <= hi)) {
          errs.push(`${where}: at drop ${drop} a wall-kick gap must be ${lo}-${hi} ` +
            "long; longer cannot be made even with the wall jump");
        }
      }
    } else if (t === "dash") {
      const drop = whole("drop", ...DASH_DROP);
      const length = num("length", GAP_MIN, GAP_LENGTH_MAX);
      if (drop !== null && length !== null) {
        const [lo, hi] = dashWindow(drop);
        if (!(lo <= length && length <= hi)) {
          errs.push(`${where}: at drop ${drop} a dash gap must be ${lo}-${hi} long: ` +
            "shorter can be jumped, longer cannot be dashed");
        }
      }
    } else {
      errs.push(`${where}: unknown type; must be one of ${tupleRepr(SEGMENT_TYPES)}`);
    }
  });
  return errs;
}

/* -------------------------------- layout -------------------------------- */
// tools/mapgen/layout.py: spec -> brushes, and the rules that need geometry.

export const FLOOR_THICK = 32;
export const WALL_THICK = 16;
export const WALL_HEIGHT = 256;
export const ROOM_LEN = 384;
const SPAWN_BACK = 96;
const TRIGGER_DEPTH = 32;
export const TRIGGER_HEIGHT = 192;
const SHELL_MARGIN = 512;
const PIT_DEPTH = 384;
const WEDGE_DEG = 11.25;
const CUT_MIN_SKIP = 1024.0;
const CUT_MIN_FRACTION = 0.10;
const ROOF_THICK = 16;
export const CUT_SPEED_OK = 1000.0;
const SHORTCUT_BACK = 192;
const SHORTCUT_WINDOW = 96;
const SHORTCUT_PLATFORM = 64;
const SHORTCUT_GAP_FILL = 0.92;
export const CP_EVERY = 2560;
const CP_MIN = 1024;
const CP_END_MIN = 768;
const CP_EDGE = 64;
export const EXTENT_MAX_XY = 16384;
export const EXTENT_MAX_Z = 8192;
export const BRUSH_MAX = 1500;
const FIN_THICK = 32;
const SPLIT_GATE = 96;
export const VOID_DEPTH = 160;
const EDGE_BAND = 16;
const WALLCLIMB_ARC = 96;

export class Prism {
  constructor(poly, zmin, top0, gx = 0.0, gy = 0.0, tex = "floor", heading = null) {
    this.poly = poly.map(([x, y]) => [x, y]);
    this.zmin = zmin;
    this.top0 = top0;
    this.gx = gx;
    this.gy = gy;
    this.tex = tex;
    this.heading = heading;
    this.seg = null;   // the editor's addition: which segment laid it
  }
  topAt(x, y) { return this.top0 + this.gx * x + this.gy * y; }
  zmax() { return Math.max(...this.poly.map(([x, y]) => this.topAt(x, y))); }
  static flat(poly, zmin, zmax, tex, heading = null) {
    return new Prism(poly, zmin, zmax, 0.0, 0.0, tex, heading);
  }
}

class Hull {
  constructor(poly, zlo, zhi, seg) {
    this.poly = poly; this.zlo = zlo; this.zhi = zhi; this.seg = seg;
  }
}

function rect(o, f, l, back, fwd, right, left) {
  const p = (a, b) => [o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b];
  return [p(back, -right), p(fwd, -right), p(fwd, left), p(back, left)];
}
const band = (o, f, l, back, fwd, lo, hi) => rect(o, f, l, back, fwd, -lo, hi);

export function planCheckpoints(spec) {
  const segs = spec.segments;
  const at = [0.0];
  for (const seg of segs) at.push(at[at.length - 1] + routeLength(seg));
  const total = at[at.length - 1];
  const planned = [];
  segs.forEach((seg, i) => { if (seg.type === "checkpoint") planned.push(at[i]); });

  let allowed = [];
  segs.forEach((seg, i) => {
    if (seg.type === "straight" && seg.length > 2 * CP_EDGE) allowed.push([at[i] + CP_EDGE, at[i + 1] - CP_EDGE, i]);
  });
  const blocked = [[0.0, CP_END_MIN], [total - CP_END_MIN, total]];
  const reach = SHORTCUT_BACK + SHORTCUT_WINDOW / 2 + CP_EDGE;
  segs.forEach((seg, i) => {
    if (seg.type === "turn" && seg.shortcut) blocked.push([at[i] - reach, at[i + 1] + reach]);
  });

  const carve = (spans, cut) => {
    const out = [];
    for (let [a, b, i] of spans) {
      let broke = false;
      for (const [c, d] of cut) {
        if (d <= a || c >= b) continue;
        if (c > a) out.push([a, c, i]);
        a = Math.max(a, d);
        if (a >= b) { broke = true; break; }
      }
      if (!broke) out.push([a, b, i]);
    }
    return out.filter(([a, b]) => b >= a);
  };

  for (const cut of blocked) allowed = carve(allowed, [cut]);
  allowed = carve(allowed, planned.map((c) => [c - CP_MIN, c + CP_MIN]));
  allowed.sort(cmpTuple);

  const firstFrom = (target) => {
    for (const [a, b, i] of allowed) if (b >= target) return [Math.max(a, target), i];
    return null;
  };

  const added = [];
  let last = 0.0;
  for (;;) {
    const spot = firstFrom(last + CP_EVERY);
    if (spot === null) break;
    const [d, i] = spot;
    const passed = planned.filter((c) => last < c && c <= d);
    if (passed.length) {
      last = Math.max(...passed);
      continue;
    }
    added.push([d, i]);
    last = d;
    allowed = carve(allowed, [[d - CP_MIN, d + CP_MIN]]);
  }
  if (!planned.length && !added.length && allowed.length) {
    const key = (s) => Math.min(Math.abs(s[0] - total / 2), Math.abs(s[1] - total / 2));
    let best = allowed[0];
    for (const s of allowed) if (key(s) < key(best)) best = s;
    const [a, b, i] = best;
    added.push([Math.min(Math.max(total / 2, a), b), i]);
  }
  return added.sort(cmpTuple).map(([d, i]) => [i, pyRound(d - at[i], 1)]);
}

function satOverlap(a, b, eps = 1.0) {
  for (const poly of [a, b]) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % n];
      let ax = y2 - y1, ay = x1 - x2;
      const L = Math.hypot(ax, ay) || 1.0;
      ax /= L; ay /= L;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const [x, y] of a) { const p = x * ax + y * ay; amin = Math.min(amin, p); amax = Math.max(amax, p); }
      for (const [x, y] of b) { const p = x * ax + y * ay; bmin = Math.min(bmin, p); bmax = Math.max(bmax, p); }
      if (amax <= bmin + eps || bmax <= amin + eps) return false;
    }
  }
  return true;
}

function segGap(p1, p2, q1, q2) {
  const pointSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0.0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0.0, Math.min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = q2[0] - q1[0], d2y = q2[1] - q1[1];
  const den = d1x * d2y - d1y * d2x;
  if (den !== 0.0) {
    const t = ((q1[0] - p1[0]) * d2y - (q1[1] - p1[1]) * d2x) / den;
    const u = ((q1[0] - p1[0]) * d1y - (q1[1] - p1[1]) * d1x) / den;
    if (t >= 0.0 && t <= 1.0 && u >= 0.0 && u <= 1.0) return 0.0;
  }
  return Math.min(pointSeg(...p1, ...q1, ...q2), pointSeg(...p2, ...q1, ...q2),
    pointSeg(...q1, ...p1, ...p2), pointSeg(...q2, ...p1, ...p2));
}

function polyGap(a, b) {
  if (satOverlap(a, b)) return 0.0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) best = Math.min(best, segGap(p1, p2, b[j], b[(j + 1) % b.length]));
  }
  return best;
}

const segname = (i) => (i < 0 ? "the start room" : `segment ${i}`);
const LANDINGS = ["straight", "turn", "slalom", "split", "wallclimb"];

class Walker {
  constructor(spec) {
    this.c = {
      spec, world: [], entities: [], hulls: [], floorPolys: [], route: [], landmarks: [],
      shortcuts: [], features: [], overpasses: [], segDist: [], openSegs: new Set(),
      falloffSegs: new Set(), cuts: [], autoCheckpoints: [], length: 0.0, bounds: null,
      // The editor's additions: where the cursor stood (x, y, z, heading)
      // and how far along the route it was as each segment began, plus one
      // more entry for the finish line.
      segStart: [], collision: null,
    };
    this.w = spec.width;
    this.x = 0.0; this.y = 0.0; this.z = 0.0;
    this.heading = 0.0;
    this.runup = 0.0;
    this.problems = [];
    this.roofed = new Set();
    this.seg = -1;
    this.tn = 0;
    this.walls = new Map();
    this.pending = null;
  }

  add(prism) {
    prism.seg = this.seg;
    this.c.world.push(prism);
    return prism;
  }

  frame() {
    const h = radians(this.heading);
    return [[this.x, this.y], [Math.cos(h), Math.sin(h)], [-Math.sin(h), Math.cos(h)]];
  }

  advance(d, dz = 0.0) {
    const [, f] = this.frame();
    this.x += f[0] * d;
    this.y += f[1] * d;
    this.z += dz;
    this.c.length += d;
    this.c.route.push([this.x, this.y, this.z]);
  }

  targetname(kind) {
    this.tn += 1;
    return `mg_${kind}${this.tn}`;
  }

  hull(poly, zlo, zhi) { this.c.hulls.push(new Hull(poly, zlo, zhi, this.seg)); }

  boxRun(length, { rise = 0.0, tex = "floor", floor = true, wallFloor = null, walls = [1, -1] } = {}) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z0 = this.z;
    const slope = length ? rise / length : 0.0;
    const gx = f[0] * slope, gy = f[1] * slope;
    const top0 = z0 - (gx * o[0] + gy * o[1]);
    const lo = Math.min(z0, z0 + rise);
    const base = wallFloor === null ? lo - FLOOR_THICK : wallFloor;
    if (floor) {
      const poly = rect(o, f, l, 0, length, half, half);
      this.add(new Prism(poly, lo - FLOOR_THICK, top0, gx, gy, tex, this.heading));
      this.c.floorPolys.push([poly, tex]);
    }
    const idx = new Map();
    for (const side of [1, -1]) {
      if (walls.includes(side)) {
        idx.set(side, this.c.world.length);
        this.add(new Prism(this.wallPoly(o, f, l, side, 0, length), base, top0 + WALL_HEIGHT, gx, gy, "wall"));
      } else if (floor) {
        const b = side > 0 ? band(o, f, l, 0, length, half - EDGE_BAND, half)
          : band(o, f, l, 0, length, -half, -half + EDGE_BAND);
        this.add(new Prism(b, lo - 4, top0 + 1, gx, gy, "edge"));
      }
    }
    if (rise === 0) {
      this.walls.set(this.seg, { o, f, l, length, idx, base, top: z0 + WALL_HEIGHT });
    }
    this.hull(rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
      base, Math.max(z0, z0 + rise) + WALL_HEIGHT);
    this.advance(length, rise);
  }

  wallPoly(o, f, l, side, a, b) {
    const half = this.w / 2.0;
    if (side > 0) return rect(o, f, l, a, b, -half, half + WALL_THICK);
    return rect(o, f, l, a, b, half + WALL_THICK, -half);
  }

  cutWindow(seg, side, a, b) {
    const w = this.walls.get(seg);
    if (!w || !w.idx.has(side)) return;
    const { o, f, l, length: n } = w;
    const k = w.idx.get(side);
    const keep = this.c.world[k].seg;
    const p = Prism.flat(this.wallPoly(o, f, l, side, 0, a), w.base, w.top, "wall");
    p.seg = keep;
    this.c.world[k] = p;
    this.add(Prism.flat(this.wallPoly(o, f, l, side, b, n), w.base, w.top, "wall")).seg = keep;
  }

  shortcut(legB) {
    const p = this.pending;
    this.pending = null;
    const { sign, radius: r } = p;
    const [ax, ay] = p.origin, f = p.f, l = p.l;
    const half = this.w / 2.0;
    const legA = p.turn - 1;
    const back = SHORTCUT_BACK;
    const la = this.walls.get(legA).length;
    this.cutWindow(legA, sign, la - back - SHORTCUT_WINDOW / 2, la - back + SHORTCUT_WINDOW / 2);
    this.cutWindow(legB, sign, back - SHORTCUT_WINDOW / 2, back + SHORTCUT_WINDOW / 2);

    const u = [l[0] * sign, l[1] * sign];
    const v = [-u[1], u[0]];
    const edge = [ax - f[0] * back + u[0] * half, ay - f[1] * back + u[1] * half];
    const span = 2 * r - this.w;
    const gmax = maxGap(0) * SHORTCUT_GAP_FILL;
    const P = SHORTCUT_PLATFORM;
    const n = span <= gmax ? 0 : Math.ceil((span - gmax) / (P + gmax));
    const gap = (span - n * P) / (n + 1);
    const heading = pymod(degrees(Math.atan2(u[1], u[0])), 360.0);
    const z = p.z;
    for (let i = 0; i < n; i++) {
      const d = gap * (i + 1) + P * i + P / 2;
      const c = [edge[0] + u[0] * d, edge[1] + u[1] * d];
      const poly = rect(c, u, v, -P / 2, P / 2, P / 2, P / 2);
      this.add(Prism.flat(poly, z - FLOOR_THICK, z, "platform", heading)).seg = p.turn;
      this.c.floorPolys.push([poly, "platform"]);
    }
    const saves = 2 * back + Math.PI * r - 2 * r;
    this.c.shortcuts.push({ turn: p.turn, platforms: n, gap: pyRound(gap), span: pyRound(span), saves: pyRound(saves) });
    this.c.landmarks.push(["shortcut", [edge[0], edge[1], z], heading]);
  }

  endWall(behind) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0 + WALL_THICK;
    const [a, b] = behind ? [-WALL_THICK, 0] : [0, WALL_THICK];
    this.add(Prism.flat(rect(o, f, l, a, b, half, half), this.z - FLOOR_THICK, this.z + WALL_HEIGHT, "wall"));
  }

  stripe(tex, back, fwd) {
    const [o, f, l] = this.frame();
    const poly = rect(o, f, l, back, fwd, this.w / 2.0, this.w / 2.0);
    this.add(Prism.flat(poly, this.z - 4, this.z + 1, tex, this.heading));
  }

  trigger(classnameTarget, targetKeys, stripe = null) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    if (stripe) this.stripe(stripe, -TRIGGER_DEPTH, TRIGGER_DEPTH);
    const kind = targetKeys.classname.replace("target_", "").replace("timer", "");
    this.c.landmarks.push([kind, [this.x, this.y, this.z], this.heading]);
    const parts = targetKeys.classname.split("_");
    const name = this.targetname(parts[parts.length - 1]);
    const poly = rect(o, f, l, -TRIGGER_DEPTH / 2, TRIGGER_DEPTH / 2, half, half);
    const brush = Prism.flat(poly, this.z, this.z + TRIGGER_HEIGHT, "trigger");
    brush.seg = this.seg;
    this.c.entities.push([{ classname: classnameTarget, target: name }, [brush]]);
    const ent = { ...targetKeys, targetname: name, origin: [this.x, this.y, this.z + 32] };
    this.c.entities.push([ent, []]);
  }

  checkpoint() {
    this.trigger("trigger_multiple", { classname: "target_checkpoint" }, "checkpoint");
  }

  checkpointAt(o, f, a) {
    const hx = this.x, hy = this.y;
    this.x = o[0] + f[0] * a;
    this.y = o[1] + f[1] * a;
    this.checkpoint();
    this.x = hx; this.y = hy;
  }

  turn(direction, angle, radius, walls = true, tex = "floor") {
    const sign = direction === "left" ? 1.0 : -1.0;
    const [o, , l] = this.frame();
    const cx = o[0] + l[0] * radius * sign, cy = o[1] + l[1] * radius * sign;
    const half = this.w / 2.0;
    const rIn = radius - half, rOut = radius + half;
    const a0 = Math.atan2(o[1] - cy, o[0] - cx);
    const n = Math.max(1, int(pyRound(angle / WEDGE_DEG)));
    const step = (radians(angle) / n) * sign;
    const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

    for (let i = 0; i < n; i++) {
      const a = a0 + step * i, b = a0 + step * (i + 1);
      const rings = [[rIn, rOut, tex, this.z - FLOOR_THICK, this.z]];
      if (walls) {
        rings.push([rOut, rOut + WALL_THICK, "wall", this.z - FLOOR_THICK, this.z + WALL_HEIGHT]);
        if (rIn - WALL_THICK > 1) {
          rings.push([rIn - WALL_THICK, rIn, "wall", this.z - FLOOR_THICK, this.z + WALL_HEIGHT]);
        }
      } else {
        rings.push([rOut - EDGE_BAND, rOut, "edge", this.z - 4, this.z + 1],
          [rIn, rIn + EDGE_BAND, "edge", this.z - 4, this.z + 1]);
      }
      const midHeading = this.heading + (sign * angle * (i + 0.5)) / n;
      for (const [ri, ro, tx, zlo, zhi] of rings) {
        const poly = [pt(ri, a), pt(ro, a), pt(ro, b), pt(ri, b)];
        if (sign < 0) poly.reverse();
        this.add(Prism.flat(poly, zlo, zhi, tx, midHeading));
        if (tx === "floor" || tx === "ice") this.c.floorPolys.push([poly, tx]);
      }
      const ri = Math.max(rIn - WALL_THICK, 0.0);
      const hp = [pt(ri, a), pt(rOut + WALL_THICK, a), pt(rOut + WALL_THICK, b), pt(ri, b)];
      if (sign < 0) hp.reverse();
      this.hull(hp, this.z - FLOOR_THICK, this.z + WALL_HEIGHT);
      const mid = pt(radius, b);
      this.c.route.push([mid[0], mid[1], this.z]);
    }
    [this.x, this.y] = pt(radius, a0 + step * n);
    this.heading = pymod(this.heading + sign * angle, 360.0);
    this.c.length += radians(angle) * radius;
  }

  fins(o, f, l, spots, lanes, tex = "pylon") {
    spots.forEach((a, k) => {
      const [lo, hi] = lanes[k];
      const poly = band(o, f, l, a - FIN_THICK / 2, a + FIN_THICK / 2, lo, hi);
      this.add(Prism.flat(poly, this.z - FLOOR_THICK, this.z + WALL_HEIGHT, tex));
    });
  }

  reroute(o, f, l, points) {
    const end = this.c.route.pop();
    let prev = this.c.route[this.c.route.length - 1];
    this.c.length -= dist(prev, end);
    const z = this.z;
    for (const [a, b] of points) {
      const p = [o[0] + f[0] * a + l[0] * b, o[1] + f[1] * a + l[1] * b, z];
      this.c.length += dist(prev, p);
      this.c.route.push(p);
      prev = p;
    }
    this.c.length += dist(prev, end);
    this.c.route.push(end);
  }

  slalom(length, count, tex = "floor") {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const gate = SLALOM_GATE;
    this.c.landmarks.push(["slalom", [this.x, this.y, this.z], this.heading]);
    this.boxRun(length, { tex });
    const spacing = length / (count + 1);
    const spots = Array.from({ length: count }, (_, i) => spacing * (i + 1));
    const lanes = spots.map((_, i) => (i % 2 === 0 ? [-half + gate, half] : [-half, half - gate]));
    this.fins(o, f, l, spots, lanes);
    const mid = half - gate / 2;
    this.reroute(o, f, l, spots.map((a, i) => [a, i % 2 === 0 ? -mid : mid]));
    this.c.features.push({ type: "slalom", segment: this.seg, fins: count, gate, spacing: pyRound(spacing) });
    return spacing;
  }

  beam(length, width) {
    const [o, f, l] = this.frame();
    const z = this.z;
    this.stripe("edge", -32, 0);
    this.c.landmarks.push(["beam", [this.x, this.y, z], this.heading]);
    this.boxRun(length, { floor: false, wallFloor: z - FLOOR_THICK - VOID_DEPTH });
    const poly = rect(o, f, l, 0, length, width / 2.0, width / 2.0);
    this.add(Prism.flat(poly, z - FLOOR_THICK, z, "beam", this.heading));
    this.c.floorPolys.push([poly, "beam"]);
    this.c.features.push({ type: "beam", segment: this.seg, width, length });
  }

  split(length, direction, count) {
    const [o, f, l] = this.frame();
    const z = this.z;
    const half = this.w / 2.0;
    const m = SPLIT_MEDIAN / 2.0;
    const mouth = SPLIT_MOUTH;
    const fast = direction === "left" ? 1 : -1;
    const laneW = half - m;
    this.c.landmarks.push(["split", [this.x, this.y, z], this.heading]);
    this.boxRun(length, { floor: false, wallFloor: z - FLOOR_THICK - VOID_DEPTH });
    const lane = (side) => (side > 0 ? [m, half] : [-half, -m]);
    const floor = (a, b, lo, hi, tex = "floor") => {
      const poly = band(o, f, l, a, b, lo, hi);
      this.add(Prism.flat(poly, z - FLOOR_THICK, z, tex, this.heading));
      this.c.floorPolys.push([poly, tex]);
    };
    floor(0, mouth, -half, half);
    floor(length - mouth, length, -half, half);
    this.add(Prism.flat(band(o, f, l, mouth, length - mouth, -m, m),
      z - FLOOR_THICK - VOID_DEPTH, z + WALL_HEIGHT, "wall"));
    const hole = splitHole();
    const inner = length - 2 * mouth;
    const runway = SPLIT_RUNWAY + (inner - SPLIT_LANDING - count * (SPLIT_RUNWAY + hole)) / count;
    const [lo, hi] = lane(fast);
    let a = mouth;
    for (let k = 0; k < count; k++) {
      floor(a, a + runway, lo, hi);
      a += runway;
      const lip = band(o, f, l, a - 32, a, lo, hi);
      this.add(Prism.flat(lip, z - 4, z + 1, "edge", this.heading));
      a += hole;
    }
    floor(a, length - mouth, lo, hi);
    const [slo, shi] = lane(-fast);
    floor(mouth, length - mouth, slo, shi);
    const n = count + 1;
    const spacing = inner / (n + 1);
    const spots = Array.from({ length: n }, (_, i) => mouth + spacing * (i + 1));
    const bands = [[slo, shi - SPLIT_GATE], [slo + SPLIT_GATE, shi]];
    this.fins(o, f, l, spots, spots.map((_, i) => bands[i % 2]));
    const c = fast * (m + laneW / 2);
    this.reroute(o, f, l, [[mouth, c], [length - mouth, c]]);
    this.c.features.push({ type: "split", segment: this.seg, fast_lane: direction, holes: count, hole,
      safe_fins: n, gate: SPLIT_GATE });
  }

  laySegment(i, seg, segs, auto) {
    const t = seg.type;
    const sides = seg.open ? [] : [1, -1];
    const tex = seg.ice ? "ice" : "floor";
    if (t === "straight") {
      const [o, f] = this.frame();
      this.boxRun(seg.length, { tex, walls: sides });
      this.runup += seg.length;
      if (this.pending && this.pending.turn === i - 1) this.shortcut(i);
      for (const a of auto.get(i) || []) {
        this.checkpointAt(o, f, a);
        this.c.autoCheckpoints.push([i, a]);
      }
    } else if (t === "ramp") {
      this.boxRun(seg.length, { rise: seg.rise, tex, walls: sides });
      this.runup = 0.0;
    } else if (t === "turn") {
      if (seg.shortcut) {
        const [o, f, l] = this.frame();
        this.pending = { turn: i, origin: o, f, l, z: this.z, sign: seg.direction === "left" ? 1 : -1,
          radius: seg.radius };
      }
      this.turn(seg.direction, seg.angle, seg.radius, sides.length > 0, tex);
      this.runup += radians(seg.angle) * seg.radius;
    } else if (t === "checkpoint") {
      this.checkpoint();
    } else if (t === "gap") {
      this.gap(i, seg, segs);
    } else if (t === "slalom") {
      this.runup = this.slalom(seg.length, seg.count, tex);
    } else if (t === "beam") {
      this.beam(seg.length, seg.beam_width);
      this.runup += seg.length;
    } else if (t === "split") {
      this.split(seg.length, seg.direction, seg.count);
      this.runup = SPLIT_MOUTH;
    } else if (t === "wallclimb") {
      if (this.runup + seg.length / 2.0 < WALL_RUNUP) {
        this.problems.push(
          `segment ${i} (wallclimb): only ${int(this.runup + seg.length / 2)} ` +
          `units of flat floor before its ledge; it needs ${WALL_RUNUP} ` +
          "(a ramp resets it, because a jump off a ramp flies high enough " +
          "to skip the kick). Lengthen it or put a straight before it");
      }
      this.wallclimb(seg.length, seg.rise, seg.direction);
      this.runup = seg.length / 2.0;
    } else if (t === "wallgap") {
      this.gap(i, seg, segs, seg.direction);
    } else if (t === "dash") {
      this.dash(i, seg, segs);
    }
  }

  run() {
    const s = this.c.spec;
    this.startRoom();
    const segs = s.segments;
    const auto = new Map();
    for (const [i, a] of planCheckpoints(s)) {
      if (!auto.has(i)) auto.set(i, []);
      auto.get(i).push(a);
    }
    segs.forEach((seg, i) => {
      this.seg = i;
      this.c.segStart.push({ x: this.x, y: this.y, z: this.z, heading: this.heading, at: this.c.length });
      this.c.segDist.push(this.c.length);
      const t = seg.type;
      const open = !!seg.open;
      if (open) this.c.openSegs.add(i);
      if (open || ["gap", "wallgap", "dash", "beam", "split"].includes(t)) this.c.falloffSegs.add(i);
      this.laySegment(i, seg, segs, auto);
    });
    this.seg = segs.length;
    this.c.segStart.push({ x: this.x, y: this.y, z: this.z, heading: this.heading, at: this.c.length });
    this.finishRoom();
    this.selfIntersections();
    this.cutsCheck();
    this.sizeLimits();
    this.shell();
    return this.c;
  }

  sizeLimits() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of this.c.world) {
      for (const [x, y] of p.poly) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      z0 = Math.min(z0, p.zmin); z1 = Math.max(z1, p.zmax());
    }
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    if (Math.max(dx, dy) > EXTENT_MAX_XY) {
      this.problems.push(`the course spreads ${int(dx)} x ${int(dy)} units; at most ${EXTENT_MAX_XY} ` +
        "in each direction (fold it back on itself with turns)");
    }
    if (dz > EXTENT_MAX_Z) this.problems.push(`the course is ${int(dz)} units tall; at most ${EXTENT_MAX_Z}`);
    const brushes = brushCount(this.c);
    if (brushes > BRUSH_MAX) {
      this.problems.push(`the course needs ${brushes} brushes; at most ${BRUSH_MAX} ` +
        "(fewer slalom fins, splits or tight turns)");
    }
  }

  startRoom() {
    const [o, f] = this.frame();
    this.endWall(true);
    this.boxRun(ROOM_LEN, { tex: "start" });
    this.c.length = 0.0;
    this.c.route = [[this.x, this.y, this.z]];
    const spawn = [o[0] + f[0] * SPAWN_BACK, o[1] + f[1] * SPAWN_BACK, this.z + 40];
    this.c.entities.push([{ classname: "info_player_deathmatch", origin: spawn, angle: this.heading }, []]);
    this.trigger("trigger_multiple", { classname: "target_starttimer" }, "trim");
    this.runup = ROOM_LEN - SPAWN_BACK;
  }

  finishRoom() {
    this.trigger("trigger_multiple", { classname: "target_stoptimer" }, "trim");
    this.boxRun(ROOM_LEN, { tex: "finish" });
    this.endWall(false);
  }

  landing(where, i, segs) {
    const nxt = i + 1 < segs.length ? segs[i + 1].type : "finish";
    if (!LANDINGS.includes(nxt)) {
      this.problems.push(`${where}: must land on a ${LANDINGS.slice(0, -1).join(", ")} or ` +
        `${LANDINGS[LANDINGS.length - 1]}, not on ${pyRepr(nxt)}`);
    }
  }

  gap(i, seg, segs, kick = null) {
    const kind = kick ? "wallgap" : "gap";
    const where = `segment ${i} (${kind})`;
    if (kick && this.runup < WALL_RUNUP) {
      this.problems.push(
        `${where}: only ${int(this.runup)} units of flat floor before it; a wall-kick ` +
        `gap needs ${WALL_RUNUP} (straights and turns; a ramp resets it, ` +
        "because a jump off a ramp flies high enough to skip the kick)");
    } else if (this.runup < MIN_RUNUP) {
      this.problems.push(
        `${where}: only ${int(this.runup)} units of flat floor before it; a gap ` +
        `needs ${int(MIN_RUNUP)} of straight/turn run-up (ramps and ` +
        "other gaps reset it)");
    }
    this.landing(where, i, segs);
    this.stripe("edge", -32, 0);
    this.c.landmarks.push([kind, [this.x, this.y, this.z], this.heading]);
    const land = this.z - seg.drop;
    const wallFloor = Math.min(this.z, land) - FLOOR_THICK - 128;
    if (kick) {
      const [o, f, l] = this.frame();
      const side = kick === "left" ? 1 : -1;
      this.add(Prism.flat(this.wallPoly(o, f, l, side, 0, seg.length),
        wallFloor, Math.max(this.z, land) + WALL_HEIGHT, "kick"));
      this.boxRun(seg.length, { floor: false, wallFloor, walls: [] });
      this.c.features.push({ type: "wallgap", segment: this.seg, side: kick, length: seg.length, drop: seg.drop });
    } else {
      const sides = seg.open ? [] : [1, -1];
      this.boxRun(seg.length, { floor: false, wallFloor, walls: sides });
    }
    this.z = land;
    this.c.route[this.c.route.length - 1] = [this.x, this.y, this.z];
    this.runup = 0.0;
  }

  dash(i, seg, segs) {
    const where = `segment ${i} (dash)`;
    this.landing(where, i, segs);
    this.boxRun(DASH_PAD, { walls: [] });
    this.stripe("edge", -32, 0);
    this.c.landmarks.push(["dash", [this.x, this.y, this.z], this.heading]);
    const land = this.z - seg.drop;
    this.boxRun(seg.length, { floor: false, walls: [] });
    this.z = land;
    this.c.route[this.c.route.length - 1] = [this.x, this.y, this.z];
    this.runup = 0.0;
    this.c.features.push({ type: "dash", segment: this.seg, length: seg.length, drop: seg.drop });
  }

  wallclimb(length, rise, direction) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z = this.z;
    const a = length / 2.0;
    const side = direction === "left" ? 1 : -1;
    this.c.landmarks.push(["wallclimb", [this.x, this.y, z], this.heading]);
    for (const [b0, b1, top] of [[0, a, z], [a, length, z + rise]]) {
      const poly = rect(o, f, l, b0, b1, half, half);
      this.add(Prism.flat(poly, z - FLOOR_THICK, top, "floor", this.heading));
      this.c.floorPolys.push([poly, "floor"]);
      const b = side > 0 ? band(o, f, l, b0, b1, -half, -half + EDGE_BAND)
        : band(o, f, l, b0, b1, half - EDGE_BAND, half);
      this.add(Prism.flat(b, top - 4, top + 1, "edge"));
    }
    this.add(Prism.flat(rect(o, f, l, a, a + 32, half - EDGE_BAND, half - EDGE_BAND),
      z + rise - 4, z + rise + 1, "edge", this.heading));
    const wall = this.wallPoly(o, f, l, side, 0, length);
    this.add(Prism.flat(wall, z - FLOOR_THICK, z + rise + WALL_HEIGHT, "kick"));
    this.hull(rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK),
      z - FLOOR_THICK, z + rise + WALL_HEIGHT);
    this.advance(a - WALLCLIMB_ARC);
    this.z += rise;
    this.advance(WALLCLIMB_ARC);
    this.advance(length - a);
    this.c.features.push({ type: "wallclimb", segment: this.seg, side: direction, rise });
  }

  selfIntersections() {
    const hs = this.c.hulls;
    const over = new Map();
    for (let i = 0; i < hs.length; i++) {
      for (let j = i + 1; j < hs.length; j++) {
        const a = hs[i], b = hs[j];
        if (Math.abs(a.seg - b.seg) <= 1) continue;
        if (a.zhi <= b.zlo || b.zhi <= a.zlo) {
          if (satOverlap(a.poly, b.poly)) {
            const [lo, hi] = a.zhi <= b.zlo ? [a, b] : [b, a];
            const key = lo.seg + "," + hi.seg;
            const prev = over.has(key) ? over.get(key)[2] : 1e9;
            over.set(key, [lo.seg, hi.seg, Math.min(prev, hi.zlo - lo.zhi)]);
          }
          continue;
        }
        if (satOverlap(a.poly, b.poly)) {
          this.problems.push(`course runs into itself: ${segname(a.seg)} overlaps ${segname(b.seg)}`);
          this.c.collision = [a.seg, b.seg];
          return;
        }
      }
    }
    const items = [...over.values()].sort(cmpTuple);
    for (const [lo, hi, clear] of items) {
      if (this.c.overpasses.some((p) => Math.abs(lo - p.lower) <= 1 && Math.abs(hi - p.upper) <= 1)) continue;
      this.c.overpasses.push({ lower: lo, upper: hi, clearance: pyRound(clear) });
    }
  }

  cutsCheck() {
    const walk = this.walkSurfaces();
    const walkKeys = [...walk.keys()].sort((a, b) => a - b);
    for (const src of [...this.c.falloffSegs].sort((a, b) => a - b)) {
      if (!walk.has(src)) continue;
      const [zs, polysS] = walk.get(src);
      for (const tgt of walkKeys) {
        if (tgt - src <= 1) continue;
        if (this.declaredShortcut(src, tgt)) continue;
        const saved = this.cutSkip(src, tgt);
        if (saved < Math.max(CUT_MIN_SKIP, CUT_MIN_FRACTION * this.c.length)) continue;
        const [zt, polysT] = walk.get(tgt);
        const drop = zs - zt;
        if (drop < 0) continue;
        if (!this.c.openSegs.has(tgt) && drop <= WALL_HEIGHT) continue;
        let gap = Infinity;
        for (const a of polysS) for (const b of polysT) gap = Math.min(gap, polyGap(a, b));
        const fl = airTime(drop);
        if (fl === null || fl <= 0.0) continue;
        const needed = gap / fl;
        if (needed >= CUT_SPEED_OK) continue;
        const reach = CUT_SPEED_OK * fl;
        if (!this.c.openSegs.has(tgt) && this.roof(tgt, polysS, reach)) {
          this.c.cuts.push({ kind: "drop", from: src, to: tgt, saves: pyRound(saved), gap: pyRound(gap),
            needs_ups: pyRound(needed), fixed: "roofed" });
          continue;
        }
        this.c.cuts.push({ kind: gap ? "jump" : "drop", from: src, to: tgt, saves: pyRound(saved),
          gap: pyRound(gap), needs_ups: pyRound(needed) });
        const how = gap <= 1.0 ? `drop straight down onto ${segname(tgt)}`
          : `jump the ${int(gap)} units to ${segname(tgt)} at only ${int(needed)} ups`;
        this.problems.push(
          `unintended shortcut: from ${segname(src)} a player can ${how}, skipping ` +
          `about ${int(saved)} units of the course. Both are open, so there is ` +
          "nothing in the way — give the later one walls (drop its \"open\": " +
          "true), or bend the course so the two do not pass so close");
      }
    }
  }

  walkSurfaces() {
    const out = new Map();
    for (const h of this.c.hulls) {
      const top = h.zlo + FLOOR_THICK;
      const cur = out.get(h.seg);
      if (cur === undefined) out.set(h.seg, [top, [h.poly]]);
      else out.set(h.seg, [Math.min(cur[0], top), [...cur[1], h.poly]]);
    }
    return out;
  }

  roof(seg, srcPolys, reach) {
    let done = false;
    this.c.hulls.forEach((h, idx) => {
      if (h.seg !== seg || this.roofed.has(idx)) return;
      if (Math.min(...srcPolys.map((sp) => polyGap(sp, h.poly))) > reach) return;
      this.add(Prism.flat(h.poly, h.zhi - ROOF_THICK, h.zhi, "wall")).seg = seg;
      this.roofed.add(idx);
      done = true;
    });
    return done || this.c.hulls.some((h, i) => h.seg === seg && this.roofed.has(i));
  }

  cutSkip(a, b) {
    const d = this.c.segDist;
    if (a >= d.length || b >= d.length) return 0.0;
    return Math.abs(d[b] - d[a]);
  }

  declaredShortcut(a, b) {
    return b === a + 2 && this.c.shortcuts.some((s) => s.turn === a + 1);
  }

  shell() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of this.c.world) {
      for (const [x, y] of p.poly) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      z0 = Math.min(z0, p.zmin); z1 = Math.max(z1, p.zmax());
    }
    const m = SHELL_MARGIN;
    x0 -= m; x1 += m; y0 -= m; y1 += m; z0 -= PIT_DEPTH; z1 += m;
    const T = 16;
    const box = (a, b, c, d, lo, hi) => {
      const p = Prism.flat([[a, c], [b, c], [b, d], [a, d]], lo, hi, "sky");
      p.seg = null;
      return p;
    };
    this.c.world.push(
      box(x0 - T, x1 + T, y0 - T, y1 + T, z0 - T, z0),
      box(x0 - T, x1 + T, y0 - T, y1 + T, z1, z1 + T),
      box(x0 - T, x0, y0, y1, z0, z1),
      box(x1, x1 + T, y0, y1, z0, z1),
      box(x0 - T, x1 + T, y0 - T, y0, z0, z1),
      box(x0 - T, x1 + T, y1, y1 + T, z0, z1),
    );
    const hurt = Prism.flat([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z0 + 64, "trigger");
    this.c.entities.push([{ classname: "trigger_hurt", dmg: 9999 }, [hurt]]);
    this.c.bounds = [[x0, y0, z0], [x1, y1, z1]];
  }
}

export function brushCount(course) {
  return course.world.length + course.entities.reduce((n, [, b]) => n + b.length, 0);
}

// Spec -> { problems, course }, the way layout.build() judges it.
//
// problems is exactly what the generator would say: spec.validate()'s list
// when the ranges are wrong (and then, like the Python, no layout), otherwise
// layout's own. Unlike layout.build(), a course is returned even when layout
// found problems, so the editor can show WHERE the course runs into itself;
// course is null only when the ranges are wrong or the walk itself fails.
export function build(spec) {
  const problems = validate(spec);
  if (problems.length) return { problems, course: null };
  let course;
  const w = new Walker(spec);
  try {
    course = w.run();
  } catch (e) {
    return { problems: [`layout failed: ${e.message}`], course: null };
  }
  return { problems: w.problems, course };
}

// Lay the course out regardless of name/title problems: those are words, not
// geometry, and the editor should keep drawing while a title is half-typed.
export function preview(spec) {
  const geometric = validate({ ...spec, name: "gen_preview", title: "Preview" });
  if (geometric.length) return { problems: geometric, course: null };
  return build({ ...spec, name: "gen_preview", title: "Preview" });
}

// The facts the build report will carry, from a laid-out course.
export function summary(course, spec) {
  return {
    route_length: pyRound(course.length),
    par_seconds: pyRound(course.length / 320.0, 1),
    brushes: brushCount(course),
    checkpoints: course.entities.filter(([e]) => e.classname === "target_checkpoint").length,
    auto_checkpoints: course.autoCheckpoints.length,
    shortcuts: course.shortcuts,
    par_seconds_shortcuts: pyRound((course.length - course.shortcuts.reduce((n, s) => n + s.saves, 0)) / 320.0, 1),
    features: course.features,
    overpasses: course.overpasses,
    ice_segments: spec.segments.flatMap((s, i) => (s.ice ? [i] : [])),
  };
}
