/* Full map pack: every .pk3 the game servers hand out, as ONE downloadable zip.
 *
 * Clients auto-download missing maps on join, but the pool is ~4,600 packs /
 * ~13 GB — a player who wants to browse offline (or who joins on a slow link)
 * is better served by grabbing the lot once. That is what this module streams.
 *
 * WHY IT IS STREAMED, NOT A FILE ON DISK
 * A .pk3 is itself a deflate zip, so re-compressing it buys nothing: the pack
 * is written with method 0 (STORE), which makes the archive a pure
 * concatenation of headers + the untouched pk3 bytes. That has three
 * consequences we lean on:
 *   * a prebuilt copy would duplicate the whole ~13 GB mirror on a box that
 *     already carries it once, so we build the bytes per request instead;
 *   * the layout is fully determined by (name, size, mtime, crc32) of each
 *     pack, so the total length is known BEFORE sending a byte — the response
 *     carries a real Content-Length and browsers show a true progress bar;
 *   * because every byte's offset is known, Range requests can be served by
 *     seeking into the right pk3. A 13 GB download WILL be interrupted, so
 *     resume support is the difference between a usable feature and a useless
 *     one. `curl -C -`, wget and download managers all work.
 *
 * The one thing STORE still needs up front is each entry's CRC-32, which means
 * reading every pk3 once. That happens in a background pass whose results are
 * persisted to MAPPACK_INDEX (a small JSON file) and refreshed incrementally —
 * only packs whose size or mtime changed are re-read, so installing a batch of
 * new maps costs a scan of the new files, not of the mirror.
 *
 * ZIP64 is mandatory here: the archive is far past 4 GB, so local-header
 * offsets in the central directory overflow and the End Of Central Directory
 * record needs its 64-bit counterpart. Individual packs are all well under
 * 4 GB, so the LOCAL headers stay plain 2.0 records (see localHeader).
 *
 * DETERMINISM ACROSS REPLICAS: nginx round-robins two web replicas, so a
 * resumed range request usually lands on the OTHER replica than the one that
 * started the download. Both must therefore produce byte-identical archives
 * from the same directory: entries are sorted by name with a plain code-unit
 * compare (never localeCompare), DOS timestamps are derived in UTC (never
 * local time), and the README entry is generated from the index alone with no
 * "generated at" clock reading. The ETag hashes that layout, so if the two
 * replicas ever DO disagree (one has re-indexed a new map batch, the other has
 * not), an If-Range resume mismatches and the client restarts cleanly instead
 * of silently stitching two different archives together.
 */
import { createReadStream } from "node:fs";
import { readdir, stat, readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Bumped when the on-disk index shape or the archive layout changes, so a
// stale index from an older build is discarded rather than trusted.
const INDEX_VERSION = 1;

// Pack filenames we are willing to put in the archive. The name is written
// into the zip verbatim and is what an extractor creates on the user's disk,
// so the bar is "safe to write on any OS", NOT "tidy": ~15 real packs are named
// with `+`, `#`, `!`, backtick or brackets (the same punctuation that broke the
// in-game /top gate), and a player needs those maps like any other. What stays
// out is what an extractor could not honour anyway — path separators and
// traversal, control characters, a leading dot or dash, and the characters
// Windows forbids in a filename.
const PACK_NAME_RE = /^(?![.-])[^/\\:*?"<>|\x00-\x1f]{1,196}\.pk3$/i;

// A single zip entry must stay under 4 GiB for the plain 2.0 local header we
// write (see the ZIP64 note in the module header). The biggest real pack is a
// ~140 MB texture archive, so this only ever fires on something pathological.
const MAX_ENTRY_BYTES = 0xfffffffe;

const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

export const README_NAME = "README.txt";

/* ----------------------------- zip primitives ---------------------------- */

// CRC-32 of a whole file, streamed a megabyte at a time so a 140 MB pack never
// lands in memory. zlib.crc32 (Node >= 20.15) takes a running value, which is
// what makes the chunked form equivalent to hashing the file in one go.
export function crc32File(file) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    const rs = createReadStream(file, { highWaterMark: 1 << 20 });
    rs.on("data", (chunk) => {
      crc = zlib.crc32(chunk, crc);
    });
    rs.on("error", reject);
    rs.on("end", () => resolve(crc >>> 0));
  });
}

// mtime -> the MS-DOS date/time pair zip entries carry. Read in UTC on
// purpose: the two web replicas must derive identical bytes (see the
// determinism note above), and a container's TZ is not a contract. Dates
// before the DOS epoch (1980) clamp rather than wrap into garbage.
export function dosStamp(ms) {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (!Number.isFinite(ms) || year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

// Bit 11 tells the extractor the name is UTF-8. Pure-ASCII names are
// unambiguous in every code page, so the flag is only set when it matters.
const utf8Flag = (name) => (/^[\x20-\x7e]*$/.test(name) ? 0 : 0x800);

function localHeader(e) {
  const name = Buffer.from(e.name, "utf8");
  const b = Buffer.alloc(30 + name.length);
  const { time, date } = dosStamp(e.mtimeMs);
  b.writeUInt32LE(0x04034b50, 0); // local file header signature
  b.writeUInt16LE(20, 4); // version needed: 2.0 — stored, no zip64 in THIS header
  b.writeUInt16LE(utf8Flag(e.name), 6);
  b.writeUInt16LE(0, 8); // method 0: stored
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.size, 18); // compressed size == uncompressed size (stored)
  b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28); // no extra field
  name.copy(b, 30);
  return b;
}

// Central-directory record. Entries whose local header sits past 4 GiB carry
// the 64-bit offset in a zip64 extra field, with the 32-bit slot sentinel-ed —
// which is every entry after the first ~4 GB of packs.
function centralHeader(e, localOffset) {
  const name = Buffer.from(e.name, "utf8");
  const zip64 = localOffset >= ZIP64_SENTINEL_32;
  const extraLen = zip64 ? 12 : 0;
  const b = Buffer.alloc(46 + name.length + extraLen);
  const { time, date } = dosStamp(e.mtimeMs);
  b.writeUInt32LE(0x02014b50, 0); // central file header signature
  b.writeUInt16LE((3 << 8) | 45, 4); // made by: UNIX, spec 4.5
  b.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed to extract
  b.writeUInt16LE(utf8Flag(e.name), 8);
  b.writeUInt16LE(0, 10); // stored
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.size, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(extraLen, 30);
  b.writeUInt16LE(0, 32); // comment length
  b.writeUInt16LE(0, 34); // disk number start
  b.writeUInt16LE(0, 36); // internal attributes
  b.writeUInt32LE(0x81a40000, 38); // external attributes: unix 0100644
  b.writeUInt32LE(zip64 ? ZIP64_SENTINEL_32 : localOffset, 42);
  name.copy(b, 46);
  if (zip64) {
    // Only the local-header offset is sentinel-ed, so the extra field body is
    // exactly that one 8-byte value (the fields are order-dependent: sizes
    // first, then offset — omitted sizes must not be sentinel-ed above).
    b.writeUInt16LE(0x0001, 46 + name.length);
    b.writeUInt16LE(8, 46 + name.length + 2);
    b.writeBigUInt64LE(BigInt(localOffset), 46 + name.length + 4);
  }
  return b;
}

// End-of-central-directory, preceded by the zip64 EOCD record + locator
// whenever any of the three 32-bit slots would overflow (for the real pack:
// always, since the directory starts ~13 GB in).
function endRecords(count, cdSize, cdOffset) {
  const zip64 =
    cdOffset >= ZIP64_SENTINEL_32 || cdSize >= ZIP64_SENTINEL_32 || count >= ZIP64_SENTINEL_16;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(Math.min(count, ZIP64_SENTINEL_16), 8);
  eocd.writeUInt16LE(Math.min(count, ZIP64_SENTINEL_16), 10);
  eocd.writeUInt32LE(Math.min(cdSize, ZIP64_SENTINEL_32), 12);
  eocd.writeUInt32LE(Math.min(cdOffset, ZIP64_SENTINEL_32), 16);
  eocd.writeUInt16LE(0, 20); // comment length
  if (!zip64) return eocd;

  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(44n, 4); // size of this record minus its first 12 bytes
  z64.writeUInt16LE((3 << 8) | 45, 12); // made by
  z64.writeUInt16LE(45, 14); // needed to extract
  z64.writeUInt32LE(0, 16); // this disk
  z64.writeUInt32LE(0, 20); // disk with the central directory
  z64.writeBigUInt64LE(BigInt(count), 24);
  z64.writeBigUInt64LE(BigInt(count), 32);
  z64.writeBigUInt64LE(BigInt(cdSize), 40);
  z64.writeBigUInt64LE(BigInt(cdOffset), 48);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0);
  loc.writeUInt32LE(0, 4); // disk holding the zip64 EOCD
  loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8); // where that record starts
  loc.writeUInt32LE(1, 16); // total disks
  return Buffer.concat([z64, loc, eocd]);
}

/* ------------------------------- the layout ------------------------------ */

// Byte-for-byte plan of the archive: an ordered list of segments, each either a
// literal buffer (headers, the README, the trailing directory) or a slice of a
// pk3 on disk. Every segment knows its absolute offset, which is what makes
// Range serving a matter of walking the list.
//
// `entries` are index records ({name, size, mtimeMs, crc}); `extra` entries may
// instead carry their bytes inline as `data` (the README).
export function buildLayout(entries, { dir = "", extra = [] } = {}) {
  const files = [...extra, ...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const segments = [];
  const central = [];
  let off = 0;
  const push = (seg) => {
    seg.off = off;
    off += seg.len;
    segments.push(seg);
    return seg;
  };
  for (const e of files) {
    const localOffset = off;
    const lh = localHeader(e);
    push({ len: lh.length, buf: lh });
    if (e.size > 0) {
      if (e.data) push({ len: e.size, buf: e.data });
      else push({ len: e.size, file: path.join(dir, e.name), name: e.name });
    }
    central.push(centralHeader(e, localOffset));
  }
  const cd = Buffer.concat(central);
  const tail = Buffer.concat([cd, endRecords(files.length, cd.length, off)]);
  push({ len: tail.length, buf: tail });

  // Strong validator over exactly the inputs that decide the bytes. Two
  // replicas with the same mirror produce the same ETag; a new map batch on
  // one of them produces a different one (and invalidates in-flight resumes,
  // which is the correct outcome — the offsets really did move).
  const h = crypto.createHash("sha256");
  h.update(`v${INDEX_VERSION}\n`);
  for (const e of files) h.update(`${e.name}\0${e.size}\0${e.crc}\0${Math.floor(e.mtimeMs)}\n`);
  return {
    segments,
    entries: files,
    size: off,
    files: files.length,
    packs: entries.length,
    packBytes: entries.reduce((n, e) => n + e.size, 0),
    etag: `"${h.digest("hex").slice(0, 32)}"`,
    // Newest pack mtime: the archive's own Last-Modified, and (via the README)
    // the only clock reading in the whole layout.
    mtimeMs: files.reduce((m, e) => Math.max(m, e.mtimeMs), 0),
  };
}

// Yields exactly the bytes of [start, end] (both inclusive) of the archive.
// File-backed segments are read with an fd range so a resume from 9 GB in
// costs a seek, not a 9 GB read.
export async function* readRange(layout, start, end) {
  for (const seg of layout.segments) {
    const segEnd = seg.off + seg.len - 1;
    if (segEnd < start) continue;
    if (seg.off > end) break;
    const from = Math.max(start, seg.off) - seg.off;
    const to = Math.min(end, segEnd) - seg.off;
    if (seg.buf) {
      yield seg.buf.subarray(from, to + 1);
      continue;
    }
    // A pack that was replaced or removed since indexing would silently
    // corrupt the archive (short read, or the wrong bytes at the right
    // offset). Count what we get and blow up the response instead: a truncated
    // transfer is recoverable by the client, a plausible-looking corrupt zip is
    // not. The index refresh will have picked up the change by the next try.
    let got = 0;
    const rs = createReadStream(seg.file, { start: from, end: to });
    for await (const chunk of rs) {
      got += chunk.length;
      yield chunk;
    }
    if (got !== to - from + 1) {
      throw new Error(`map pack: ${seg.name} changed under the download (${got} of ${to - from + 1} bytes)`);
    }
  }
}

// Fixed, human-readable note dropped in the archive root. Derived purely from
// the index (no clock, no request context) so the archive stays byte-stable.
export function readmeText(layout0) {
  const gb = (layout0.packBytes / 1e9).toFixed(1);
  return [
    "Racesow map pack",
    "================",
    "",
    `${layout0.packs} map packs (.pk3), ${gb} GB extracted.`,
    "",
    "This is every custom pak the Racesow game servers hand out — the same",
    "files your client downloads one at a time when it joins a map it does not",
    "have. Extracting them up front just saves you the wait.",
    "",
    "WHERE TO PUT THEM",
    "  Drop the .pk3 files (no subfolder) into the mod directory your client",
    "  already downloads maps into:",
    "",
    "    Warsow 2.1   ->  racemod/",
    "    Warfork      ->  racesow/",
    "",
    "  That directory lives either next to the game executable or in your",
    "  per-user profile directory, depending on how the client was installed",
    "  and on fs_usehomedir. The reliable way to find it: join a server, let it",
    "  download one map, then search your disk for that .pk3 — whichever folder",
    "  it landed in is the one to extract into.",
    "",
    "  Existing files can be overwritten; the packs are content-identical to",
    "  what the servers serve.",
    "",
    "NOTES",
    "  * Nothing here replaces the base game. Install Warsow 2.1 or Warfork",
    "    first; these are the community race maps on top of it.",
    "  * base_tex.pk3 is a texture-only pack (no maps) that many third-party",
    "    race maps reference. Keep it.",
    "  * The archive is stored, not compressed: a .pk3 is already a zip, so",
    "    re-compressing it would only cost you CPU.",
    "",
    "https://racesow.org/",
    "",
  ].join("\n");
}

/* --------------------------- map name -> pack ---------------------------- */

// The .bsp basenames a pack carries, read from ITS central directory only —
// tens of KB, not the whole pack (bsp.js reads pk3s whole because it needs the
// bsp lumps; here only the file list matters). Lowercased, because that is how
// a map name is keyed everywhere else in this codebase.
//
// A pack filename is NOT the map name: `0000_drace1_semibeta.pk3` can carry a
// map called something else entirely, and one pack often carries several. That
// mapping is exactly what a per-map download link needs.
export async function pk3MapNames(file) {
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
    if (eocd < 0) return [];
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    // A pk3 big enough to need zip64 does not exist in the pool; treat the
    // sentinel as "cannot read" rather than misparsing it.
    if (cdOff === ZIP64_SENTINEL_32 || cdSize === ZIP64_SENTINEL_32) return [];
    if (cdOff + cdSize > size) return [];
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    const maps = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const name = cd.toString("latin1", p + 46, p + 46 + nameLen).toLowerCase();
      const m = /^maps\/([^/]+)\.bsp$/.exec(name);
      if (m) maps.push(m[1]);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return maps;
  } catch {
    return [];
  } finally {
    await fh?.close().catch(() => {});
  }
}

// A reverse race is its own map row named "<map>-reversed" and no pack contains
// a bsp by that name (db.js says as much where it filters the pool), so a
// reverse map downloads the pack of the forward map it runs backwards.
export const basePackMapName = (name) => String(name || "").toLowerCase().replace(/-reversed$/, "");

/* ------------------------------ the index -------------------------------- */

// One CRC pass over ~13 GB is minutes of disk on a box that is also running
// game servers and Postgres, so it happens once, in the background, and is
// persisted. Both replicas share the index file (it lives on the same ./data
// mount); a lock file keeps them from doing the same 13 GB of reads twice on a
// first deploy.
const LOCK_STALE_MS = 45 * 60 * 1000;

async function readIndex(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeIndex(file, entries) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ version: INDEX_VERSION, builtAt: Date.now(), entries });
  await writeFile(tmp, body);
  await rename(tmp, file); // atomic: a reader never sees a half-written index
}

// Cooperative, best-effort lock. O_EXCL create; a lock older than
// LOCK_STALE_MS is assumed to belong to a replica that died mid-scan.
async function takeLock(file) {
  try {
    const fh = await open(file, "wx");
    await fh.writeFile(String(Date.now()));
    await fh.close();
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") return false;
    try {
      const st = await stat(file);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(file).catch(() => {});
        return takeLock(file);
      }
    } catch {
      /* vanished between the create and the stat — let the next cycle retry */
    }
    return false;
  }
}

export function createMapPack({
  dir = process.env.MAPPACK_DIR || "/mappack",
  indexPath = process.env.MAPPACK_INDEX || "/data/mappack-index.json",
  refreshMs = parseInt(process.env.MAPPACK_REFRESH_MS || "", 10) || 6 * 60 * 60 * 1000,
  // Concurrent full-size streams. The scarce resource is the box's uplink, not
  // CPU: four saturating clients already outrun most of it, and everything past
  // that just makes every download slower. Refused requests get a 503 +
  // Retry-After rather than a stall.
  maxStreams = parseInt(process.env.MAPPACK_MAX_STREAMS || "", 10) || 4,
  downloadName = "racesow-maps.zip",
  log = console,
} = {}) {
  let layout = null; // immutable snapshot; replaced wholesale on refresh
  let byMap = new Map(); // map name -> the index entry of the pack carrying it
  let building = false;
  let progress = null; // {done, total} while a CRC pass is running
  let timer = null;
  let stopped = false;
  let streams = 0;

  const lockPath = `${indexPath}.lock`;
  // Short retry used when another replica holds the indexing lock, so the
  // loser picks up the published index in a minute rather than at the next
  // full refresh (hours away).
  let retryTimer = null;
  const scheduleRetry = () => {
    if (retryTimer || stopped) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      refresh();
    }, 60_000);
    retryTimer.unref();
  };

  const install = (entries) => {
    const base = buildLayout(entries, { dir });
    const readme = Buffer.from(readmeText(base), "utf8");
    layout = buildLayout(entries, {
      dir,
      extra: [
        {
          name: README_NAME,
          size: readme.length,
          crc: zlib.crc32(readme) >>> 0,
          // Stamped with the newest pack, never with "now": see the
          // determinism note at the top of the file.
          mtimeMs: base.mtimeMs || Date.now(),
          data: readme,
        },
      ],
    });
    // map -> pack. A map can sit in more than one pack (an old pack and a
    // remake); prefer the pack NAMED after the map, then the first
    // alphabetically, so the choice is deterministic across replicas rather
    // than dependent on readdir order.
    byMap = new Map();
    for (const e of entries) {
      for (const m of e.maps ?? []) {
        const prev = byMap.get(m);
        if (!prev || (e.name.toLowerCase() === `${m}.pk3` && prev.name.toLowerCase() !== `${m}.pk3`)) {
          byMap.set(m, e);
        }
      }
    }
    return layout;
  };

  // Cheap pass: stat the directory and split it into entries we can reuse from
  // the persisted index and packs that still need hashing. Returns null only
  // when the directory itself is unreadable (not mounted).
  async function statPass(known) {
    const byName = new Map(known.map((e) => [e.name, e]));
    let names;
    try {
      names = await readdir(dir);
    } catch (e) {
      log.warn?.(`map pack: cannot read ${dir}: ${e.message}`);
      return null;
    }
    const wanted = names.filter((n) => PACK_NAME_RE.test(n)).sort();
    const entries = [];
    const todo = [];
    for (const name of wanted) {
      let st;
      try {
        st = await stat(path.join(dir, name));
      } catch {
        continue; // vanished mid-scan
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_ENTRY_BYTES) {
        log.warn?.(`map pack: skipping ${name} (${st.size} bytes exceeds the 4 GiB entry limit)`);
        continue;
      }
      const prev = byName.get(name);
      if (prev && prev.size === st.size && Math.floor(prev.mtimeMs) === Math.floor(st.mtimeMs)) {
        // An index written before per-map downloads existed has no map list.
        // Reading a pack's central directory is tens of KB, so backfilling it
        // is cheap — re-CRCing 13 GB to get it would not be. Copied rather than
        // mutated: `prev` belongs to the `known` list the change check below
        // compares against, and editing it in place would hide the change.
        entries.push(Array.isArray(prev.maps) ? prev : { ...prev, maps: await pk3MapNames(path.join(dir, name)) });
      } else {
        todo.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    return { entries, todo };
  }

  // Expensive pass: read each new/changed pack once for its CRC-32 and its map
  // list. Minutes of disk on a first run, seconds for a new map batch.
  async function hashPass(entries, todo) {
    progress = { done: 0, total: todo.length };
    log.log?.(`map pack: hashing ${todo.length} new/changed pack(s) in ${dir}`);
    for (const e of todo) {
      if (stopped) return null;
      try {
        e.crc = await crc32File(path.join(dir, e.name));
        e.maps = await pk3MapNames(path.join(dir, e.name));
        entries.push(e);
      } catch (err) {
        log.warn?.(`map pack: skipping ${e.name}: ${err.message}`);
      }
      progress.done++;
    }
    progress = null;
    return entries;
  }

  // Sorted by name so the persisted index has ONE canonical order: the change
  // check and the layout both compare positionally.
  const sorted = (entries) => entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  async function refresh() {
    if (building || stopped) return;
    building = true;
    try {
      const onDisk = await readIndex(indexPath);
      const known = onDisk?.entries ?? [];
      // Publish whatever the persisted index already covers before spending
      // minutes on the new files: a restart after a map batch serves the old
      // (still valid) pack instead of 503-ing until the hash pass finishes.
      if (!layout && known.length) install(known);

      const pass = await statPass(known);
      if (!pass || stopped) return;
      let { entries: fresh, todo } = pass;

      // Hashing is the only expensive part, and both replicas share one
      // ./data mount — so the lock is taken BEFORE the hash pass, not just
      // around the write. Without that, a first deploy has two replicas
      // reading the same 13 GB at the same time on a box that is also running
      // game servers. The replica that loses serves whatever the persisted
      // index already covers and retries shortly, by which time the winner has
      // published its index and the retry is a stat pass.
      let held = false;
      if (todo.length) {
        held = await takeLock(lockPath);
        if (!held) {
          log.log?.(`map pack: another replica is indexing ${todo.length} pack(s); retrying shortly`);
          scheduleRetry();
          return;
        }
      }
      try {
        if (todo.length && !(await hashPass(fresh, todo))) return;
        if (stopped) return;
        sorted(fresh);
        const shape = (list) => JSON.stringify(list.map((e) => [e.name, e.size, e.crc, e.maps ?? null]));
        // The backfill path (an old index gaining map lists) changes the stored
        // shape without needing the hash pass, so this is checked either way.
        if (shape(fresh) !== shape(known) && (held || (await takeLock(lockPath)))) {
          held = true;
          await writeIndex(indexPath, fresh);
        }
      } finally {
        if (held) await unlink(lockPath).catch(() => {});
      }
      const l = install(fresh);
      log.log?.(
        `map pack: ${l.packs} packs, ${(l.size / 1e9).toFixed(2)} GB archive, etag ${l.etag}`
      );
    } catch (e) {
      log.error?.(`map pack refresh failed: ${e?.message ?? e}`);
    } finally {
      building = false;
    }
  }

  function status() {
    if (!layout) {
      return { ready: false, building, files: 0, bytes: 0, progress };
    }
    return {
      ready: true,
      building,
      progress,
      // What the user gets: N packs, `bytes` of archive to download.
      packs: layout.packs,
      files: layout.files,
      bytes: layout.size,
      pack_bytes: layout.packBytes,
      etag: layout.etag,
      // Epoch SECONDS, like every other timestamp this API hands out — the
      // newest pack's mtime, i.e. when the mirror last gained a map.
      updated_at: Math.floor(layout.mtimeMs / 1000),
      download_url: `/download/${downloadName}`,
      filename: downloadName,
      maps: byMap.size,
    };
  }

  // What the map page needs to render its download button: the pack carrying
  // this map, how big it is, and what else rides along inside it. null when the
  // map is not in the mirror (or the index is not built yet), which the caller
  // renders as "no button" rather than a broken link.
  function packFor(mapName) {
    const key = basePackMapName(mapName);
    const e = key && byMap.get(key);
    if (!e) return null;
    return {
      url: `/download/map/${encodeURIComponent(key)}.pk3`,
      filename: e.name,
      bytes: e.size,
      // Other maps in the same pack — worth showing, since the file a player
      // downloads for one map may hand them four.
      maps: e.maps ?? [],
    };
  }

  // Single-pack download for one map. The path is resolved through the index
  // (never joined from user input), so there is no traversal surface, and
  // res.sendFile brings Range/If-Modified-Since with it.
  function handleMap(req, res) {
    const hit = packFor(String(req.params.name || "").replace(/\.pk3$/i, ""));
    if (!hit) {
      return res
        .status(404)
        .json({ error: layout ? "no pack installed for that map" : "the map pack is still being indexed" });
    }
    res.sendFile(
      path.join(dir, hit.filename),
      {
        // A pack is immutable content under a stable name; a day of browser
        // caching saves re-downloading it when someone revisits the map page.
        maxAge: "1d",
        headers: {
          "Content-Type": "application/zip",
          // The pack's real filename, not the map's: dropping `cpm22.pk3` into
          // the mod dir under some other name would break the client's pure
          // check against the server.
          "Content-Disposition": `attachment; filename="${hit.filename.replace(/[^\x20-\x7e]|"/g, "_")}"`,
        },
      },
      (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: "pack not available" });
      }
    );
  }

  // GET/HEAD handler. Express-compatible (req, res) — kept here rather than in
  // server.js so the range/validator logic sits next to the layout it depends
  // on.
  async function handle(req, res) {
    const snapshot = layout; // pin: a refresh must not move offsets mid-response
    if (!snapshot) {
      res.set("Retry-After", "300");
      return res.status(503).json({ error: "the map pack is still being indexed" });
    }
    res.set("Accept-Ranges", "bytes");
    res.set("ETag", snapshot.etag);
    res.set("Last-Modified", new Date(snapshot.mtimeMs).toUTCString());
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${downloadName}"`);
    // 13 GB of already-compressed data: any proxy that tries to buffer or
    // re-encode this is a bug, and a stale cached copy would be a 13 GB one.
    res.set("Cache-Control", "no-store");
    res.set("X-Accel-Buffering", "no");

    if (req.headers["if-none-match"] === snapshot.etag) return res.status(304).end();

    let start = 0;
    let end = snapshot.size - 1;
    let partial = false;
    const range = req.headers.range;
    if (range) {
      // If-Range: only honour the range when the client's copy of the archive
      // still matches ours, otherwise fall back to a fresh full transfer.
      const ifRange = req.headers["if-range"];
      if (ifRange && ifRange !== snapshot.etag) {
        // fall through as a normal 200
      } else {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!m || (m[1] === "" && m[2] === "")) {
          res.set("Content-Range", `bytes */${snapshot.size}`);
          return res.status(416).end();
        }
        if (m[1] === "") {
          // suffix range: the last N bytes (how some tools read the directory)
          const n = parseInt(m[2], 10);
          if (!n) {
            res.set("Content-Range", `bytes */${snapshot.size}`);
            return res.status(416).end();
          }
          start = Math.max(0, snapshot.size - n);
        } else {
          start = parseInt(m[1], 10);
          if (m[2] !== "") end = Math.min(end, parseInt(m[2], 10));
        }
        if (!(start >= 0) || start > end || start >= snapshot.size) {
          res.set("Content-Range", `bytes */${snapshot.size}`);
          return res.status(416).end();
        }
        partial = true;
        res.set("Content-Range", `bytes ${start}-${end}/${snapshot.size}`);
      }
    }

    res.set("Content-Length", String(end - start + 1));
    res.status(partial ? 206 : 200);
    if (req.method === "HEAD") return res.end();

    if (streams >= maxStreams) {
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Range");
      res.set("Retry-After", "120");
      return res.status(503).json({ error: "too many map-pack downloads in flight, try again shortly" });
    }
    streams++;
    try {
      await pipeline(Readable.from(readRange(snapshot, start, end)), res);
    } catch (e) {
      // A client that closes the tab mid-download is the common case, not an
      // incident — only surface something that is not a hangup.
      const code = e?.code ?? "";
      if (!["ERR_STREAM_PREMATURE_CLOSE", "EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(code)) {
        log.error?.(`map pack stream failed: ${e?.message ?? e}`);
      }
      res.destroy();
    } finally {
      streams--;
    }
  }

  return {
    start() {
      if (timer || stopped) return;
      refresh();
      timer = setInterval(refresh, refreshMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(retryTimer);
      timer = null;
      retryTimer = null;
    },
    refresh,
    status,
    packFor,
    handle,
    handleMap,
    // Test seam: the pinned layout the handler would serve right now.
    get layout() {
      return layout;
    },
  };
}
