// Parse a Warsow/Warfork race demo (.wd / .wdz20) to recover the run it holds:
// { map, name, login, timeMs, gametype }. This is what lets a CLIENT-recorded
// demo (uploaded to the SFTP dropbox) be attributed to a map + player + time —
// SERVER demos already arrive with that metadata over the trusted ingest, but a
// raw client demo carries none, so we read it out of the file itself.
//
// Format (verified against real files, see server/test/fixtures/*.wdz20):
//   * The container is one or more CONCATENATED gzip members (the engine flushes
//     each demo message as its own member; the first is often a 0-byte member).
//     Node's zlib decompresses all members in one pass.
//   * The decompressed stream OPENS with the demo metadata block written by the
//     engine's SNAP_WriteDemoMetaData: after a short binary message header it is
//     a run of NUL-separated `key\0value` pairs, padded with NULs to a fixed
//     size. Keys we use:
//       mapname     -> the map            (e.g. "sh1tdash")
//       matchname   -> the runner's name  (colour-coded, e.g. "^2ngc.^5depresja")
//       matchscore  -> the finish time    ("MM-SS-mmm", e.g. "00-01-488")
//       gametype    -> "hrace" for race
//     (`duration` is NOT the finish time — it is a separate demo counter.)
//   * Fallbacks scan the early server commands: map from `cs 30 "maps/<m>.bsp"`.
//
// The finish time / runner in `matchscore` / `matchname` is exactly what the
// engine used to NAME a per-run demo (demoStop(name, finishTime) -> the
// "<map>_<clean>_<MM-SS-mmm>.wdz20" path), so a parse here reproduces what the
// game module would have reported for that run.

import fs from "node:fs";
import zlib from "node:zlib";

// Time sanity floor/ceiling, matching web/server.js MIN_TIME_MS / MAX_TIME_MS so
// a parsed demo can never assert a time the ingest would reject anyway.
export const MIN_TIME_MS = 50;
export const MAX_TIME_MS = 24 * 60 * 60 * 1000; // 24h

// The metadata block lives in the first few hundred bytes; 256 KiB is a generous
// cap that also catches the early serverdata/configstrings for the map fallback,
// while bounding memory on a huge auto demo (or a decompression bomb) — we stop
// reading the gunzip stream once we have this much.
const HEAD_LIMIT = 256 * 1024;

// The metadata keys the engine emits, in order. Used to bound value parsing: a
// value token is whatever follows a key token, and the block ends at the first
// NUL padding after the pairs.
const META_KEYS = new Set([
  "hostname",
  "localtime",
  "multipov",
  "duration",
  "mapname",
  "gametype",
  "levelname",
  "matchname",
  "matchscore",
]);

// Decompress only the head of a (possibly multi-member) gzip file. Resolves with
// a Buffer of at most `limit` decompressed bytes; tolerates a truncated tail once
// we already have data (we deliberately tear the stream down at the cap).
export function decompressHead(path, limit = HEAD_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const rs = fs.createReadStream(path);
    const gunzip = zlib.createGunzip();
    const finish = (err) => {
      if (settled) return;
      settled = true;
      rs.destroy();
      gunzip.destroy();
      if (err && chunks.length === 0) return reject(err);
      resolve(Buffer.concat(chunks, Math.min(total, limit)));
    };
    gunzip.on("data", (c) => {
      chunks.push(c);
      total += c.length;
      if (total >= limit) finish();
    });
    gunzip.on("end", () => finish());
    gunzip.on("error", (e) => finish(e));
    rs.on("error", (e) => finish(e));
    rs.pipe(gunzip);
  });
}

// Pull the NUL-separated key/value metadata pairs out of the decompressed head.
// Returns a plain object of the string values that are present.
export function extractMetaBlock(head) {
  // Split on NUL and keep the raw tokens; the binary message prefix before the
  // first real key becomes junk tokens we simply skip by only reading the token
  // that FOLLOWS a known key.
  const tokens = head.toString("latin1").split("\0");
  const meta = {};
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i];
    if (META_KEYS.has(k) && meta[k] === undefined) {
      meta[k] = tokens[i + 1];
    }
  }
  return meta;
}

// "MM-SS-mmm" (the demo matchscore / filename suffix) -> milliseconds.
export function parseMatchScore(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,3})-(\d{2})-(\d{3})$/.exec(s.trim());
  if (!m) return null;
  const [, mm, ss, mmm] = m;
  const ms = Number(mm) * 60000 + Number(ss) * 1000 + Number(mmm);
  return Number.isFinite(ms) ? ms : null;
}

// --- Canonical demo filename reconstruction -------------------------------
// Mirrors hrace/demos.as RACE_DemoRelPath so a promoted upload is named exactly
// like a server-recorded per-run demo ("<map>_<clean>_<MM-SS-mmm>.wdz20") and
// therefore passes the web's validDemoPath. The clean-name / time-string rules
// are the ones pinned byte-for-byte against the engine in demoname.test.mjs.
// Because the demo head is decoded as latin1, each char here is one original
// byte — so this per-byte cleaning matches the engine's byte-wise SV_CleanDemoName.
export function cleanDemoName(raw) {
  const stripped = String(raw).replace(/\^[0-9]/g, ""); // removeColorTokens
  let clean = "";
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped.charCodeAt(i);
    if (
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f ||
      c === 0x2d
    )
      clean += stripped[i];
    else if (c >= 0x20 && c < 0x7f) clean += "_"; // other printable ASCII -> _
    // control / DEL / >= 0x80: dropped
  }
  return clean.length ? clean : "player";
}

function pad(v, w) {
  let s = "" + v;
  while (s.length < w) s = "0" + s;
  return s;
}

// milliseconds -> "MM-SS-mmm" (SV_UintToTimeString).
export function msToDemoTime(ms) {
  let m = Math.floor(ms / 60000);
  ms -= m * 60000;
  let s = Math.floor(ms / 1000);
  ms -= s * 1000;
  return `${pad(m, 2)}-${pad(s, 2)}-${pad(ms, 3)}`;
}

// The two-segment served path the web stores + validates.
export function demoRelPath(map, name, timeMs) {
  return `${map}/${map}_${cleanDemoName(name)}_${msToDemoTime(timeMs)}.wdz20`;
}

// Fallback map extraction: the worldmodel configstring `cs 30 "maps/<map>.bsp"`.
export function mapFromConfigstrings(head) {
  const m = /\bcs\s+\d+\s+"maps\/([A-Za-z0-9_.-]+)\.bsp"/i.exec(head.toString("latin1"));
  return m ? m[1] : null;
}

// Parse a demo file into { map, name, login, timeMs, gametype }. Throws an Error
// (with a human reason) when the file is not a usable race demo — the caller
// (scripts/ingest-demos.sh) treats a throw as "reject this upload".
export async function parseDemoMeta(path) {
  const head = await decompressHead(path);
  if (head.length === 0) throw new Error("empty / not a gzip demo");

  const meta = extractMetaBlock(head);

  const map = (meta.mapname || mapFromConfigstrings(head) || "").trim().toLowerCase();
  if (!map) throw new Error("no map name in demo");

  const name = (meta.matchname || "").trim();
  if (!name) throw new Error("no runner name (matchname) in demo");

  const timeMs = parseMatchScore(meta.matchscore);
  if (timeMs === null) throw new Error(`no finish time (matchscore=${JSON.stringify(meta.matchscore)})`);
  if (timeMs < MIN_TIME_MS || timeMs > MAX_TIME_MS)
    throw new Error(`finish time ${timeMs}ms out of range`);

  return {
    map,
    name,
    login: "", // demos carry no MM login; player resolution groups by nick
    timeMs,
    gametype: (meta.gametype || "").trim(),
    // The canonical served path/name a server-recorded demo of this run would
    // have — what the ingest stores and the file is promoted to.
    relPath: demoRelPath(map, name, timeMs),
  };
}

// Report a parsed demo to the stats ingest as a `wr_demo` pointer — the SAME
// wire shape the game module sends (web/server.js), so an uploaded client demo
// reuses the whole player/map/time attribution path. Reads INGEST_URL /
// INGEST_TOKEN / DEMO_INGEST_VERSION from the env. Prints machine-readable
// STATUS / RELPATH lines the host watcher (scripts/ingest-demos.sh) parses; it
// never throws, so the watcher can branch on STATUS instead of exit codes.
async function ingestDemo(file) {
  const url = process.env.INGEST_URL;
  const token = process.env.INGEST_TOKEN;
  const version = process.env.DEMO_INGEST_VERSION || "client";
  const line = (k, v) => process.stdout.write(`${k}=${String(v).replace(/[\r\n]+/g, " ")}\n`);
  if (!url || !token) {
    line("STATUS", "error");
    line("REASON", "INGEST_URL/INGEST_TOKEN unset");
    return;
  }
  let meta;
  try {
    meta = await parseDemoMeta(file);
  } catch (e) {
    line("STATUS", "reject");
    line("REASON", e && e.message ? e.message : e);
    return;
  }
  line("RELPATH", meta.relPath);
  let bytes = null;
  try {
    bytes = fs.statSync(file).size;
  } catch {}
  const body = {
    version,
    map: meta.map,
    wr_demo: { name: meta.name, login: meta.login, time: meta.timeMs, demo: meta.relPath, bytes },
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (res.ok) line("STATUS", "ok");
    else {
      line("STATUS", "error");
      line("HTTP", res.status);
    }
  } catch (e) {
    line("STATUS", "error");
    line("REASON", e && e.message ? e.message : e);
  }
}

// CLI:
//   node demo-meta.mjs <file>            -> one line of JSON (parse only); exit 2 on failure
//   node demo-meta.mjs --ingest <file>   -> parse + POST wr_demo; prints STATUS=/RELPATH=; exit 0
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const ingest = args[0] === "--ingest";
  const file = ingest ? args[1] : args[0];
  if (!file) {
    console.error("usage: node demo-meta.mjs [--ingest] <demo.wdz20>");
    process.exit(64);
  }
  if (ingest) {
    ingestDemo(file).then(() => process.exit(0));
  } else {
    parseDemoMeta(file)
      .then((r) => process.stdout.write(JSON.stringify(r) + "\n"))
      .catch((e) => {
        console.error("demo-meta: " + (e && e.message ? e.message : e));
        process.exit(2);
      });
  }
}
