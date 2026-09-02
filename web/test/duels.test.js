// Tests for 1v1 duels: storing a concluded match-up, reading it back onto a
// profile from either side of the pair, the alias grouping that has to survive
// a canonical rebuild, and the HTTP contract the game module's RS_ApiReportDuel
// native emits.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js), so
// tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, DUEL_REASONS } from "../db.js";
import { createTestDb } from "./pg-util.js";

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  // The achievements seed migration ships starter definitions whose evaluator
  // fires on ingest; nothing here needs them and they only slow the tests.
  await race.pool.query("DELETE FROM achievement WHERE created_by = 'seed'");
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

const VER = "wsw 2.1";

function duel(over = {}) {
  return {
    version: VER,
    map: "coldrun",
    a: { name: "reed", login: "", time: 34109, finishes: 12 },
    b: { name: "tudduf", login: "", time: 34812, finishes: 9 },
    winner: "a",
    reason: "map_change",
    duration: 842,
    ...over,
  };
}

async function playerIdByName(race, name) {
  const r = await race.one("SELECT id, canonical_id FROM player WHERE name = $1", [name]);
  return r ? Number(r.canonical_id ?? r.id) : null;
}

test("a concluded duel lands on both profiles, from each player's own side", async (t) => {
  const race = await freshDb(t);
  const r = await race.recordDuel(duel());
  assert.equal(r.ok, true);
  assert.equal(r.mapCreated, true);

  const reedId = await playerIdByName(race, "reed");
  const tudId = await playerIdByName(race, "tudduf");

  const reed = await race.playerDuels(reedId);
  assert.deepEqual(reed.record, { played: 1, wins: 1, losses: 0, draws: 0 });
  assert.equal(reed.duels.length, 1);
  assert.equal(reed.duels[0].result, "win");
  assert.equal(reed.duels[0].you.time, 34109);
  assert.equal(reed.duels[0].them.time, 34812);
  assert.equal(reed.duels[0].them.id, tudId);
  assert.equal(reed.duels[0].mapName, "coldrun");
  assert.equal(reed.duels[0].you.finishes, 12);

  // The SAME row, read from the loser's profile, is rewritten so "you" is them.
  const tud = await race.playerDuels(tudId);
  assert.deepEqual(tud.record, { played: 1, wins: 0, losses: 1, draws: 0 });
  assert.equal(tud.duels[0].result, "loss");
  assert.equal(tud.duels[0].you.time, 34812);
  assert.equal(tud.duels[0].them.time, 34109);
  assert.equal(tud.duels[0].them.id, reedId);
  assert.equal(tud.duels[0].you.finishes, 9);
});

test("a player who never finished is stored as no time, not as zero", async (t) => {
  const race = await freshDb(t);
  await race.recordDuel(
    duel({ b: { name: "tudduf", login: "", time: 0, finishes: 0 }, winner: "a" })
  );
  const tudId = await playerIdByName(race, "tudduf");
  const tud = await race.playerDuels(tudId);
  assert.equal(tud.duels[0].you.time, null);
  assert.equal(tud.duels[0].result, "loss");

  // Stored as SQL NULL: a 0 would sort as the fastest run ever recorded.
  const row = await race.one("SELECT time_b FROM duel LIMIT 1");
  assert.equal(row.time_b, null);
});

test("a forfeit is a loss even when the forfeiter was faster", async (t) => {
  const race = await freshDb(t);
  // reed holds the better time but conceded, so the game reports b as winner.
  await race.recordDuel(duel({ winner: "b", reason: "forfeit" }));
  const reedId = await playerIdByName(race, "reed");
  const reed = await race.playerDuels(reedId);
  assert.equal(reed.duels[0].result, "loss");
  assert.equal(reed.duels[0].you.time, 34109);
  assert.equal(reed.duels[0].them.time, 34812);
  assert.equal(reed.duels[0].reason, "forfeit");
  assert.deepEqual(reed.record, { played: 1, wins: 0, losses: 1, draws: 0 });
});

test("an unrecognised winner or reason degrades rather than failing", async (t) => {
  const race = await freshDb(t);
  await race.recordDuel(duel({ winner: "nobody", reason: "asteroid strike" }));
  const reedId = await playerIdByName(race, "reed");
  const reed = await race.playerDuels(reedId);
  assert.equal(reed.duels[0].result, "draw");
  assert.equal(reed.duels[0].reason, "map_change");
  assert.deepEqual(reed.record, { played: 1, wins: 0, losses: 0, draws: 1 });
  assert.ok(DUEL_REASONS.includes(reed.duels[0].reason));
});

test("equal times reported as a draw count as a draw for both", async (t) => {
  const race = await freshDb(t);
  await race.recordDuel(
    duel({ b: { name: "tudduf", login: "", time: 34109, finishes: 4 }, winner: "draw" })
  );
  for (const nick of ["reed", "tudduf"]) {
    const d = await race.playerDuels(await playerIdByName(race, nick));
    assert.equal(d.duels[0].result, "draw");
    assert.deepEqual(d.record, { played: 1, wins: 0, losses: 0, draws: 1 });
  }
});

test("two nicks that are the same person are refused, not stored", async (t) => {
  const race = await freshDb(t);
  // Same nick on both sides resolves to one canonical player.
  const r = await race.recordDuel(
    duel({ b: { name: "reed", login: "", time: 35000, finishes: 3 } })
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /same player/);
  const n = await race.one("SELECT COUNT(*)::int AS n FROM duel");
  assert.equal(n.n, 0);
});

test("a map name the charset gate refuses never mints a row", async (t) => {
  const race = await freshDb(t);
  const r = await race.recordDuel(duel({ map: "../etc/passwd" }));
  assert.equal(r.ok, false);
  const n = await race.one("SELECT COUNT(*)::int AS n FROM duel");
  assert.equal(n.n, 0);
});

test("a reverse duel is stored against the reversed map, like a reverse finish", async (t) => {
  const race = await freshDb(t);
  await race.recordDuel(duel({ map: "coldrun-reversed" }));
  const reedId = await playerIdByName(race, "reed");
  const reed = await race.playerDuels(reedId);
  assert.equal(reed.duels[0].mapName, "coldrun-reversed");
});

test("the record counts every duel while the card shows only the newest few", async (t) => {
  const race = await freshDb(t);
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 9; i++) {
    await race.recordDuel(
      duel({
        map: "coldrun",
        b: { name: "opp" + i, login: "", time: 40000 + i, finishes: 1 },
        winner: i < 6 ? "a" : "b",
        createdAt: now - (9 - i) * 60,
      })
    );
  }
  const reedId = await playerIdByName(race, "reed");
  const reed = await race.playerDuels(reedId, { limit: 4 });
  assert.deepEqual(reed.record, { played: 9, wins: 6, losses: 3, draws: 0 });
  assert.equal(reed.duels.length, 4);
  // Newest first: the last one written is opp8.
  assert.equal(reed.duels[0].them.name, "opp8");
  assert.ok(reed.duels[0].at >= reed.duels[1].at);
});

test("a duel found under an alias still shows on the canonical profile", async (t) => {
  const race = await freshDb(t);
  // Two finishes under the same simplified nick with different colour codes put
  // both player rows into one canonical group.
  await race.ingest({
    version: VER,
    map: "coldrun",
    source: "racelog",
    records: [
      { name: "reed", login: "", time: 40000, checkpoints: [] },
      { name: "^1reed", login: "", time: 39000, checkpoints: [] },
    ],
  });
  const variants = await race.all("SELECT id, canonical_id FROM player WHERE simplified = 'reed'");
  assert.ok(variants.length >= 2, "expected an alias group");
  const canonId = Number(variants[0].canonical_id);

  // The duel is reported under the COLOURED variant...
  await race.recordDuel(duel({ a: { name: "^1reed", login: "", time: 34109, finishes: 5 } }));

  // ...and is visible from the canonical profile and from every variant id.
  for (const v of variants) {
    const d = await race.playerDuels(Number(v.id));
    assert.equal(d.record.played, 1, `variant ${v.id} should see the duel`);
    assert.equal(d.duels[0].result, "win");
  }
  const canon = await race.playerDuels(canonId);
  assert.equal(canon.record.played, 1);
});

test("the profile payload carries the duels card", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: "coldrun",
    source: "racelog",
    records: [{ name: "reed", login: "", time: 40000, checkpoints: [] }],
  });
  await race.recordDuel(duel());
  const reedId = await playerIdByName(race, "reed");
  const detail = await race.playerDetail(reedId, { limit: 1 });
  assert.ok(detail.duels, "playerDetail should include duels");
  assert.deepEqual(detail.duels.record, { played: 1, wins: 1, losses: 0, draws: 0 });
  assert.equal(detail.duels.duels[0].them.name, "tudduf");
});

test("a player with no duels gets an empty record, not a missing one", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: "coldrun",
    source: "racelog",
    records: [{ name: "lonely", login: "", time: 40000, checkpoints: [] }],
  });
  const id = await playerIdByName(race, "lonely");
  const d = await race.playerDuels(id);
  assert.deepEqual(d.record, { played: 0, wins: 0, losses: 0, draws: 0 });
  assert.deepEqual(d.duels, []);
});
