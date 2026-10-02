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

// What the language model is taught to write; SEGMENT_SCHEMA's enum is these.
export const MODEL_SEGMENT_TYPES = ["straight", "turn", "ramp", "gap", "checkpoint", "slalom",
  "beam", "split", "wallclimb", "wallgap", "dash"];
// ...and what the map editor can lay as well: shape rather than move, asking
// nothing of the player that physics.py has to model.
export const EDITOR_SEGMENT_TYPES = ["stairs", "platforms", "pillars", "tunnel", "chicane",
  "bumps", "pinch", "ledge", "hazard", "strafepads"];
export const SEGMENT_TYPES = [...MODEL_SEGMENT_TYPES, ...EDITOR_SEGMENT_TYPES];
// A piece can be open (no side walls, floating over the void) if it HAS side
// walls to lose and a floor to paint the edge of.
export const OPENABLE = ["straight", "turn", "ramp", "gap", "stairs", "platforms", "pillars",
  "chicane", "bumps", "pinch", "hazard"];
// Ice floors a piece. Anything with a walking surface can carry it.
export const ICEABLE = ["straight", "turn", "ramp", "slalom", "stairs", "platforms", "pillars",
  "tunnel", "chicane", "bumps", "pinch", "ledge", "strafepads"];
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

// -- the pieces that are shape rather than move (spec.py) -------------------
export const FIN_THICK = 32;
export const PLAYER_WIDTH = 32;
export const STAIRS_RISE_MAX = 2048;
export const STAIR_TREAD_MIN = 16;
export const PLATFORM_MIN = 64;
export const PLATFORM_FILL = 0.55;
export const BUMP_MIN = 64;
export const PILLAR_MIN = 48;
export const PILLAR_CLEAR = 64;
export const TUNNEL_MIN = 96;
export const TUNNEL_SAFE = 160;
export const PINCH_MIN = PLAYER_WIDTH + 16;
export const PINCH_BITE = 32;
export const LEDGE_MIN = 48;
export const LEDGE_CLEAR = 64;
export const HAZARD_MIN = 64;
export const STRAFE_PAD_LEN = 128;
export const STRAFE_GAP_MIN = 32;
export const CHICANE_ANGLE = [10, 90];
export const SHIFT_MAX = 4096;
export const ROTATE_MAX = 180;
export const AWAY_MAX = 8192;
export const ROLL_MAX = 180;
export const PITCH_MAX = 180;
export const STRICT_SHIFT_MAX = 256;
export const STRICT_ROTATE_MAX = 30;

// -- the two rule tiers (spec.STRICT / spec.OPEN) ---------------------------
// "strict" is the generator's own: every bound is one physics.py can defend,
// because a described map or a random_map tile goes in the pool with nobody
// having looked at it. "open" is this editor: a person is laying the course
// out, they can see it, and an admin approves it before it is built, so what
// is left are the limits that decide whether the map COMPILES and LOADS.
export const STRICT = {
  name: "strict",
  physics: true,
  combine: true,
  angles: TURN_ANGLES,
  angleRange: null,
  route: ROUTE_MAX,
  segments: MAX_SEGMENTS,
  width: [WIDTH_MIN, WIDTH_MAX],
  straight: [STRAIGHT_MIN, STRAIGHT_MAX],
  ramp: [RAMP_MIN, RAMP_MAX],
  rise: 1024,
  slope: null,
  radiusSlack: 64,
  radiusMax: TURN_RADIUS_MAX,
  gap: [GAP_MIN, GAP_LENGTH_MAX],
  dropMax: DROP_MAX,
  dropMin: null,
  slalomCount: SLALOM_COUNT,
  slalomSpacing: SLALOM_SPACING,
  beam: [STRAIGHT_MIN, BEAM_MAX_LENGTH],
  beamClear: BEAM_WALL_CLEAR,
  splitCount: SPLIT_COUNT,
  splitRunway: SPLIT_RUNWAY,
  wallclimbRise: WALLCLIMB_RISE,
  wallclimbMin: WALLCLIMB_MIN,
  wallgapDrop: WALLGAP_DROP,
  dashDrop: DASH_DROP,
  chicaneAngle: [10, 90],
  bumpsRise: [16, 256],
  padsCount: [2, 16],
  padsSpacing: [STRAFE_PAD_LEN + STRAFE_GAP_MIN, 512],
  padsCurve: 90,
  stairsCount: [2, 32],
  platformsCount: [2, 12],
  pillarsCount: [1, 12],
  bumpsCount: [1, 12],
  tunnelHeight: [TUNNEL_SAFE, 512],
  pinchGate: [PINCH_MIN, null],
  ledgeWidth: [LEDGE_MIN, null],
  hazard: [HAZARD_MIN, null],
  shift: STRICT_SHIFT_MAX,
  rotate: STRICT_ROTATE_MAX,
  // Forbidden in this tier: `away` opens the unclearable gap every physics
  // rule here exists to prevent, and roll/pitch leave the upright, 2-D world
  // that the cut and self-intersection answers are computed in.
  away: 0,
  roll: 0,
  pitch: 0,
  extentXY: 16384,
  extentZ: 8192,
  brushes: 1500,
};

// "Within reason" means the same thing throughout: the map still compiles,
// still loads, and the piece is still the shape its name says.
export const OPEN = {
  name: "open",
  physics: false,
  combine: false,
  angles: null,
  angleRange: [5, 180],
  route: 200000,
  segments: 256,
  width: [64, 2048],
  straight: [32, 16384],
  ramp: [32, 16384],
  rise: 8192,
  slope: 3.0,
  radiusSlack: 8,
  radiusMax: 8192,
  gap: [16, 8192],
  dropMax: 8192,
  dropMin: -8192,
  slalomCount: [1, 48],
  slalomSpacing: FIN_THICK + PLAYER_WIDTH,
  beam: [32, 8192],
  beamClear: 16,
  splitCount: [1, 24],
  splitRunway: 32,
  wallclimbRise: [16, 1024],
  wallclimbMin: 64,
  wallgapDrop: [-1024, 0],
  dashDrop: [32, 4096],
  chicaneAngle: [5, 170],
  bumpsRise: [8, 1024],
  padsCount: [1, 64],
  padsSpacing: [STRAFE_PAD_LEN + STRAFE_GAP_MIN, 4096],
  padsCurve: 270,
  stairsCount: [1, 128],
  platformsCount: [1, 48],
  pillarsCount: [1, 48],
  bumpsCount: [1, 48],
  tunnelHeight: [TUNNEL_MIN, 4096],
  pinchGate: [PINCH_MIN, null],
  ledgeWidth: [LEDGE_MIN, null],
  hazard: [HAZARD_MIN, 8192],
  shift: SHIFT_MAX,
  rotate: ROTATE_MAX,
  away: AWAY_MAX,
  roll: ROLL_MAX,
  pitch: PITCH_MAX,
  extentXY: 30000,
  extentZ: 16000,
  brushes: 6000,
};

export const TIERS = { strict: STRICT, open: OPEN };

// Anything unknown is the strict tier, so a caller that forgets to pass one
// gets the safe tier and never the loose one.
export const tier = (rules) => TIERS[rules] || STRICT;


export const wallgapWindow = (drop) => [WALLGAP_MIN, int(wallJumpReach(drop))];
export const dashWindow = (drop) => [int(jumpReach(drop)) + 1, int(dashReach(drop))];

export function routeLength(seg) {
  const t = seg.type;
  if (t === "turn" || t === "chicane") {
    const a = radians(typeof seg.angle === "number" ? seg.angle : 0);
    // A chicane is two arcs of the same angle, one each way.
    return a * (seg.radius ?? 0) * (t === "chicane" ? 2 : 1);
  }
  if (t === "strafepads") {
    // The run is its pads end to end, however it bends.
    const n = seg.count, sp = seg.spacing;
    if (!isNum(n) || !isNum(sp)) return 0.0;
    return Number(n) * Number(sp);
  }
  if (t === "checkpoint") return 0.0;
  const n = seg.length ?? 0;
  if (!isNum(n)) return 0.0;
  return Number(n) + (t === "dash" ? DASH_PAD : 0);
}

export const splitHole = () => int(maxGap(0) * SPLIT_HOLE_FILL);
export const splitMinLength = (count, rules = "strict") =>
  2 * SPLIT_MOUTH + count * (tier(rules).splitRunway + splitHole()) + SPLIT_LANDING;
export const platformCell = () => int(PLATFORM_MIN / PLATFORM_FILL);
export const turnRadiusMin = (width, rules = "strict") =>
  Math.floor(width / 2) + tier(rules).radiusSlack;

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
  stairs: ["length", "rise", "count", "open", "ice"],
  platforms: ["length", "count", "drop", "open", "ice"],
  pillars: ["length", "count", "open", "ice"],
  tunnel: ["length", "height", "ice"],
  chicane: ["direction", "angle", "radius", "open", "ice"],
  bumps: ["length", "count", "rise", "open", "ice"],
  pinch: ["length", "gate", "open", "ice"],
  ledge: ["length", "direction", "ledge_width", "ice"],
  hazard: ["length", "open"],
  strafepads: ["count", "spacing", "curve", "ice"],
};
// Every piece may be placed relative to the one before it: three that move
// the cursor and two that turn the piece's brushes. See spec.PLACEMENT.
export const NUDGE = ["away", "shift", "rotate", "roll", "pitch"];
// The fields each piece type uses, for the editor's inspector.
export const FIELDS = KEEP;

export function normalize(spec) {
  const out = {};
  for (const k of ["name", "title", "width"]) if (k in spec) out[k] = spec[k];
  out.segments = [];
  for (const seg of spec.segments || []) {
    const t = seg.type;
    const clean = { type: t };
    for (const k of [...(KEEP[t] || []), ...NUDGE]) if (k in seg) clean[k] = seg[k];
    for (const flag of ["shortcut", "open", "ice"]) if (clean[flag] === false) delete clean[flag];
    for (const z of NUDGE) if (clean[z] === 0) delete clean[z];
    out.segments.push(clean);
  }
  return out;
}

export function validate(spec, rules = "strict") {
  // `rules` names the tier (STRICT / OPEN above). The strict tier measures
  // every take-off against the physics; the open tier — this editor — keeps
  // only the bounds that decide whether the course can be built at all.
  const L = tier(rules);
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
  if (!Number.isInteger(width) || !(L.width[0] <= width && width <= L.width[1])) {
    errs.push(`width ${pyRepr(width)} must be an integer in [${L.width[0]}, ${L.width[1]}]`);
    width = 384;
  }

  const segs = spec.segments;
  if (!Array.isArray(segs) || !segs.length) {
    // The start and the finish are implicit, so this is the whole of "a
    // course needs a start, a finish, and something in between".
    errs.push("segments must be a non-empty list: a course needs at least one " +
      "piece between its start and its finish");
    return errs;
  }
  if (segs.length > L.segments) errs.push(`${segs.length} segments; at most ${L.segments}`);

  let route = 0.0;
  for (const seg of segs) {
    if (!isObj(seg)) continue;
    const v = seg[(seg.type === "turn" || seg.type === "chicane") ? "radius" : "length"];
    if (isNum(v) && v > 0) route += routeLength(seg);
  }
  if (route > L.route) {
    errs.push(`the route is ${int(route)} units long; at most ${L.route} ` +
      `(about ${Math.floor(L.route / 320)} s at 320 ups)`);
  }

  const slope = L.slope !== null ? L.slope : maxRampSlope();
  const radiusMin = turnRadiusMin(width, rules);
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
    const needsWidth = (least, why) => {
      if (width < least) errs.push(`${where}: needs width >= ${least} (${why})`);
    };

    if ("open" in seg && typeof seg.open !== "boolean") {
      errs.push(`${where}: open must be true or false`);
    } else if (seg.open && !OPENABLE.includes(t)) {
      errs.push(`${where}: only ${OPENABLE.join(", ")} can be open ` +
        "(the rest have no side walls to lose)");
    }
    if ("ice" in seg && typeof seg.ice !== "boolean") {
      errs.push(`${where}: ice must be true or false`);
    } else if (seg.ice && !ICEABLE.includes(t)) {
      errs.push(`${where}: only ${ICEABLE.join(", ")} can be ice ` +
        "(a piece with no walking surface has nothing to be slick)");
    }

    // Every piece may be placed relative to the one before it. A tier that
    // forbids one of these bounds it to [0, 0], so the message says so
    // rather than pretending the field is unknown.
    for (const key of NUDGE) if (key in seg) num(key, -L[key], L[key]);

    const side = (what = "the side of the kick wall") => {
      if (seg.direction !== "left" && seg.direction !== "right") {
        errs.push(`${where}: direction (${what}) must be 'left' or 'right'`);
      }
    };
    const arc = (what) => {
      if (seg.direction !== "left" && seg.direction !== "right") {
        errs.push(`${where}: direction must be 'left' or 'right'`);
      }
      if (what === "chicane") {
        whole("angle", ...L.chicaneAngle);
      } else if (L.angles !== null) {
        if (!L.angles.includes(seg.angle)) {
          errs.push(`${where}: angle ${pyRepr(seg.angle)} must be one of ${tupleRepr(L.angles)}`);
        }
      } else {
        whole("angle", ...L.angleRange);
      }
      num("radius", radiusMin, L.radiusMax);
    };

    if (t === "straight") {
      num("length", ...L.straight);
    } else if (t === "turn") {
      arc("turn");
      if (seg.shortcut) {
        if (seg.angle !== 180) {
          errs.push(`${where}: a shortcut needs a 180-degree turn, not ${pyRepr(seg.angle)}`);
        } else if (L.combine) {
          for (const [j, rel] of [[i - 1, "before"], [i + 1, "after"]]) {
            const nb = j >= 0 && j < segs.length ? segs[j] : null;
            if (!isObj(nb) || nb.type !== "straight" || !isNum(nb.length)
                || nb.length < SHORTCUT_MIN_LEG) {
              errs.push(`${where}: a shortcut needs a straight of at least ` +
                `${SHORTCUT_MIN_LEG} directly ${rel} the turn`);
            }
          }
        }
      }
    } else if (t === "ramp") {
      const length = num("length", ...L.ramp);
      const rise = num("rise", -L.rise, L.rise);
      if (length && rise !== null && Math.abs(rise) > slope * length + 1e-6) {
        errs.push(`${where}: rise ${rise} over length ${length} is steeper than ` +
          `${Math.round(degrees(Math.atan(slope)))} degrees; |rise| must be <= ${int(slope * length)}`);
      }
    } else if (t === "gap") {
      const drop = num("drop", L.dropMin !== null ? L.dropMin : -int(maxRise()), L.dropMax);
      const length = num("length", ...L.gap);
      if (L.physics && drop !== null && length !== null) {
        const reach = maxGap(drop);
        if (length > reach) {
          errs.push(`${where}: a ${length}-unit gap with drop ${drop} is not ` +
            `clearable from a 320 ups run-up; max is ${int(reach)}`);
        }
      }
    } else if (t === "checkpoint") {
      // nothing to check
    } else if (t === "slalom") {
      const length = num("length", ...L.straight);
      const count = whole("count", ...L.slalomCount);
      needsWidth(SLALOM_GATE + SLALOM_FIN_MIN, `a ${SLALOM_GATE}-unit gate beside each fin`);
      if (length && count && length / (count + 1) < L.slalomSpacing) {
        errs.push(`${where}: ${count} fins in ${length} units are closer than ` +
          `${L.slalomSpacing}; length must be >= ${L.slalomSpacing * (count + 1)}`);
      }
    } else if (t === "beam") {
      num("length", ...L.beam);
      num("beam_width", BEAM_MIN, Math.max(BEAM_MIN, width - 2 * L.beamClear));
    } else if (t === "split") {
      side("the side of the fast lane with the holes");
      const count = whole("count", ...L.splitCount);
      const length = num("length", ...L.straight);
      needsWidth(2 * SPLIT_LANE_MIN + SPLIT_MEDIAN, `two ${SPLIT_LANE_MIN}-unit lanes`);
      const least = count ? splitMinLength(count, rules) : null;
      if (length && least && length < least) {
        errs.push(`${where}: ${count} hole(s) need length >= ${least}`);
      }
    } else if (t === "wallclimb") {
      side();
      num("length", L.wallclimbMin, L.straight[1]);
      whole("rise", ...L.wallclimbRise);
    } else if (t === "wallgap") {
      side();
      const drop = whole("drop", ...L.wallgapDrop);
      const length = num("length", ...L.gap);
      if (L.physics && drop !== null && length !== null) {
        const [lo, hi] = wallgapWindow(drop);
        if (!(lo <= length && length <= hi)) {
          errs.push(`${where}: at drop ${drop} a wall-kick gap must be ${lo}-${hi} ` +
            "long; longer cannot be made even with the wall jump");
        }
      }
    } else if (t === "dash") {
      const drop = whole("drop", ...L.dashDrop);
      const length = num("length", ...L.gap);
      if (L.physics && drop !== null && length !== null) {
        const [lo, hi] = dashWindow(drop);
        if (!(lo <= length && length <= hi)) {
          errs.push(`${where}: at drop ${drop} a dash gap must be ${lo}-${hi} long: ` +
            "shorter can be jumped, longer cannot be dashed");
        }
      }

    // -- shape pieces -------------------------------------------------------
    } else if (t === "stairs") {
      const length = num("length", ...L.straight);
      const count = whole("count", ...L.stairsCount);
      const cap = Math.min(L.rise, STAIRS_RISE_MAX);
      const rise = num("rise", -cap, cap);
      if (length && count && length / count < STAIR_TREAD_MIN) {
        errs.push(`${where}: ${count} steps in ${length} units leave treads under ` +
          `${STAIR_TREAD_MIN}; length must be >= ${STAIR_TREAD_MIN * count}`);
      }
      if (L.physics && count && rise !== null && Math.abs(rise) / count > STEP_SIZE) {
        errs.push(`${where}: steps of ${int(Math.abs(rise) / count)} are taller than the ` +
          `${int(STEP_SIZE)}-unit step the engine walks up; use more steps or less rise`);
      }
    } else if (t === "platforms") {
      const length = num("length", ...L.straight);
      const count = whole("count", ...L.platformsCount);
      const drop = num("drop", L.dropMin !== null ? L.dropMin : -int(maxRise()), L.dropMax);
      const cell = platformCell();
      if (length && count && length / count < cell) {
        errs.push(`${where}: ${count} stones need length >= ${cell * count} ` +
          `(each is a ${PLATFORM_MIN}-unit landing and the hole before it)`);
      }
      if (L.physics && length && count) {
        const hole = (length / count) * (1.0 - PLATFORM_FILL);
        const reach = maxGap(drop || 0);
        if (hole > reach) {
          errs.push(`${where}: the holes are ${int(hole)} units; at drop ` +
            `${int(drop || 0)} a run-speed jump clears ${int(reach)}`);
        }
      }
    } else if (t === "pillars") {
      const length = num("length", ...L.straight);
      const count = whole("count", ...L.pillarsCount);
      needsWidth(PILLAR_MIN + 2 * PILLAR_CLEAR,
        `a ${PILLAR_CLEAR}-unit gate either side of each pillar`);
      if (length && count && length / count < FIN_THICK + PLAYER_WIDTH) {
        errs.push(`${where}: ${count} pillars in ${length} units would touch; ` +
          `length must be >= ${(FIN_THICK + PLAYER_WIDTH) * count}`);
      }
    } else if (t === "tunnel") {
      num("length", ...L.straight);
      num("height", ...L.tunnelHeight);
    } else if (t === "chicane") {
      arc("chicane");
    } else if (t === "bumps") {
      const length = num("length", ...L.straight);
      const count = whole("count", ...L.bumpsCount);
      const rise = num("rise", ...L.bumpsRise);
      if (length && count && length / count < BUMP_MIN) {
        errs.push(`${where}: ${count} bumps in ${length} units are shorter than ` +
          `${BUMP_MIN}; length must be >= ${BUMP_MIN * count}`);
      }
      if (L.physics && length && count && rise) {
        const half = length / count / 2.0;
        if (rise > slope * half + 1e-6) {
          errs.push(`${where}: bumps ${int(rise)} tall over ${int(half)}-unit ` +
            `faces are steeper than ${Math.round(degrees(Math.atan(slope)))} ` +
            `degrees; rise must be <= ${int(slope * half)}`);
        }
      }
    } else if (t === "pinch") {
      num("length", ...L.straight);
      needsWidth(PINCH_MIN + 2 * PINCH_BITE,
        `a ${PINCH_MIN}-unit gate with ${PINCH_BITE} taken off each side`);
      num("gate", PINCH_MIN, Math.max(PINCH_MIN, width - 2 * PINCH_BITE));
    } else if (t === "ledge") {
      side("the wall the walkway runs along");
      num("length", ...L.beam);
      num("ledge_width", LEDGE_MIN, Math.max(LEDGE_MIN, width - LEDGE_CLEAR));
    } else if (t === "strafepads") {
      whole("count", ...L.padsCount);
      const spacing = num("spacing", ...L.padsSpacing);
      num("curve", -L.padsCurve, L.padsCurve);
      if (L.physics && spacing !== null) {
        const gap = spacing - STRAFE_PAD_LEN;
        const reach = maxGap(0);
        if (gap > reach) {
          errs.push(`${where}: ${int(gap)} units between pads; a run-speed jump ` +
            `clears ${int(reach)}`);
        }
      }
    } else if (t === "hazard") {
      let [lo, hi] = L.hazard;
      if (hi === null) hi = int(maxGap(0));
      num("length", lo, hi);
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
// The strict tier's own numbers; STRICT above is where they are written down.
export const EXTENT_MAX_XY = STRICT.extentXY;
export const EXTENT_MAX_Z = STRICT.extentZ;
export const BRUSH_MAX = STRICT.brushes;
// FIN_THICK is declared with the shape-piece constants above.
const SPLIT_GATE = 96;
export const VOID_DEPTH = 160;
const EDGE_BAND = 16;
const WALLCLIMB_ARC = 96;
const HAZARD_DEPTH = 64;
const HAZARD_LIP = 8;
const JOINT_DEPTH = 64;
const ROOF_THICK_TUNNEL = 16;

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
    // A roll/pitch applied after this brush was laid flat: [origin, 3x3].
    this.tilt = null;
  }
  topAt(x, y) { return this.top0 + this.gx * x + this.gy * y; }
  // [bottom ring, top ring] in world space, tilt applied. The only honest
  // answer to "where is this brush": everything that has to agree with the
  // compiled map reads it here, because a tilted brush is not its footprint.
  corners() {
    const bot = this.poly.map(([x, y]) => [x, y, this.zmin]);
    const top = this.poly.map(([x, y]) => [x, y, this.topAt(x, y)]);
    if (!this.tilt) return [bot, top];
    return [bot.map((v) => tiltPoint(this.tilt, v)), top.map((v) => tiltPoint(this.tilt, v))];
  }
  zmax() {
    if (!this.tilt) return Math.max(...this.poly.map(([x, y]) => this.topAt(x, y)));
    const [bot, top] = this.corners();
    return Math.max(...bot.concat(top).map((v) => v[2]));
  }
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

// Rotation matrix about a UNIT axis, counter-clockwise looking along it.
// Rows, so rotateDir() is a plain dot per row. Mirrors layout._rodrigues.
export function rodrigues(axis, deg) {
  const a = radians(deg);
  const c = Math.cos(a), si = Math.sin(a);
  const [x, y, z] = axis;
  const t = 1.0 - c;
  return [[t * x * x + c, t * x * y - si * z, t * x * z + si * y],
    [t * x * y + si * z, t * y * y + c, t * y * z - si * x],
    [t * x * z - si * y, t * y * z + si * x, t * z * z + c]];
}

export function matmul(a, b) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const row = [];
    for (let j = 0; j < 3; j++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += a[i][k] * b[k][j];
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

// A direction through the matrix; no translation, so normals use this.
export function rotateDir(m, v) {
  return [0, 1, 2].map((i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2]);
}

// A point through a tilt: rotate about the tilt's own origin.
export function tiltPoint(tilt, v) {
  const [o, m] = tilt;
  const d = rotateDir(m, [v[0] - o[0], v[1] - o[1], v[2] - o[2]]);
  return [d[0] + o[0], d[1] + o[1], d[2] + o[2]];
}

// Twice the signed area of a footprint, unsigned; mirrors layout._area.
function polyArea(poly) {
  let a = 0.0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2.0;
}

// Convex hull, counter-clockwise (monotone chain); mirrors layout._hull.
// Every brush footprint has to be convex, and the hull is how a nudge's seam
// stays one.
function convexHull(points) {
  const seen = new Map();
  for (const [x, y] of points) {
    const p = [pyRound(x, 4), pyRound(y, 4)];
    seen.set(`${p[0]},${p[1]}`, p);
  }
  const pts = [...seen.values()].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  if (pts.length < 3) return pts;
  const half = (seq) => {
    const out = [];
    for (const p of seq) {
      while (out.length >= 2) {
        const [ax, ay] = out[out.length - 2], [bx, by] = out[out.length - 1];
        if ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) > 0) break;
        out.pop();
      }
      out.push(p);
    }
    return out;
  };
  const lower = half(pts), upper = half([...pts].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

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
// What a gap, a wall-kick gap or a dash may land on: a piece whose floor is
// solid where the jump arrives. platforms (a hole at its lip), ledge (void but
// for the walkway), hazard (lethal) and strafepads do not qualify.
const LANDINGS = ["straight", "turn", "slalom", "split", "wallclimb",
  "stairs", "pillars", "tunnel", "chicane", "bumps", "pinch"];

class Walker {
  constructor(spec, rules = "strict") {
    this.rules = rules;
    this.L = tier(rules);
    this.c = {
      spec, world: [], entities: [], hulls: [], floorPolys: [], route: [], landmarks: [],
      shortcuts: [], features: [], overpasses: [], segDist: [], openSegs: new Set(),
      falloffSegs: new Set(), cuts: [], autoCheckpoints: [], length: 0.0, bounds: null,
      // Open tier: the pieces-fit-together problems, kept as notes.
      notes: [],
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

  // A problem with how the pieces fit TOGETHER — a missing run-up, a landing
  // on nothing, the course crossing itself, a cut round the side. Refusals in
  // the strict tier, which nobody looks at before it is in the pool; notes on
  // the report in the open tier, where a person can see the course and an
  // admin signs it off.
  note(msg) {
    if (this.L.combine) this.problems.push(msg);
    else this.c.notes.push(msg);
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

  // -- shape pieces -------------------------------------------------------
  // Mirrors layout.py's methods of the same names, brush for brush and in the
  // same order: the golden fixture compares them one by one.

  stairs(length, rise, count, tex = "floor", walls = [1, -1]) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z0 = this.z;
    const tread = length / count, step = rise / count;
    const lo = z0 + Math.min(0.0, rise), hi = z0 + Math.max(0.0, rise);
    const base = lo - FLOOR_THICK;
    for (let n = 0; n < count; n++) {
      const poly = rect(o, f, l, n * tread, (n + 1) * tread, half, half);
      this.add(Prism.flat(poly, base, z0 + step * (n + 1), tex, this.heading));
      this.c.floorPolys.push([poly, tex]);
    }
    for (const side of [1, -1]) {
      if (walls.includes(side)) {
        this.add(Prism.flat(this.wallPoly(o, f, l, side, 0, length), base, hi + WALL_HEIGHT, "wall"));
      } else {
        const b = side > 0 ? band(o, f, l, 0, length, half - EDGE_BAND, half)
          : band(o, f, l, 0, length, -half, -half + EDGE_BAND);
        this.add(Prism.flat(b, base, hi + 1, "edge"));
      }
    }
    this.hull(rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK), base, hi + WALL_HEIGHT);
    this.c.features.push({ type: "stairs", segment: this.seg, steps: count,
      step: pyRound(Math.abs(step), 1) });
    this.advance(length, rise);
  }

  platforms(length, count, drop, tex = "platform", walls = [1, -1]) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z0 = this.z;
    const cell = length / count;
    const stone = cell * PLATFORM_FILL;
    const lo = z0 + Math.min(0.0, drop), hi = z0 + Math.max(0.0, drop);
    const base = lo - FLOOR_THICK - VOID_DEPTH;
    for (const side of [1, -1]) {
      if (walls.includes(side)) {
        this.add(Prism.flat(this.wallPoly(o, f, l, side, 0, length), base, hi + WALL_HEIGHT, "wall"));
      }
    }
    for (let n = 0; n < count; n++) {
      const a = (n + 1) * cell - stone;
      const z = z0 + (drop * (n + 1)) / count;
      const poly = rect(o, f, l, a, a + stone, half, half);
      this.add(Prism.flat(poly, z - FLOOR_THICK, z, tex, this.heading));
      this.c.floorPolys.push([poly, tex]);
    }
    this.hull(rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK), base, hi + WALL_HEIGHT);
    this.c.features.push({ type: "platforms", segment: this.seg, stones: count,
      hole: pyRound(cell - stone) });
    this.advance(length, drop);
  }

  pillars(length, count, tex = "floor", walls = [1, -1]) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const pw = PILLAR_MIN;
    this.boxRun(length, { tex, walls });
    const cell = length / count;
    const spots = Array.from({ length: count }, (_, n) => cell * (n + 0.5));
    for (const a of spots) {
      const poly = band(o, f, l, a - pw / 2.0, a + pw / 2.0, -pw / 2.0, pw / 2.0);
      this.add(Prism.flat(poly, this.z - FLOOR_THICK, this.z + WALL_HEIGHT, "pylon"));
    }
    const lane = (half - pw / 2.0) / 2.0;
    this.reroute(o, f, l, spots.map((a, n) => [a, n % 2 ? lane : -lane]));
    this.c.features.push({ type: "pillars", segment: this.seg, pillars: count,
      gate: pyRound(half - pw / 2.0) });
  }

  tunnel(length, height, tex = "floor") {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z0 = this.z;
    this.boxRun(length, { tex });
    const poly = rect(o, f, l, 0, length, half + WALL_THICK, half + WALL_THICK);
    this.add(Prism.flat(poly, z0 + height, z0 + height + ROOF_THICK_TUNNEL, "wall"));
    this.hull(poly, z0 - FLOOR_THICK, z0 + height + ROOF_THICK_TUNNEL);
    this.c.features.push({ type: "tunnel", segment: this.seg, height });
  }

  chicane(direction, angle, radius, walls = true, tex = "floor") {
    const other = direction === "left" ? "right" : "left";
    this.turn(direction, angle, radius, walls, tex);
    this.turn(other, angle, radius, walls, tex);
    this.c.features.push({ type: "chicane", segment: this.seg, angle,
      offset: pyRound(2 * radius * (1 - Math.cos(radians(angle)))) });
  }

  bumps(length, count, rise, tex = "floor", walls = [1, -1]) {
    const cell = length / count;
    for (let n = 0; n < count; n++) {
      this.boxRun(cell / 2.0, { rise, tex, walls });
      this.boxRun(cell / 2.0, { rise: -rise, tex, walls });
    }
    this.c.features.push({ type: "bumps", segment: this.seg, bumps: count, rise });
  }

  pinch(length, gate, tex = "floor", walls = [1, -1]) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    this.boxRun(length, { tex, walls });
    for (const side of [1, -1]) {
      const [lo, hi] = side > 0 ? [gate / 2.0, half] : [-half, -gate / 2.0];
      this.add(Prism.flat(band(o, f, l, 0, length, lo, hi),
        this.z - FLOOR_THICK, this.z + WALL_HEIGHT, "pylon"));
    }
    this.c.features.push({ type: "pinch", segment: this.seg, gate });
  }

  ledge(length, direction, width, tex = "floor") {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z = this.z;
    const sign = direction === "left" ? 1.0 : -1.0;
    this.stripe("edge", -32, 0);
    this.boxRun(length, { floor: false, wallFloor: z - FLOOR_THICK - VOID_DEPTH });
    const [lo, hi] = sign > 0 ? [half - width, half] : [-half, -half + width];
    const poly = band(o, f, l, 0, length, lo, hi);
    this.add(Prism.flat(poly, z - FLOOR_THICK, z, tex, this.heading));
    this.c.floorPolys.push([poly, tex]);
    this.reroute(o, f, l, [[length / 2.0, sign * (half - width / 2.0)]]);
    this.c.features.push({ type: "ledge", segment: this.seg, width, side: direction });
  }

  hazard(length, walls = [1, -1]) {
    const [o, f, l] = this.frame();
    const half = this.w / 2.0;
    const z = this.z;
    this.boxRun(length, { floor: false, wallFloor: z - HAZARD_DEPTH - FLOOR_THICK, walls });
    const poly = rect(o, f, l, 0, length, half, half);
    this.add(Prism.flat(poly, z - HAZARD_DEPTH - FLOOR_THICK, z - HAZARD_DEPTH, "hazard", this.heading));
    this.c.floorPolys.push([poly, "hazard"]);
    this.c.landmarks.push(["hazard", [this.x, this.y, z], this.heading]);
    this.c.entities.push([{ classname: "trigger_hurt", dmg: 9999 },
      [Prism.flat(poly, z - HAZARD_DEPTH, z - HAZARD_LIP, "trigger")]]);
    this.c.features.push({ type: "hazard", segment: this.seg, length });
  }

  strafepads(count, spacing, curve, tex = "platform") {
    const total = Number(count) * spacing;
    const [o, f, l] = this.frame();
    const h0 = this.heading;
    const half = this.w / 2.0;
    const pad = STRAFE_PAD_LEN;
    const z = this.z;
    const sweep = Math.abs(curve);
    const sign = curve > 0 ? 1.0 : -1.0;
    const r = sweep ? total / radians(sweep) : 0.0;
    let cx = 0.0, cy = 0.0, a0 = 0.0;
    if (sweep) {
      cx = o[0] + l[0] * r * sign; cy = o[1] + l[1] * r * sign;
      a0 = Math.atan2(o[1] - cy, o[0] - cx);
    }
    const at = (dist) => {
      if (!sweep) return [[o[0] + f[0] * dist, o[1] + f[1] * dist], h0];
      const a = a0 + radians(sweep) * (dist / total) * sign;
      return [[cx + r * Math.cos(a), cy + r * Math.sin(a)], h0 + (sign * sweep * dist) / total];
    };
    for (let n = 0; n < count; n++) {
      const [[px, py], hd] = at((n + 0.5) * spacing);
      const ph = radians(hd);
      const pf = [Math.cos(ph), Math.sin(ph)], pl = [-Math.sin(ph), Math.cos(ph)];
      const poly = rect([px, py], pf, pl, -pad / 2.0, pad / 2.0, half, half);
      this.add(Prism.flat(poly, z - FLOOR_THICK, z, tex, hd));
      this.c.floorPolys.push([poly, tex]);
      this.hull(poly, z - FLOOR_THICK, z);
      this.c.route.push([px, py, z]);
    }
    const [[ex, ey]] = at(total);
    this.x = ex; this.y = ey;
    this.heading = pymod(h0 + sign * sweep, 360.0);
    this.c.length += total;
    this.c.route.push([this.x, this.y, this.z]);
    this.c.landmarks.push(["strafepads", [o[0], o[1], z], h0]);
    this.c.features.push({ type: "strafepads", segment: this.seg, pads: count,
      spacing: pyRound(spacing), gap: pyRound(spacing - pad), curve });
  }

  // -- shifting and rotating a piece --------------------------------------

  mouth() {
    const [o, , l] = this.frame();
    const half = this.w / 2.0;
    return [[[o[0] + l[0] * half, o[1] + l[1] * half],
      [o[0] - l[0] * half, o[1] - l[1] * half]], this.frame()[1]];
  }

  // Place the piece relative to where the last one left off, before any of
  // it is laid. Three cursor transforms — `away` along the way it is facing
  // (+ opens a gap to the piece before), `shift` across that (+ is left),
  // `rotate` on the spot (+ is left) — so the course itself goes somewhere
  // different. `away` leaves the void it opens alone: separating two pieces
  // is the point of asking for it, while a sideways or turned seam is
  // incidental and gets patched by joint().
  nudge(seg) {
    const away = seg.away || 0;
    const shift = seg.shift || 0;
    const rot = seg.rotate || 0;
    if (!away && !shift && !rot) return;
    const before = this.mouth();
    if (away || shift) {
      const [, f, l] = this.frame();
      this.x += f[0] * away + l[0] * shift;
      this.y += f[1] * away + l[1] * shift;
      this.c.length += Math.abs(away) + Math.abs(shift);
      this.c.route.push([this.x, this.y, this.z]);
    }
    if (rot) this.heading = pymod(this.heading + rot, 360.0);
    if (!away) this.joint(before);
  }

  // The roll/pitch this piece is built with: [origin, 3x3], or null. Both
  // turn about the cursor at floor level, and neither MOVES the cursor — the
  // course carries on from where it would have anyway and the piece is a
  // tilted thing sitting on that line, which is what stops a banked corner
  // dragging everything after it off the floor.
  tiltFor(seg) {
    const roll = seg.roll || 0;
    const pitch = seg.pitch || 0;
    if (!roll && !pitch) return null;
    const [, f, l] = this.frame();
    // Pitch first, then roll. The pitch angle is negated so + tips the course
    // UP: about the LEFT vector, a positive angle would point it down.
    const m = matmul(rodrigues([f[0], f[1], 0], roll), rodrigues([l[0], l[1], 0], -pitch));
    return [[this.x, this.y, this.z], m];
  }

  // Stamp the tilt on everything the piece just added. The brushes are built
  // flat and turned afterwards, which is why a tilt costs no piece any code
  // of its own. Hulls stay flat on purpose — they feed the 2-D tests for a
  // course crossing itself and for cuts, which cannot describe a banked piece
  // anyway, and in the tier that allows tilting both are notes.
  applyTilt(tilt, mark) {
    const [w0, e0] = mark;
    for (let i = w0; i < this.c.world.length; i++) this.c.world[i].tilt = tilt;
    for (let i = e0; i < this.c.entities.length; i++) {
      for (const b of this.c.entities[i][1]) b.tilt = tilt;
    }
  }

  // Floor bridging the seam a nudge opened. Both cross-sections are extruded
  // a little along their own heading and the plate is the convex hull of all
  // of it — the extrusion is what makes a plain sideways shift work (on its
  // own it moves the cursor ALONG its cross-section, so the four corners are
  // collinear), and the hull is what keeps a hard rotation a valid brush.
  // The plate sits a unit under the floor for the reason stripe() does.
  joint(before) {
    const [ptsB, fb] = before;
    const [ptsA, fa] = this.mouth();
    const d = JOINT_DEPTH;
    const plate = convexHull([...ptsB, ...ptsB.map(([x, y]) => [x - fb[0] * d, y - fb[1] * d]),
      ...ptsA, ...ptsA.map(([x, y]) => [x + fa[0] * d, y + fa[1] * d])]);
    if (plate.length < 3 || polyArea(plate) < 16.0) return;
    const top = this.z - 1;
    this.add(Prism.flat(plate, top - FLOOR_THICK, top, "floor", this.heading));
    this.c.floorPolys.push([plate, "floor"]);
    this.hull(plate, top - FLOOR_THICK, this.z + WALL_HEIGHT);
  }

  laySegment(i, seg, segs, auto) {
    const t = seg.type;
    // Away, sideways and on the spot, before anything is laid: see nudge().
    this.nudge(seg);
    // Roll and pitch are applied to the brushes AFTER the piece is laid.
    const tilt = this.tiltFor(seg);
    const mark = [this.c.world.length, this.c.entities.length];
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
        this.note(
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
    } else if (t === "stairs") {
      this.stairs(seg.length, seg.rise, seg.count, tex, sides);
      // A staircase is not flat floor: it cannot be the run-up to a jump.
      this.runup = 0.0;
    } else if (t === "platforms") {
      this.platforms(seg.length, seg.count, seg.drop ?? 0, "platform", sides);
      // The last stone is the only footing, and it is one stone long.
      this.runup = (seg.length / seg.count) * PLATFORM_FILL;
    } else if (t === "pillars") {
      this.pillars(seg.length, seg.count, tex, sides);
      this.runup += seg.length;
    } else if (t === "tunnel") {
      this.tunnel(seg.length, seg.height, tex);
      this.runup += seg.length;
    } else if (t === "chicane") {
      this.chicane(seg.direction, seg.angle, seg.radius, sides.length > 0, tex);
      this.runup += 2 * radians(seg.angle) * seg.radius;
    } else if (t === "bumps") {
      this.bumps(seg.length, seg.count, seg.rise, tex, sides);
      // Like a ramp: a jump off a hump leaves with the hump's own lift.
      this.runup = 0.0;
    } else if (t === "pinch") {
      this.pinch(seg.length, seg.gate, tex, sides);
      this.runup += seg.length;
    } else if (t === "ledge") {
      this.ledge(seg.length, seg.direction, seg.ledge_width, tex);
      this.runup += seg.length;
    } else if (t === "hazard") {
      this.hazard(seg.length, sides);
      this.runup = 0.0;
    } else if (t === "strafepads") {
      this.strafepads(seg.count, seg.spacing, seg.curve ?? 0, seg.ice ? "ice" : "platform");
      // One pad is all the footing there is.
      this.runup = STRAFE_PAD_LEN;
    }
    if (tilt) this.applyTilt(tilt, mark);
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
      if (open || ["gap", "wallgap", "dash", "beam", "split",
        "platforms", "ledge", "hazard", "strafepads"].includes(t)) this.c.falloffSegs.add(i);
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

  // The one set of limits BOTH tiers enforce: past them the map does not
  // compile, or does not load, or hurts every server that holds it. The open
  // tier's are further out (OPEN above), not absent.
  sizeLimits() {
    const { extentXY, extentZ, brushes: bmax } = this.L;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of this.c.world) {
      for (const ring of p.corners()) {
        for (const [x, y, z] of ring) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
    }
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    if (Math.max(dx, dy) > extentXY) {
      this.problems.push(`the course spreads ${int(dx)} x ${int(dy)} units; at most ${extentXY} ` +
        "in each direction (fold it back on itself with turns)");
    }
    if (dz > extentZ) this.problems.push(`the course is ${int(dz)} units tall; at most ${extentZ}`);
    const brushes = brushCount(this.c);
    if (brushes > bmax) {
      this.problems.push(`the course needs ${brushes} brushes; at most ${bmax} ` +
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
      this.note(`${where}: must land on a ${LANDINGS.slice(0, -1).join(", ")} or ` +
        `${LANDINGS[LANDINGS.length - 1]}, not on ${pyRepr(nxt)}`);
    }
  }

  gap(i, seg, segs, kick = null) {
    const kind = kick ? "wallgap" : "gap";
    const where = `segment ${i} (${kind})`;
    if (kick && this.runup < WALL_RUNUP) {
      this.note(
        `${where}: only ${int(this.runup)} units of flat floor before it; a wall-kick ` +
        `gap needs ${WALL_RUNUP} (straights and turns; a ramp resets it, ` +
        "because a jump off a ramp flies high enough to skip the kick)");
    } else if (this.runup < MIN_RUNUP) {
      this.note(
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
          this.note(`course runs into itself: ${segname(a.seg)} overlaps ${segname(b.seg)}`);
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
        this.note(
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
      // Real corners, not the footprint: a tilted brush reaches past it, and
      // a shell that does not enclose every brush is a leak.
      for (const ring of p.corners()) {
        for (const [x, y, z] of ring) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x);
          y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
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
// `rules` is the tier: "strict" is the generator's (described maps, random_map
// tiles), "open" is the map editor's. See STRICT / OPEN above.
export function build(spec, rules = "strict") {
  const problems = validate(spec, rules);
  if (problems.length) return { problems, course: null };
  let course;
  const w = new Walker(spec, rules);
  try {
    course = w.run();
  } catch (e) {
    return { problems: [`layout failed: ${e.message}`], course: null };
  }
  return { problems: w.problems, course, notes: course.notes };
}

// Lay the course out regardless of name/title problems: those are words, not
// geometry, and the editor should keep drawing while a title is half-typed.
export function preview(spec, rules = "strict") {
  const named = { ...spec, name: "gen_preview", title: "Preview" };
  const geometric = validate(named, rules);
  if (geometric.length) return { problems: geometric, course: null };
  return build(named, rules);
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
