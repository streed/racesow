// Verifies web/demo-meta.mjs recovers { map, name, timeMs } from a real Warsow/
// Warfork race demo. This is the load-bearing invariant of client-demo upload
// attribution: a demo the SFTP dropbox receives must yield the SAME map/runner/
// finish-time the game module would have reported over the trusted ingest.
//
// Fixtures are two real per-run demos pulled off the EU box (single-runner
// recordings, structurally identical to a client POV demo of one run). Their
// filenames encode the ground truth "<map>_<clean>_<MM-SS-mmm>.wdz20", so the
// parse must reproduce the map and the MM-SS-mmm suffix as milliseconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseDemoMeta,
  parseMatchScore,
  extractMetaBlock,
  mapFromConfigstrings,
  decompressHead,
  cleanDemoName,
  msToDemoTime,
  demoRelPath,
  MIN_TIME_MS,
} from "../../web/demo-meta.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

// Ground truth derived from the fixture filenames + their metadata blocks.
const CASES = [
  {
    file: "sh1tdash_ngc_depresja_00-00-188.wdz20",
    map: "sh1tdash",
    name: "^2ngc.^5depresja", // colour codes preserved (site strips them on group)
    timeMs: 188, // 00-00-188
    gametype: "hrace",
  },
  {
    file: "sliccup_4_Fleks_00-01-488.wdz20",
    map: "sliccup_4", // map names can contain underscores
    name: "Fleks",
    timeMs: 1488, // 00-01-488
    gametype: "hrace",
  },
];

for (const c of CASES) {
  test(`parseDemoMeta recovers map/name/time from ${c.file}`, async () => {
    const r = await parseDemoMeta(path.join(FIX, c.file));
    assert.equal(r.map, c.map);
    assert.equal(r.name, c.name);
    assert.equal(r.timeMs, c.timeMs);
    assert.equal(r.gametype, c.gametype);
    assert.equal(r.login, "");
    // The reconstructed canonical path must equal the file's own on-disk name
    // (proves our clean-name/time-string matches the engine that wrote it).
    assert.equal(r.relPath, `${c.map}/${c.file}`);
  });
}

test("demo filename reconstruction matches the engine (clean name + MM-SS-mmm)", () => {
  assert.equal(cleanDemoName("^2ngc.^5depresja"), "ngc_depresja"); // colours + '.' -> _
  assert.equal(cleanDemoName("Fleks"), "Fleks");
  assert.equal(cleanDemoName("El Chupa"), "El_Chupa"); // space -> _
  assert.equal(cleanDemoName("^1^2^3"), "player"); // all stripped -> fallback
  assert.equal(msToDemoTime(188), "00-00-188");
  assert.equal(msToDemoTime(1488), "00-01-488");
  assert.equal(msToDemoTime(92560), "01-32-560");
  assert.equal(demoRelPath("100m", "^2Runner", 12360), "100m/100m_Runner_00-12-360.wdz20");
});

test("decompressHead handles the multi-member gzip and reaches the metadata", async () => {
  const head = await decompressHead(path.join(FIX, CASES[0].file));
  assert.ok(head.length > 0, "decompressed head is non-empty");
  const s = head.toString("latin1");
  assert.match(s, /mapname\0sh1tdash\0/);
  assert.match(s, /matchscore\0/);
});

test("parseMatchScore parses MM-SS-mmm to ms and rejects junk", () => {
  assert.equal(parseMatchScore("00-00-188"), 188);
  assert.equal(parseMatchScore("00-01-488"), 1488);
  assert.equal(parseMatchScore("01-32-560"), 92560);
  assert.equal(parseMatchScore("123-59-999"), 123 * 60000 + 59999);
  assert.equal(parseMatchScore(""), null);
  assert.equal(parseMatchScore("garbage"), null);
  assert.equal(parseMatchScore("1:32.560"), null); // wrong separators
  assert.equal(parseMatchScore(null), null);
});

test("extractMetaBlock reads NUL-separated key/value pairs, skipping binary prefix", () => {
  // A synthetic head: some binary junk, then the pairs, then NUL padding.
  const block =
    "\x11@\x00\x00junk\x00hostname\x00My Server\x00mapname\x00core-cuarto\x00" +
    "gametype\x00hrace\x00matchname\x00^7Runner\x00matchscore\x0002-03-456\x00\x00\x00\x00\x00";
  const meta = extractMetaBlock(Buffer.from(block, "latin1"));
  assert.equal(meta.mapname, "core-cuarto");
  assert.equal(meta.matchname, "^7Runner");
  assert.equal(meta.matchscore, "02-03-456");
  assert.equal(meta.gametype, "hrace");
  assert.equal(parseMatchScore(meta.matchscore), 2 * 60000 + 3 * 1000 + 456);
});

test("mapFromConfigstrings falls back to the worldmodel configstring", () => {
  const head = Buffer.from('foo cs 30 "maps/nood-stoned.bsp" bar', "latin1");
  assert.equal(mapFromConfigstrings(head), "nood-stoned");
  assert.equal(mapFromConfigstrings(Buffer.from("no map here", "latin1")), null);
});

test("parse rejects a demo whose finish time is missing or absurd", () => {
  // matchscore absent -> no attributable time.
  const noScore = extractMetaBlock(Buffer.from("mapname\0m\0matchname\0N\0", "latin1"));
  assert.equal(parseMatchScore(noScore.matchscore), null);
  // Below the ingest floor -> would be rejected downstream.
  assert.ok(parseMatchScore("00-00-010") < MIN_TIME_MS);
});
