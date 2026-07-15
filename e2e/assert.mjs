// E2E assertions against the live web API. The expected numbers correspond to
// the report lines run.sh feeds the harness — keep the two in sync.
//
//   node assert.mjs <baseUrl> phaseA   (after Nova x3 + Wave x1 on testrace)
//   node assert.mjs <baseUrl> phaseB   (after Wave's 47.0 PR while the server
//                                       was restarting — retry path)
import assert from "node:assert/strict";

const [base, phase] = process.argv.slice(2);
if (!base || !["phaseA", "phaseB"].includes(phase)) {
  console.error("usage: node assert.mjs <baseUrl> phaseA|phaseB");
  process.exit(2);
}

async function get(p) {
  const r = await fetch(`${base}/api${p}`);
  assert.equal(r.status, 200, `GET ${p} -> ${r.status}`);
  return r.json();
}

// Ingest is async on both ends (native send thread + debounced aggregate
// refresh), so poll until the world reaches the expected state or time out.
async function until(desc, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      console.error(`TIMEOUT waiting for: ${desc}`);
      throw lastErr;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const expected =
  phase === "phaseA"
    ? { finishes: 4, wr: 48000, wrHolder: "Nova", wrSplits: [10000, 28000], perfect: 47500, board: [["Nova", 48000], ["Wave", 49000]],
        // starts: Nova 2+1+3 riding her finish reports; Wave 2 + a 4-start
        // standalone flush (run.sh curls it after the harness)
        novaAttempts: 6, waveAttempts: 6 }
    : { finishes: 5, wr: 47000, wrHolder: "Wave", wrSplits: [9500, 27000], perfect: 47000, board: [["Wave", 47000], ["Nova", 48000]],
        // phase B: Wave's retried finish carries the default 1 attempt
        novaAttempts: 6, waveAttempts: 7 };

// 1. Every finish is recorded as an attempt (run tally, straight from the DB).
const ov = await until(`overview.finishes == ${expected.finishes}`, async () => {
  const o = await get("/overview");
  assert.equal(o.totals.finishes, expected.finishes);
  return o;
});
assert.equal(ov.totals.records, 2, "one PR row per player");
assert.ok(ov.recent.length >= 1, "recent-records feed populated");

// 2. Map page: records for ALL players, WR + splits, perfect run.
const m = await until("map aggregate refresh", async () => {
  const maps = await get("/maps?q=testrace");
  assert.equal(maps.total, 1, "testrace present in map index");
  assert.equal(maps.rows[0].finishes, expected.finishes, "map attempt count");
  return maps.rows[0];
});
assert.equal(m.players, 2);
assert.equal(m.wr_time, expected.wr);

const d = await until("map detail reflects latest PRs", async () => {
  const det = await get(`/maps/${m.id}?limit=10000`);
  assert.equal(det.wr.time, expected.wr);
  return det;
});
assert.deepEqual(
  d.leaderboard.map((r) => [r.simplified, r.time]),
  expected.board,
  "leaderboard = every player's PR, fastest first"
);
assert.equal(d.wr.simplified, expected.wrHolder);
assert.deepEqual(d.wr.splits, expected.wrSplits, "WR splits are the record run's checkpoints");
assert.ok(d.perfect && d.perfect.complete, "perfect run computed");
assert.equal(d.perfect.time, expected.perfect, "best possible time = sum of best splits");
assert.ok(d.perfect.time <= d.wr.time, "perfect run never slower than the WR");

// 3. Player page: PR + finish/attempt tallies for Nova (3 finishes in phase A,
//    still 3 in B; starts accumulate from the per-report attempts field).
const nova = d.leaderboard.find((r) => r.simplified === "Nova");
const pd = await get(`/players/${nova.playerId}`);
assert.equal(pd.records.rows.length, 1, "one PR per map on the player page");
assert.equal(pd.records.rows[0].time, 48000, "Nova's PR");
assert.equal(pd.finishes, 3, "Nova's finish count");
assert.equal(pd.attempts, expected.novaAttempts, "Nova's total attempts (race starts)");
assert.equal(pd.records.rows[0].attempts, expected.novaAttempts, "per-map attempts on the profile");

// 3b. Wave's total includes the standalone (finish-less) attempt flush.
const wave = d.leaderboard.find((r) => r.simplified === "Wave");
const wd = await get(`/players/${wave.playerId}`);
assert.equal(wd.attempts, expected.waveAttempts, "Wave's attempts include the standalone flush");

// 4. Colour codes survive to the API for rendering (name vs simplified).
assert.ok(nova.name.includes("^"), "raw colour-coded name preserved");

console.log(`assert.mjs: ${phase} OK`);
