/* The random_map tile deck, read straight out of the compiled pack.
 *
 * random_map is not a course: it is a deck of 78 pieces compiled into ONE
 * .bsp, and the gametype (server/racemod .../hrace/metamap.as) deals a route
 * from a seed at map load. To show a player the route a seed produces, the web
 * side needs the same numbers the dealer reads — how big each piece is, where
 * its exit sits, how far it turns.
 *
 * Those numbers ship INSIDE the pack, at maps/random_map.deck, and this module
 * reads them from there rather than from a copy checked in beside the web app.
 * That is the whole point: a preview built from a second copy can disagree with
 * the servers the moment one of them is rebuilt and the other is not. There is
 * one file, and both sides read it.
 *
 * WHAT IS IN THE MANIFEST
 *   deck <version> <tiles> <width>     header; version 1 is the only one
 *   play <half> <up> <down>            the arena the dealer must stay inside
 *   gate <model> <depth> <half> <height>
 *   tile <model> <flags> <weight> <fwd> <lat> <rise> <yaw>
 *        <minx..minz> <maxx..maxz> <route> <kind> <name>
 *   face <model> <tex> <top> <points> <x> <y> ...
 * `face` lines are the walkable footprints a plan draws, in the TILE'S own
 * frame; they join back to a tile by its inline-model index, the same way the
 * `gate` line names its model.
 *
 * The object this hands back is deliberately the same shape as the one
 * public/assets/js/random-dealer.js parses in the browser, so a route can serve
 * either the JSON or the raw manifest text and the dealer runs on it unchanged.
 * The difference is what happens on a bad file: the browser parser throws,
 * because a page that cannot draw should say so, while nothing here throws —
 * no pack, an unreadable pack, or a manifest that does not parse all return
 * null with the reason logged, so a route renders "no preview" instead of 500.
 *
 * HOW STRICT TO BE. RACE_MetaLoadDeck's head dispatch has no trailing else, so
 * a deployed server silently ignores a line head it does not know — which is
 * what let `face` be added to a grammar older servers already read. This parser
 * keeps that tolerance (unknown heads skipped, extra trailing tokens on a
 * `tile` line ignored) so a future deck does not break the preview, but it is
 * stricter than the engine where the engine cannot afford a check and we can:
 * a declared tile count that does not match means the file is truncated and the
 * whole parse is refused. A half-read deck would draw a plan that is quietly
 * WRONG, which is worse than no plan at all.
 */
import { open, stat } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// The only version RACE_MetaLoadDeck accepts (it aborts the whole load on a
// mismatch), so the preview refuses the same files the servers refuse.
export const DECK_VERSION = 1;

const PACK_FILE = "random_map.pk3";
const DECK_ENTRY = "maps/random_map.deck";

// Where the pack lives on the web box: the read-only map-store mount that
// mappack.js already serves packs from. The repo's build/ is the local-dev
// fallback — a checkout has the pack there long before it has a /mappack.
const LOCAL_BUILD_DIR = fileURLToPath(new URL("../build/", import.meta.url));
export const deckDirs = () => [process.env.MAPPACK_DIR || "/mappack", LOCAL_BUILD_DIR];

// tile.flags, mirrored by META_F_* in metamap.as and F_* in tools/mapgen. The
// dealer only reads START/FINISH; the rest describe what the piece asks of the
// player (OPEN = no side walls, DASH/WALLJUMP = the move it is built around).
export const DECK_FLAGS = Object.freeze({ OPEN: 1, DASH: 2, WALLJUMP: 4, START: 8, FINISH: 16 });

// Headings are eighths of a turn everywhere in the dealer, so a yaw that is not
// a multiple of 45 would round into a different route than the server deals.
const STEP_DEG = 45.0;
const STEPS = 8;

const ZIP64_SENTINEL_32 = 0xffffffff;

/* ------------------------- one entry out of a pack ------------------------ */

// Read a single file out of a .pk3 without unpacking it: tail -> end of central
// directory -> central directory -> that entry's local header -> its bytes.
// Four small reads, which matters because the map store can be an NFS mount
// (the US box reads it over a WireGuard tunnel) where touching a 14 GB mirror
// file by file is measured in minutes.
//
// Same walk as mappack.js's pk3MapNames, which only ever needs the NAMES; this
// one also has to inflate, because everything in a pk3 except the outer archive
// mappack builds is deflated. Returns a Buffer, or null for anything unreadable
// — it never throws.
export async function readPackEntry(file, entry) {
  const want = String(entry).toLowerCase();
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    // EOCD is the last 22 bytes plus an optional comment (<= 64 KiB).
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    // No pk3 in the pool is big enough to need zip64; treat the sentinel as
    // "cannot read" rather than misparsing it.
    if (cdOff === ZIP64_SENTINEL_32 || cdSize === ZIP64_SENTINEL_32) return null;
    if (cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      const name = cd.toString("latin1", p + 46, p + 46 + nameLen).toLowerCase();
      if (name === want) {
        if (method !== 0 && method !== 8) return null;
        // The local header's own name/extra lengths decide where the data
        // starts — they are allowed to differ from the central directory's, and
        // the offset itself comes from an untrusted file, so bounds-check both
        // before reading.
        if (localOff + 30 > size) return null;
        const lh = Buffer.alloc(30);
        await fh.read(lh, 0, 30, localOff);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        const dataOff = localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        if (dataOff + compSize > size) return null;
        const comp = Buffer.alloc(compSize);
        if (compSize) await fh.read(comp, 0, compSize, dataOff);
        return method === 0 ? comp : zlib.inflateRawSync(comp);
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/* ------------------------------ the manifest ------------------------------ */

// AngelScript's String::getToken is COM_Parse, which splits on whitespace and
// eats `//` to the end of the line — including a comment trailing a data line.
// Matching that here costs one check and means the preview reads exactly what
// the server reads.
function tokens(line) {
  const out = [];
  for (const tok of line.split(/\s+/)) {
    if (!tok) continue;
    if (tok.startsWith("//")) break;
    out.push(tok);
  }
  return out;
}

const finite = (tok) => {
  const v = Number(tok);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * Parse the manifest text into { version, width, play, gate, tiles, start,
 * finishes }: `start` and `finishes` are indexes into `tiles`, `finishes` is
 * roomiest first (the order the dealer falls down when a run-out does not fit),
 * and each tile carries its own `faces`. Returns null, with the reason logged,
 * if the text is not a deck this side can draw from.
 */
export function parseDeck(text, { log = console, source = "" } = {}) {
  const where = source ? ` (${source})` : "";
  const fail = (why) => {
    log.warn?.(`random deck: ${why}${where}`);
    return null;
  };

  const deck = { version: 0, width: 0, play: null, gate: null, tiles: [], start: -1, finishes: [] };
  const byModel = new Map();
  let declared = NaN; // the tile count the header promises
  let orphanFaces = 0;

  const lines = String(text).split("\n");
  for (let n = 0; n < lines.length; n++) {
    const t = tokens(lines[n]);
    if (!t.length) continue; // blank or comment-only
    const at = `line ${n + 1}`;

    if (t[0] === "deck") {
      deck.version = finite(t[1]);
      if (deck.version !== DECK_VERSION) return fail(`manifest version ${t[1]} is not ${DECK_VERSION}`);
      declared = finite(t[2]);
      deck.width = t.length > 3 ? finite(t[3]) : 0;
    } else if (t[0] === "play") {
      deck.play = { half: finite(t[1]), up: finite(t[2]), down: finite(t[3]) };
      if (!Number.isFinite(deck.play.half + deck.play.up + deck.play.down)) {
        return fail(`bad play box at ${at}`);
      }
    } else if (t[0] === "gate") {
      deck.gate = { model: finite(t[1]), depth: finite(t[2]), half: finite(t[3]), height: finite(t[4]) };
      if (!Number.isFinite(deck.gate.model + deck.gate.depth + deck.gate.half + deck.gate.height)) {
        return fail(`bad gate at ${at}`);
      }
    } else if (t[0] === "tile") {
      // 17 tokens is the whole line; more is allowed on purpose — getToken is
      // index-addressed, so appending a field to this grammar is the one
      // change deployed servers absorb silently.
      if (t.length < 17) return fail(`short tile line at ${at} (${t.length} tokens)`);
      const v = t.slice(1, 15).map(finite);
      if (v.some((x) => !Number.isFinite(x))) return fail(`bad number in the tile at ${at}`);
      const steps = v[6] / STEP_DEG;
      if (Math.abs(steps - Math.round(steps)) > 0.01) {
        return fail(`tile ${t[16]} turns ${v[6]} degrees, not a multiple of ${STEP_DEG}`);
      }
      const tile = {
        model: v[0],
        flags: v[1],
        weight: v[2], // 0 for the start and the finishes: those are placed by hand
        // The exit, in the tile's own frame: fwd along the entry heading, lat
        // to its left, rise in z. This is what mates one piece onto the next.
        fwd: v[3],
        lat: v[4],
        rise: v[5],
        // The yaw as an eighth-of-a-circle step, which is how the dealer
        // carries a heading.
        turn: ((Math.round(steps) % STEPS) + STEPS) % STEPS,
        mins: { x: v[7], y: v[8], z: v[9] },
        maxs: { x: v[10], y: v[11], z: v[12] },
        route: v[13], // centre-line length, i.e. what the piece is worth
        kind: t[15],
        name: t[16],
        faces: [],
      };
      if (tile.flags & DECK_FLAGS.START) deck.start = deck.tiles.length;
      if (tile.flags & DECK_FLAGS.FINISH) deck.finishes.push(deck.tiles.length);
      byModel.set(tile.model, tile);
      deck.tiles.push(tile);
    } else if (t[0] === "face") {
      const model = finite(t[1]);
      const top = finite(t[3]);
      const points = finite(t[4]);
      if (!Number.isFinite(model + top) || !Number.isInteger(points) || points < 3) {
        return fail(`bad face at ${at}`);
      }
      // The declared point count is what makes a variable-arity line
      // self-checking: a token that gained or lost a space shifts the arity
      // and is caught here instead of drawing a mangled polygon.
      if (t.length !== 5 + 2 * points) {
        return fail(`face at ${at} declares ${points} points but carries ${t.length - 5} numbers`);
      }
      const tile = byModel.get(model);
      if (!tile) {
        // A footprint for a model with no tile line. Not fatal: the dealer
        // never reads faces, so a deck that grew faces for something else
        // (the gate, say) is still a deck we can deal and draw.
        orphanFaces++;
        continue;
      }
      const poly = [];
      for (let i = 0; i < points; i++) {
        const x = finite(t[5 + i * 2]);
        const y = finite(t[6 + i * 2]);
        if (!Number.isFinite(x + y)) return fail(`bad face point at ${at}`);
        poly.push([x, y]);
      }
      // tex is the texture role a plan colours by; top is the top plane's
      // HIGHEST point (a ramp's top is a plane, not a height), tile-local.
      tile.faces.push({ tex: t[2], top, points: poly });
    }
    // No trailing else, exactly like RACE_MetaLoadDeck: a head we do not know
    // is a line written for someone else.
  }

  if (!deck.version) return fail("no deck header");
  if (!deck.tiles.length) return fail("no tiles");
  if (Number.isFinite(declared) && declared !== deck.tiles.length) {
    return fail(`header promises ${declared} tiles, the file carries ${deck.tiles.length}`);
  }
  if (deck.start < 0) return fail("no start tile");
  if (!deck.finishes.length) return fail("no finish tile");
  if (!deck.gate || !(deck.gate.model > 0)) return fail("no gate model");
  if (!deck.play || !(deck.play.half > 0)) return fail("no play box");
  if (orphanFaces) log.warn?.(`random deck: ${orphanFaces} face(s) name a model with no tile${where}`);

  // Roomiest finish first. Stable, like the insertion sort in metamap.as: two
  // run-outs of the same length keep manifest order, and the dealer walks that
  // list in order.
  deck.finishes.sort((a, b) => deck.tiles[b].route - deck.tiles[a].route);
  return deck;
}

/* -------------------------------- the cache ------------------------------- */

// One slot: there is one pack, and the parse is a few hundred lines. Keyed on
// the pack's path + size + mtime so republishing it (a deploy drops a new pk3
// into the map store under the same name) is picked up on the next call instead
// of at the next restart. A parse that failed is cached under the same key too,
// so a corrupt pack is read once per version of itself, not once per request.
// The text is kept beside the parse because a page that runs the dealer in the
// browser wants the manifest itself, and that must not cost a second read.
let cached = null; // { key, text, deck }

async function findPack(dirs) {
  for (const dir of dirs) {
    const file = path.join(dir, PACK_FILE);
    try {
      const st = await stat(file);
      if (st.isFile()) return { file, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      /* not here — try the next candidate */
    }
  }
  return null;
}

async function current({ dirs = deckDirs(), log = console } = {}) {
  const found = await findPack(dirs);
  const key = found ? `${found.file}\0${found.size}\0${Math.floor(found.mtimeMs)}` : "";
  if (cached && cached.key === key) return cached;

  let text = null;
  let deck = null;
  if (!found) {
    log.warn?.(`random deck: no ${PACK_FILE} under ${dirs.join(", ")}`);
  } else {
    const raw = await readPackEntry(found.file, DECK_ENTRY);
    if (!raw) log.warn?.(`random deck: ${found.file} carries no ${DECK_ENTRY}`);
    else text = raw.toString("utf8");
    if (text !== null) deck = parseDeck(text, { log, source: found.file });
    if (deck) {
      // Where it came from and how to tell it apart from the next one: enough
      // for a route to build a validator without stat-ing the pack again.
      deck.source = { file: found.file, size: found.size, mtimeMs: found.mtimeMs };
      log.log?.(`random deck: ${deck.tiles.length} tiles from ${found.file}`);
    }
  }
  cached = { key, text: deck ? text : null, deck };
  return cached;
}

/**
 * The deck the servers are dealing from, or null if it cannot be read.
 *
 * The returned object is shared by every caller and must be treated as
 * read-only; it is replaced wholesale when the pack changes.
 */
export async function loadDeck(opts) {
  return (await current(opts)).deck;
}

/**
 * The manifest exactly as it ships inside the pack, or null. Only handed back
 * once it has parsed, so a page that parses it again in the browser is never
 * given text this side has already judged unreadable.
 */
export async function loadDeckText(opts) {
  return (await current(opts)).text;
}
