// Seed the game server's topscores files from the central race database
// (PostgreSQL edition — behaviour and file format identical to the SQLite-era
// version; see git history for the long-form comments).
//
// For every map this writes topscores/race/<map>.txt in the exact format the
// hrace racemod reads: merge-only (an on-disk record that beats the DB time
// for the same nick is kept), idempotent (files rewritten only on change).
//
// Run via the one-shot compose service:
//   docker compose --profile seed run --rm seed-topscores
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://racesow:racesow@127.0.0.1:5432/racesow";
const OUT_DIR = process.env.TOPSCORES_DIR || "/topscores/race";
const MAX_RECORDS = 50; // mirrors the mod

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
  while (i < tokens.length) {
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

const race = await openDatabase(DATABASE_URL);

const maps = (
  await race.all("SELECT DISTINCT m.id, m.name FROM map m JOIN race r ON r.map_id = m.id ORDER BY m.name")
).filter((m) => /^[a-z0-9][a-z0-9_.-]*$/i.test(m.name)); // path-safe names only

fs.mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
let unchanged = 0;
for (const map of maps) {
  // Best race per canonical player; display name = canonical rep's.
  const rows = await race.all(
    `WITH k AS (
       SELECT pl.canonical_id cid, r.id rid, r.time,
              ROW_NUMBER() OVER (PARTITION BY pl.canonical_id ORDER BY r.time, r.id) rn
       FROM race r JOIN player pl ON pl.id = r.player_id
       WHERE r.map_id = $1
     )
     SELECT k.rid, k.time, rep.name
     FROM k JOIN player rep ON rep.id = k.cid
     WHERE k.rn = 1 ORDER BY k.time, k.rid LIMIT ${MAX_RECORDS}`,
    [map.id]
  );
  const fromDb = [];
  for (const r of rows) {
    const sectors = (
      await race.all("SELECT time FROM checkpoint WHERE race_id = $1 ORDER BY number", [r.rid])
    ).map((c) => c.time | 0);
    fromDb.push({ time: r.time, name: sanitizeName(r.name), sectors });
  }
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
await race.close();
