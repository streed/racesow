// The map editor's model of a piece: what each piece is, the range every
// field may take, and how a spec from anywhere is brought into range. Pure
// (no DOM, no WebGL), so test/mapgen-pieces.test.js runs it under node.
//
// There are two bands, and the difference is the point of the editor:
//
//   limits(seg, width)            what a value MAY be — the open tier's
//                                 bounds, which is what a person may type
//   limits(seg, width, "strict")  what it probably SHOULD be — the
//                                 generator's own band, shown as a hint
//
// PIECES.make() builds every new piece from the strict band, so the course
// you get by clicking is a sane one; the wider band is only reached by
// meaning to. What neither band can express (a gap's run-up, a landing, the
// course running into itself) the layout reports — as refusals for a
// described map, and as notes for a course from here.
import * as mg from "./mapgen-course.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmt = (n) => Math.round(n).toLocaleString("en-US");

export const PIECES = {
  straight: { name: "Straight", hint: "A plain run. Long ones carry speed.",
    make: () => ({ type: "straight", length: 768 }) },
  turn: { name: "Turn", hint: "Bend 45 to 180 degrees, left or right.",
    make: (w) => ({ type: "turn", direction: "left", angle: 90, radius: Math.max(512, mg.turnRadiusMin(w)) }) },
  ramp: { name: "Ramp", hint: "Climb or drop, up to 30 degrees.",
    make: () => ({ type: "ramp", length: 768, rise: -192 }) },
  checkpoint: { name: "Checkpoint", hint: "A timing split. More are added for you.",
    make: () => ({ type: "checkpoint" }) },
  gap: { name: "Gap", hint: "A pit to jump. Falling in sends you back to the start.",
    make: () => ({ type: "gap", length: 128, drop: 0 }) },
  dash: { name: "Dash drop", hint: "A drop too long to jump: needs the dash.",
    make: () => { const [lo, hi] = mg.dashWindow(512); return { type: "dash", length: Math.round((lo + hi) / 2), drop: 512 }; } },
  slalom: { name: "Slalom", hint: "Fins off alternate walls: weave through.",
    make: () => ({ type: "slalom", length: 1024, count: 3 }),
    needs: (w) => (w - mg.SLALOM_GATE < mg.SLALOM_FIN_MIN ? `needs width ${mg.SLALOM_GATE + mg.SLALOM_FIN_MIN}+` : null) },
  beam: { name: "Beam", hint: "No floor but a narrow bridge.",
    make: (w) => ({ type: "beam", length: 768, beam_width: Math.min(96, w - 2 * mg.BEAM_WALL_CLEAR) }) },
  split: { name: "Split lanes", hint: "Fast lane over holes, or a safe weave.",
    make: () => ({ type: "split", length: mg.splitMinLength(2), direction: "left", count: 2 }),
    needs: (w) => ((w - mg.SPLIT_MEDIAN) / 2 < mg.SPLIT_LANE_MIN ? `needs width ${2 * mg.SPLIT_LANE_MIN + mg.SPLIT_MEDIAN}+` : null) },
  wallclimb: { name: "Wall climb", hint: "A ledge only a wall jump reaches.",
    make: () => ({ type: "wallclimb", length: 768, rise: 80, direction: "left" }) },
  wallgap: { name: "Wall-kick gap", hint: "A gap up to a ledge: kick off the wall.",
    make: () => ({ type: "wallgap", length: 120, drop: -80, direction: "left" }) },

  // Shape rather than move: corridor laid differently. None of these ask for
  // anything the physics has to model, which is why the editor hands them out
  // freely and the model is never offered them.
  stairs: { name: "Stairs", hint: "A staircase up or down. Short steps you can run.",
    make: () => ({ type: "stairs", length: 512, rise: 128, count: 8 }) },
  platforms: { name: "Stepping stones", hint: "Stones over a pit: a hop to each.",
    make: () => ({ type: "platforms", length: 768, count: 4, drop: 0 }) },
  strafepads: { name: "Strafe pads", hint: "Pads over the void: strafe from one to the next. Straight or curved.",
    make: () => ({ type: "strafepads", count: 6, spacing: 256, curve: 0 }) },
  pillars: { name: "Pillars", hint: "Columns down the middle: pass either side.",
    make: () => ({ type: "pillars", length: 768, count: 4 }),
    needs: (w) => (w < mg.PILLAR_MIN + 2 * mg.PILLAR_CLEAR
      ? `needs width ${mg.PILLAR_MIN + 2 * mg.PILLAR_CLEAR}+` : null) },
  tunnel: { name: "Tunnel", hint: "A roofed run. Lower the roof for a tight tube.",
    make: () => ({ type: "tunnel", length: 768, height: 192 }) },
  chicane: { name: "Chicane", hint: "A turn each way: ends up facing the same way, offset sideways.",
    make: (w) => ({ type: "chicane", direction: "left", angle: 30,
      radius: Math.max(512, mg.turnRadiusMin(w)) }) },
  bumps: { name: "Bumps", hint: "A rolling floor. Keeps the player off the ground.",
    make: () => ({ type: "bumps", length: 768, count: 4, rise: 48 }) },
  pinch: { name: "Pinch", hint: "The corridor narrows to a gate.",
    make: (w) => ({ type: "pinch", length: 512, gate: Math.min(192, w - 2 * mg.PINCH_BITE) }),
    needs: (w) => (w < mg.PINCH_MIN + 2 * mg.PINCH_BITE
      ? `needs width ${mg.PINCH_MIN + 2 * mg.PINCH_BITE}+` : null) },
  ledge: { name: "Ledge", hint: "A walkway along one wall, void beside it.",
    make: (w) => ({ type: "ledge", length: 512, direction: "left",
      ledge_width: Math.min(96, w - mg.LEDGE_CLEAR) }),
    needs: (w) => (w < mg.LEDGE_MIN + mg.LEDGE_CLEAR
      ? `needs width ${mg.LEDGE_MIN + mg.LEDGE_CLEAR}+` : null) },
  hazard: { name: "Hazard", hint: "A strip of lethal floor: jump it.",
    make: () => ({ type: "hazard", length: 128 }) },
};
export const GROUPS = [
  ["Track", ["straight", "turn", "chicane", "ramp", "checkpoint"]],
  ["Jumps", ["gap", "dash", "platforms", "strafepads"]],
  ["Obstacles", ["slalom", "pillars", "beam", "ledge", "split", "pinch", "hazard"]],
  ["Shape", ["stairs", "bumps", "tunnel"]],
  ["Wall jumps", ["wallclimb", "wallgap"]],
];


// The valid range of every numeric field of a piece, given the rest of it and
// the course width. With no tier named this is the OPEN band — what a person
// may type; pass "strict" for the generator's own band, which is what the
// editor shows as a hint and what PIECES.make() builds from.
export function limits(seg, width, rules = "open") {
  const L = mg.tier(rules);
  const T = {};
  const slope = L.slope !== null ? L.slope : mg.maxRampSlope();
  // A gap's reach is only a bound while the physics are being enforced.
  const reach = (drop, hi) => (L.physics ? Math.floor(mg.maxGap(drop)) : hi);
  // Every field is bounded by its tier's OWN range and, where the physics are
  // on, by what a player can do. A range that honours only one of the two is
  // the bug this helper exists to stop: validate checks both.
  const both = ([alo, ahi], [blo, bhi]) => {
    const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
    return [lo, Math.max(lo, hi)];
  };
  switch (seg.type) {
    case "straight": T.length = L.straight; break;
    case "turn":
      T.radius = [mg.turnRadiusMin(width, rules), L.radiusMax];
      if (L.angles === null) T.angle = L.angleRange;
      break;
    case "ramp": {
      T.length = L.ramp;
      const m = Math.min(L.rise, Math.floor(slope * clamp(seg.length || 0, ...T.length)));
      T.rise = [-m, m];
      break;
    }
    case "gap":
      T.drop = [L.dropMin !== null ? L.dropMin : -Math.trunc(mg.maxRise()), L.dropMax];
      T.length = both(L.gap, [L.gap[0], reach(clamp(seg.drop || 0, ...T.drop), L.gap[1])]);
      break;
    case "slalom":
      T.count = L.slalomCount;
      T.length = both(L.straight,
        [L.slalomSpacing * (clamp(seg.count || T.count[0], ...T.count) + 1), L.straight[1]]);
      break;
    case "beam":
      T.length = L.beam;
      T.beam_width = [mg.BEAM_MIN, Math.max(mg.BEAM_MIN, width - 2 * L.beamClear)];
      break;
    case "split":
      T.count = L.splitCount;
      T.length = both(L.straight,
        [mg.splitMinLength(clamp(seg.count || T.count[0], ...T.count), rules), L.straight[1]]);
      break;
    case "wallclimb":
      T.length = [L.wallclimbMin, L.straight[1]];
      T.rise = L.wallclimbRise;
      break;
    case "wallgap":
      T.drop = L.wallgapDrop;
      T.length = L.physics ? both(L.gap, mg.wallgapWindow(clamp(seg.drop ?? -80, ...T.drop))) : L.gap;
      break;
    case "dash":
      T.drop = L.dashDrop;
      T.length = L.physics ? both(L.gap, mg.dashWindow(clamp(seg.drop ?? 512, ...T.drop))) : L.gap;
      break;

    // -- shape pieces -------------------------------------------------------
    case "stairs": {
      T.count = L.stairsCount;
      const n = clamp(seg.count || T.count[0], ...T.count);
      T.length = both(L.straight, [mg.STAIR_TREAD_MIN * n, L.straight[1]]);
      // Every step inside the engine's own step height, while that is a rule.
      const cap = Math.min(L.rise, mg.STAIRS_RISE_MAX,
        L.physics ? Math.floor(mg.STEP_SIZE * n) : Infinity);
      T.rise = [-cap, cap];
      break;
    }
    case "platforms": {
      T.count = L.platformsCount;
      const n = clamp(seg.count || T.count[0], ...T.count);
      T.drop = [L.dropMin !== null ? L.dropMin : -Math.trunc(mg.maxRise()), L.dropMax];
      // Each cell is a stone and the hole before it; while the physics hold,
      // the hole also has to be inside a jump.
      const lo = Math.max(L.straight[0], mg.platformCell() * n);
      // While the physics hold, the holes also have to be inside a jump —
      // but never past what a straight of this tier may be in the first place.
      const jumpable = Math.floor((reach(clamp(seg.drop || 0, ...T.drop), L.straight[1]) * n)
        / (1 - mg.PLATFORM_FILL));
      T.length = both([lo, L.straight[1]], [lo, L.physics ? jumpable : L.straight[1]]);
      break;
    }
    case "pillars": {
      T.count = L.pillarsCount;
      const n = clamp(seg.count || T.count[0], ...T.count);
      T.length = both(L.straight, [(mg.FIN_THICK + mg.PLAYER_WIDTH) * n, L.straight[1]]);
      break;
    }
    case "tunnel":
      T.length = L.straight;
      T.height = L.tunnelHeight;
      break;
    case "chicane":
      T.angle = L.chicaneAngle;
      T.radius = [mg.turnRadiusMin(width, rules), L.radiusMax];
      break;
    case "bumps": {
      T.count = L.bumpsCount;
      const n = clamp(seg.count || T.count[0], ...T.count);
      T.length = both(L.straight, [mg.BUMP_MIN * n, L.straight[1]]);
      const half = clamp(seg.length || T.length[0], ...T.length) / n / 2.0;
      T.rise = both(L.bumpsRise,
        [L.bumpsRise[0], L.physics ? Math.floor(slope * half) : L.bumpsRise[1]]);
      break;
    }
    case "pinch":
      T.length = L.straight;
      T.gate = [mg.PINCH_MIN, Math.max(mg.PINCH_MIN, width - 2 * mg.PINCH_BITE)];
      break;
    case "ledge":
      T.length = L.beam;
      T.ledge_width = [mg.LEDGE_MIN, Math.max(mg.LEDGE_MIN, width - mg.LEDGE_CLEAR)];
      break;
    case "hazard":
      T.length = [L.hazard[0], L.hazard[1] === null ? Math.floor(mg.maxGap(0)) : L.hazard[1]];
      break;
    case "strafepads":
      T.count = L.padsCount;
      T.spacing = both(L.padsSpacing, [L.padsSpacing[0],
        L.physics ? Math.floor(mg.maxGap(0)) + mg.STRAFE_PAD_LEN : L.padsSpacing[1]]);
      T.curve = [-L.padsCurve, L.padsCurve];
      break;
    default:
  }
  // Every piece may be nudged sideways and turned on the spot.
  T.shift = [-L.shift, L.shift];
  T.rotate = [-L.rotate, L.rotate];
  return T;
}

// The course width's own band, which is not a per-piece field.
export const widthLimits = (rules = "open") => mg.tier(rules).width;

// Pull every field of a piece into range, dependencies first (a gap's drop
// before its length, a ramp's length before its rise), and drop flags the
// piece cannot carry. Anything not a number becomes the bottom of its range.
// `rules` is the band to pull into: the editor's own, by default.
export function fix(seg, width, rules = "open") {
  const out = { ...seg };
  // Order matters: a field that bounds another comes first.
  for (const key of ["drop", "count", "spacing", "curve", "angle", "radius",
    "length", "rise", "beam_width", "height", "gate", "ledge_width", "shift", "rotate"]) {
    const L = limits(out, width, rules)[key];
    if (!L) continue;
    // A nudge a piece never asked for stays absent rather than becoming 0.
    if (mg.NUDGE.includes(key) && !(key in out)) continue;
    const v = Number.isFinite(out[key]) ? out[key] : L[0];
    out[key] = Math.round(clamp(v, L[0], L[1]));
  }
  const angles = mg.tier(rules).angles;
  if (out.type === "turn" && angles !== null && !angles.includes(out.angle)) out.angle = 90;
  if (["turn", "split", "wallclimb", "wallgap", "chicane", "ledge"].includes(out.type)
      && out.direction !== "right") out.direction = "left";
  if (!mg.OPENABLE.includes(out.type)) delete out.open;
  if (!mg.ICEABLE.includes(out.type)) delete out.ice;
  if (out.type !== "turn" || out.angle !== 180) delete out.shortcut;
  for (const f of ["open", "ice", "shortcut"]) if (out[f] !== true) delete out[f];
  for (const z of mg.NUDGE) if (!out[z]) delete out[z];
  return out;
}

export function chipLabel(s) {
  switch (s.type) {
    case "straight": return `${fmt(s.length)}`;
    case "turn": return `${s.direction === "left" ? "L" : "R"} ${s.angle}°`;
    case "ramp": return s.rise > 0 ? `↑ ${fmt(s.rise)}` : s.rise < 0 ? `↓ ${fmt(-s.rise)}` : "flat";
    case "gap": return `${fmt(s.length)}${s.drop ? (s.drop > 0 ? ` ↓${fmt(s.drop)}` : ` ↑${fmt(-s.drop)}`) : ""}`;
    case "checkpoint": return "CP";
    case "slalom": return `${s.count} fins`;
    case "beam": return `${fmt(s.beam_width)} wide`;
    case "split": return `${s.count} hole${s.count === 1 ? "" : "s"}`;
    case "wallclimb": return `↑ ${s.rise}`;
    case "wallgap": return `↑ ${-s.drop}`;
    case "dash": return `↓ ${fmt(s.drop)}`;
    case "stairs": return `${s.count} step${s.count === 1 ? "" : "s"} ${s.rise >= 0 ? "↑" : "↓"}${fmt(Math.abs(s.rise))}`;
    case "platforms": return `${s.count} stone${s.count === 1 ? "" : "s"}`;
    case "pillars": return `${s.count} pillar${s.count === 1 ? "" : "s"}`;
    case "tunnel": return `roof ${fmt(s.height)}`;
    case "chicane": return `${s.direction === "left" ? "L" : "R"} ${s.angle}° S`;
    case "bumps": return `${s.count} bump${s.count === 1 ? "" : "s"}`;
    case "pinch": return `gate ${fmt(s.gate)}`;
    case "ledge": return `${s.direction === "left" ? "L" : "R"} ${fmt(s.ledge_width)}`;
    case "hazard": return `${fmt(s.length)} hot`;
    case "strafepads":
      return `${s.count} pad${s.count === 1 ? "" : "s"}` +
        (s.curve ? ` ${s.curve > 0 ? "↰" : "↱"}${Math.abs(s.curve)}°` : "");
    default: return "";
  }
}

// What a nudge adds to a chip's label, so a shifted or turned piece reads as
// one at a glance instead of only in the inspector.
export function nudgeLabel(s) {
  const bits = [];
  if (s.shift) bits.push(`${s.shift > 0 ? "←" : "→"}${fmt(Math.abs(s.shift))}`);
  if (s.rotate) bits.push(`${s.rotate > 0 ? "↺" : "↻"}${Math.abs(s.rotate)}°`);
  return bits.join(" ");
}

export const slug = (title) => {
  const s = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  return "gen_" + (s.length >= 2 ? s : "my_course");
};

export const STARTERS = {
  blank: { title: "My Course", width: 384, segments: [{ type: "straight", length: 768 }] },
  first_light: { title: "First Light", width: 384, segments: [
    { type: "straight", length: 1024 }, { type: "turn", direction: "left", angle: 90, radius: 512 },
    { type: "straight", length: 512 }, { type: "gap", length: 128, drop: 32 }, { type: "straight", length: 768 },
    { type: "checkpoint" }, { type: "ramp", length: 768, rise: -256 }, { type: "straight", length: 256 },
    { type: "turn", direction: "right", angle: 135, radius: 640 }, { type: "straight", length: 1024 } ] },
  ice_run: { title: "Glacier Run", width: 448, segments: [
    { type: "straight", length: 768 }, { type: "ramp", length: 1024, rise: -512, ice: true },
    { type: "turn", direction: "left", angle: 135, radius: 768, ice: true }, { type: "straight", length: 1024, ice: true },
    { type: "slalom", length: 1280, count: 4, ice: true }, { type: "straight", length: 512 },
    { type: "gap", length: 160, drop: 64 }, { type: "straight", length: 640 },
    { type: "turn", direction: "right", angle: 90, radius: 640, ice: true }, { type: "ramp", length: 768, rise: -384, ice: true },
    { type: "straight", length: 1024 } ] },
  tricks: { title: "Kick and Dash", width: 448, segments: [
    { type: "straight", length: 768 }, { type: "wallclimb", length: 768, rise: 80, direction: "right" },
    { type: "straight", length: 512 }, { type: "wallgap", length: 150, drop: -80, direction: "left" },
    { type: "straight", length: 768 }, { type: "turn", direction: "left", angle: 90, radius: 640 },
    { type: "dash", length: 500, drop: 512 }, { type: "straight", length: 768 } ] },
};

// A spec from anywhere (a pasted model reply, a downloaded file, a generated
// map) as the editor holds it: normalized, every field in range, at most
// MAX_SEGMENTS pieces of known types. Returns [spec, notes].
export function adopt(raw) {
  const notes = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("That isn't a course spec: expected a JSON object with a segments list.");
  if (!Array.isArray(raw.segments)) throw new Error("That JSON has no \"segments\" list.");
  const [wlo, whi] = widthLimits();
  const width = Number.isInteger(raw.width) ? clamp(raw.width, wlo, whi) : 384;
  const n = mg.normalize({ ...raw, width });
  const known = n.segments.filter((s) => mg.SEGMENT_TYPES.includes(s.type));
  if (known.length < n.segments.length) notes.push(`${n.segments.length - known.length} piece(s) of an unknown type were left out.`);
  const cap = mg.tier("open").segments;
  const segs = known.slice(0, cap).map((s) => fix(s, width));
  if (known.length > cap) notes.push(`Only the first ${cap} pieces were kept.`);
  const changed = segs.filter((s, i) => JSON.stringify(s) !== JSON.stringify(known[i])).length;
  if (changed) notes.push(`${changed} piece(s) had a value out of range and were pulled back in.`);
  const title = typeof raw.title === "string" && mg.TITLE_RE.test(raw.title) ? raw.title : "My Course";
  return [{ title, width, segments: segs.length ? segs : [{ type: "straight", length: 768 }] }, notes];
}

// The hotbar: number keys place these. Deliberately NOT every piece — there
// are 21 and only eleven keys, and these eleven are the ones already in
// people's fingers. The rest are a click away in the palette.
export const HOTBAR = ["straight", "turn", "ramp", "checkpoint", "gap", "dash", "slalom", "beam", "split",
  "wallclimb", "wallgap"];
export const HOTKEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-"];

// A piece reflected left to right: turns bend the other way, a split's fast
// lane and a kick wall change sides, a sideways nudge goes the other way and
// so does a rotation and a strafe-pad curve. Everything else is symmetric
// already.
export function mirror(seg) {
  const out = { ...seg };
  if (out.direction === "left") out.direction = "right";
  else if (out.direction === "right") out.direction = "left";
  for (const k of ["shift", "rotate", "curve"]) if (out[k]) out[k] = -out[k];
  return out;
}

// A course's identity: the width and the pieces, not the title. Any edit to a
// piece gives a new key; a rename does not. FNV-1a over the normalized JSON.
// Nothing in the editor calls this today (it keyed per-course state in the
// browser); test/mapgen-pieces.test.js pins the rule.
export function courseKey(spec) {
  const text = JSON.stringify([spec.width, mg.normalize({ segments: spec.segments }).segments]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + ":" + text.length;
}
