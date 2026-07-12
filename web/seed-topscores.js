// Seed the game server's topscores files from the central race database.
//
// For every map in db.sqlite this writes topscores/race/<map>.txt in the exact
// format the hrace racemod reads (RACE_LoadTopScores in
// server/racemod/source/progs/gametypes/hrace/recordtime.as):
//
//   //<map> top scores
//
//   "<finishMs>" "<playerName>" "<numSectors>" "<cp1Ms>" ... "<cpNMs>"
//
// One line per player (their best time), fastest first, capped at MAX_RECORDS
// (50, matching the mod). Sector times are absolute milliseconds from the
// checkpoint table; 0 means "not passed". Logins are deliberately omitted:
// the auth servers are gone, and mixing logins into otherwise login-less
// records makes the mod treat same-nick entries as different players.
//
// Existing files are MERGED, not clobbered: entries already on disk (e.g. a
// record set on the server moments ago that the collector hasn't shipped yet)
// are kept when they beat the DB time for the same nick. The merge also
// collapses same-nick duplicates left behind by the pre-fix racemod. Files are
// only rewritten when content changes, so the collector's mtime-based rescan
// isn't churned.
//
// Run via the one-shot compose service (see docker-compose.yml):
//
//   docker compose --profile seed run --rm seed-topscores
//
// then restart the game server so already-loaded maps re-read their files.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = process.env.DB_PATH || "/data/db.sqlite";
const OUT_DIR = process.env.TOPSCORES_DIR || "/topscores/race";
const MAX_RECORDS = 50; // mirrors the mod

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Same normalization the mod applies for identity: strip ^N color tokens,
// lowercase. (^^ escapes a literal caret.)
function cleanName(name) {
  return name.replace(/\^\^/g, "\0").replace(/\^[0-9]/g, "").replace(/\0/g, "^").toLowerCase();
}

// A name goes inside a quoted token the engine tokenizer can't escape.
function sanitizeName(name) {
  return name.replace(/["\r\n\t]/g, "").slice(0, 64);
}

// Quake-style tokenizer for existing topscores files: skips whitespace and
// //-comments, reads quoted or bare tokens.
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) break;
      tokens.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !" \t\r\n".includes(text[j])) j++;
    tokens.push(text.slice(i, j));
    i = j;
  }
  return tokens;
}

// Parse an existing topscores file into entries ({time, name, sectors}).
function parseExisting(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const tokens = tokenize(text);
  const entries = [];
  let i = 0;
  while (i + 2 < tokens.length + 1 && i < tokens.length) {
    let timeTok = tokens[i++];
    const pipe = timeTok.indexOf("|"); // drop any legacy login suffix
    if (pipe !== -1) timeTok = timeTok.slice(0, pipe);
    const name = tokens[i++];
    const nTok = tokens[i++];
    if (name === undefined || nTok === undefined) break;
    const n = parseInt(nTok, 10);
    if (!Number.isInteger(n) || n < 0 || n > 64) break; // malformed; stop
    const sectors = [];
    for (let j = 0; j < n && i < tokens.length; j++) sectors.push(parseInt(tokens[i++], 10) || 0);
    const time = parseInt(timeTok, 10);
    if (Number.isInteger(time) && time > 0 && name) entries.push({ time, name, sectors });
  }
  return entries;
}

const maps = db
  .prepare("SELECT DISTINCT m.id, m.name FROM map m JOIN race r ON r.map_id = m.id ORDER BY m.name")
  .all()
  .filter((m) => /^[a-z0-9][a-z0-9_.-]*$/i.test(m.name)); // path-safe names only

// Best race per canonical player for a map; display name = canonical rep's.
const bestStmt = db.prepare(`
  WITH k AS (
    SELECT pl.canonical_id cid, r.id rid, r.time,
           ROW_NUMBER() OVER (PARTITION BY pl.canonical_id ORDER BY r.time, r.id) rn
    FROM race r JOIN player pl ON pl.id = r.player_id
    WHERE r.map_id = ?
  )
  SELECT k.rid, k.time, rep.name
  FROM k JOIN player rep ON rep.id = k.cid
  WHERE k.rn = 1 ORDER BY k.time, k.rid LIMIT ${MAX_RECORDS}
`);
const cpStmt = db.prepare("SELECT time FROM checkpoint WHERE race_id = ? ORDER BY number");

fs.mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
let unchanged = 0;
for (const map of maps) {
  const fromDb = bestStmt.all(map.id).map((r) => ({
    time: r.time,
    name: sanitizeName(r.name),
    sectors: cpStmt.all(r.rid).map((c) => c.time | 0),
  }));
  const file = path.join(OUT_DIR, `${map.name.toLowerCase()}.txt`);

  // Merge: union of DB bests and on-disk entries, best time per clean nick.
  const byNick = new Map();
  for (const e of [...fromDb, ...parseExisting(file)]) {
    const key = cleanName(e.name);
    if (!key) continue;
    const cur = byNick.get(key);
    if (!cur || e.time < cur.time) byNick.set(key, e);
  }
  const entries = [...byNick.values()].sort((a, b) => a.time - b.time).slice(0, MAX_RECORDS);
  if (!entries.length) continue;

  const body =
    `//${map.name.toLowerCase()} top scores\n\n` +
    entries
      .map((e) => {
        let line = `"${e.time}" "${e.name}" "${e.sectors.length}" `;
        for (const s of e.sectors) line += `"${s}" `;
        return line + "\n";
      })
      .join("");

  try {
    if (fs.readFileSync(file, "utf8") === body) {
      unchanged++;
      continue;
    }
  } catch {}

  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, body);
  fs.chmodSync(tmp, 0o666); // game server (another uid) must be able to rewrite
  fs.renameSync(tmp, file);
  written++;
}

console.log(`seed-topscores: ${written} file(s) written, ${unchanged} unchanged, ${maps.length} maps considered`);
