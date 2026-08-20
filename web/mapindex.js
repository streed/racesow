// Map-name -> pk3 location lookup table for the heatmap base render.
//
// The in-game map name is a .bsp basename (maps/<name>.bsp), but a pack's
// FILENAME is frequently different: e.g. map "bug70_slick-wjfix" ships inside
// "bug70-wjfix.pk3". So loadMapGeometry can NOT derive the pack path from the map
// name alone — the old `${name}.pk3` guess silently missed every mismatched pack
// and those maps rendered a heatmap with no map outline underneath.
//
// This module scans the pool's zip central directories ONCE and records which
// pk3(s) carry each maps/<name>.bsp, so the base render can find the real pack.
// Indexing reads only the zip directory bytes (no decompression, partial reads),
// so cataloguing thousands of multi-hundred-MB packs stays cheap.
//
// A map name can appear in more than one pack (updated re-releases). The engine
// VFS loads pk3s in sorted order with later packs overriding earlier, so the
// index keeps every candidate ordered last-wins-first; loadMapGeometry tries them
// in that order until one yields a parseable bsp (a corrupt / patch-only pack
// falls through to a good one).
import fs from "node:fs";
import path from "node:path";
import { isSafeMapName } from "./mapname.js";

const CD_SIG = 0x02014b50; // central directory file header
const EOCD_SIG = 0x06054b50; // end of central directory
const EOCD_MIN = 22; // EOCD with no archive comment
const MAX_COMMENT = 65535; // zip comment length is a uint16

// Read ONLY the central directory of a pk3 and return the lowercased basenames of
// its maps/<name>.bsp entries. Partial reads (tail to find the EOCD, then the CD
// region) so we never pull a whole pack into memory just to list its map names.
// Returns [] for anything that is not a readable zip — indexing must never throw
// on a corrupt/truncated pack.
export function listBspNames(pk3Path) {
  let fd;
  try {
    fd = fs.openSync(pk3Path, "r");
    const size = fs.fstatSync(fd).size;
    if (size < EOCD_MIN) return [];
    // The EOCD lives in the last (comment + 22) bytes; read that tail once.
    const tailLen = Math.min(size, MAX_COMMENT + EOCD_MIN);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) return [];
    const cdCount = tail.readUInt16LE(eocd + 10);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff >= size) return []; // corrupt directory pointer
    // The CD is often already inside the tail we read; otherwise read from its
    // start to EOF. We deliberately size that read by the file span, NOT by the
    // EOCD's cdSize field: an under-reported cdSize would truncate the buffer and
    // silently drop trailing entries (bsp.js's whole-file reader is immune since
    // it never consults cdSize). The cdCount loop below stops on the first
    // non-central-directory record (the EOCD) regardless of how much we read.
    const tailStart = size - tailLen;
    let cd, cdBase;
    if (cdOff >= tailStart) {
      cd = tail; cdBase = tailStart;
    } else {
      const cdLen = size - cdOff;
      cd = Buffer.alloc(cdLen); cdBase = cdOff;
      fs.readSync(fd, cd, 0, cdLen, cdOff);
    }
    const names = [];
    let p = cdOff - cdBase;
    for (let n = 0; n < cdCount; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen > cd.length) break;
      const fname = cd.toString("latin1", p + 46, p + 46 + nameLen).toLowerCase();
      const m = fname.match(/^maps\/(.+)\.bsp$/);
      if (m && isSafeMapName(m[1])) names.push(m[1]);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Scan every *.pk3 in mapsDir and return Map<name, string[]> where the strings
// are candidate pk3 FILENAMES (not full paths) carrying maps/<name>.bsp, ordered
// so the engine's winning pack (last in sorted VFS order) comes first.
export function buildMapIndex(mapsDir) {
  const index = new Map();
  let files;
  try {
    files = fs.readdirSync(mapsDir).filter((f) => f.toLowerCase().endsWith(".pk3")).sort();
  } catch {
    return index;
  }
  for (const f of files) {
    for (const name of listBspNames(path.join(mapsDir, f))) {
      let arr = index.get(name);
      if (!arr) { arr = []; index.set(name, arr); }
      if (!arr.includes(f)) arr.push(f); // files pre-sorted ascending -> appended in order
    }
  }
  // VFS precedence: a later pk3 in sorted order overrides an earlier one, so the
  // last-sorted candidate should be tried first.
  for (const arr of index.values()) arr.reverse();
  return index;
}

// Pool change-detector folding every pack's name + size + mtime into one FNV-1a
// hash. This is content-sensitive on purpose: a same-filename in-place rewrite (a
// re-release overwritten onto the existing pk3) does NOT bump the maps-directory
// mtime, so a coarser count+dir-mtime signature would keep serving a stale table
// across restarts. Statting the whole pool is ~15ms — cheap next to the rebuild
// it guards. A pack that vanishes mid-scan is skipped (self-heals next call).
export function poolSignature(mapsDir) {
  let files;
  try {
    files = fs.readdirSync(mapsDir).filter((f) => f.toLowerCase().endsWith(".pk3")).sort();
  } catch {
    return "";
  }
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (const f of files) {
    let st;
    try { st = fs.statSync(path.join(mapsDir, f)); } catch { continue; }
    const s = `${f}:${st.size}:${Math.floor(st.mtimeMs)};`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return `${files.length}:${(h >>> 0).toString(16)}`;
}

// Process-lifetime cache of the last-built index (the sidecar renders many maps
// per cycle from one pool; rebuilding per map would rescan thousands of packs).
let _cache = null; // { mapsDir, signature, index }

// Atomically write the lookup table to disk (also the human-inspectable dump).
// Never throws — a write failure just means the in-memory index serves this run.
function persist(cachePath, signature, index) {
  try {
    const maps = {};
    for (const [k, v] of index) maps[k] = v;
    const payload = { signature, builtAt: Math.floor(Date.now() / 1000), count: index.size, maps };
    const tmp = `${cachePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, cachePath);
  } catch { /* non-fatal */ }
}

// Get the map -> pk3 index for mapsDir, reusing the cached / persisted table when
// the pool signature is unchanged and rebuilding + rewriting mapindex.json
// otherwise. When cacheDir is given the table is persisted there. Never throws.
export function getMapIndex(mapsDir, cacheDir = null) {
  const signature = poolSignature(mapsDir);
  if (_cache && _cache.mapsDir === mapsDir && _cache.signature === signature) return _cache.index;

  const cachePath = cacheDir ? path.join(cacheDir, "mapindex.json") : null;
  if (cachePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (saved && saved.signature === signature && saved.maps) {
        const index = new Map(Object.entries(saved.maps));
        _cache = { mapsDir, signature, index };
        return index;
      }
    } catch { /* missing / stale / corrupt -> rebuild below */ }
  }

  const index = buildMapIndex(mapsDir);
  _cache = { mapsDir, signature, index };
  if (cachePath) persist(cachePath, signature, index);
  return index;
}

// Unconditionally rebuild the table, persist it, and refresh the cache — the
// operator escape hatch (heatmap.js --reindex). Unlike getMapIndex it ignores
// any existing same-signature file, so it always rewrites mapindex.json even if
// the on-disk table is wrong but its signature happens to match.
export function rebuildMapIndex(mapsDir, cacheDir = null) {
  const signature = poolSignature(mapsDir);
  const index = buildMapIndex(mapsDir);
  _cache = { mapsDir, signature, index };
  if (cacheDir) persist(path.join(cacheDir, "mapindex.json"), signature, index);
  return index;
}

// Test/CLI hook: drop the in-memory cache so the next getMapIndex rebuilds.
export function clearMapIndexCache() { _cache = null; }
