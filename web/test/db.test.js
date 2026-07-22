// Unit tests for the data-access layer: ingest semantics (attempts, PRs,
// records), canonical identity grouping, and the queries that power the site
// (map leaderboard for all players, WR splits, perfect run, player PRs).
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js),
// so tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, simplifyName, normToken, identKey, canonKey, rebuildCanonical, sha256 } from "../db.js";
import { createTestDb } from "./pg-util.js";

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  // Single ordered teardown: close the pool, THEN drop (WITH FORCE would kill
  // live pool connections if it ran first).
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

// One finish as reported by the game module (racelog.as -> RS_ApiReportRace):
// absolute checkpoint ms in spatial order, 0 = checkpoint not passed.
function finish(name, time, checkpoints = [], login = "") {
  return { name, login, time, checkpoints };
}

const MAP = "e2m2";
const VER = "wsw 2.1";
const N = Number;

test("name helpers strip colours and collision suffixes", () => {
  assert.equal(simplifyName("^8EL^9chupa^7"), "ELchupa");
  assert.equal(normToken("ELchupa(1)"), "elchupa");
  // Identity grouping: colour-strip + lowercase + drop trailing (N), exact match.
  assert.equal(canonKey("^8EL^9chupa^7", ""), canonKey("ELchupa(1)", "")); // colour + (N) variants merge
  // Login is IGNORED for grouping (auth servers are gone): the nick alone keys
  // identity, so a historical login token never splits one person into rows.
  assert.equal(canonKey("Player", "elchupa"), "player");
  assert.equal(canonKey("Player", "elchupa"), canonKey("Player", "")); // login makes no difference
});

test("identity grouping is exact on punctuation/spacing (no over-merge)", () => {
  // The whole point of the rework: names that differ ONLY by the game's
  // colour codes or the (N) collision suffix merge; anything else stays apart.
  assert.equal(canonKey("^2Nova", ""), canonKey("Nova(3)", "")); // colour + (N) -> merge
  assert.notEqual(canonKey("Nova", ""), canonKey("Nova x", "")); // trailing word -> separate
  assert.notEqual(canonKey("nova", ""), canonKey("n.o.v.a", "")); // punctuation -> separate (used to MERGE)
  assert.notEqual(canonKey("ab", ""), canonKey("a b", "")); // space -> separate (used to MERGE)
  // Symbol-only nicks are distinct, not all collapsed into one "?empty?" group.
  assert.notEqual(canonKey("|||", ""), canonKey("___", ""));
  assert.notEqual(canonKey("|||", ""), "?empty?");
});

test("openDatabase bootstraps a usable schema on an empty database", async (t) => {
  const race = await freshDb(t);
  const o = await race.overview();
  assert.equal(o.totals.records, 0);
  assert.equal(o.totals.finishes, 0);
  assert.deepEqual((await race.maps()).rows, []);
});

test("a later racelog nick cannot seize an existing canonical group (identity hijack)", async (t) => {
  const race = await freshDb(t);
  // Victim establishes the group under the nick "Victim".
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Victim", 50000, [], "")] });
  const victimId = N((await race.one("SELECT id FROM player WHERE name = 'Victim'")).id);
  const key = canonKey(simplifyName("Victim"), "");
  assert.equal(N((await race.one("SELECT player_id FROM canonical WHERE key = $1", [key])).player_id), victimId);

  // Attacker submits a COLOUR VARIANT of the victim's nick (same identity key)
  // with a faster time. It JOINS the victim's group but must not seize it.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("^1Victim", 40000, [], "")] });
  await race.refreshAggregates();

  // The group representative (display identity) must NOT move to the attacker's
  // freshly-created row: the whole leaderboard footprint stays "Victim".
  assert.equal(N((await race.one("SELECT player_id FROM canonical WHERE key = $1", [key])).player_id), victimId);
  const mapId = N((await race.one("SELECT id FROM map WHERE name = $1", [MAP])).id);
  assert.equal((await race.mapDetail(mapId)).leaderboard[0].name, "Victim");
});

// The "sjn|gibbz" bug: one human who raced anonymously AND under old matchmaker
// logins used to split into several Hall-of-Fame rows because canonKey keyed on
// login. Identity now keys on the nick alone, so the login no longer matters.
const GIBBZ = "^0sjn^6|^7gi^6b^5b^7z^7"; // simplifies + identKeys to "sjn|gibbz"

test("distinct historical logins for one nick collapse into a single identity", async (t) => {
  const race = await freshDb(t);
  // Same nick finished on three maps under three different login states.
  await race.ingest({ version: VER, map: "m1", source: "racelog", records: [finish(GIBBZ, 50000, [], "")] });
  await race.ingest({ version: VER, map: "m2", source: "racelog", records: [finish(GIBBZ, 51000, [], "loginA")] });
  await race.ingest({ version: VER, map: "m3", source: "racelog", records: [finish(GIBBZ, 52000, [], "loginB")] });
  await race.refreshAggregates();

  // Three player rows (UNIQUE(name, login)) but ONE canonical group...
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM player WHERE simplified = 'sjn|gibbz'")).c), 3);
  assert.equal(N((await race.one("SELECT COUNT(DISTINCT canonical_id) c FROM player WHERE simplified = 'sjn|gibbz'")).c), 1);
  // ...so the Hall of Fame shows the player exactly once, across all three maps.
  const hof = (await race.overview()).hallOfFame.filter((r) => simplifyName(r.name) === "sjn|gibbz");
  assert.equal(hof.length, 1);
  assert.equal(N(hof[0].maps), 3);
});

test("rebuildCanonical regroups a legacy login-split identity by nick", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "m1", source: "racelog", records: [finish(GIBBZ, 50000, [], "")] });
  await race.ingest({ version: VER, map: "m2", source: "racelog", records: [finish(GIBBZ, 51000, [], "loginA")] });
  await race.ingest({ version: VER, map: "m3", source: "racelog", records: [finish(GIBBZ, 52000, [], "loginB")] });

  // Recreate the pre-migration state: each row its OWN login-keyed canonical
  // group (what canonKey used to produce), the exact shape the migration fixes.
  await race.pool.query("UPDATE player SET canonical_id = id WHERE simplified = 'sjn|gibbz'");
  await race.pool.query("DELETE FROM canonical");
  await race.pool.query(
    "INSERT INTO canonical (key, player_id) " +
    "SELECT login, id FROM player WHERE simplified = 'sjn|gibbz' AND login <> '' " +
    "UNION ALL SELECT 'sjn|gibbz', id FROM player WHERE simplified = 'sjn|gibbz' AND login = ''"
  );
  assert.equal(N((await race.one("SELECT COUNT(DISTINCT canonical_id) c FROM player WHERE simplified = 'sjn|gibbz'")).c), 3);

  // The regroup (same logic the SQL migration runs) collapses them into one.
  await rebuildCanonical(race.pool);
  await race.refreshAggregates();
  assert.equal(N((await race.one("SELECT COUNT(DISTINCT canonical_id) c FROM player WHERE simplified = 'sjn|gibbz'")).c), 1);
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM canonical WHERE key = 'sjn|gibbz'")).c), 1);
  const hof = (await race.overview()).hallOfFame.filter((r) => simplifyName(r.name) === "sjn|gibbz");
  assert.equal(hof.length, 1);
  assert.equal(N(hof[0].maps), 3);
});

test("inherited Object.prototype sort keys fall back to default, never error", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000)] });
  await race.refreshAggregates();
  for (const sort of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    await assert.doesNotReject(() => race.maps({ sort }), `maps sort=${sort}`);
    await assert.doesNotReject(() => race.players({ sort }), `players sort=${sort}`);
    await assert.doesNotReject(() => race.playerDetail(1, { sort }), `playerDetail sort=${sort}`);
  }
  // A valid default result still comes back.
  assert.equal((await race.maps({ sort: "constructor" })).rows.length, 1);
});

test("skill rating (SR) rewards closeness to the WR over breadth of maps", async (t) => {
  const race = await freshDb(t);

  // One well-contested map: Ace sets the WR, Slow finishes twice as slow.
  const field = [finish("Ace", 30000), finish("Slow", 60000)];
  for (let i = 0; i < 10; i++) field.push(finish(`pack${i}`, 45000 + i * 500));
  await race.ingest({ version: VER, map: "arena", source: "racelog", records: field });

  // A breadth player who is mediocre on many small maps: never near a WR, but
  // racks up Points by placing in the top-15 of lots of sparse leaderboards.
  for (let m = 0; m < 12; m++) {
    await race.ingest({
      version: VER,
      map: `filler${m}`,
      source: "racelog",
      records: [finish("Leader", 20000), finish("Breadth", 40000)],
    });
  }
  await race.refreshAggregates();

  const byName = new Map(
    (await race.players({ sort: "sr", limit: 200 })).rows.map((r) => [r.simplified, r])
  );
  const ace = byName.get("Ace");
  const slow = byName.get("Slow");
  const breadth = byName.get("Breadth");

  // SR is present, integer, and bounded to the 0–1000 scale.
  for (const p of [ace, slow, breadth]) {
    assert.ok(Number.isInteger(p.sr), `${p.name} sr is an integer`);
    assert.ok(p.sr >= 0 && p.sr <= 1000, `${p.name} sr in range`);
  }

  // The WR holder outranks the twice-as-slow racer on the SAME field.
  assert.ok(ace.sr > slow.sr, `Ace SR ${ace.sr} > Slow SR ${slow.sr}`);

  // Breadth beats Ace on POINTS (12 second-places worth of top-15 bonuses beat
  // one WR) but NOT on SR — being consistently half-speed can't out-skill a WR.
  assert.ok(breadth.points > ace.points, `Breadth points ${breadth.points} > Ace points ${ace.points}`);
  assert.ok(ace.sr > breadth.sr, `Ace SR ${ace.sr} > Breadth SR ${breadth.sr}`);

  // sort=sr actually orders the board by SR descending.
  const board = (await race.players({ sort: "sr", limit: 200 })).rows.map((r) => r.sr);
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1] >= board[i], "players sorted by SR desc");
});

test("every finish counts as an attempt; only the best is kept as the PR", async (t) => {
  const race = await freshDb(t);

  // Three finishes by the same player: 52s, then a PR at 48s, then a slower 50s.
  let c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 52000, [11000, 30000])] });
  assert.deepEqual(c, { inserted: 1, improved: 0, unchanged: 0 });
  c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 48000, [10000, 28000])] });
  assert.deepEqual(c, { inserted: 0, improved: 1, unchanged: 0 });
  c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000, [10500, 29000])] });
  assert.deepEqual(c, { inserted: 0, improved: 0, unchanged: 1 });

  // Attempts: all three finishes tallied.
  assert.equal(N((await race.one("SELECT SUM(finishes) f FROM run_tally")).f), 3);

  // PR: exactly one race row per player/map/version, holding the best time.
  const rows = await race.all("SELECT time FROM race");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, 48000);

  // The PR's checkpoints replaced the old run's.
  const cps = await race.all("SELECT number, time FROM checkpoint ORDER BY number");
  assert.deepEqual(cps, [{ number: 0, time: 10000 }, { number: 1, time: 28000 }]);
});

test("an improved PR gets a strictly higher race id (announcer contract)", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 52000)] });
  const id1 = N((await race.one("SELECT id FROM race")).id);
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 48000)] });
  const id2 = N((await race.one("SELECT id FROM race")).id);
  assert.ok(id2 > id1, `expected ${id2} > ${id1}`);
});

test("topscores source backfills bests without inflating the attempt tally", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: MAP, source: "topscores", records: [finish("Nova", 52000)] });
  await race.ingest({ version: VER, map: MAP, source: "topscores", records: [finish("Nova", 52000)] });
  assert.equal(N((await race.one("SELECT COALESCE(SUM(finishes),0) f FROM run_tally")).f), 0);
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM race")).c), 1);
});

test("colour/spelling variants of one player collapse to one canonical identity", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("^8EL^9chupa^7", 50000)] });
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("ELchupa(1)", 49000)] });
  await race.refreshAggregates();

  // Two player rows, one canonical group, one leaderboard entry at the best time.
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM player")).c), 2);
  assert.equal(N((await race.one("SELECT COUNT(DISTINCT canonical_id) c FROM player")).c), 1);
  const mapId = N((await race.one("SELECT id FROM map WHERE name = $1", [MAP])).id);
  const detail = await race.mapDetail(mapId);
  assert.equal(detail.leaderboard.length, 1);
  assert.equal(detail.leaderboard[0].time, 49000);
});

test("map detail lists a PR for EVERY player, with WR splits and rank order", async (t) => {
  const race = await freshDb(t);
  const records = [];
  for (let i = 0; i < 60; i++) records.push(finish(`racer${i}`, 40000 + i * 250, [9000 + i * 50, 25000 + i * 100]));
  await race.ingest({ version: VER, map: MAP, source: "racelog", records });
  await race.refreshAggregates();

  const mapId = N((await race.one("SELECT id FROM map WHERE name = $1", [MAP])).id);
  const detail = await race.mapDetail(mapId, { limit: 10000 });
  assert.equal(detail.leaderboard.length, 60);
  assert.equal(detail.players, 60);
  assert.equal(detail.leaderboard[0].name, "racer0");
  assert.equal(detail.leaderboard[0].pos, 1);
  assert.equal(detail.leaderboard[59].pos, 60);
  assert.equal(detail.wr.time, 40000);
  assert.deepEqual(detail.wr.splits, [9000, 25000]);
});

test("perfect run is the sum of best segments across different players", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: MAP,
    source: "racelog",
    records: [finish("A", 45000, [10000, 25000]), finish("B", 46000, [12000, 21000])],
  });
  await race.refreshAggregates();

  const mapId = N((await race.one("SELECT id FROM map WHERE name = $1", [MAP])).id);
  const detail = await race.mapDetail(mapId, { limit: 100 });
  const p = detail.perfect;
  assert.ok(p && p.complete);
  assert.deepEqual(p.segments.map((s) => s.delta), [10000, 9000, 20000]);
  assert.deepEqual(p.segments.map((s) => s.simplified), ["A", "B", "A"]);
  assert.equal(p.time, 39000);
  assert.equal(p.savingVsWr, 45000 - 39000);
});

test("perfect run skips unpassed checkpoints (time 0) instead of inventing segments", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: MAP,
    source: "racelog",
    records: [finish("A", 45000, [10000, 25000]), finish("B", 43500, [0, 24000])],
  });
  await race.refreshAggregates();
  const mapId = N((await race.one("SELECT id FROM map WHERE name = $1", [MAP])).id);
  const p = (await race.mapDetail(mapId)).perfect;
  assert.ok(p.complete);
  assert.deepEqual(p.segments.map((s) => s.delta), [10000, 15000, 19500]);
  assert.deepEqual(p.segments.map((s) => s.simplified), ["A", "A", "B"]);
});

test("player detail returns the player's PRs across maps plus attempt count", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "map_a", source: "racelog", records: [finish("Nova", 52000)] });
  await race.ingest({ version: VER, map: "map_a", source: "racelog", records: [finish("Nova", 48000)] });
  await race.ingest({ version: VER, map: "map_b", source: "racelog", records: [finish("Nova", 61000)] });
  await race.refreshAggregates();

  const pid = N((await race.one("SELECT id FROM player LIMIT 1")).id);
  const d = await race.playerDetail(pid);
  assert.equal(d.finishes, 3); // finished runs, not just bests
  assert.equal(d.records.total, 2); // one PR per map
  const byMap = Object.fromEntries(d.records.rows.map((r) => [r.map_name, r.time]));
  assert.deepEqual(byMap, { map_a: 48000, map_b: 61000 });
});

test("player detail exposes game version per record and filters by map + version", async (t) => {
  const race = await freshDb(t);
  // Nova sets PRs on three maps across two game versions.
  await race.ingest({ version: "wsw 2.1", map: "alpha", source: "racelog", records: [finish("Nova", 50000)] });
  await race.ingest({ version: "wsw 2.1", map: "beta", source: "racelog", records: [finish("Nova", 51000)] });
  await race.ingest({ version: "wsw 1.6", map: "gamma", source: "racelog", records: [finish("Nova", 52000)] });
  await race.refreshAggregates();
  const pid = N((await race.one("SELECT id FROM player LIMIT 1")).id);

  // Every record carries the game version of the best run.
  const all = await race.playerDetail(pid, { sort: "map", order: "asc" });
  assert.equal(all.records.total, 3);
  assert.deepEqual(
    Object.fromEntries(all.records.rows.map((r) => [r.map_name, r.versionName])),
    { alpha: "wsw 2.1", beta: "wsw 2.1", gamma: "wsw 1.6" }
  );

  // Version list for the filter dropdown: counts, most-common first.
  assert.deepEqual(all.versions.map((v) => `${v.name}:${v.count}`).sort(), ["wsw 1.6:1", "wsw 2.1:2"]);

  // Map-name search narrows both rows and total.
  const q = await race.playerDetail(pid, { q: "amm" }); // substring of "gamma"
  assert.equal(q.records.total, 1);
  assert.equal(q.records.rows[0].map_name, "gamma");

  // Version filter keeps only that version's records.
  const v21 = all.versions.find((v) => v.name === "wsw 2.1").id;
  const filtered = await race.playerDetail(pid, { version: v21 });
  assert.equal(filtered.records.total, 2);
  assert.ok(filtered.records.rows.every((r) => r.versionName === "wsw 2.1"));

  // Combined map search + version filter.
  const combo = await race.playerDetail(pid, { q: "alp", version: v21 });
  assert.equal(combo.records.total, 1);
  assert.equal(combo.records.rows[0].map_name, "alpha");
});

test("per-server enrollment: token hash lookup and provenance stamping", async (t) => {
  const race = await freshDb(t);
  const enrolled = await race.enrollServer("eu#1", "secret-token");
  assert.ok(enrolled.id > 0);
  const found = await race.serverByTokenHash(sha256("secret-token"));
  assert.equal(found.name, "eu#1");
  await race.ingest({ version: VER, map: MAP, source: "racelog", serverId: enrolled.id, records: [finish("Nova", 50000)] });
  assert.equal(N((await race.one("SELECT server_id FROM race")).server_id), enrolled.id);
});

test("concurrent ingests of the same NEW map/player/version do not collide", async (t) => {
  const race = await freshDb(t);
  // 8 servers report DIFFERENT players finishing the SAME brand-new map at
  // the same instant: every batch must create the map/version once and land
  // its own player+race — a SELECT-then-INSERT race would 500 all but one.
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      race.ingest({
        version: VER,
        map: "brandnew",
        source: "racelog",
        serverId: null,
        records: [finish(`racer${i}`, 40000 + i * 100)],
      })
    )
  );
  for (const c of results) assert.deepEqual(c, { inserted: 1, improved: 0, unchanged: 0 });
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM map WHERE name='brandnew'")).c), 1);
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM race")).c), 8);
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM player")).c), 8);

  // And the same player improving from many servers at once stays single-row.
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      race.ingest({ version: VER, map: "brandnew", source: "racelog", records: [finish("racer0", 39000 - i * 100)] })
    )
  );
  assert.equal(N((await race.one("SELECT COUNT(*) c FROM race WHERE player_id=(SELECT id FROM player WHERE name='racer0')")).c), 1);
});

test("?sort=map orders player records case-insensitively (no alias-in-function error)", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "Zeta", source: "racelog", records: [finish("Nova", 50000)] });
  await race.ingest({ version: VER, map: "alpha", source: "racelog", records: [finish("Nova", 40000)] });
  await race.ingest({ version: VER, map: "Beta", source: "racelog", records: [finish("Nova", 45000)] });
  await race.refreshAggregates();
  const pid = N((await race.one("SELECT id FROM player WHERE name='Nova'")).id);
  const d = await race.playerDetail(pid, { sort: "map", order: "asc" });
  assert.deepEqual(d.records.rows.map((r) => r.map_name), ["alpha", "Beta", "Zeta"]);
});

test("trigram search: exact beats prefix beats substring beats fuzzy", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: "coldrun",
    source: "racelog",
    records: [finish("^8EL^9chupa^7", 50000), finish("chup", 51000), finish("SuperChupacabra", 52000)],
  });
  await race.ingest({ version: VER, map: "coldrun2", source: "racelog", records: [finish("chup", 40000)] });
  await race.refreshAggregates();

  // Exact map name first even though the other has more records is moot here;
  // prefix/substring ordering on maps:
  const maps = (await race.search("coldrun")).maps.map((m) => m.name);
  assert.equal(maps[0], "coldrun"); // exact above prefix match coldrun2
  assert.ok(maps.includes("coldrun2"));

  // Player tiers: exact "chup" > substring ELchupa > SuperChupacabra.
  const players = (await race.search("chup")).players.map((p) => p.simplified);
  assert.equal(players[0], "chup");
  assert.ok(players.includes("ELchupa"));
  assert.ok(players.includes("SuperChupacabra"));

  // Typo tolerance: trigram similarity still finds ELchupa from "elchpa".
  const fuzzy = (await race.search("elchpa")).players.map((p) => p.simplified);
  assert.ok(fuzzy.includes("ELchupa"), `fuzzy match failed: ${JSON.stringify(fuzzy)}`);
});
