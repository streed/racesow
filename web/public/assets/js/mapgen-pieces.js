// The map editor's model of a piece: what each piece is, the range every
// field may take, and how a spec from anywhere is brought into range. Pure
// (no DOM, no WebGL), so test/mapgen-pieces.test.js runs it under node.
//
// The ranges are spec.validate()'s (tools/mapgen/spec.py, ported in
// mapgen-course.js) solved for one field at a time, so a slider bounded by
// limits() can only produce a value the generator accepts. What ranges cannot
// express (a gap's run-up, a landing, the course running into itself) is left
// to the layout, which reports it.
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
};
export const GROUPS = [
  ["Track", ["straight", "turn", "ramp", "checkpoint"]],
  ["Jumps", ["gap", "dash"]],
  ["Obstacles", ["slalom", "beam", "split"]],
  ["Wall jumps", ["wallclimb", "wallgap"]],
];


// The valid range of every numeric field of a piece, given the rest of it and
// the course width. These are spec.validate()'s ranges, solved for each field,
// so a slider can only ever produce a value the generator accepts.
export function limits(seg, width) {
  const L = {};
  switch (seg.type) {
    case "straight": L.length = [mg.STRAIGHT_MIN, mg.STRAIGHT_MAX]; break;
    case "turn": L.radius = [mg.turnRadiusMin(width), mg.TURN_RADIUS_MAX]; break;
    case "ramp": {
      L.length = [mg.RAMP_MIN, mg.RAMP_MAX];
      // 30 degrees over its length, and never more than spec.validate's 1024.
      const m = Math.min(1024, Math.floor(mg.maxRampSlope() * clamp(seg.length || 0, ...L.length)));
      L.rise = [-m, m];
      break;
    }
    case "gap":
      L.drop = [-Math.trunc(mg.maxRise()), mg.DROP_MAX];
      L.length = [mg.GAP_MIN, Math.floor(mg.maxGap(clamp(seg.drop || 0, ...L.drop)))];
      break;
    case "slalom":
      L.count = mg.SLALOM_COUNT;
      L.length = [mg.SLALOM_SPACING * (clamp(seg.count || 2, ...L.count) + 1), mg.STRAIGHT_MAX];
      break;
    case "beam":
      L.length = [mg.STRAIGHT_MIN, mg.BEAM_MAX_LENGTH];
      L.beam_width = [mg.BEAM_MIN, Math.max(mg.BEAM_MIN, width - 2 * mg.BEAM_WALL_CLEAR)];
      break;
    case "split":
      L.count = mg.SPLIT_COUNT;
      L.length = [mg.splitMinLength(clamp(seg.count || 1, ...L.count)), mg.STRAIGHT_MAX];
      break;
    case "wallclimb":
      L.length = [mg.WALLCLIMB_MIN, mg.STRAIGHT_MAX];
      L.rise = mg.WALLCLIMB_RISE;
      break;
    case "wallgap":
      L.drop = mg.WALLGAP_DROP;
      L.length = mg.wallgapWindow(clamp(seg.drop ?? -80, ...L.drop));
      break;
    case "dash":
      L.drop = mg.DASH_DROP;
      L.length = mg.dashWindow(clamp(seg.drop ?? 512, ...L.drop));
      break;
    default:
  }
  return L;
}

// Pull every field of a piece into range, dependencies first (a gap's drop
// before its length, a ramp's length before its rise), and drop flags the
// piece cannot carry. Anything not a number becomes the bottom of its range.
export function fix(seg, width) {
  const out = { ...seg };
  for (const key of ["drop", "count", "length", "rise", "radius", "beam_width"]) {
    const L = limits(out, width)[key];
    if (!L) continue;
    const v = Number.isFinite(out[key]) ? out[key] : L[0];
    out[key] = Math.round(clamp(v, L[0], L[1]));
  }
  if (out.type === "turn" && !mg.TURN_ANGLES.includes(out.angle)) out.angle = 90;
  if (["turn", "split", "wallclimb", "wallgap"].includes(out.type) && out.direction !== "right") out.direction = "left";
  if (!mg.OPENABLE.includes(out.type)) delete out.open;
  if (!mg.ICEABLE.includes(out.type)) delete out.ice;
  if (out.type !== "turn" || out.angle !== 180) delete out.shortcut;
  for (const f of ["open", "ice", "shortcut"]) if (out[f] !== true) delete out[f];
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
    default: return "";
  }
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
  const width = Number.isInteger(raw.width) ? clamp(raw.width, mg.WIDTH_MIN, mg.WIDTH_MAX) : 384;
  const n = mg.normalize({ ...raw, width });
  const known = n.segments.filter((s) => mg.SEGMENT_TYPES.includes(s.type));
  if (known.length < n.segments.length) notes.push(`${n.segments.length - known.length} piece(s) of an unknown type were left out.`);
  const segs = known.slice(0, mg.MAX_SEGMENTS).map((s) => fix(s, width));
  if (known.length > mg.MAX_SEGMENTS) notes.push(`Only the first ${mg.MAX_SEGMENTS} pieces were kept.`);
  const changed = segs.filter((s, i) => JSON.stringify(s) !== JSON.stringify(known[i])).length;
  if (changed) notes.push(`${changed} piece(s) had a value out of range and were pulled back in.`);
  const title = typeof raw.title === "string" && mg.TITLE_RE.test(raw.title) ? raw.title : "My Course";
  return [{ title, width, segments: segs.length ? segs : [{ type: "straight", length: 768 }] }, notes];
}
