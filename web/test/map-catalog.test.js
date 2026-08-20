// Cataloguing the INSTALLED map pool: a map that ships in a pk3 should be
// findable on the site before anyone has raced it.
//
// The guarantee being tested is end-to-end, not just "the insert worked": a
// freshly catalogued map has to survive refreshAggregates() and come back out
// of maps() — the query /maps and the search actually read — with zeroed stats
// rather than being dropped by one of its joins.
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

test("a catalogued map is browsable with no records at all", async (t) => {
  const race = await freshDb(t);
  const { considered, created } = await race.ensureMapsByName(["neverraced1", "neverraced2"]);
  assert.equal(considered, 2);
  assert.deepEqual(created.sort(), ["neverraced1", "neverraced2"]);

  // map_index is derived and rebuilt wholesale, so the row is not visible until
  // the refresh — this is the step the seeder must not skip.
  await race.refreshAggregates();

  const page = await race.maps({ q: "neverraced" });
  assert.equal(page.total, 2, "both catalogued maps are listed");
  const row = page.rows.find((r) => r.name === "neverraced1");
  assert.ok(row, "the map comes back out of maps()");
  assert.ok(row.id > 0, "it has a real id, so /map/:id resolves");
  assert.equal(row.records, 0);
  assert.equal(row.players, 0);
  assert.equal(row.wr_time, null, "no world record yet");
  assert.equal(row.last_played, null, "never played");
});

test("cataloguing is idempotent and never disturbs an existing map", async (t) => {
  const race = await freshDb(t);
  // A map with real history.
  await race.ingest({
    version: "wsw 2.1",
    map: "raced",
    source: "racelog",
    records: [{ name: "nova", login: "", time: 12345, checkpoints: [] }],
  });
  const before = await race.one("SELECT id, name FROM map WHERE name = 'raced'");

  const first = await race.ensureMapsByName(["raced", "fresh"]);
  assert.deepEqual(first.created, ["fresh"], "only the unknown map is created");

  const second = await race.ensureMapsByName(["raced", "fresh"]);
  assert.deepEqual(second.created, [], "a re-run creates nothing");

  const after = await race.one("SELECT id, name FROM map WHERE name = 'raced'");
  assert.equal(Number(after.id), Number(before.id), "the existing map keeps its id");

  await race.refreshAggregates();
  const raced = (await race.maps({ q: "raced" })).rows.find((r) => r.name === "raced");
  assert.equal(raced.records, 1, "its history is untouched");
});

test("cataloguing applies the same name gate as every other mint", async (t) => {
  const race = await freshDb(t);
  const { created } = await race.ensureMapsByName([
    "GoodName",          // uppercase is normalised, not rejected
    "  ",                // blank
    "../etc/passwd",     // traversal
    "-leading-dash",     // must start alphanumeric
    "has space",
    "has;semicolon",     // would end a console command
    "good-name_2.0",
    null,
    "dupe", "dupe",      // de-duplicated before the insert
  ]);
  assert.deepEqual(created.sort(), ["dupe", "good-name_2.0", "goodname"]);

  const names = (await race.all("SELECT name FROM map ORDER BY name")).map((r) => r.name);
  assert.deepEqual(names, ["dupe", "good-name_2.0", "goodname"]);
});

test("cataloguing does not resurrect a blocked map onto the maps page", async (t) => {
  const race = await freshDb(t);
  await race.ensureMapsByName(["hiddenmap"]);
  const id = Number((await race.one("SELECT id FROM map WHERE name = 'hiddenmap'")).id);
  await race.blockMap(id, "broken", "tester");
  await race.refreshAggregates();

  // A moderator's block is curation that outranks "it is installed".
  assert.equal((await race.maps({ q: "hiddenmap" })).total, 0);
  // Re-running the seeder must not undo it.
  await race.ensureMapsByName(["hiddenmap"]);
  await race.refreshAggregates();
  assert.equal((await race.maps({ q: "hiddenmap" })).total, 0);
});
