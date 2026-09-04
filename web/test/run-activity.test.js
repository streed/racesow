// Unit tests for the finished-vs-attempted series behind the /runs page.
//
// The interesting behaviour is not the counting — it is the NULLs. Attempts
// have per-day history only from the day run_activity_daily shipped, so every
// test here is really about keeping "we were not recording yet" distinct from
// "nobody raced", in both directions and at the week-fold boundary.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.js";
import { createTestDb } from "./pg-util.js";

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

const VER = "wsw 2.1";
const finish = (name, time) => ({ name, login: "", time, checkpoints: [] });
const today = () => new Date().toISOString().slice(0, 10);
const at = (p, day) => p.points.find((x) => x.day === day);

// Rewrite what the live ingest just recorded so a test can place activity on a
// specific past day. Both halves must move together: the finish log carries an
// epoch timestamp and the attempt bucket an already-cut DATE, and the whole
// point of the page is that the two line up on the same axis.
async function backdate(race, dayIso) {
  const ts = Math.floor(Date.parse(dayIso + "T12:00:00Z") / 1000);
  await race.pool.query("UPDATE finish SET created_at = $1", [ts]);
  await race.pool.query("UPDATE run_activity_daily SET day = $1::date", [dayIso]);
}

test("ingest records the attempt delta as a daily bucket", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("Nova", 50000), attempts: 4 }],
    attempts: [{ name: "Ghost", login: "", count: 6 }],
  });

  const d = await race.runActivity({ days: 30 });
  const row = at(d, today());
  // 4 (the finisher's tries) + 6 (a standalone flush from someone who never
  // finished) — the attempted series counts runs STARTED, so it must include
  // players who have no finish row at all.
  assert.equal(row.attempts, 10);
  assert.equal(row.finishes, 1);
  assert.equal(d.totals.finishes, 1);
  assert.equal(d.totals.attempts, 10);
});

test("attempts accumulate across ingests into one bucket per day", async (t) => {
  const race = await freshDb(t);
  for (let i = 0; i < 3; i++) {
    await race.ingest({
      version: VER, map: "e2m2", source: "racelog",
      records: [{ ...finish("Nova", 50000 - i), attempts: 2 }],
    });
  }
  const d = await race.runActivity({ days: 30 });
  assert.equal(at(d, today()).attempts, 6);
  // One row per (day, server) — the upsert must add, not insert a second row.
  const rows = await race.pool.query("SELECT COUNT(*)::int n FROM run_activity_daily");
  assert.equal(rows.rows[0].n, 1);
});

test("a topscores re-sync adds no attempt volume", async (t) => {
  const race = await freshDb(t);
  // A mirror refresh resends the whole top-50 every interval. Counting it would
  // invent daily volume out of a sync, so the bucket is racelog-only.
  await race.ingest({
    version: VER, map: "e2m2", source: "topscores",
    records: [{ ...finish("Nova", 50000), attempts: 99 }],
  });
  const d = await race.runActivity({ days: 30 });
  assert.equal(d.totals.attempts, 0);
  assert.equal(d.attemptsFrom, null);
});

test("days before attempt tracking began are null, not zero", async (t) => {
  const race = await freshDb(t);
  // A finish 10 days ago, from before there was any attempt bucket...
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog", records: [finish("Old", 60000)],
  });
  const old = new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 10);
  await backdate(race, old);
  await race.pool.query("DELETE FROM run_activity_daily"); // tracking had not shipped yet
  // ...and a finish today, with attempts recorded.
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("New", 55000), attempts: 3 }],
  });

  const d = await race.runActivity({ days: 30 });
  assert.equal(d.attemptsFrom, today());
  assert.equal(d.finishesFrom, old);

  // The old day has a real finish and NO attempt figure. Zero would claim one
  // run was finished out of zero attempts, which is impossible.
  assert.equal(at(d, old).finishes, 1);
  assert.equal(at(d, old).attempts, null);
  assert.equal(at(d, today()).attempts, 3);

  // A quiet day INSIDE the tracked span is a genuine zero, not a null.
  assert.ok(d.points.length > 2);
  for (const p of d.points) {
    if (p.day > old && p.day < today()) assert.equal(p.finishes, 0);
    if (p.day < d.attemptsFrom) assert.equal(p.attempts, null);
  }
});

test("the completion rate is taken only from buckets carrying both series", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog", records: [finish("Old", 60000)],
  });
  const old = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
  await backdate(race, old);
  await race.pool.query("DELETE FROM run_activity_daily");
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("New", 55000), attempts: 4 }],
  });

  const d = await race.runActivity({ days: 30 });
  const ov = d.totals.overlap;
  // Only today has both. The untracked day's lone finish must NOT inflate the
  // numerator against attempts that were never counted.
  assert.equal(ov.finishes, 1);
  assert.equal(ov.attempts, 4);
  assert.equal(ov.rate, 0.25);
  // The headline totals still describe everything drawn.
  assert.equal(d.totals.finishes, 2);
});

test("weekly buckets sum the days inside each week", async (t) => {
  const race = await freshDb(t);
  // Seed attempts across five full weeks so the fold is exercised on whole
  // weeks rather than on the ragged current one.
  const day0 = new Date(Date.now() - 35 * 86400_000);
  for (let i = 0; i < 35; i++) {
    const iso = new Date(day0.getTime() + i * 86400_000).toISOString().slice(0, 10);
    await race.pool.query(
      "INSERT INTO run_activity_daily (day, server_id, attempts) VALUES ($1::date, 1, 2)",
      [iso]
    );
  }
  const d = await race.runActivity({ days: 90, bucket: "week" });
  assert.equal(d.bucket, "week");
  // Every bucket is a Monday.
  for (const p of d.points) assert.equal(new Date(p.day + "T00:00:00Z").getUTCDay(), 1);
  // A week fully inside the seeded span is 7 days x 2 attempts.
  const whole = d.points.filter((p) => !p.partial && p.attempts != null);
  assert.ok(whole.length >= 3);
  for (const p of whole) assert.equal(p.attempts, 14);
  // The current week is incomplete and flagged so the page can dash it rather
  // than let a mid-week total read as a collapse in activity.
  assert.equal(d.points[d.points.length - 1].partial, true);
});

test("a week only half-covered by the attempt series is null, not a dip", async (t) => {
  const race = await freshDb(t);
  // Tracking begins mid-week: that week holds real attempts, but only some of
  // its days. Reporting the partial sum next to whole weeks would draw a crash
  // in activity where there was only the edge of the data.
  const wed = "2026-08-12"; // a Wednesday
  await race.pool.query(
    "INSERT INTO run_activity_daily (day, server_id, attempts) VALUES ($1::date, 1, 9)",
    [wed]
  );
  const d = await race.runActivity({ days: 0, bucket: "week" });
  assert.equal(d.attemptsFrom, wed);
  const wk = at(d, "2026-08-10"); // the Monday of that week
  assert.equal(wk.attempts, null);
});

// The finish log only began in 2026-07; anything plotted before it comes from
// demos imported later. A near-empty leading stretch therefore means "not
// logged yet", not "nobody raced" — the page has to be able to say which.
test("a sparse leading stretch of the finish log is reported", async (t) => {
  const race = await freshDb(t);
  await race.pool.query("INSERT INTO map (name) VALUES ('e2m2')");
  await race.pool.query("INSERT INTO version (name) VALUES ('wsw 2.1')");
  await race.pool.query("INSERT INTO player (name,simplified,trimmed,login) VALUES ('R','R','R','')");
  const add = (daysAgo, n) =>
    race.pool.query(
      `INSERT INTO finish (player_id,map_id,version_id,time,server_id,created_at)
       SELECT 1,1,1,40000,1,$1 FROM generate_series(1,$2)`,
      [Math.floor(Date.now() / 1000) - daysAgo * 86400, n]
    );
  // Six lone imported runs spread over the older half of the window...
  for (let d = 300; d > 150; d -= 25) await add(d, 1);
  // ...then a dense log for the last 60 days.
  for (let d = 60; d >= 0; d--) await add(d, 5);

  const d = await race.runActivity({ days: 365 });
  assert.ok(d.finishesSparseBefore, "expected a sparse leading stretch to be detected");
  // It ends in the gap before the dense log starts, not inside it.
  const dense = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  assert.ok(d.finishesSparseBefore < dense, `${d.finishesSparseBefore} should precede ${dense}`);
});

test("a consistently active log reports no sparse stretch", async (t) => {
  const race = await freshDb(t);
  await race.pool.query("INSERT INTO map (name) VALUES ('e2m2')");
  await race.pool.query("INSERT INTO version (name) VALUES ('wsw 2.1')");
  await race.pool.query("INSERT INTO player (name,simplified,trimmed,login) VALUES ('R','R','R','')");
  for (let d = 200; d >= 0; d--) {
    await race.pool.query(
      `INSERT INTO finish (player_id,map_id,version_id,time,server_id,created_at)
       SELECT 1,1,1,40000,1,$1 FROM generate_series(1,4)`,
      [Math.floor(Date.now() / 1000) - d * 86400]
    );
  }
  const d = await race.runActivity({ days: 365 });
  // Nothing to warn about, so the page says nothing.
  assert.equal(d.finishesSparseBefore, null);
});

// The cumulative counter predates dated recording by years, so the page shows it
// as a headline figure. It must never be folded into the plotted series — those
// two numbers overlap, and adding them would double-count every recent attempt.
test("the all-time attempt counter is reported separately from the dated series", async (t) => {
  const race = await freshDb(t);
  // Historic attempts with no dated bucket at all — the pre-tracking era.
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("Old", 60000), attempts: 500 }],
  });
  await race.pool.query("DELETE FROM run_activity_daily");

  let d = await race.runActivity({ days: 30 });
  assert.equal(d.lifetimeAttempts, 500, "the counter survives even with no dated rows");
  assert.equal(d.totals.attempts, 0, "the undateable counter must not enter the plotted total");
  assert.equal(d.attemptsFrom, null);

  // Once dated recording starts, the two coexist: the counter keeps climbing and
  // the series reports only what it can actually place on a day.
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("New", 55000), attempts: 7 }],
  });
  d = await race.runActivity({ days: 30 });
  assert.equal(d.lifetimeAttempts, 507);
  assert.equal(d.totals.attempts, 7);
});

test("the all-time finish counter is reported separately from the finish log", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [finish("Old", 60000), finish("Older", 61000)],
  });
  // The pre-log era: run_tally counted these finishes, but no dated row exists
  // for them. That is the real shape of the production data, where the counter
  // holds ~240k finishes and the log a few thousand.
  await race.pool.query("DELETE FROM finish");

  let d = await race.runActivity({ days: 30 });
  assert.equal(d.lifetimeFinishes, 2, "the counter survives with no dated finish rows");
  assert.equal(d.totals.finishes, 0, "the undateable counter must not enter the plotted total");
  assert.equal(d.finishesFrom, null);

  // Both keep their own books once the log is recording again.
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [finish("New", 55000)],
  });
  d = await race.runActivity({ days: 30 });
  assert.equal(d.lifetimeFinishes, 3);
  assert.equal(d.totals.finishes, 1);
});

test("only the newest bucket is flagged as still filling", async (t) => {
  const race = await freshDb(t);
  await race.ingest({
    version: VER, map: "e2m2", source: "racelog",
    records: [{ ...finish("Nova", 50000), attempts: 2 }],
  });
  const d = await race.runActivity({ days: 30 });
  // Today is mid-day: the page dashes it so a part-day total does not read as a
  // collapse. Every earlier day is complete and must NOT be flagged.
  assert.equal(d.points[d.points.length - 1].day, today());
  assert.equal(d.points[d.points.length - 1].partial, true);
  for (const p of d.points.slice(0, -1)) assert.notEqual(p.partial, true);
});

test("an empty database yields no series rather than a wall of zeros", async (t) => {
  const race = await freshDb(t);
  const d = await race.runActivity({ days: 30 });
  assert.equal(d.finishesFrom, null);
  assert.equal(d.attemptsFrom, null);
  assert.equal(d.totals.finishes, 0);
  assert.equal(d.totals.attempts, 0);
  assert.equal(d.totals.overlap.rate, null);
  // Nothing has ever happened, so every point is null on both series.
  for (const p of d.points) {
    assert.equal(p.finishes, null);
    assert.equal(p.attempts, null);
  }
});

test("windows and buckets outside the allow-list fall back to the defaults", async (t) => {
  const race = await freshDb(t);
  const d = await race.runActivity({ days: 7777, bucket: "fortnight" });
  assert.equal(d.days, 90);
  assert.equal(d.bucket, "day");
});
