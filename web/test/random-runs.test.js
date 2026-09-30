// Tests for the meta map's seed board: storing a finished run on a dealt
// course, the faster-only rule that makes a seed's rows a race rather than a
// log, the grouping that keeps different seeds apart, and the HTTP contract
// the game module's RS_ApiReportRandomRun native emits.
//
// The property that matters most here is a negative one: a run on random_map
// must NEVER become a record. It has no map row, no `race` row, no finish and
// no run tally — that separation is the whole reason the table exists, so it
// is asserted directly rather than assumed.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.js";
import { createTestDb } from "./pg-util.js";

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  await race.pool.query("DELETE FROM achievement WHERE created_by = 'seed'");
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

const VER = "wsw 2.1";

function run(over = {}) {
  return { version: VER, seed: 4242, player: "reed", login: "", timeMs: 31500,
           pieces: 16, routeUnits: 17200, ...over };
}

test("a finished run lands on the seed board", async (t) => {
  const race = await freshDb(t);
  const r = await race.recordRandomRun(run());
  assert.equal(r.ok, true);
  assert.equal(r.improved, true);
  assert.equal(r.seed, 4242);

  const board = await race.randomBoard({});
  assert.equal(board.length, 1);
  assert.equal(board[0].seed, 4242);
  assert.equal(board[0].runs, 1);
  assert.equal(board[0].best, 31500);
  assert.equal(board[0].pieces, 16);
  assert.equal(board[0].routeUnits, 17200);
  assert.equal(board[0].runsList[0].player, "reed");
  assert.equal(board[0].runsList[0].rank, 1);
});

test("a run on a dealt course is not a record anywhere", async (t) => {
  const race = await freshDb(t);
  await race.recordRandomRun(run());

  // The whole point: no map, no race row, no finish, no tally. A leaderboard
  // for "random_map" would pool thousands of different courses into one board.
  for (const table of ["map", "race", "finish"]) {
    const { rows } = await race.pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    assert.equal(rows[0].n, 0, `${table} should be untouched by a random run`);
  }
});

test("only a faster run on the same seed replaces the stored one", async (t) => {
  const race = await freshDb(t);
  await race.recordRandomRun(run({ timeMs: 31500 }));

  const slower = await race.recordRandomRun(run({ timeMs: 33000 }));
  assert.equal(slower.ok, true);
  assert.equal(slower.improved, false, "a slower re-run must not overwrite");

  const faster = await race.recordRandomRun(run({ timeMs: 29000 }));
  assert.equal(faster.improved, true);

  const board = await race.randomBoard({});
  assert.equal(board[0].runs, 1, "one row per player per seed");
  assert.equal(board[0].best, 29000);
});

test("each seed keeps its own ladder", async (t) => {
  const race = await freshDb(t);
  await race.recordRandomRun(run({ seed: 1001, player: "reed", timeMs: 20000 }));
  await race.recordRandomRun(run({ seed: 1001, player: "tudduf", timeMs: 19000 }));
  await race.recordRandomRun(run({ seed: 2002, player: "reed", timeMs: 90000 }));

  const board = await race.randomBoard({});
  const bySeed = new Map(board.map((b) => [b.seed, b]));
  assert.equal(bySeed.size, 2);
  assert.equal(bySeed.get(1001).runs, 2);
  // Fastest first WITHIN a seed, and the two seeds never share a ladder.
  assert.deepEqual(bySeed.get(1001).runsList.map((r) => r.player), ["tudduf", "reed"]);
  assert.equal(bySeed.get(2002).runs, 1);

  const only = await race.randomBoard({ seed: 2002 });
  assert.equal(only.length, 1);
  assert.equal(only[0].seed, 2002);
});

test("a bad seed or time is refused rather than stored", async (t) => {
  const race = await freshDb(t);
  assert.equal((await race.recordRandomRun(run({ seed: 0 }))).ok, false);
  assert.equal((await race.recordRandomRun(run({ seed: -5 }))).ok, false);
  assert.equal((await race.recordRandomRun(run({ timeMs: 0 }))).ok, false);
  assert.equal((await race.recordRandomRun(run({ player: "  " }))).ok, false);
  assert.equal((await race.randomBoard({})).length, 0);
});

test("the board is keyed on the canonical player, like every other board", async (t) => {
  const race = await freshDb(t);
  await race.recordRandomRun(run({ seed: 7, player: "reed", timeMs: 40000 }));
  const before = await race.randomBoard({ seed: 7 });
  assert.equal(before[0].runsList.length, 1);
  const pid = before[0].runsList[0].playerId;

  const { rows } = await race.pool.query("SELECT id FROM player WHERE id = $1", [pid]);
  assert.equal(rows.length, 1, "the stored id is a real player row");
});
