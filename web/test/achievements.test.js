// Tests for the admin-defined achievements system: rule validation, the SQL
// evaluators (lifetime + windowed + standings-based + event-scoped kinds),
// idempotent awarding, the once-per-day sweep claim, and the profile /
// directory read shapes.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js),
// so tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.js";
import { validateDefinition, periodKey, describeRule, qualifyQuery, progressQuery, targetOf, RULE_KINDS } from "../achievements.js";
import { createTestDb } from "./pg-util.js";

// The seed migration ships ~40 starter definitions into every fresh DB. The
// logic tests below assert exact award/definition counts, so the default
// helper purges the seeds (no awards exist yet, so the guard-less DELETE is
// safe); the dedicated seed-validation test opts out to inspect them.
async function freshDb(t, { keepSeeds = false } = {}) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  if (!keepSeeds) await race.pool.query("DELETE FROM achievement WHERE created_by = 'seed'");
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

const VER = "wsw 2.1";
// One live finish as the game module reports it (racelog source).
function finish(name, time, extra = {}) {
  return { name, login: "", time, checkpoints: [], ...extra };
}
async function ingest(race, map, records) {
  return race.ingest({ version: VER, map, source: "racelog", records });
}

// Validate + create (+ optionally activate) a definition from admin-form-shaped
// input; returns the new achievement id.
async function makeAch(race, input, { activate = true } = {}) {
  const v = validateDefinition(input);
  assert.equal(v.error, undefined, `unexpected validation error: ${v.error}`);
  const id = await race.createAchievement(v.value, "test-admin");
  assert.ok(id, "createAchievement returned no id");
  if (activate) await race.setAchievementActive(id, true, "test-admin");
  return id;
}

test("every seeded achievement is a valid instance of the rule catalog", async (t) => {
  const race = await freshDb(t, { keepSeeds: true });
  const defs = (await race.all("SELECT * FROM achievement WHERE created_by = 'seed' ORDER BY id")).map((r) =>
    race._achRow(r)
  );
  assert.ok(defs.length >= 30, `expected the full seed set, got ${defs.length}`);
  const slugs = new Set();
  for (const def of defs) {
    assert.ok(!slugs.has(def.slug), `duplicate slug ${def.slug}`);
    slugs.add(def.slug);
    const kind = RULE_KINDS[def.rule.kind];
    assert.ok(kind, `${def.slug}: unknown rule kind "${def.rule.kind}"`);
    assert.ok(
      kind.windows.includes(def.time_window),
      `${def.slug}: window "${def.time_window}" unsupported by ${def.rule.kind}`
    );
    if (def.repeatable)
      assert.ok(["month", "day"].includes(def.time_window), `${def.slug}: repeatable needs a month/day window`);
    assert.ok(Number.isFinite(targetOf(def)), `${def.slug}: target not derivable`);
    // Both statements must be executable SQL (empty DB -> zero rows, but any
    // typo'd column/param mismatch throws here instead of in production).
    const q = qualifyQuery(def);
    await race.all(q.sql, q.params);
    const p = progressQuery(def, 1);
    await race.all(p.sql, p.params);
  }
});

test("validateDefinition normalises good input and rejects junk", () => {
  // Good: slug derived, ints coerced, unsupported repeatable dropped.
  const ok = validateDefinition({
    title: "Century Club!",
    tier: "gold",
    kind: "distinct_maps_finished",
    params: { count: "100", newOnly: "on" },
    window: "month",
    repeatable: true,
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.slug, "century-club");
  assert.deepEqual(ok.value.rule, { kind: "distinct_maps_finished", count: 100, newOnly: true });
  assert.equal(ok.value.time_window, "month");
  assert.equal(ok.value.repeatable, true);
  assert.ok(describeRule(ok.value).includes("100"));

  // repeatable is only meaningful for month/day windows.
  const lifetime = validateDefinition({
    title: "Grinder",
    kind: "finishes",
    params: { count: "1000" },
    window: "lifetime",
    repeatable: true,
  });
  assert.equal(lifetime.value.repeatable, false);
  assert.equal(periodKey(lifetime.value), "");

  // A window the kind doesn't support falls back to the kind's first window.
  const badWin = validateDefinition({
    title: "Wallhugger",
    kind: "movement_total",
    params: { metric: "wall_jumps", count: "500" },
    window: "month",
  });
  assert.equal(badWin.value.time_window, "lifetime");

  // Junk is refused with a human error, never saved.
  assert.ok(validateDefinition({ title: "", kind: "finishes", params: { count: "5" } }).error);
  assert.ok(validateDefinition({ title: "x", kind: "nope", params: {} }).error);
  assert.ok(validateDefinition({ title: "x", kind: "finishes", params: { count: "zero" } }).error);
  assert.ok(validateDefinition({ title: "x", kind: "movement_total", params: { metric: "attempts; DROP TABLE", count: "5" } }).error);
  assert.ok(validateDefinition({ title: "x", kind: "map_time", params: { map: "", maxMs: "40000" } }).error);
});

test("distinct-maps rule awards idempotently, incrementally, and with a monthly period", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "m1", [finish("Alpha", 50000), finish("Beta", 51000)]);
  await ingest(race, "m2", [finish("Alpha", 40000)]);

  const id = await makeAch(race, {
    title: "Explorer",
    kind: "distinct_maps_finished",
    params: { count: "2", newOnly: "on" },
    window: "month",
    repeatable: true,
  });

  // Full pass: only Alpha has 2 distinct first-time maps this month.
  assert.equal(await race.evaluateAchievements(null), 1);
  // Idempotent: nothing new on a re-run.
  assert.equal(await race.evaluateAchievements(null), 0);

  const month = new Date().toISOString().slice(0, 7);
  const rows = await race.all("SELECT * FROM player_achievement WHERE achievement_id = $1", [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, month);
  assert.equal(rows[0].detail.value, 2);

  // Incremental pass restricted to the players a later ingest touched.
  const r = await ingest(race, "m2", [finish("Beta", 60000)]);
  assert.equal(r.playerIds.length, 1);
  assert.equal(await race.evaluateAchievements(r.playerIds), 1);
  assert.equal((await race.all("SELECT * FROM player_achievement WHERE achievement_id = $1", [id])).length, 2);
});

test("strafe-quality single-run captures the qualifying finish", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "sq", [finish("Clean", 30000, { strafe_quality: 5200 }), finish("Sloppy", 29000, { strafe_quality: 3000 })]);

  const id = await makeAch(race, {
    title: "Half Perfect",
    kind: "strafe_quality_run",
    params: { minPct: "50" },
    window: "lifetime",
  });
  assert.equal(await race.evaluateAchievements(null), 1);

  const row = await race.one(
    `SELECT pa.*, p.simplified FROM player_achievement pa JOIN player p ON p.id = pa.player_id
     WHERE pa.achievement_id = $1`,
    [id]
  );
  assert.equal(row.simplified, "Clean");
  assert.ok(row.finish_id != null, "event-scoped award should record the qualifying finish");
  assert.equal(row.detail.value, 5200);
});

test("standings-based rules read the aggregates; map_time reads all-time PBs", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "wrmap", [finish("Fast", 40000), finish("Slow", 50000)]);
  await race.refreshAggregates();

  await makeAch(race, { title: "Record Holder", kind: "world_records", params: { min: "1" }, window: "lifetime" });
  await makeAch(race, {
    title: "Sub 45 on wrmap",
    kind: "map_time",
    params: { map: "WRMAP", maxMs: "45000" },
    window: "lifetime",
  });
  // Both rules award exactly the WR holder.
  assert.equal(await race.evaluateAchievements(null), 2);
  const winners = await race.all(
    `SELECT DISTINCT p.simplified FROM player_achievement pa JOIN player p ON p.id = pa.player_id`
  );
  assert.deepEqual(winners.map((w) => w.simplified), ["Fast"]);
});

test("preview is a dry run that splits holders from newly qualifying", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "p1", [finish("One", 30000), finish("Two", 31000)]);

  const id = await makeAch(race, { title: "Finisher", kind: "finishes", params: { count: "1" }, window: "lifetime" });
  let pv = await race.previewAchievement(id);
  assert.equal(pv.total, 2);
  assert.equal(pv.newlyQualifying, 2);
  assert.equal(pv.alreadyHolding, 0);
  assert.equal(pv.sample.length, 2);
  // Nothing was inserted by the preview.
  assert.equal((await race.all("SELECT 1 FROM player_achievement")).length, 0);

  await race.evaluateAchievements(null);
  pv = await race.previewAchievement(id);
  assert.equal(pv.alreadyHolding, 2);
  assert.equal(pv.newlyQualifying, 0);
});

test("daily sweep is claimed once per UTC day across instances", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "d1", [finish("Daily", 30000)]);
  await makeAch(race, { title: "Any Finish", kind: "finishes", params: { count: "1" }, window: "lifetime" });

  assert.equal(await race.achievementsDailySweep(), 1);
  assert.equal(await race.achievementsDailySweep(), 0); // in-memory memo
  race._achSweepDay = null; // simulate the second replica (fresh memo, same DB)
  assert.equal(await race.achievementsDailySweep(), 0); // config claim holds
});

test("profile + directory shapes: earned rides playerDetail, hidden defs are masked, progress lists the rest", async (t) => {
  const race = await freshDb(t);
  const r = await ingest(race, "shape", [finish("Shapely", 30000)]);
  const rawId = r.playerIds[0];
  await race.refreshAggregates();

  await makeAch(race, {
    title: "Secret Handshake",
    kind: "finishes",
    params: { count: "1" },
    window: "lifetime",
    hidden: true,
  });
  const grindId = await makeAch(race, { title: "Grinder", kind: "finishes", params: { count: "100" }, window: "lifetime" });
  assert.equal(await race.evaluateAchievements(null), 1); // only the hidden 1-finish def

  // Earned (even hidden) shows on the profile payload with full details.
  const detail = await race.playerDetail(rawId);
  assert.equal(detail.achievements.length, 1);
  assert.equal(detail.achievements[0].title, "Secret Handshake");

  // The lazy endpoint: earned + progress toward the visible unearned def.
  const pa = await race.playerAchievements(rawId);
  assert.equal(pa.earned.length, 1);
  assert.equal(pa.progress.length, 1);
  assert.equal(pa.progress[0].id, grindId);
  assert.equal(pa.progress[0].value, 1);
  assert.equal(pa.progress[0].target, 100);
  assert.equal(pa.progress[0].better, "high");

  // Directory: hidden def is masked (no title), earner counts + rarity there.
  const dir = await race.achievementsDirectory();
  assert.equal(dir.achievements.length, 2);
  const hidden = dir.achievements.find((a) => a.hidden);
  const visible = dir.achievements.find((a) => !a.hidden);
  assert.equal(hidden.title, undefined);
  assert.equal(hidden.earners, 1);
  assert.equal(visible.title, "Grinder");
  assert.equal(visible.earners, 0);
});

test("revoke deletes the award; a still-qualifying player is re-awarded by the next pass", async (t) => {
  const race = await freshDb(t);
  const r = await ingest(race, "rv", [finish("Comeback", 30000)]);
  const id = await makeAch(race, { title: "One Run", kind: "finishes", params: { count: "1" }, window: "lifetime" });
  assert.equal(await race.evaluateAchievements(null), 1);

  const row = await race.one("SELECT player_id, period FROM player_achievement WHERE achievement_id = $1", [id]);
  assert.equal(await race.revokeAward(id, Number(row.player_id), row.period), 1);
  assert.equal((await race.all("SELECT 1 FROM player_achievement")).length, 0);
  // Documented behaviour: the data still qualifies, so the evaluator re-awards.
  assert.equal(await race.evaluateAchievements(r.playerIds), 1);
});

test("distance/strafes tallies + speed snapshots flow through ingest, profile, and achievement kinds", async (t) => {
  const race = await freshDb(t);
  // A finish carrying the v2 metrics (distance/strafes counter deltas +
  // max/start speed snapshots)...
  const r = await race.ingest({
    version: VER,
    map: "far",
    source: "racelog",
    records: [
      {
        name: "Roadrunner", login: "", time: 44000, checkpoints: [],
        distance: 250000, strafes: 120, max_speed: 2100, start_speed: 460, strafe_quality: 4000,
      },
    ],
  });
  // ...and a finish-less attempt flush adding more of the counters.
  await race.ingest({
    version: VER,
    map: "far",
    source: "racelog",
    attempts: [
      { name: "Roadrunner", login: "", count: 2, restarts: 1, distance: 50000, strafes: 30 },
    ],
  });

  const tally = await race.one("SELECT distance, strafes FROM run_tally");
  assert.equal(Number(tally.distance), 300000);
  assert.equal(Number(tally.strafes), 150);
  const fin = await race.one("SELECT max_speed, start_speed FROM finish");
  assert.equal(fin.max_speed, 2100);
  assert.equal(fin.start_speed, 460);

  await race.refreshAggregates();
  const detail = await race.playerDetail(r.playerIds[0]);
  assert.equal(detail.metrics.distance, 300000);
  assert.equal(detail.metrics.strafes, 150);
  assert.equal(detail.metrics.maxSpeed, 2100);

  // Achievement kinds over the new data: lifetime distance total + top-speed
  // run (event-scoped, captures the qualifying finish).
  await makeAch(race, {
    title: "Marathon",
    kind: "movement_total",
    params: { metric: "distance", count: "200000" },
    window: "lifetime",
  });
  await makeAch(race, { title: "Speed Demon", kind: "max_speed_run", params: { minUps: "2000" }, window: "lifetime" });
  assert.equal(await race.evaluateAchievements(null), 2);
  const sd = await race.one(
    `SELECT pa.finish_id, pa.detail FROM player_achievement pa
     JOIN achievement a ON a.id = pa.achievement_id WHERE a.slug = 'speed-demon'`
  );
  assert.ok(sd.finish_id != null, "top-speed award should record the qualifying finish");
  assert.equal(sd.detail.value, 2100);
});

test("deleting is blocked once earned; deactivation stops new awards but keeps old ones", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "dl", [finish("Keeper", 30000)]);
  const id = await makeAch(race, { title: "Sticky", kind: "finishes", params: { count: "1" }, window: "lifetime" });
  assert.equal(await race.evaluateAchievements(null), 1);
  assert.equal(await race.deleteAchievement(id), 0); // earned -> refuse
  await race.setAchievementActive(id, false, "test-admin");
  await ingest(race, "dl2", [finish("Late", 31000)]);
  assert.equal(await race.evaluateAchievements(null), 0); // inactive: no new awards
  assert.equal((await race.all("SELECT 1 FROM player_achievement")).length, 1); // old award kept
});
