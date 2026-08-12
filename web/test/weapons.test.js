// Tests for map weapon tagging: the pure weapon helpers (token/classname
// resolution, strafe rule), the game-server plain-text endpoint feed, and the
// website maps() weapon/strafe filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.js";
import { createTestDb } from "./pg-util.js";
import { tokenToCode, isStrafe, codesFromEntities } from "../weapons.js";

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

async function setWeapons(race, name, codes) {
  await race.pool.query(
    `INSERT INTO map_weapon (name, weapons, is_strafe) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET weapons = EXCLUDED.weapons, is_strafe = EXCLUDED.is_strafe`,
    [name, codes, isStrafe(codes)]
  );
}

test("tokenToCode accepts 2-char codes, full names and aliases", () => {
  assert.equal(tokenToCode("rl"), "rl");
  assert.equal(tokenToCode("rocket"), "rl");
  assert.equal(tokenToCode("rocketlauncher"), "rl");
  assert.equal(tokenToCode("PG"), "pg");
  assert.equal(tokenToCode("plasma"), "pg");
  assert.equal(tokenToCode("shotgun"), "rg"); // riotgun alias
  assert.equal(tokenToCode(" Electro "), "eb");
  assert.equal(tokenToCode("strafe"), null); // handled separately, not a weapon
  assert.equal(tokenToCode("nope"), null);
  assert.equal(tokenToCode(""), null);
});

test("isStrafe ignores the gunblade every player already carries", () => {
  assert.equal(isStrafe([]), true);
  assert.equal(isStrafe(["gb"]), true);
  assert.equal(isStrafe(["rl"]), false);
  assert.equal(isStrafe(["gb", "rl"]), false);
});

test("codesFromEntities maps weapon_* classnames, deduped in canonical order", () => {
  const ents = `
    { "classname" "worldspawn" }
    { "classname" "weapon_rocketlauncher" "origin" "0 0 0" }
    { "classname" "info_player_start" }
    { "classname"  "weapon_plasmagun" }
    { "classname" "weapon_rocketlauncher" }
    { "classname" "weapon_gunblade" }
    { "classname" "item_health" }
  `;
  // canonical order is gb, mg, rg, gl, rl, pg, ... so gb precedes rl precedes pg.
  assert.deepEqual(codesFromEntities(ents), ["gb", "rl", "pg"]);
  assert.deepEqual(codesFromEntities(""), []);
  assert.deepEqual(codesFromEntities("{ \"classname\" \"weapon_unknownthing\" }"), []);
});

test("gameMapWeaponsText: sorted, codes joined, strafe map is a bare name", async (t) => {
  const race = await freshDb(t);
  await setWeapons(race, "z_rocket", ["rl"]);
  await setWeapons(race, "a_strafe", []);
  await setWeapons(race, "m_mixed", ["rl", "pg"]);
  const text = await race.gameMapWeaponsText();
  assert.equal(text, "a_strafe\nm_mixed rl pg\nz_rocket rl");
});

test("maps() ?weapon= filters by weapon, AND across multiple, and strafe union", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "rocketmap", source: "racelog", records: [finish("A", 50000)] });
  await race.ingest({ version: VER, map: "plasmamap", source: "racelog", records: [finish("A", 51000)] });
  await race.ingest({ version: VER, map: "bothmap", source: "racelog", records: [finish("A", 52000)] });
  await race.ingest({ version: VER, map: "puremap", source: "racelog", records: [finish("A", 53000)] });
  await race.ingest({ version: VER, map: "coolstrafe", source: "racelog", records: [finish("A", 54000)] });
  await race.refreshAggregates();

  await setWeapons(race, "rocketmap", ["rl"]);
  await setWeapons(race, "plasmamap", ["pg"]);
  await setWeapons(race, "bothmap", ["rl", "pg"]);
  await setWeapons(race, "puremap", []); // scanned strafe
  await setWeapons(race, "coolstrafe", ["rl"]); // has a weapon, but name says strafe

  const names = async (weapon) => (await race.maps({ weapon, limit: 100 })).rows.map((r) => r.name).sort();

  // coolstrafe also carries an rl (its name is strafe-y but it has a weapon).
  assert.deepEqual(await names("rl"), ["bothmap", "coolstrafe", "rocketmap"]);
  assert.deepEqual(await names("rocket"), ["bothmap", "coolstrafe", "rocketmap"]); // alias
  assert.deepEqual(await names("rl pg"), ["bothmap"]); // AND
  // strafe = scanned-strafe (puremap) UNION name-contains-strafe (coolstrafe).
  assert.deepEqual(await names("strafe"), ["coolstrafe", "puremap"]);
  assert.equal((await race.maps({ limit: 100 })).total, 5); // no filter = everything
});

test("maps() rows expose weapons + is_strafe for badges", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "rocketmap", source: "racelog", records: [finish("A", 50000)] });
  await race.ingest({ version: VER, map: "puremap", source: "racelog", records: [finish("A", 51000)] });
  await race.refreshAggregates();
  await setWeapons(race, "rocketmap", ["rl", "pg"]);
  await setWeapons(race, "puremap", []);

  const byName = Object.fromEntries((await race.maps({ limit: 100 })).rows.map((r) => [r.name, r]));
  assert.deepEqual(byName.rocketmap.weapons, ["rl", "pg"]);
  assert.equal(byName.rocketmap.is_strafe, false);
  assert.deepEqual(byName.puremap.weapons, []);
  assert.equal(byName.puremap.is_strafe, true);
});

// --- slick (icy floor) tagging ----------------------------------------------
// The measured fraction lives in its own column; the "sl" tag the game votes on
// is derived from it at read time (see gameMapWeaponsText / SLICK_MIN_FRAC).

async function setSlick(race, name, frac) {
  await race.pool.query(
    `INSERT INTO map_weapon (name, weapons, is_strafe, slick_frac)
     VALUES ($1, '{}', true, $2)
     ON CONFLICT (name) DO UPDATE SET slick_frac = EXCLUDED.slick_frac`,
    [name, frac]
  );
}

test("gameMapWeaponsText appends the sl tag for slick maps only", async (t) => {
  const race = await freshDb(t);
  await setWeapons(race, "a_icy", []);
  await setSlick(race, "a_icy", 0.6);
  await setWeapons(race, "b_trace", ["rl"]);
  await setSlick(race, "b_trace", 0.01); // below threshold: some slick, not a slick map
  await setWeapons(race, "c_icyrocket", ["rl"]);
  await setSlick(race, "c_icyrocket", 0.4);
  await setWeapons(race, "d_dry", ["pg"]);

  const text = await race.gameMapWeaponsText();
  assert.equal(text, "a_icy sl\nb_trace rl\nc_icyrocket rl sl\nd_dry pg");
});

test("maps() ?weapon=slick filters on the measured fraction and ANDs with weapons", async (t) => {
  const race = await freshDb(t);
  for (const [i, m] of ["icymap", "icyrocket", "tracemap", "drymap"].entries()) {
    await race.ingest({ version: VER, map: m, source: "racelog", records: [finish("A", 50000 + i)] });
  }
  await race.refreshAggregates();
  await setWeapons(race, "icymap", []);
  await setSlick(race, "icymap", 0.6);
  await setWeapons(race, "icyrocket", ["rl"]);
  await setSlick(race, "icyrocket", 0.35);
  await setWeapons(race, "tracemap", ["rl"]);
  await setSlick(race, "tracemap", 0.01); // below SLICK_MIN_FRAC
  await setWeapons(race, "drymap", ["rl"]);

  const names = async (weapon) => (await race.maps({ weapon, limit: 100 })).rows.map((r) => r.name).sort();
  assert.deepEqual(await names("slick"), ["icymap", "icyrocket"]);
  assert.deepEqual(await names("ice"), ["icymap", "icyrocket"]); // alias
  assert.deepEqual(await names("rl slick"), ["icyrocket"]);      // AND with a weapon
  assert.deepEqual(await names("rl"), ["drymap", "icyrocket", "tracemap"]);
});

test("maps() rows expose slick_pct + is_slick for the badge", async (t) => {
  const race = await freshDb(t);
  await race.ingest({ version: VER, map: "icymap", source: "racelog", records: [finish("A", 50000)] });
  await race.ingest({ version: VER, map: "tracemap", source: "racelog", records: [finish("A", 51000)] });
  await race.ingest({ version: VER, map: "drymap", source: "racelog", records: [finish("A", 52000)] });
  await race.refreshAggregates();
  await setSlick(race, "icymap", 0.342);
  await setSlick(race, "tracemap", 0.02);

  const byName = Object.fromEntries((await race.maps({ limit: 100 })).rows.map((r) => [r.name, r]));
  assert.equal(byName.icymap.slick_pct, 34);
  assert.equal(byName.icymap.is_slick, true);
  // Some slick, but not a slick map: the badge still shows, dimmed.
  assert.equal(byName.tracemap.slick_pct, 2);
  assert.equal(byName.tracemap.is_slick, false);
  // Never scanned for slick at all -> 0, and no badge.
  assert.equal(byName.drymap.slick_pct, 0);
  assert.equal(byName.drymap.is_slick, false);
});
