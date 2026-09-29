// The maps page's "where did this map come from" dropdown: show everything,
// only the /mapgen-built courses, or only the hand-made pool.
//
// "Generated" is the GENERATED_MAP_PREFIX name test — the same one the ratings
// flag and the standings rebuild use — not a join on mapgen_job, so a map whose
// job an admin hid still filters as generated.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, GENERATED_MAP_PREFIX } from "../db.js";
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

// A map row exists once anyone has finished on it OR once the catalog seeds it;
// map_index (what maps() reads) is rebuilt by refreshAggregates.
async function seed(race, names) {
  for (const name of names) {
    await race.pool.query("INSERT INTO map (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }
  await race.refreshAggregates();
}

const CLASSIC = ["coldrun", "aurora-speed1", "un-dead!020_3"];
const GENERATED = ["gen_first_light", "gen_sweep_and_plunge_a4ce1f"];

const namesOf = (d) => d.rows.map((r) => r.name).sort();

test("no origin filter lists generated and hand-made maps together", async (t) => {
  const race = await freshDb(t);
  await seed(race, [...CLASSIC, ...GENERATED]);

  const d = await race.maps({ limit: 50 });
  assert.equal(d.total, 5);
  assert.deepEqual(namesOf(d), [...CLASSIC, ...GENERATED].sort());
});

test("origin=gen returns only the generated maps", async (t) => {
  const race = await freshDb(t);
  await seed(race, [...CLASSIC, ...GENERATED]);

  const d = await race.maps({ origin: "gen", limit: 50 });
  assert.equal(d.total, 2);
  assert.deepEqual(namesOf(d), GENERATED.slice().sort());
});

test("origin=classic hides the generated maps", async (t) => {
  const race = await freshDb(t);
  await seed(race, [...CLASSIC, ...GENERATED]);

  const d = await race.maps({ origin: "classic", limit: 50 });
  assert.equal(d.total, 3);
  assert.deepEqual(namesOf(d), CLASSIC.slice().sort());
});

test("an unknown origin value filters nothing rather than erroring", async (t) => {
  const race = await freshDb(t);
  await seed(race, [...CLASSIC, ...GENERATED]);

  for (const origin of ["", "banana", "GEN", null, undefined]) {
    const d = await race.maps({ origin, limit: 50 });
    assert.equal(d.total, 5, `origin=${String(origin)} should not filter`);
  }
});

test("the prefix's underscore is literal, not a LIKE wildcard", async (t) => {
  const race = await freshDb(t);
  // "genx-something" shares the three letters but is NOT a generated map: a
  // naive ILIKE 'gen_%' would match it, because '_' is LIKE's any-character.
  await seed(race, ["genx-canyon", "generator-run", ...GENERATED]);

  const gen = await race.maps({ origin: "gen", limit: 50 });
  assert.deepEqual(namesOf(gen), GENERATED.slice().sort());

  const classic = await race.maps({ origin: "classic", limit: 50 });
  assert.deepEqual(namesOf(classic), ["generator-run", "genx-canyon"]);
});

test("origin is case-insensitive about the map's own name", async (t) => {
  const race = await freshDb(t);
  // Map names reach us in whatever case the server reported.
  await seed(race, ["GEN_Shouty_Course", "coldrun"]);

  const d = await race.maps({ origin: "gen", limit: 50 });
  assert.deepEqual(namesOf(d), ["GEN_Shouty_Course"]);
});

test("origin composes with the name search and the blocklist", async (t) => {
  const race = await freshDb(t);
  await seed(race, [...GENERATED, "gen_dusty_ruin", "coldrun"]);

  // Name search narrows within the generated set.
  const q = await race.maps({ origin: "gen", q: "dusty", limit: 50 });
  assert.deepEqual(namesOf(q), ["gen_dusty_ruin"]);

  // A blocked generated map drops out of the generated list too.
  const row = await race.one("SELECT id FROM map WHERE name = $1", ["gen_dusty_ruin"]);
  await race.pool.query(
    "INSERT INTO map_block (map_id, reason, blocked_at) VALUES ($1, $2, $3)",
    [row.id, "test", Math.floor(Date.now() / 1000)]
  );
  await race.refreshAggregates();

  const after = await race.maps({ origin: "gen", limit: 50 });
  assert.equal(after.total, 2);
  assert.ok(!namesOf(after).includes("gen_dusty_ruin"));
});

test("GENERATED_MAP_PREFIX is what the filter is built on", async (t) => {
  // Guards the filter against a drifting prefix: if the constant changes, the
  // dropdown must follow it rather than keeping a hardcoded "gen_".
  assert.equal(GENERATED_MAP_PREFIX, "gen_");
  const race = await freshDb(t);
  await seed(race, [GENERATED_MAP_PREFIX + "whatever", "coldrun"]);
  const d = await race.maps({ origin: "gen", limit: 50 });
  assert.deepEqual(namesOf(d), [GENERATED_MAP_PREFIX + "whatever"]);
});
