// Unit tests for the data-access layer: ingest semantics (attempts, PRs,
// records), canonical identity grouping, and the queries that power the site
// (map leaderboard for all players, WR splits, perfect run, player PRs).
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js),
// so tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, simplifyName, normToken, identKey, canonKey, rebuildCanonical, sha256, SR_MU, SR_MIN_FIELD } from "../db.js";
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

test("blocked maps drop out of the total map count and the maps list", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "keepmap", source: "racelog", records: [finish("Nova", 50000)] });
  await race.ingest({ version: VER, map: "blockme", source: "racelog", records: [finish("Nova", 51000)] });
  await race.refreshAggregates(); // populate map_index for the maps() list
  // Both maps are counted and listed before any block.
  assert.equal((await race.overview()).totals.maps, 2);
  assert.equal((await race.maps()).total, 2);

  const blockId = (await race.one("SELECT id FROM map WHERE name = $1", ["blockme"])).id;
  await race.blockMap(blockId, "test", "cli");

  // Headline total, maps() total, and maps() rows all exclude the blocked map
  // immediately — the filter is evaluated live against map_block, so no
  // aggregate rebuild is needed after blocking.
  assert.equal((await race.overview()).totals.maps, 1, "overview total excludes blocked");
  const list = await race.maps();
  assert.equal(list.total, 1, "maps() total excludes blocked");
  assert.deepEqual(list.rows.map((r) => r.name), ["keepmap"], "maps() rows exclude blocked");
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

test("strafe quality: lifetime average and daily trend across the canonical group", async (t) => {
  const race = await freshDb(t);
  // One person under two nick variants finishes with a per-run strafe quality
  // (basis points 0..10000 as the game reports it). A third run reports no value
  // (older server / pre-column) and must be EXCLUDED from the average, never
  // counted as 0%.
  await race.ingest({ version: VER, map: "s1", source: "racelog",
    records: [{ name: "Strafer", login: "", time: 30000, checkpoints: [], strafe_quality: 8000 }] });
  await race.ingest({ version: VER, map: "s2", source: "racelog",
    records: [{ name: "^3Strafer(1)", login: "", time: 31000, checkpoints: [], strafe_quality: 6000 }] });
  await race.ingest({ version: VER, map: "s3", source: "racelog",
    records: [{ name: "Strafer", login: "", time: 32000, checkpoints: [] }] });
  await race.refreshAggregates();

  const pd = await race.playerDetail(1, {});
  // Lifetime average of the two reported runs (80% and 60%) as a percentage —
  // proving aliases merge into one series and NULL runs are skipped.
  assert.equal(pd.metrics.strafeQuality, 70);
  // Every finish is "today", so the by-day trend has one bucket carrying that
  // day's average plus its best (max) and worst (min) run.
  assert.equal(pd.strafeHistory.length, 1);
  assert.equal(pd.strafeHistory[0].quality, 70);
  assert.equal(pd.strafeHistory[0].max, 80);
  assert.equal(pd.strafeHistory[0].min, 60);
});

test("strafe quality is null when a player has no reported runs", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "n1", source: "racelog", records: [finish("Plain", 30000)] });
  await race.refreshAggregates();
  const pd = await race.playerDetail(1, {});
  assert.equal(pd.metrics.strafeQuality, null);
  assert.deepEqual(pd.strafeHistory, []);
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

  // Breadth's 12 maps are all two-player fields — below SR_MIN_FIELD they
  // prove nothing, so he sits at exactly the bare prior.
  assert.equal(breadth.sr, Math.round(1000 * SR_MU), `Breadth SR ${breadth.sr} is the prior`);

  // sort=sr actually orders the board by SR descending.
  const board = (await race.players({ sort: "sr", limit: 200 })).rows.map((r) => r.sr);
  for (let i = 1; i < board.length; i++) assert.ok(board[i - 1] >= board[i], "players sorted by SR desc");
});

test("SR averages the top 50: same sample for everyone, weak maps included", async (t) => {
  const race = await freshDb(t);

  // 12 contested maps (12-strong fields). Champ WRs every one; Clone matches
  // his times exactly but races nothing else; Tourist takes a razor-thin 2nd
  // on just four of them.
  for (let m = 0; m < 12; m++) {
    const field = [finish("Champ", 30000), finish("Clone", 30000)];
    if (m < 4) field.push(finish("Tourist", 30300));
    for (let i = 0; i < 10; i++) field.push(finish(`pack${i}`, 45000 + i * 500));
    await race.ingest({ version: VER, map: `comp${m}`, source: "racelog", records: field });
  }
  // Champ ALSO cruises 20 more contested maps far off the pace. All 32 of his
  // maps are under the top-50 cap, so every one of them lands in his rating.
  for (let m = 0; m < 20; m++) {
    const field = [finish("CruiseWr", 20000), finish("Champ", 60000)];
    for (let i = 0; i < 10; i++) field.push(finish(`pack${i}`, 25000 + i * 500));
    await race.ingest({ version: VER, map: `cruise${m}`, source: "racelog", records: field });
  }
  await race.refreshAggregates();

  const byName = new Map(
    (await race.players({ sort: "sr", limit: 200 })).rows.map((r) => [r.simplified, r])
  );
  const champ = byName.get("Champ");
  const clone = byName.get("Clone");
  const tourist = byName.get("Tourist");

  // The deliberate trade-off of a fixed top-50: those 20 casual maps DO count,
  // so Champ now rates below his stay-at-home twin despite identical WR runs.
  // (Under the old prefix-max they were dropped and the two tied.)
  assert.ok(champ.sr < clone.sr, `Champ SR ${champ.sr} < Clone SR ${clone.sr} — weak maps count`);

  // Same trade-off, sharper edge, pinned here so nobody has to rediscover it:
  // Tourist's four near-WR maps are a SHORT sample, and short samples are only
  // regressed by kappa, so he outranks a player with 12 WRs and 20 slow maps.
  // Under prefix-max the ordering was the other way round. If that ever wants
  // fixing, the lever is padding unused slots toward the prior (or a bigger
  // kappa), not the top-50 rule itself.
  assert.ok(tourist.sr > champ.sr, `Tourist SR ${tourist.sr} > Champ SR ${champ.sr} — short samples ride high`);

  // A WR-on-everything catalog still tops a mixed one.
  const cruiseWr = byName.get("CruiseWr");
  assert.ok(cruiseWr.sr > champ.sr, `CruiseWr ${cruiseWr.sr} > Champ ${champ.sr}`);
  assert.ok(clone.sr > tourist.sr, `Clone (12 WRs) ${clone.sr} > Tourist (4 near-WRs) ${tourist.sr}`);
});

test("empty slots are held at the prior: a short catalog can't ride high", async (t) => {
  const race = await freshDb(t);

  // Two players who are equally fast — both WR their maps against identical
  // 12-strong fields. The only difference is how many slots they've filled:
  // Deep has 20 maps, Thin has 3.
  for (let m = 0; m < 20; m++) {
    const field = [finish("Deep", 30000)];
    if (m < 3) field.push(finish("Thin", 30000));
    for (let i = 0; i < 11; i++) field.push(finish(`pack${m}_${i}`, 45000 + i * 500));
    await race.ingest({ version: VER, map: `m${m}`, source: "racelog", records: field });
  }
  await race.refreshAggregates();

  const byName = new Map((await race.players({ sort: "sr", limit: 200 })).rows.map((r) => [r.simplified, r]));
  const deep = byName.get("Deep");
  const thin = byName.get("Thin");

  // Identical per-map quality (both hold the WR on every map they've raced), so
  // WITHOUT slot padding these two would sit within a few points of each other.
  // With it, the 17 extra unfilled slots cost Thin real rating.
  assert.ok(deep.sr > thin.sr + 50, `Deep ${deep.sr} clearly ahead of Thin ${thin.sr} on the same per-map quality`);

  // Neither is at the prior — both have real, contested WRs.
  assert.ok(thin.sr > Math.round(1000 * SR_MU), `Thin ${thin.sr} still above the prior`);

  // And the empty slots are exactly the difference the breakdown reports.
  const bdThin = await race.srBreakdown(thin.id);
  const bdDeep = await race.srBreakdown(deep.id);
  assert.equal(bdThin.counted, 3);
  assert.equal(bdThin.emptySlots, bdThin.topK - 3);
  assert.equal(bdDeep.counted, 20);
  assert.equal(bdDeep.emptySlots, bdDeep.topK - 20);
  assert.equal(bdThin.rows[bdThin.rows.length - 1].running, thin.sr, "last row already includes the empty slots");
});

test("SR is the weighted mean over 50 slots, empty ones held at the prior", async (t) => {
  const race = await freshDb(t);

  // One strong map and one weak one, both contested. Under prefix-max the weak
  // map would be dropped (it lowers the mean) and SR would be the strong map's
  // value alone; under a fixed top-50 both are in the average.
  const strong = [finish("Duo", 30000)];
  for (let i = 0; i < 10; i++) strong.push(finish(`p${i}`, 45000 + i * 500));
  await race.ingest({ version: VER, map: "strong", source: "racelog", records: strong });

  const weak = [finish("Rocket", 20000), finish("Duo", 60000)];
  for (let i = 0; i < 10; i++) weak.push(finish(`p${i}`, 30000 + i * 500));
  await race.ingest({ version: VER, map: "weak", source: "racelog", records: weak });
  await race.refreshAggregates();

  const duo = (await race.players({ sort: "sr", limit: 50 })).rows.find((r) => r.simplified === "Duo");
  const bd = await race.srBreakdown(duo.id);
  assert.equal(bd.counted, 2, "both maps are in the rating");
  assert.equal(bd.rows.length, 2);

  // Recompute the Bayesian weighted mean by hand from the exposed inputs,
  // including the 48 unfilled slots sitting at the prior.
  assert.equal(bd.emptySlots, bd.topK - 2, "the rest of the 50 slots are empty");
  const sumPw = bd.rows.reduce((a, r) => a + r.perf * r.weight, 0);
  const sumW = bd.rows.reduce((a, r) => a + r.weight, 0);
  const fill = bd.emptySlots * bd.fillWeight;
  const expected = Math.round(
    (1000 * (sumPw + bd.kappa * bd.mu + fill * bd.mu)) / (sumW + bd.kappa + fill)
  );
  assert.equal(duo.sr, expected, `SR ${duo.sr} is the mean over BOTH maps + empty slots (${expected})`);
  assert.equal(bd.sr, duo.sr);
  assert.equal(bd.computed, duo.sr);
  assert.equal(bd.rows[bd.rows.length - 1].running, duo.sr, "the last row's running value is the rating");
  // The weak map genuinely costs: the rating sits below the strong map alone.
  assert.ok(bd.rows[0].running > duo.sr, `strong-map-only ${bd.rows[0].running} > final ${duo.sr}`);
});

test("a map counts toward SR once the player and two others have a time on it", async (t) => {
  const race = await freshDb(t);

  // Two players is not a contest: nothing qualifies, so the rating is the bare
  // prior even though this player holds the WR.
  await race.ingest({
    version: VER,
    map: "duo",
    source: "racelog",
    records: [finish("Local", 30000), finish("Rival", 40000)],
  });
  await race.refreshAggregates();
  let bd = await race.srBreakdown((await race.players({ limit: 50 })).rows.find((r) => r.simplified === "Local").id);
  assert.equal(bd.contested, 0, "a 2-player map is below the threshold");
  assert.equal(bd.sr, Math.round(1000 * SR_MU), "still the prior");

  // A third finisher shows up and the same map starts counting — the threshold
  // is the player plus SR_MIN_FIELD - 1 others (3 total), not a big field.
  await race.ingest({ version: VER, map: "duo", source: "racelog", records: [finish("Third", 50000)] });
  await race.refreshAggregates();
  const local = (await race.players({ limit: 50 })).rows.find((r) => r.simplified === "Local");
  bd = await race.srBreakdown(local.id);
  assert.equal(SR_MIN_FIELD, 3, "threshold is you + 2 others");
  assert.equal(bd.contested, 1, "the 3-player map now qualifies");
  assert.equal(bd.rows[0].field, 3);
  assert.equal(bd.counted, 1);
  assert.equal(bd.sr, local.sr);
  assert.ok(local.sr > Math.round(1000 * SR_MU), `WR on a contested map beats the prior (${local.sr})`);

  // The field weight still scales with size, so a 3-player map is worth much
  // less than a big one: the WR holder on a 30-player map outranks this WR.
  const big = [finish("Big", 30000)];
  for (let i = 0; i < 29; i++) big.push(finish(`crowd${i}`, 40000 + i * 200));
  await race.ingest({ version: VER, map: "packed", source: "racelog", records: big });
  await race.refreshAggregates();
  const rows = (await race.players({ sort: "sr", limit: 50 })).rows;
  const bigSr = rows.find((r) => r.simplified === "Big").sr;
  const smallSr = rows.find((r) => r.simplified === "Local").sr;
  assert.ok(bigSr > smallSr, `WR on a 30-player field ${bigSr} > WR on a 3-player field ${smallSr}`);
});

test("SR breakdown lists the maps the rating is actually made of", async (t) => {
  const race = await freshDb(t);

  // Same shape as the test above: 12 contested maps Champ WRs, plus 20 more
  // contested maps he cruises far off the pace (and one two-player map that is
  // below SR_MIN_FIELD, so it never qualifies at all).
  for (let m = 0; m < 12; m++) {
    const field = [finish("Champ", 30000)];
    for (let i = 0; i < 10; i++) field.push(finish(`pack${i}`, 45000 + i * 500));
    await race.ingest({ version: VER, map: `comp${m}`, source: "racelog", records: field });
  }
  for (let m = 0; m < 20; m++) {
    const field = [finish("CruiseWr", 20000), finish("Champ", 60000)];
    for (let i = 0; i < 10; i++) field.push(finish(`pack${i}`, 25000 + i * 500));
    await race.ingest({ version: VER, map: `cruise${m}`, source: "racelog", records: field });
  }
  await race.ingest({ version: VER, map: "empty", source: "racelog", records: [finish("Champ", 10000), finish("Solo", 11000)] });
  await race.refreshAggregates();

  const champ = (await race.players({ sort: "sr", limit: 200 })).rows.find((r) => r.simplified === "Champ");
  const bd = await race.srBreakdown(champ.id);

  // The dropdown can never disagree with the board: the same arithmetic on the
  // same inputs, and the LAST row IS the rating (every row counts now).
  assert.equal(bd.sr, champ.sr, "breakdown reports the standings SR");
  assert.equal(bd.computed, champ.sr, `recomputed ${bd.computed} = standings ${champ.sr}`);
  assert.equal(bd.rows[bd.rows.length - 1].running, champ.sr, "the last row's running total is the rating");

  // 32 contested maps (the 2-player "empty" doesn't qualify), all under the
  // top-K cap, so all 32 are in the rating — the 12 WR maps lead the ranking.
  assert.equal(bd.contested, 32);
  assert.equal(bd.rows.length, 32);
  assert.equal(bd.counted, 32, `counted ${bd.counted} maps`);
  for (const r of bd.rows.slice(0, 12)) {
    assert.ok(r.map_name.startsWith("comp"), `${r.map_name} is one of the WR maps`);
    assert.equal(r.rank, 1);
    assert.equal(r.time, r.wr_time);
    assert.equal(r.ratio, 1);
    assert.equal(r.field, 11);
  }
  // Rows are ranked strongest-first, and the 20 cruise maps at the tail visibly
  // drag the running rating down from its 12-WR peak.
  for (let i = 1; i < bd.rows.length; i++)
    assert.ok(bd.rows[i].perf <= bd.rows[i - 1].perf, "rows ordered by performance desc");
  assert.ok(bd.rows[11].running > bd.sr, `peak after the WR maps ${bd.rows[11].running} > final ${bd.sr}`);

  // Unknown player -> null (the endpoint turns this into a 404).
  assert.equal(await race.srBreakdown(999999), null);
});

test("SR breakdown of a player with no contested maps is empty at the prior", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "lonely", source: "racelog", records: [finish("Hermit", 30000)] });
  await race.refreshAggregates();

  const hermit = (await race.players({ limit: 50 })).rows.find((r) => r.simplified === "Hermit");
  const bd = await race.srBreakdown(hermit.id);
  assert.deepEqual(bd.rows, []);
  assert.equal(bd.counted, 0);
  assert.equal(bd.contested, 0);
  assert.equal(bd.sr, Math.round(1000 * SR_MU));
  assert.equal(bd.computed, Math.round(1000 * SR_MU));
});

test("compare: head-to-head on shared maps drives the verdict", async (t) => {
  const race = await freshDb(t);

  // Alpha vs Beta share three maps (Alpha wins 2, Beta wins 1); Alpha has one
  // extra solo map that must NOT count toward the head-to-head.
  await race.ingest({ version: VER, map: "d1", source: "racelog", records: [finish("Alpha", 30000), finish("Beta", 32000)] });
  await race.ingest({ version: VER, map: "d2", source: "racelog", records: [finish("Alpha", 40000), finish("Beta", 35000)] });
  await race.ingest({ version: VER, map: "d3", source: "racelog", records: [finish("Alpha", 20000), finish("Beta", 25000)] });
  await race.ingest({ version: VER, map: "solo", source: "racelog", records: [finish("Alpha", 10000)] });
  await race.refreshAggregates();

  const idOf = async (nick) =>
    N((await race.one("SELECT canonical_id c FROM player WHERE simplified = $1", [nick])).c);
  const alpha = await idOf("Alpha");
  const beta = await idOf("Beta");

  const cmp = await race.compare(alpha, beta);
  assert.equal(cmp.a.id, alpha);
  assert.equal(cmp.b.id, beta);
  assert.equal(cmp.summary.shared, 3, "only the three shared maps count");
  assert.equal(cmp.summary.aWins, 2);
  assert.equal(cmp.summary.bWins, 1);
  assert.equal(cmp.summary.ties, 0);
  assert.equal(cmp.summary.leader, "a", "Alpha leads the head-to-head");
  assert.equal(cmp.summary.basis, "head-to-head");
  assert.equal(cmp.head.length, 3);
  // Every detail row carries a resolved winner and a non-negative gap.
  for (const h of cmp.head) {
    assert.ok(["a", "b", "tie"].includes(h.winner));
    assert.equal(h.delta, Math.abs(h.aTime - h.bTime));
  }

  // Order is symmetric: swapping sides swaps the wins and the leader.
  const rev = await race.compare(beta, alpha);
  assert.equal(rev.summary.aWins, 1);
  assert.equal(rev.summary.bWins, 2);
  assert.equal(rev.summary.leader, "b");

  // Same player on both sides is flagged, not scored.
  const self = await race.compare(alpha, alpha);
  assert.equal(self.same, true);

  // Unknown id -> null (the route turns this into a 404).
  assert.equal(await race.compare(alpha, 999999), null);
});

test("every finish counts as an attempt; only the best is kept as the PR", async (t) => {
  const race = await freshDb(t);

  // Three finishes by the same player: 52s, then a PR at 48s, then a slower
  // 50s. Alongside the counts, ingest reports which player rows the batch
  // touched (playerIds — the achievements evaluator's input).
  let c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 52000, [11000, 30000])] });
  assert.deepEqual(c, { inserted: 1, improved: 0, unchanged: 0, playerIds: c.playerIds });
  assert.equal(c.playerIds.length, 1);
  c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 48000, [10000, 28000])] });
  assert.deepEqual(c, { inserted: 0, improved: 1, unchanged: 0, playerIds: c.playerIds });
  c = await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000, [10500, 29000])] });
  assert.deepEqual(c, { inserted: 0, improved: 0, unchanged: 1, playerIds: c.playerIds });

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

test("a finish stamps both last_finish and last_attempt (every finish is an attempt)", async (t) => {
  const race = await freshDb(t);
  const before = Math.floor(Date.now() / 1000);
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000)] });
  const row = await race.one("SELECT last_finish, last_attempt FROM run_tally");
  assert.ok(row.last_finish != null && row.last_finish >= before, "last_finish stamped");
  assert.ok(row.last_attempt != null && row.last_attempt >= before, "last_attempt stamped");
});

test("standings expose last_active and players sort=active orders by recency", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "m1", source: "racelog", records: [finish("Older", 50000)] });
  await race.ingest({ version: VER, map: "m2", source: "racelog", records: [finish("Newer", 50000)] });

  // ingest stamps "now" for both; force distinct activity times so ordering is
  // deterministic. last_active = max(last_finish, last_attempt) per player.
  await race.pool.query(
    "UPDATE run_tally SET last_finish = 1000, last_attempt = 1000 WHERE player_id IN (SELECT id FROM player WHERE name = 'Older')"
  );
  await race.pool.query(
    "UPDATE run_tally SET last_finish = 2000, last_attempt = 2000 WHERE player_id IN (SELECT id FROM player WHERE name = 'Newer')"
  );
  await race.refreshAggregates();

  // Descending (the default for this sort) leads with the most recently active.
  const desc = await race.players({ sort: "active" });
  assert.deepEqual(desc.rows.map((r) => r.name), ["Newer", "Older"]);
  assert.equal(desc.rows[0].last_active, 2000);
  assert.equal(desc.rows[1].last_active, 1000);

  // Ascending flips it.
  const asc = await race.players({ sort: "active", order: "asc" });
  assert.deepEqual(asc.rows.map((r) => r.name), ["Older", "Newer"]);
});

test("players with no tally (last_active NULL) sort last, never first", async (t) => {
  const race = await freshDb(t);
  // topscores source backfills a best WITHOUT tallying, so this player has a
  // standing but no activity timestamp.
  await race.ingest({ version: VER, map: "m1", source: "topscores", records: [finish("Ghost", 50000)] });
  await race.ingest({ version: VER, map: "m2", source: "racelog", records: [finish("Active", 50000)] });
  await race.refreshAggregates();

  const desc = await race.players({ sort: "active" });
  assert.equal(desc.rows[0].name, "Active", "active player leads");
  assert.equal(desc.rows[desc.rows.length - 1].name, "Ghost", "NULL activity sorts last");
  assert.equal(desc.rows.find((r) => r.name === "Ghost").last_active, null);

  // NULLS still sort last even ascending — blanks never lead the list.
  const asc = await race.players({ sort: "active", order: "asc" });
  assert.equal(asc.rows[asc.rows.length - 1].name, "Ghost");
});

test("maps sort=played orders by most recent activity, never-played last", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "old", source: "racelog", records: [finish("Nova", 50000)] });
  await race.ingest({ version: VER, map: "hot", source: "racelog", records: [finish("Nova", 50000)] });
  // topscores backfill writes no tally -> the map has records but no
  // last_played, and must trail the list in either direction.
  await race.ingest({ version: VER, map: "archived", source: "topscores", records: [finish("Ghost", 40000)] });

  // Both racelog ingests stamped the same "now"; force distinct times.
  await race.pool.query(
    "UPDATE run_tally SET last_finish = 1000, last_attempt = 1000 WHERE map_id = (SELECT id FROM map WHERE name = 'old')"
  );
  await race.pool.query(
    "UPDATE run_tally SET last_finish = 2000, last_attempt = 2000 WHERE map_id = (SELECT id FROM map WHERE name = 'hot')"
  );
  await race.refreshAggregates();

  const desc = await race.maps({ sort: "played" });
  assert.deepEqual(desc.rows.map((r) => r.name), ["hot", "old", "archived"]);
  assert.equal(desc.rows[0].last_played, 2000);
  assert.equal(desc.rows[1].last_played, 1000);
  assert.equal(desc.rows[2].last_played, null);

  const asc = await race.maps({ sort: "played", order: "asc" });
  assert.deepEqual(asc.rows.map((r) => r.name), ["old", "hot", "archived"]);
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

test("player detail sums movement metrics across maps and flush types", async (t) => {
  const race = await freshDb(t);
  // A finish carries per-flush movement metrics the same way it carries attempts.
  await race.ingest({
    version: VER,
    map: "map_a",
    source: "racelog",
    records: [
      { name: "Nova", login: "", time: 50000, checkpoints: [], attempts: 3,
        wall_jumps: 12, dashes: 5, prejump_failures: 1, restarts: 2 },
    ],
  });
  // A finish on another map adds to the lifetime totals.
  await race.ingest({
    version: VER,
    map: "map_b",
    source: "racelog",
    records: [
      { name: "Nova", login: "", time: 61000, checkpoints: [], attempts: 1,
        wall_jumps: 8, dashes: 3, prejump_failures: 0, restarts: 4 },
    ],
  });
  // A finish-less attempt flush (disconnect / map end) carries metrics too.
  await race.ingest({
    version: VER,
    map: "map_a",
    source: "racelog",
    attempts: [
      { name: "Nova", login: "", count: 2, wall_jumps: 1, dashes: 1, prejump_failures: 3, restarts: 1 },
    ],
  });
  await race.refreshAggregates();

  const pid = N((await race.one("SELECT id FROM player LIMIT 1")).id);
  const d = await race.playerDetail(pid);
  assert.deepEqual(d.metrics, {
    wallJumps: 12 + 8 + 1,
    dashes: 5 + 3 + 1,
    prejumpFailures: 1 + 0 + 3,
    restarts: 2 + 4 + 1,
    distance: 0, // none of these finishes reported the v2 metrics
    strafes: 0,
    maxSpeed: null,
    strafeQuality: null, // these finishes reported no strafe quality
  });
});

test("movement metrics are racelog-only (topscores ingest never counts them)", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER,
    map: "map_a",
    source: "topscores",
    records: [
      { name: "Nova", login: "", time: 50000, checkpoints: [],
        wall_jumps: 12, dashes: 5, prejump_failures: 1, restarts: 2 },
    ],
  });
  const pid = N((await race.one("SELECT id FROM player LIMIT 1")).id);
  const d = await race.playerDetail(pid);
  assert.deepEqual(d.metrics, {
    wallJumps: 0,
    dashes: 0,
    prejumpFailures: 0,
    restarts: 0,
    distance: 0,
    strafes: 0,
    maxSpeed: null,
    strafeQuality: null,
  });
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
  for (const c of results) {
    assert.deepEqual(c, { inserted: 1, improved: 0, unchanged: 0, playerIds: c.playerIds });
    assert.equal(c.playerIds.length, 1);
  }
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

test("finish log records every finish (not just PBs), with splits, and skips topscores syncs", async (t) => {
  const race = await freshDb(t);
  const cnt = async (sql) => N((await race.one(sql)).c);

  // First finish (a PB): stored in race AND logged with its splits.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 50000, [10000, 30000])] });
  assert.equal(await cnt("SELECT COUNT(*) c FROM race"), 1);
  assert.equal(await cnt("SELECT COUNT(*) c FROM finish"), 1);
  assert.equal(await cnt("SELECT COUNT(*) c FROM finish_checkpoint"), 2, "splits logged");

  // Slower finish (NOT a PB): race unchanged, but the finish is still logged —
  // this is the whole point of the finish log.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 60000, [12000, 36000])] });
  assert.equal(await cnt("SELECT COUNT(*) c FROM race"), 1, "non-PB adds no race row");
  assert.equal(await cnt("SELECT COUNT(*) c FROM finish"), 2, "but the non-PB finish IS logged");

  // Faster finish (new PB): race improves AND it is logged.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova", 40000, [8000, 24000])] });
  assert.equal(N((await race.one("SELECT time FROM race")).time), 40000, "race holds the faster PB");
  assert.equal(await cnt("SELECT COUNT(*) c FROM finish"), 3);

  await race.refreshAggregates(); // build `best` so the recentFinishes pb flag resolves

  const pid = N((await race.one("SELECT id FROM player WHERE name = 'Nova'")).id);
  const feed = await race.recentFinishes({ playerId: pid });
  assert.equal(feed.length, 3, "all three finishes surface");
  assert.deepEqual(feed.map((f) => f.time), [40000, 60000, 50000], "newest first");
  assert.deepEqual(feed[0].checkpoints, [8000, 24000], "splits carried through");
  assert.equal(feed.find((f) => f.time === 40000).pb, true, "the current-best run is flagged pb");
  assert.equal(feed.find((f) => f.time === 60000).pb, false, "a slower run is not");

  // A topscores re-sync resends the whole top-50 every interval — it must NOT
  // duplicate the finish log (only live racelog finishes are logged).
  const before = await cnt("SELECT COUNT(*) c FROM finish");
  await race.ingest({ version: VER, map: MAP, source: "topscores", records: [finish("Nova", 40000, [8000, 24000])] });
  assert.equal(await cnt("SELECT COUNT(*) c FROM finish"), before, "topscores source is not logged");
});

test("gameRanksText: every finisher, canonical-deduped, dense-tie ranks + true total", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: MAP, source: "racelog",
    records: [
      finish("Alpha", 30000),
      finish("Beta", 32000),
      finish("Gamma", 32000), // tie with Beta -> both rank 2
      finish("Delta", 40000), // dense-tie gap -> rank 4
    ],
  });
  // A colour-code variant of an existing finisher must collapse to the same
  // canonical player (not add a phantom finisher / extra line).
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("^1Alpha", 31000)] });

  const body = await race.gameRanksText(MAP);
  const lines = body.trimEnd().split("\n");
  assert.equal(lines[0], "//ranks 4", "header carries the true canonical finisher count");
  // Ordered by rank, then name; ties share a rank, RANK() leaves the gap.
  assert.deepEqual(lines.slice(1), ["1 Alpha", "2 Beta", "2 Gamma", "4 Delta"]);

  // Map-name handling: case-insensitive, unknown -> null, unsafe -> null.
  assert.equal(await race.gameRanksText(MAP.toUpperCase()), body, "map lookup is case-insensitive");
  assert.equal(await race.gameRanksText("no_such_map"), null, "unknown map -> null (404)");
  assert.equal(await race.gameRanksText("../etc/passwd"), null, "unsafe map name -> null");

  // An improved time re-ranks live (ingest keeps race.global_rank current), so
  // the served blob reflects it with no batch refresh in between.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Delta", 10000)] });
  const after = (await race.gameRanksText(MAP)).trimEnd().split("\n");
  assert.equal(after[1], "1 Delta", "Delta's faster time makes it rank 1 immediately");
  assert.equal(after[2], "2 Alpha", "Alpha pushed down to 2");
});

test("gamePlayerRecordText: one player's PB — rank+total header + exact topscores data line", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: MAP, source: "racelog",
    records: [
      finish("Nova", 30000, [10000, 20000]),
      finish("Beta", 32000, [11000, 21000]),
      finish("Gamma", 32000, [12000, 22000]), // tie with Beta -> both rank 2
      finish("^3Zeta", 35000, [13000, 26000]), // colour-coded nick
      finish("Delta", 40000, [15000, 30000]),
    ],
  });

  // Exact bytes: header "//playerrec <rank> <total> <sr>", then the topscores
  // per-record line — every field quoted, sectors in `number` order, and the
  // SINGLE trailing space after the last sector preserved (the game's getToken
  // loader keeps it; do NOT trimEnd the assertion). SR is 0 here: `standings` is
  // built by refreshAggregates, which this test deliberately never runs (see the
  // dedicated SR test below), so every player reads as unrated.
  assert.equal(
    await race.gamePlayerRecordText(MAP, "nova"),
    `//playerrec 1 5 0\n"30000" "Nova" "2" "10000" "20000" \n`,
    "leader: rank 1 of 5, checkpoints ascending by number"
  );
  assert.equal(
    await race.gamePlayerRecordText(MAP, "beta"),
    `//playerrec 2 5 0\n"32000" "Beta" "2" "11000" "21000" \n`,
    "dense-tie rank matches the ranks blob (Beta shares rank 2)"
  );

  // Colour-code match: the game sends removeColorTokens().tolower() = "zeta";
  // it must resolve to ^3Zeta's canonical group (SQL strips ^N the same way).
  assert.equal(
    await race.gamePlayerRecordText(MAP, "zeta"),
    `//playerrec 4 5 0\n"35000" "^3Zeta" "2" "13000" "26000" \n`,
    "colour-stripped name still finds the record; emitted name keeps ^ codes"
  );

  // Fail-open: known map + no record for that player => empty body (NOT null).
  assert.equal(await race.gamePlayerRecordText(MAP, "nobody"), "", "unknown player => empty body");
  assert.equal(await race.gamePlayerRecordText(MAP, "^1^2"), "", "name that normalises to nothing => empty body");

  // Map handling mirrors gameRanksText: case-insensitive, unknown/unsafe => null.
  assert.equal(
    await race.gamePlayerRecordText(MAP.toUpperCase(), "nova"),
    await race.gamePlayerRecordText(MAP, "nova"),
    "map lookup is case-insensitive"
  );
  assert.equal(await race.gamePlayerRecordText("no_such_map", "nova"), null, "unknown map => null (404)");
  assert.equal(await race.gamePlayerRecordText("../etc/passwd", "nova"), null, "unsafe map name => null");

  // Canonical grouping: a PB set under a colour/(N) variant collapses into the
  // player's single best, and the rank recomputes live. "Nova(2)" identKeys to
  // "nova" (both for canonical grouping AND for the match), so a faster run
  // under that nick becomes Nova's PB and both queries return it identically.
  await race.ingest({ version: VER, map: MAP, source: "racelog", records: [finish("Nova(2)", 25000, [8000, 16000])] });
  const viaBase = await race.gamePlayerRecordText(MAP, "nova");
  const viaSuffix = await race.gamePlayerRecordText(MAP, "nova(2)");
  assert.equal(viaBase, viaSuffix, "the (N) collision suffix resolves to the same canonical group");
  assert.match(viaBase, /^\/\/playerrec 1 5 0\n"25000" /, "faster variant run becomes the group PB, still rank 1");
  assert.match(viaBase, /"2" "8000" "16000" \n$/, "the variant run's checkpoints are the ones served");
});

test("gamePlayerRecordText: the header carries the player's global Skill Rating", async (t) => {
  const race = await freshDb(t);
  const OTHER = "testmap2";
  // Five finishers make the map contested (SR_MIN_FIELD), so the aggregate
  // refresh gives everyone who finished it a real rating.
  await race.ingest({
    version: VER, map: MAP, source: "racelog",
    records: [
      finish("Nova", 30000, [10000, 20000]),
      finish("Beta", 32000),
      finish("Gamma", 34000),
      finish("Delta", 36000),
      finish("Epsilon", 38000),
    ],
  });
  // Rho races only the OTHER map: rated, but with nothing on MAP.
  await race.ingest({ version: VER, map: OTHER, source: "racelog", records: [finish("Rho", 20000)] });
  await race.refreshAggregates();

  const nova = await race.gamePlayerRecordText(MAP, "nova");
  const novaSr = Number(nova.split("\n")[0].split(" ")[3]);
  assert.equal(
    novaSr,
    Number((await race.one("SELECT sr FROM standings s JOIN player p ON p.id = s.player_id WHERE p.name = 'Nova'")).sr),
    "the header SR is exactly the standings value the site shows"
  );
  assert.ok(novaSr > 0, "a finisher on a contested map is rated");
  assert.match(nova, /^\/\/playerrec 1 5 \d+\n"30000" /, "rank/total are untouched by the added field");

  // Rated, but no record on THIS map: a header-only body — rank 0 (the game
  // stamps no Pos from it) with the rating still delivered.
  const rho = await race.gamePlayerRecordText(MAP, "rho");
  assert.match(rho, /^\/\/playerrec 0 0 \d+\n$/, "no record here => header-only SR payload");
  assert.ok(Number(rho.split(" ")[3]) > 0, "the SR is a real rating, not the 0 placeholder");

  // A name nobody has raced under stays an empty body: nothing to say at all.
  assert.equal(await race.gamePlayerRecordText(MAP, "nobody"), "", "unrated unknown player => empty body");
});

test("saved starts: upsert, per-player text, canonical match, replace, delete", async (t) => {
  const race = await freshDb(t);
  const M = "spacejam";

  // Store a race start (colour-coded nick) and a reverse start (plain nick) —
  // both identKey to "nova", so they collapse onto ONE canonical player.
  assert.equal(
    await race.upsertPlayerSavedStart({
      map: M, name: "^3Nova", mode: "race",
      origin: [100.5, -200.25, 16], angles: [0, 90, 0],
    }),
    true
  );
  await race.upsertPlayerSavedStart({
    map: M, name: "Nova", mode: "reverse",
    origin: [1, 2, 3], angles: [10, 20, 30],
  });
  // A different player's start must not leak into Nova's payload.
  await race.upsertPlayerSavedStart({ map: M, name: "Beta", mode: "race", origin: [9, 9, 9], angles: [1, 1, 1] });

  // Per-player text: "//starts" header, one line per direction, floats to 3dp,
  // matched by colour-stripped nick.
  const nova = await race.savedStartText(M, "nova");
  assert.match(nova, /^\/\/starts\n/, "leads with the //starts header");
  assert.match(nova, /\nrace 100\.500 -200\.250 16\.000 0\.000 90\.000 0\.000\n/, "race line");
  assert.match(nova, /\nreverse 1\.000 2\.000 3\.000 10\.000 20\.000 30\.000\n/, "reverse line");
  assert.doesNotMatch(nova, /9\.000 9\.000 9\.000/, "only this player's own starts");

  // Upsert is most-recent-wins in place (PK = player,map,mode): one race line.
  await race.upsertPlayerSavedStart({ map: M, name: "Nova", mode: "race", origin: [5, 5, 5], angles: [0, 0, 0] });
  const nova2 = await race.savedStartText(M, "nova");
  assert.match(nova2, /\nrace 5\.000 5\.000 5\.000 0\.000 0\.000 0\.000\n/, "race start replaced");
  assert.equal((nova2.match(/\nrace /g) || []).length, 1, "still exactly one race line");

  // Canonical grouping is already proven above: the race start was saved under
  // "^3Nova" and the reverse under "Nova" — both colour-strip to "nova" and come
  // back together for that clean nick (they share one canonical player). A nick
  // the player never actually used does NOT match (same posture as the ranks /
  // player-record boards: match is by an existing colour-stripped alias).
  assert.equal(await race.savedStartText(M, "someone-else"), "//starts\n", "an unused nick matches nothing");

  // Fail-open + guards: no start => bare header; unknown/unsafe map => null.
  assert.equal(await race.savedStartText(M, "nobody"), "//starts\n", "no saved start => bare header");
  assert.equal(await race.savedStartText("no_such_map", "nova"), null, "unknown map => null");
  assert.equal(await race.savedStartText("../etc/passwd", "nova"), null, "unsafe map => null");

  // Delete one direction; the other survives. Deleting again => false.
  assert.equal(await race.deletePlayerSavedStart({ map: M, name: "Nova", mode: "race" }), true);
  const afterDel = await race.savedStartText(M, "nova");
  assert.doesNotMatch(afterDel, /\nrace /, "race start removed");
  assert.match(afterDel, /\nreverse /, "reverse start survives");
  assert.equal(await race.deletePlayerSavedStart({ map: M, name: "Nova", mode: "race" }), false, "already gone => false");
  assert.equal(await race.deletePlayerSavedStart({ map: "no_such_map", name: "Nova", mode: "race" }), false, "unknown map => false");
});
