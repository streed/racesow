// The public gallery of generated maps (/api/mapgen/gallery, db.mapgenGallery):
// which built maps it lists, in what order, with what, and what takes one out.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const token = () => crypto.randomBytes(16).toString("hex");

// A job row as the worker leaves it. `published` is the published_at time
// (null = never built); identity is set so the test can check it never leaks.
async function job(race, { name, status = "published", published = null, title = null, desc = "a course" }) {
  const t = token();
  await race.pool.query(
    `INSERT INTO mapgen_job (token, description, status, map_name, spec, report, identity, quota_day,
                             llm_usage, created_at, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-09-29', '{"est_usd": 0.2}', 1, $8)`,
    [t, desc, status, name, title ? JSON.stringify({ title, name }) : null,
     JSON.stringify({ par_seconds: 30, checkpoints: 2, features: [{ type: "slalom" }] }),
     crypto.randomBytes(16), published]
  );
  return t;
}

test("lists built maps only, newest first, with the public fields and nothing else", async (t) => {
  const race = await freshDb(t);
  await job(race, { name: "gen_old_aaaaaa", published: 100, title: "Old One", desc: "the first" });
  await job(race, { name: "gen_new_bbbbbb", status: "publishing", published: 300, title: "New One" });
  await job(race, { name: "gen_mid_cccccc", published: 200 });
  await job(race, { name: null, status: "queued" });
  await job(race, { name: "gen_fail_dddddd", status: "failed" });
  await job(race, { name: "gen_build_eeeeee", status: "building" });

  const d = await race.mapgenGallery();
  assert.equal(d.total, 3);
  assert.deepEqual(d.maps.map((m) => m.mapName), ["gen_new_bbbbbb", "gen_mid_cccccc", "gen_old_aaaaaa"]);
  const old = d.maps[2];
  assert.equal(old.title, "Old One");
  assert.equal(old.description, "the first");
  assert.equal(old.report.par_seconds, 30);
  assert.equal(d.maps[1].title, null, "no spec, no title");
  for (const m of d.maps) {
    for (const k of ["identity", "quota_day", "quotaDay", "llm_usage", "llmUsage", "spec", "id", "requested_by"]) {
      assert.ok(!(k in m), `${k} is never public`);
    }
    assert.equal(m.records, 0);
    assert.equal(m.mapId, null, "not raced, so the site has no map row yet");
  }

  const page = await race.mapgenGallery({ limit: 2, offset: 2 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.maps.map((m) => m.mapName), ["gen_old_aaaaaa"]);
  assert.equal((await race.mapgenGallery({ limit: 9999 })).limit, 60, "page size is capped");
});

test("carries the map's records and world record once raced", async (t) => {
  const race = await freshDb(t);
  await job(race, { name: "gen_raced_ffffff", published: 100 });
  await race.ingest({ version: "wsw 2.1", map: "gen_raced_ffffff", source: "racelog",
    records: [{ name: "Fast", login: "", time: 21500, checkpoints: [] },
              { name: "Slow", login: "", time: 30000, checkpoints: [] }] });
  await race.refreshAggregates();
  const [m] = (await race.mapgenGallery()).maps;
  assert.ok(m.mapId > 0);
  assert.equal(m.records, 2);
  assert.equal(m.wr_time, 21500);
  assert.equal(m.wr_name, "Fast");
});

test("a hidden job and a blocked map drop out; showing it again brings it back", async (t) => {
  const race = await freshDb(t);
  const a = await job(race, { name: "gen_keep_111111", published: 100 });
  const b = await job(race, { name: "gen_hide_222222", published: 200 });
  await job(race, { name: "gen_block_333333", published: 300 });
  await race.ingest({ version: "wsw 2.1", map: "gen_block_333333", source: "racelog",
    records: [{ name: "X", login: "", time: 20000, checkpoints: [] }] });
  const mapId = Number((await race.one("SELECT id FROM map WHERE name = 'gen_block_333333'")).id);
  assert.equal((await race.mapgenGallery()).total, 3);

  await race.blockMap(mapId, "broken", "mod");
  assert.equal(await race.mapgenSetHidden(b, true, "boss"), 1);
  let d = await race.mapgenGallery();
  assert.deepEqual(d.maps.map((m) => m.token), [a]);

  // The admin list still shows it, marked.
  const row = (await race.mapgenBuiltAdmin()).find((j) => j.token === b);
  assert.equal(row.hiddenBy, "boss");
  assert.ok(row.hiddenAt > 0);
  // The job page is unaffected.
  assert.equal((await race.mapgenJob(b)).mapName, "gen_hide_222222");

  assert.equal(await race.mapgenSetHidden(b, false, "boss"), 1);
  await race.unblockMap(mapId);
  d = await race.mapgenGallery();
  assert.equal(d.total, 3);
  assert.equal((await race.mapgenBuiltAdmin()).find((j) => j.token === b).hiddenAt, null);

  assert.equal(await race.mapgenSetHidden("not-a-token", true, "boss"), 0);
  assert.equal(await race.mapgenSetHidden(token(), true, "boss"), 0);
});
