// The generated-map rating flag: whether maps named gen_* (tools/mapgen) count
// toward the standings (Points, Skill Rating, maps / WR / podium totals).
// Off by default; an admin turns it on at /admin/mapgen.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase, isGeneratedMap, mapgenRatedValue, SETTING_MAPGEN_RATED, SR_MU,
} from "../db.js";
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

// Six ordinary maps and six generated ones, each with a contested field.
// Hybrid races both kinds; GenOnly races only the generated maps and wins
// them all; Regular races only the ordinary ones.
async function seed(race) {
  for (let m = 0; m < 6; m++) {
    await race.ingest({ version: VER, map: `plain${m}`, source: "racelog",
      records: [finish("Regular", 30000), finish("Hybrid", 31000), finish("Filler", 40000)] });
    await race.ingest({ version: VER, map: `gen_course_${m}`, source: "racelog",
      records: [finish("GenOnly", 20000), finish("Hybrid", 20500), finish("Filler", 30000)] });
  }
  await race.refreshAggregates();
}

async function board(race) {
  const rows = (await race.players({ sort: "points", limit: 200 })).rows;
  return new Map(rows.map((r) => [r.simplified, r]));
}

test("helpers: the gen_ prefix and the stored flag value", () => {
  assert.equal(isGeneratedMap("gen_kickflip"), true);
  assert.equal(isGeneratedMap("GEN_Kickflip"), true);
  assert.equal(isGeneratedMap("general_map"), false);   // "gen" is not "gen_"
  assert.equal(isGeneratedMap("cpm_gen_1"), false);
  assert.equal(mapgenRatedValue("1"), true);
  for (const v of ["0", "", "true", null, undefined]) assert.equal(mapgenRatedValue(v), false);
});

test("off by default: generated maps are left out of every standing", async (t) => {
  const race = await freshDb(t);
  await seed(race);
  assert.equal(await race.mapgenRated(), false);
  const b = await board(race);

  // GenOnly has records, but none on a counted map: no standings row at all.
  assert.equal(b.has("GenOnly"), false);
  // Hybrid is measured on the six ordinary maps only.
  const hybrid = b.get("Hybrid");
  assert.equal(hybrid.maps, 6);
  assert.equal(hybrid.wr, 0, "Hybrid's generated-map podiums don't count");
  assert.equal(hybrid.points, 6 * 85, "2nd on six ordinary maps");
  assert.equal(b.get("Regular").points, 6 * 100);

  // The SR breakdown lists the same maps the rating is made of.
  const bd = await race.srBreakdown(Number(hybrid.id ?? hybrid.playerId));
  assert.ok(bd, "breakdown exists");
  const names = JSON.stringify(bd);
  assert.ok(!names.includes("gen_course_"), "no generated map in the breakdown");

  // Records and the map page are unaffected, and say the map isn't rated.
  const genMap = (await race.maps({ limit: 50 })).rows.find((m) => m.name === "gen_course_0");
  const detail = await race.mapDetail(genMap.id);
  assert.equal(detail.rated, false);
  assert.equal(detail.leaderboard.length, 3);
  assert.equal(detail.wr.time, 20000);
  const plain = (await race.maps({ limit: 50 })).rows.find((m) => m.name === "plain0");
  assert.equal((await race.mapDetail(plain.id)).rated, true);
});

test("turned on: generated maps count like any other", async (t) => {
  const race = await freshDb(t);
  await seed(race);
  await race.setSetting(SETTING_MAPGEN_RATED, "1", "tester");
  await race.refreshAggregates();
  assert.equal(await race.mapgenRated(), true);
  const b = await board(race);

  const gen = b.get("GenOnly");
  assert.ok(gen, "GenOnly now has a standing");
  assert.equal(gen.maps, 6);
  assert.equal(gen.wr, 6);
  assert.equal(gen.points, 6 * 100);
  assert.ok(gen.sr > Math.round(1000 * SR_MU), "six contested WRs lift SR above the prior");

  const hybrid = b.get("Hybrid");
  assert.equal(hybrid.maps, 12);
  assert.equal(hybrid.points, 12 * 85);

  const bd = await race.srBreakdown(Number(hybrid.id ?? hybrid.playerId));
  assert.ok(JSON.stringify(bd).includes("gen_course_"), "generated maps in the breakdown");

  const genMap = (await race.maps({ limit: 50 })).rows.find((m) => m.name === "gen_course_0");
  assert.equal((await race.mapDetail(genMap.id)).rated, true);

  // And back off again: the next rebuild drops them.
  await race.setSetting(SETTING_MAPGEN_RATED, "0", "tester");
  await race.refreshAggregates();
  assert.equal((await board(race)).has("GenOnly"), false);
});
