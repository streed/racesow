// Unit tests for the data-access layer: ingest semantics (attempts, PRs,
// records), canonical identity grouping, and the queries that power the site
// (map leaderboard for all players, WR splits, perfect run, player PRs).
//
// Every test opens a fresh SQLite file (openDatabase bootstraps the base
// schema), so tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, simplifyName, normToken, canonKey, sha256 } from "../db.js";

function freshDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "racedb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return openDatabase(path.join(dir, "db.sqlite"));
}

// One finish as reported by the game module (racelog.as -> RS_ApiReportRace):
// absolute checkpoint ms in spatial order, 0 = checkpoint not passed.
function finish(name, time, checkpoints = [], login = "") {
  return { name, login, time, checkpoints };
}

const MAP = "e2m2";
const VER = "wsw 2.1";

test("name helpers strip colours and collision suffixes", () => {
  assert.equal(simplifyName("^8EL^9chupa^7"), "ELchupa");
  assert.equal(normToken("ELchupa(1)"), "elchupa");
  assert.equal(canonKey("^8EL^9chupa^7", ""), canonKey("ELchupa(1)", ""));
  assert.equal(canonKey("Player", "elchupa"), "elchupa"); // login wins over nick
});

test("openDatabase bootstraps a usable schema on an empty file", (t) => {
  const race = freshDb(t);
  const o = race.overview();
  assert.equal(o.totals.records, 0);
  assert.equal(o.totals.finishes, 0);
  assert.deepEqual(race.maps().rows, []);
});

test("a later racelog nick cannot seize an existing canonical group (identity hijack)", (t) => {
  const race = freshDb(t);
  // Victim establishes the group under login 'vic'.
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Victim", 50000, [], "vic")] });
  const victimId = race.db.prepare("SELECT id FROM player WHERE name = 'Victim'").get().id;
  const key = canonKey(simplifyName("Victim"), "vic");
  assert.equal(race.db.prepare("SELECT player_id FROM canonical WHERE key = ?").get(key).player_id, victimId);

  // Attacker submits a NEW nick under the victim's login with a faster time.
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("PWNED_BY_ATTACKER", 40000, [], "vic")] });
  race.refreshAggregates();

  // The group representative (display identity) must NOT move to the attacker's
  // freshly-created row: the whole leaderboard footprint stays "Victim".
  assert.equal(race.db.prepare("SELECT player_id FROM canonical WHERE key = ?").get(key).player_id, victimId);
  const mapId = race.db.prepare("SELECT id FROM map WHERE name = ?").get(MAP).id;
  assert.equal(race.mapDetail(mapId).leaderboard[0].name, "Victim");
});

test("inherited Object.prototype sort keys fall back to default, never error", (t) => {
  const race = freshDb(t);
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000)] });
  race.refreshAggregates();
  for (const sort of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.doesNotThrow(() => race.maps({ sort }), `maps sort=${sort}`);
    assert.doesNotThrow(() => race.players({ sort }), `players sort=${sort}`);
    assert.doesNotThrow(() => race.playerDetail(1, { sort }), `playerDetail sort=${sort}`);
  }
  // A valid default result still comes back.
  assert.equal(race.maps({ sort: "constructor" }).rows.length, 1);
});

test("every finish counts as an attempt; only the best is kept as the PR", (t) => {
  const race = freshDb(t);

  // Three finishes by the same player: 52s, then a PR at 48s, then a slower 50s.
  let c = race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 52000, [11000, 30000])] });
  assert.deepEqual(c, { inserted: 1, improved: 0, unchanged: 0 });
  c = race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 48000, [10000, 28000])] });
  assert.deepEqual(c, { inserted: 0, improved: 1, unchanged: 0 });
  c = race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000, [10500, 29000])] });
  assert.deepEqual(c, { inserted: 0, improved: 0, unchanged: 1 });

  // Attempts: all three finishes tallied.
  const tally = race.db.prepare("SELECT SUM(finishes) f FROM run_tally").get();
  assert.equal(tally.f, 3);

  // PR: exactly one race row per player/map/version, holding the best time.
  const rows = race.db.prepare("SELECT time FROM race").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, 48000);

  // The PR's checkpoints replaced the old run's.
  const cps = race.db.prepare("SELECT number, time FROM checkpoint ORDER BY number").all();
  assert.deepEqual(cps, [{ number: 0, time: 10000 }, { number: 1, time: 28000 }]);
});

test("an improved PR gets a strictly higher race id (announcer contract)", (t) => {
  const race = freshDb(t);
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 52000)] });
  const id1 = race.db.prepare("SELECT id FROM race").get().id;
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 48000)] });
  const id2 = race.db.prepare("SELECT id FROM race").get().id;
  assert.ok(id2 > id1, `expected ${id2} > ${id1}`);
});

test("topscores source backfills bests without inflating the attempt tally", (t) => {
  const race = freshDb(t);
  race.ingest({ version: VER, map: MAP, source: "topscores", records: [finish("Nova", 52000)] });
  race.ingest({ version: VER, map: MAP, source: "topscores", records: [finish("Nova", 52000)] });
  const tally = race.db.prepare("SELECT COALESCE(SUM(finishes),0) f FROM run_tally").get();
  assert.equal(tally.f, 0);
  assert.equal(race.db.prepare("SELECT COUNT(*) c FROM race").get().c, 1);
});

test("colour/spelling variants of one player collapse to one canonical identity", (t) => {
  const race = freshDb(t);
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("^8EL^9chupa^7", 50000)] });
  race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("ELchupa(1)", 49000)] });
  race.refreshAggregates();

  // Two player rows, one canonical group, one leaderboard entry at the best time.
  assert.equal(race.db.prepare("SELECT COUNT(*) c FROM player").get().c, 2);
  assert.equal(race.db.prepare("SELECT COUNT(DISTINCT canonical_id) c FROM player").get().c, 1);
  const mapId = race.db.prepare("SELECT id FROM map WHERE name = ?").get(MAP).id;
  const detail = race.mapDetail(mapId);
  assert.equal(detail.leaderboard.length, 1);
  assert.equal(detail.leaderboard[0].time, 49000);
});

test("map detail lists a PR for EVERY player, with WR splits and rank order", (t) => {
  const race = freshDb(t);
  // 60 players — more than the map page's old top-100/others' top-50 cuts would
  // reveal bugs at, and enough to prove no silent truncation at default limits.
  const records = [];
  for (let i = 0; i < 60; i++) records.push(finish(`racer${i}`, 40000 + i * 250, [9000 + i * 50, 25000 + i * 100]));
  race.ingest({ version: VER, map: MAP, source: "racelog", records });
  race.refreshAggregates();

  const mapId = race.db.prepare("SELECT id FROM map WHERE name = ?").get(MAP).id;
  const detail = race.mapDetail(mapId, { limit: 10000 });
  assert.equal(detail.leaderboard.length, 60);
  assert.equal(detail.players, 60);
  // Fastest first, positions dense.
  assert.equal(detail.leaderboard[0].name, "racer0");
  assert.equal(detail.leaderboard[0].pos, 1);
  assert.equal(detail.leaderboard[59].pos, 60);
  // WR belongs to racer0 with its absolute splits.
  assert.equal(detail.wr.time, 40000);
  assert.deepEqual(detail.wr.splits, [9000, 25000]);
});

test("perfect run is the sum of best segments across different players", (t) => {
  const race = freshDb(t);
  // Segments (start->cp1, cp1->cp2, cp2->finish):
  //   A: 10000, 15000, 20000  (45s total, WR)
  //   B: 12000,  9000, 25000  (46s total, but owns the middle segment)
  race.ingest({
    version: VER,
    map: MAP,
    source: "racelog",
    records: [finish("A", 45000, [10000, 25000]), finish("B", 46000, [12000, 21000])],
  });
  race.refreshAggregates();

  const mapId = race.db.prepare("SELECT id FROM map WHERE name = ?").get(MAP).id;
  const detail = race.mapDetail(mapId, { limit: 100 });
  const p = detail.perfect;
  assert.ok(p && p.complete);
  assert.deepEqual(p.segments.map((s) => s.delta), [10000, 9000, 20000]);
  assert.deepEqual(p.segments.map((s) => s.simplified), ["A", "B", "A"]);
  assert.equal(p.time, 39000);
  assert.equal(p.savingVsWr, 45000 - 39000);
});

test("perfect run skips unpassed checkpoints (time 0) instead of inventing segments", (t) => {
  const race = freshDb(t);
  // B missed cp1 (0): B may only contribute the final segment (cp2->finish,
  // 19500 — the best), never start->cp2 as a bogus "cp1->cp2".
  race.ingest({
    version: VER,
    map: MAP,
    source: "racelog",
    records: [finish("A", 45000, [10000, 25000]), finish("B", 43500, [0, 24000])],
  });
  race.refreshAggregates();
  const mapId = race.db.prepare("SELECT id FROM map WHERE name = ?").get(MAP).id;
  const p = race.mapDetail(mapId).perfect;
  assert.ok(p.complete);
  assert.deepEqual(p.segments.map((s) => s.delta), [10000, 15000, 19500]);
  assert.deepEqual(p.segments.map((s) => s.simplified), ["A", "A", "B"]);
});

test("player detail returns the player's PRs across maps plus attempt count", (t) => {
  const race = freshDb(t);
  race.ingest({ version: VER, map: "map_a", source: "racelog", records: [finish("Nova", 52000)] });
  race.ingest({ version: VER, map: "map_a", source: "racelog", records: [finish("Nova", 48000)] });
  race.ingest({ version: VER, map: "map_b", source: "racelog", records: [finish("Nova", 61000)] });
  race.refreshAggregates();

  const pid = race.db.prepare("SELECT id FROM player").get().id;
  const d = race.playerDetail(pid);
  assert.equal(d.finishes, 3); // attempts (finished runs), not just bests
  assert.equal(d.records.total, 2); // one PR per map
  const byMap = Object.fromEntries(d.records.rows.map((r) => [r.map_name, r.time]));
  assert.deepEqual(byMap, { map_a: 48000, map_b: 61000 });
});

test("per-server enrollment: token hash lookup and provenance stamping", (t) => {
  const race = freshDb(t);
  const enrolled = race.enrollServer("eu#1", "secret-token");
  assert.ok(enrolled.id > 0);
  const found = race.serverByTokenHash(sha256("secret-token"));
  assert.equal(found.name, "eu#1");
  race.ingest({ version: VER, map: MAP, source: "racelog", serverId: enrolled.id, records: [finish("Nova", 50000)] });
  assert.equal(race.db.prepare("SELECT server_id FROM race").get().server_id, enrolled.id);
});
