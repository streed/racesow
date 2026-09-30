/* Deal a random_map route, exactly the way a game server deals it.
 *
 * random_map has no course in it. The pack holds a DECK — every piece compiled
 * as a dormant inline brush model plus a manifest of the numbers needed to fit
 * one piece onto the next — and hrace/metamap.as deals a route out of it from
 * a seed. This is a port of that dealer for the browser, so /random can draw
 * the course a seed produces without asking a server.
 *
 * A preview that draws a route the server would NOT deal is worse than no
 * preview at all, so everything here is arithmetic-for-arithmetic with
 * metamap.as (RACE_MetaPick / RACE_MetaDealTile / RACE_MetaExtend). The three
 * things that decide whether a seed reproduces:
 *
 *   * The trig table is the engine's own eight-digit one, not Math.cos. Every
 *     placement is the entry frame turned by a whole 45-degree step, and the
 *     two differ in the ninth digit — a thousand times more than it takes to
 *     deal a different course (see exitOf).
 *   * The generator is turned eight times before the first piece, and then
 *     exactly ONCE per pick() that finds a candidate and never on a pick that
 *     finds none. The order the generator is consumed in IS the seed.
 *   * Tiles are scored in deck order and drawn in proportion to their score,
 *     so the manifest's order is part of the seed too — parseDeck keeps it.
 *
 * Pinned by web/test/random-dealer.test.js against golden vectors dumped from
 * the Python model of the same dealer over 340 seeds.
 */

// Mirrors metamap.as. A tile turns by a whole number of 45-degree steps, so a
// heading is an index into a table rather than an accumulated float: tiles mate
// face to face, and a fraction of a degree per piece shows as a seam.
export const STEPS = 8;
export const STEP_DEG = 45.0;
export const AHEAD = 6;              // pieces kept dealt ahead of the player
export const MAX_TILES = 44;         // ceiling on a whole route (entity budget)
export const REWIND_BUDGET = 16;     // placements the dealer may undo per extend
export const OVERPASS_CLEAR = 96.0;  // room to run under a piece crossing over
export const FENCE_MARGIN = 384.0;   // slack so a piece never touches the shell
export const EXIT_ROOM = 640.0;      // room a piece's exit leaves for the next
export const DEFAULT_TARGET = 16000; // rs_meta_distance's default

export const F_OPEN = 1;
export const F_DASH = 2;
export const F_WALLJUMP = 4;
export const F_START = 8;
export const F_FINISH = 16;

// META_COS/META_SIN, digit for digit (metamap.as:128).
const COS_TABLE = [1.0, 0.70710678, 0.0, -0.70710678, -1.0, -0.70710678, 0.0, 0.70710678];
const COS = (step) => COS_TABLE[step & 7];
const SIN = (step) => COS_TABLE[(step + 6) & 7];

/* Where a piece placed at `at` facing `step` hands the route over to the next
 * one: its entry frame turned by the table above and walked to the exit the
 * manifest records.
 *
 * Kept as ONE expression rather than turning (fwd, lat) and then adding it,
 * which is how the engine spells it (RACE_MetaRotate, then the add). In
 * doubles the two associate about 1e-12 apart, and this is the association the
 * model the golden vectors came from uses, so the test can demand the whole
 * cursor track back exactly rather than within a tolerance.
 *
 * That 1e-12 is not always invisible, which is the thing to know: pieces mate
 * exactly, and the clash test lets boxes touch (<=, not <), so a route folding
 * back on itself regularly puts a candidate's box EXACTLY against an earlier
 * piece — 6% of placements across the golden set have such a decision — and
 * then the last ulp is what decides whether that piece fits. Dealt the other
 * way round, 2 of the 352 golden routes pick a different piece. Which is also
 * why nothing here is allowed to drift "harmlessly".
 *
 * Note this is the DEALER's rotation, for placements. Brush geometry is a
 * different question: the engine turns a placed piece by its real angles, so
 * anything drawing a footprint should rotate the points with exact trig. */
export function exitOf(at, tile, step) {
  const c = COS(step), s = SIN(step);
  return { x: at.x + tile.fwd * c - tile.lat * s,
           y: at.y + tile.fwd * s + tile.lat * c,
           z: at.z + tile.rise };
}

/* ...and which way it leaves, in 45-degree steps. */
export function headingOf(tile, step) {
  return (step + tile.turn) % STEPS;
}

/* xorshift32, the generator metamap.as runs (RACE_MetaNextRandom). Returns a
 * function yielding the next unsigned 32-bit word.
 *
 * JavaScript's bitwise operators work on signed 32-bit ints, which is the
 * right width by accident: `<<` truncates to 32 bits like the engine's uint
 * does, `>>>` is the unsigned shift the middle step needs, and `>>> 0` reads
 * the pattern back as an unsigned word. */
export function xorshift32(seed) {
  let x = seed >>> 0;
  return function next() {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/* ------------------------------ the manifest ------------------------------ */

function tokens(line) {
  const t = line.split(/\s+/).filter((s) => s !== "");
  // COM_Parse (String::getToken, which is what metamap.as reads a line with)
  // treats // as a comment only where a token would start, so a comment ends
  // the line and nothing else does.
  const cut = t.findIndex((s) => s.startsWith("//"));
  return cut < 0 ? t : t.slice(0, cut);
}

function num(t, i, where) {
  const v = Number(t[i]);
  if (!Number.isFinite(v)) throw new Error(`${where}: token ${i} is not a number: ${t[i]}`);
  return v;
}

// A yaw the tiles could not mate on is fatal, as it is in RACE_MetaParseYaw:
// half a step of error is a seam a player catches, not a rounding detail.
function parseYaw(deg, where) {
  const steps = deg / STEP_DEG;
  const whole = Math.trunc(steps + (steps < 0 ? -0.5 : 0.5));
  if (Math.abs(steps - whole) > 0.01) {
    throw new Error(`${where}: turn of ${deg} degrees is not a multiple of ${STEP_DEG}`);
  }
  return ((whole % STEPS) + STEPS) % STEPS;
}

/* Read maps/<map>.deck. Returns { version, width, play, gate, tiles, start,
 * finishes } — `start` and `finishes` are indexes into `tiles`, and `finishes`
 * is roomiest first, because the dealer walks that list and a route that has
 * painted itself into a corner can still end on the small run-out.
 *
 * Unknown line heads are ignored, which is what metamap.as does (its head ==
 * chain has no trailing else) and the whole reason the manifest can grow new
 * line kinds without stranding deployed servers. `face` rows are the one that
 * exists today: the dealer needs none of them — a tile's box is all it takes
 * to fit one piece onto the next — but they are attached to their tile here so
 * that the manifest has exactly one reader on this side. */
export function parseDeck(text) {
  const deck = { version: 0, width: 0, play: null, gate: null, tiles: [], start: -1, finishes: [] };
  const faces = [];

  for (const line of String(text).split("\n")) {
    const t = tokens(line);
    if (t.length === 0) continue;

    if (t[0] === "deck") {
      // The version token is the one thing a server refuses to load past, so
      // refuse it here too rather than drawing a route on a guess.
      deck.version = num(t, 1, "deck");
      if (deck.version !== 1) throw new Error(`deck manifest version ${t[1]} (this build reads version 1)`);
      deck.width = t.length > 3 ? num(t, 3, "deck") : 0;
    } else if (t[0] === "play") {
      deck.play = { half: num(t, 1, "play"), up: num(t, 2, "play"), down: num(t, 3, "play") };
    } else if (t[0] === "gate") {
      deck.gate = { model: num(t, 1, "gate"), depth: num(t, 2, "gate"),
                    half: num(t, 3, "gate"), height: num(t, 4, "gate") };
    } else if (t[0] === "tile") {
      if (t.length < 17) throw new Error(`tile line has ${t.length} tokens, expected 17: ${line}`);
      const where = `tile ${t[16]}`;
      const tile = {
        model: num(t, 1, where), flags: num(t, 2, where), weight: num(t, 3, where),
        fwd: num(t, 4, where), lat: num(t, 5, where), rise: num(t, 6, where),
        turn: parseYaw(num(t, 7, where), where),
        mins: { x: num(t, 8, where), y: num(t, 9, where), z: num(t, 10, where) },
        maxs: { x: num(t, 11, where), y: num(t, 12, where), z: num(t, 13, where) },
        route: num(t, 14, where), kind: t[15], name: t[16],
        faces: [],
      };
      if (tile.flags & F_START) deck.start = deck.tiles.length;
      if (tile.flags & F_FINISH) deck.finishes.push(deck.tiles.length);
      deck.tiles.push(tile);
    } else if (t[0] === "face") {
      // face <model> <tex> <top> <points> <x> <y>... — the declared point count
      // makes the line self-checking, so check it.
      const n = num(t, 4, "face");
      if (t.length !== 5 + 2 * n) throw new Error(`face line declares ${n} points but carries ${t.length} tokens`);
      const pts = [];
      for (let i = 0; i < n; i++) pts.push([num(t, 5 + 2 * i, "face"), num(t, 6 + 2 * i, "face")]);
      faces.push({ model: num(t, 1, "face"), tex: t[2], top: num(t, 3, "face"), points: pts });
    }
  }

  if (deck.tiles.length === 0) throw new Error("the deck manifest holds no tiles");
  if (deck.start < 0 || deck.finishes.length === 0) throw new Error("the deck has no start tile or no finish tile");
  if (!deck.gate || deck.gate.model <= 0) throw new Error("the deck has no gate model");
  if (!deck.play || deck.play.half <= 0) throw new Error("the deck declares no play box");

  // Roomiest finish first. Stable, like the insertion sort in metamap.as: two
  // run-outs of the same length keep manifest order, and that ordering is what
  // the dealer's fallback walks.
  deck.finishes.sort((a, b) => deck.tiles[b].route - deck.tiles[a].route);

  const byModel = new Map(deck.tiles.map((tile) => [tile.model, tile]));
  for (const f of faces) {
    const tile = byModel.get(f.model);
    if (tile) tile.faces.push({ tex: f.tex, top: f.top, points: f.points });
  }
  return deck;
}

/* -------------------------------- the deal -------------------------------- */

/* Deal the whole route a seed produces.
 *
 * The server deals lazily, a few pieces ahead of whoever is furthest along,
 * but the route a seed produces does not depend on how fast anyone runs it:
 * pick() never reads progress, and the only thing that does — rewind(), which
 * refuses to undo a piece a player has reached — can only ever make the dealer
 * keep a placement it would otherwise have retried. So walking a virtual
 * player down the route, exactly as run() does below, yields the same course
 * the server ends up with.
 *
 * Returns { seed, target, pieces, cursor, heading, length, rewinds, bare,
 * deadEnd, startGate, finishGate }. Each piece is { index, tile, at, step,
 * dealtBefore, lo, hi }: `at` is where its entry goes and `step` which way it
 * faces, in 45-degree steps, so the piece list doubles as the cursor track. */
export function dealRoute(deck, seed, target = DEFAULT_TARGET) {
  // The engine draws a seed of its own when it is handed 0 (RACE_MetaNewRoute),
  // which a pure function cannot do — and a bad query string reaching here as
  // NaN would otherwise deal the one degenerate route xorshift32 has, where the
  // generator is stuck on zero and every pick takes the first candidate.
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffffffff) {
    throw new Error(`seed must be a whole number from 1 to 4294967295, got ${seed}`);
  }
  const tiles = deck.tiles;
  const fence = deck.play.half - FENCE_MARGIN;
  const rand = xorshift32(seed);
  // A few turns first: xorshift32 started from a small word — 1, 2, 3, the
  // seeds people actually type — takes a handful of rounds before its output
  // stops looking like its seed (metamap.as:762).
  for (let i = 0; i < 8; i++) rand();

  let cursor = { x: 0.0, y: 0.0, z: 0.0 };
  let heading = 0;
  let dealt = 0.0;
  let rewinds = 0;
  let progress = 0;
  let finished = false;
  let bare = false;
  let deadEnd = false;
  let startGate = null, finishGate = null;
  const placed = [];

  // The world box a tile would occupy if it were placed at `at` facing `step`:
  // the local AABB's four corners turned, then re-boxed.
  function box(tile, at, step) {
    const c = COS(step), s = SIN(step);
    let lox = 0, hix = 0, loy = 0, hiy = 0;
    for (let i = 0; i < 4; i++) {
      const px = (i === 0 || i === 3) ? tile.mins.x : tile.maxs.x;
      const py = (i < 2) ? tile.mins.y : tile.maxs.y;
      const rx = px * c - py * s;
      const ry = px * s + py * c;
      if (i === 0 || rx < lox) lox = rx;
      if (i === 0 || rx > hix) hix = rx;
      if (i === 0 || ry < loy) loy = ry;
      if (i === 0 || ry > hiy) hiy = ry;
    }
    return { lo: { x: at.x + lox, y: at.y + loy, z: at.z + tile.mins.z },
             hi: { x: at.x + hix, y: at.y + hiy, z: at.z + tile.maxs.z } };
  }

  function insideBox(lo, hi) {
    if (lo.x < -fence || hi.x > fence) return false;
    if (lo.y < -fence || hi.y > fence) return false;
    if (lo.z < -deck.play.down || hi.z > deck.play.up) return false;
    return true;
  }

  // The piece being mated to is skipped and nothing else: its box touches the
  // new one by construction. Skipping two leaves a blind spot exactly one
  // piece wide, which put a clash in 60% of simulated routes.
  function boxClear(lo, hi) {
    for (let i = 0; i < placed.length - 1; i++) {
      const a = placed[i].lo, b = placed[i].hi;
      if (hi.x <= a.x || lo.x >= b.x || hi.y <= a.y || lo.y >= b.y) continue;
      if (lo.z >= b.z + OVERPASS_CLEAR || hi.z + OVERPASS_CLEAR <= a.z) continue;
      return false;
    }
    return true;
  }

  // 0 in the middle of the play box, 1 at the fence.
  function outward(x, y) {
    const dx = Math.abs(x), dy = Math.abs(y);
    return (dx > dy ? dx : dy) / fence;
  }

  function pick() {
    const away = outward(cursor.x, cursor.y);
    const picks = [], scores = [];
    let total = 0.0;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      if (tile.weight <= 0) continue;          // start and finish are placed by hand

      const b = box(tile, cursor, heading);
      if (!insideBox(b.lo, b.hi) || !boxClear(b.lo, b.hi)) continue;

      // Leave room for whatever comes next: an exit hard against the fence is
      // a corner the dealer would have to paint itself out of.
      const ex = exitOf(cursor, tile, heading);
      if (!insideBox({ x: ex.x - EXIT_ROOM, y: ex.y - EXIT_ROOM, z: ex.z },
                     { x: ex.x + EXIT_ROOM, y: ex.y + EXIT_ROOM, z: ex.z })) continue;

      let s = tile.weight;
      // Pull back towards the middle, in proportion to how far out we are...
      if (away > 0.45) {
        const pull = (away - 0.45) / 0.55;
        let inward = 0.15 + (away - outward(ex.x, ex.y)) * 6.0;
        if (inward < 0.05) inward = 0.05;
        if (inward > 3.0) inward = 3.0;
        s = s * ((1.0 - pull) + pull * inward);
      }
      // ...and the same idea vertically. A route that only ever falls runs out
      // of box long before it runs out of pieces.
      if (tile.rise > 0 && cursor.z > deck.play.up * 0.5) s = s * 0.25;
      else if (tile.rise < 0 && cursor.z < -deck.play.down * 0.5) s = s * 0.25;
      else if (tile.rise > 0 && cursor.z < -deck.play.down * 0.4) s = s * 2.0;
      else if (tile.rise < 0 && cursor.z > deck.play.up * 0.4) s = s * 2.0;

      if (s <= 0) continue;
      picks.push(i);
      scores.push(s);
      total += s;
    }

    if (picks.length === 0) return -1;         // and no draw: a failed pick costs no randomness
    let roll = (rand() % 100000) / 100000.0 * total;
    for (let i = 0; i < picks.length; i++) {
      roll -= scores[i];
      if (roll <= 0) return picks[i];
    }
    return picks[picks.length - 1];
  }

  function deal(index) {
    const tile = tiles[index];
    const b = box(tile, cursor, heading);
    placed.push({ index, tile, at: cursor, step: heading,
                  dealtBefore: dealt, lo: b.lo, hi: b.hi });
    cursor = exitOf(cursor, tile, heading);
    heading = headingOf(tile, heading);
    dealt += tile.route;
  }

  // Undo the last placement — but only ever one no player has reached, so the
  // floor is never taken out from under anyone.
  function rewind() {
    if (placed.length - 1 <= progress + 1) return false;
    const p = placed.pop();
    cursor = p.at;
    heading = p.step;
    dealt = p.dealtBefore;
    rewinds++;
    return true;
  }

  function tryFinish() {
    for (const f of deck.finishes) {
      const b = box(tiles[f], cursor, heading);
      if (!insideBox(b.lo, b.hi) || !boxClear(b.lo, b.hi)) continue;
      finishGate = { at: cursor, step: heading };
      deal(f);
      finished = true;
      return true;
    }
    return false;
  }

  function extend() {
    let budget = REWIND_BUDGET;
    while (!finished && placed.length - 1 - progress < AHEAD) {
      let ending = dealt >= target || placed.length >= MAX_TILES - 1;
      let nothingFit = false;
      if (!ending) {
        const index = pick();
        if (index >= 0) {
          deal(index);
          continue;
        }
        ending = true;
        nothingFit = true;                     // the deck has nothing that fits here
      }
      if (tryFinish()) {
        deadEnd = nothingFit;
        return;
      }
      if (budget > 0 && rewind()) {
        budget--;
        continue;
      }
      // Walled in with nowhere to put a run-out. The gate alone still ends the
      // run: the player crosses it, the clock stops, and they drop into the pit
      // behind it, which respawns them. Driving a finish corridor through one
      // already on the ground would be the worse answer.
      finishGate = { at: cursor, step: heading };
      bare = true;
      finished = true;
      deadEnd = nothingFit;
      return;
    }
  }

  deal(deck.start);
  // The start gate sits at the END of the start pad, so the clock starts as the
  // player leaves it with a full pad of run-up behind them.
  startGate = { at: cursor, step: heading };
  extend();
  // Walk a player down the route, a piece at a time, until the dealer has
  // nothing left to add. The server does this as people run; here it is what
  // turns lazy dealing into one finished course.
  while (!finished || progress < placed.length - 1) {
    progress++;
    extend();
    if (progress > 200) break;
  }

  return {
    seed: seed >>> 0,
    target,
    pieces: placed,
    cursor,
    heading,
    length: dealt,
    rewinds,
    bare,
    deadEnd,
    startGate,
    finishGate,
  };
}
