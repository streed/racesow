// Racesow stats collector.
//
// Ships race results written by the game server into the central stats database
// via the web service's POST /api/ingest endpoint. Two independent feeds:
//
//  1. racelog/events.log — appended by our racemod fork on every finished
//     (non-practice) race. Tailed by byte offset (persisted), so nothing is
//     missed across restarts. Each line is one genuine finish, so this feed
//     also drives the attempt/run tally (source=racelog).
//  2. topscores/race/*.txt — the mod's own record files (top 50 per map),
//     re-scanned on mtime change as a best-state backfill (source=topscores);
//     does NOT affect the attempt tally. Works against a stock, unmodified
//     racemod server too (no fork required for this tier).
//
// Both feeds go through the same idempotent ingest endpoint, so overlap and
// re-sends are harmless.
//
// Event line format (tab-separated, written by hrace/racelog.as):
//   R1 <map> <finishTimeMs> <login> <cp1,cp2,...> <playerName>
import { readFile, writeFile, mkdir, open, readdir, stat, rename } from "node:fs/promises";
import path from "node:path";

const CFG = {
  ingestUrl: process.env.INGEST_URL || "http://web:8080/api/ingest",
  ingestToken: process.env.INGEST_TOKEN || "",
  serverName: process.env.SERVER_NAME || "",
  versionName: process.env.VERSION_NAME || "wsw 2.1",
  racelogFile: process.env.RACELOG_FILE || "/racelog/events.log",
  topscoresDir: process.env.TOPSCORES_DIR || "/topscores/race",
  statePath: process.env.STATE_PATH || "/state/collector.json",
  pollSeconds: Math.max(1, parseInt(process.env.POLL_INTERVAL || "3", 10)),
  rescanSeconds: Math.max(30, parseInt(process.env.TOPSCORES_RESCAN || "300", 10)),
  // Keep each POST well under the server's 1000-record / 2MB limits.
  batchSize: Math.min(500, Math.max(1, parseInt(process.env.BATCH_SIZE || "500", 10))),
  // Capped exponential backoff on transient (5xx/network) failures.
  maxBackoffSeconds: Math.max(5, parseInt(process.env.MAX_BACKOFF || "60", 10)),
};

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// A permanent (4xx) failure: the batch is bad, not the server. Don't retry.
class PermanentError extends Error {}

// --- State (racelog offset + inode + topscores mtimes) -----------------------
async function loadState() {
  try {
    const s = JSON.parse(await readFile(CFG.statePath, "utf8"));
    return { racelogOffset: s.racelogOffset || 0, racelogInode: s.racelogInode || null, topscores: s.topscores || {} };
  } catch {
    return { racelogOffset: 0, racelogInode: null, topscores: {} };
  }
}
async function saveState(state) {
  try {
    await mkdir(path.dirname(CFG.statePath), { recursive: true });
    const tmp = CFG.statePath + ".tmp";
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, CFG.statePath); // atomic: no torn JSON on crash
  } catch (e) {
    log("could not persist state:", e.message);
  }
}

// --- Ingest client -----------------------------------------------------------
async function postBatch(map, records, source) {
  const res = await fetch(CFG.ingestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.ingestToken}` },
    body: JSON.stringify({ version: CFG.versionName, server: CFG.serverName, map, records, source }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status >= 400 && res.status < 500) {
    throw new PermanentError(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Post all records for a map in chunks. A 4xx on one chunk is logged and
// skipped (the batch is malformed — retrying forever would wedge the feed);
// 5xx/network errors propagate so the caller can back off and retry.
async function postRecords(map, records, source) {
  let inserted = 0;
  let improved = 0;
  for (let i = 0; i < records.length; i += CFG.batchSize) {
    const chunk = records.slice(i, i + CFG.batchSize);
    try {
      const out = await postBatch(map, chunk, source);
      inserted += out.inserted || 0;
      improved += out.improved || 0;
    } catch (e) {
      if (e instanceof PermanentError) {
        log(`dropping ${chunk.length} rejected record(s) for map ${map}: ${e.message}`);
        continue; // skip poison chunk, keep going, allow offset to advance
      }
      throw e;
    }
  }
  if (inserted || improved) log(`map ${map}: ${inserted} new, ${improved} improved [${source}]`);
}

// --- Racelog tail ------------------------------------------------------------
// name is last: it is the only field that may contain arbitrary characters, so
// re-join any excess tab-separated fields into it.
export function parseEventLine(line) {
  const f = line.split("\t");
  if (f.length < 6 || f[0] !== "R1") return null;
  const map = f[1];
  const time = parseInt(f[2], 10);
  const name = f.slice(5).join("\t");
  if (!map || !name || !Number.isInteger(time) || time <= 0) return null; // pre-filter what the web would reject
  const checkpoints = f[4] === "" ? [] : f[4].split(",").map((n) => Math.max(0, parseInt(n, 10) || 0));
  return { map, record: { name, login: f[3], time, checkpoints } };
}

async function pumpRacelog(state) {
  let st;
  try {
    st = await stat(CFG.racelogFile);
  } catch {
    return; // no races logged yet
  }
  // Rotation / replacement detection by inode, not just size.
  if (state.racelogInode != null && st.ino !== state.racelogInode) {
    log("racelog inode changed (rotated/replaced); reading from start");
    state.racelogOffset = 0;
  } else if (st.size < state.racelogOffset) {
    log("racelog shrank (truncated); reading from start");
    state.racelogOffset = 0;
  }
  state.racelogInode = st.ino;
  if (st.size === state.racelogOffset) {
    await saveState(state); // persist inode / shrink reset even with no new data
    return;
  }

  const fh = await open(CFG.racelogFile, "r");
  let buf;
  try {
    buf = Buffer.alloc(st.size - state.racelogOffset);
    await fh.read(buf, 0, buf.length, state.racelogOffset);
  } finally {
    await fh.close();
  }

  // Consume only complete lines; a partially-written tail waits for next tick.
  // All offset math is in BYTES (find the last newline in the Buffer) so
  // invalid UTF-8 in a player name can't drift the offset.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return;
  const consumed = lastNl + 1;
  const text = buf.subarray(0, consumed).toString("utf8");

  const byMap = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseEventLine(line);
    if (!ev) {
      log("skipping unparseable event line:", JSON.stringify(line.slice(0, 200)));
      continue;
    }
    if (!byMap.has(ev.map)) byMap.set(ev.map, []);
    byMap.get(ev.map).push(ev.record);
  }

  // Post everything before advancing the offset. A 5xx/network throw here
  // leaves the offset put, so we re-send next tick (idempotent). 4xx chunks are
  // dropped inside postRecords so they can't wedge the offset forever.
  for (const [map, records] of byMap) await postRecords(map, records, "racelog");
  state.racelogOffset += consumed;
  await saveState(state);
}

// --- Topscores backfill ------------------------------------------------------
// Quoted-token format the mod reads back with getToken(): comment lines, then
// per record: "time|login" "name" "numSectors" "sec1" ... "secN".
export function parseTopscores(content) {
  const clean = content.replace(/^\s*\/\/.*$/gm, "");
  const tokens = [];
  for (const m of clean.matchAll(/"([^"]*)"|(\S+)/g)) tokens.push(m[1] ?? m[2]);

  const records = [];
  let i = 0;
  while (i + 2 < tokens.length) {
    const [timeTok, name, numTok] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    i += 3;
    const sep = timeTok.indexOf("|");
    const time = parseInt(sep < 0 ? timeTok : timeTok.slice(0, sep), 10);
    const login = sep < 0 ? "" : timeTok.slice(sep + 1);
    const numSectors = parseInt(numTok, 10);
    if (!Number.isInteger(numSectors) || numSectors < 0) break; // malformed; stop
    const checkpoints = tokens.slice(i, i + numSectors).map((t) => Math.max(0, parseInt(t, 10) || 0));
    i += numSectors;
    if (Number.isInteger(time) && time > 0 && name) records.push({ name, login, time, checkpoints });
  }
  return records;
}

async function scanTopscores(state) {
  let files;
  try {
    files = (await readdir(CFG.topscoresDir)).filter((f) => f.endsWith(".txt"));
  } catch {
    return; // no records written yet
  }
  for (const file of files) {
    const full = path.join(CFG.topscoresDir, file);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (state.topscores[file] === st.mtimeMs) continue;
    const map = file.slice(0, -4);
    try {
      const records = parseTopscores(await readFile(full, "utf8"));
      if (records.length) await postRecords(map, records, "topscores");
      state.topscores[file] = st.mtimeMs;
      await saveState(state);
    } catch (e) {
      if (e instanceof PermanentError) {
        log(`topscores ${file}: ${e.message}`);
        state.topscores[file] = st.mtimeMs; // don't loop on a bad file
        await saveState(state);
      } else {
        throw e; // transient: retry this file next scan
      }
    }
  }
}

// --- Main loop ---------------------------------------------------------------
async function main() {
  if (!CFG.ingestToken) log("WARNING: INGEST_TOKEN is empty — the ingest endpoint will reject pushes");
  log(`collector starting: ingest=${CFG.ingestUrl} server="${CFG.serverName || "(unnamed)"}" version="${CFG.versionName}"`);
  log(`  racelog=${CFG.racelogFile} topscores=${CFG.topscoresDir} poll=${CFG.pollSeconds}s rescan=${CFG.rescanSeconds}s batch=${CFG.batchSize}`);

  const state = await loadState();
  let lastScan = 0;
  let backoff = 0; // consecutive transient-failure count

  for (;;) {
    let transientFailure = false;
    // Each feed is isolated: a failure in one must not starve the other.
    try {
      await pumpRacelog(state);
    } catch (e) {
      transientFailure = true;
      log("racelog feed error (will retry):", e.message);
    }
    if (Date.now() - lastScan >= CFG.rescanSeconds * 1000) {
      try {
        await scanTopscores(state);
        lastScan = Date.now();
      } catch (e) {
        transientFailure = true;
        log("topscores feed error (will retry):", e.message);
      }
    }

    // Backoff only on transient failures; steady state polls at pollSeconds.
    if (transientFailure) backoff = Math.min(backoff + 1, 8);
    else backoff = 0;
    const delay = transientFailure
      ? Math.min(CFG.pollSeconds * 2 ** backoff, CFG.maxBackoffSeconds)
      : CFG.pollSeconds;
    await new Promise((r) => setTimeout(r, delay * 1000));
  }
}

// Only run the loop when executed directly (so tests can import the parsers).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log("fatal:", e);
    process.exit(1);
  });
}
