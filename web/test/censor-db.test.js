// Integration tests for offensive-name censoring THROUGH the data layer: an
// ingested nick that trips the seeded word list must be masked in every display
// query (originals stay in the DB), while overrides + word-list edits take
// effect live. Each test uses a fresh throwaway PostgreSQL DB (migrations run at
// open, so the seed word list is present).
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
const fin = (name, time) => ({ name, login: "", time, checkpoints: [] });
const ingest = async (race, map, name, time) => {
  await race.ingest({ version: VER, map, source: "racelog", records: [fin(name, time)] });
  await race.refreshAggregates(); // build best/standings/map_index for the read queries
};

// id of the (canonical) player displayed on a map's leaderboard.
async function pidByMap(race, map) {
  const m = await race.one("SELECT id FROM map WHERE name = $1", [map]);
  return (await race.mapDetail(Number(m.id))).leaderboard[0].playerId;
}

test("seeded word list masks an offensive nick across display queries", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "e2m2", "^1Nigger^7", 40000); // seeded slur, colour-coded
  await ingest(race, "e2m2", "^4Nova^7", 45000); // clean

  // Map leaderboard: slur masked (colours kept), clean name untouched.
  const md = await race.mapDetail((await race.one("SELECT id FROM map WHERE name='e2m2'")).id);
  const names = md.leaderboard.map((r) => r.name);
  assert.ok(names.includes("^1******^7"), `expected masked, got ${JSON.stringify(names)}`);
  assert.ok(names.includes("^4Nova^7"));
  const simp = md.leaderboard.map((r) => r.simplified);
  assert.ok(simp.includes("******") && !simp.includes("Nigger"));

  // Player list + profile.
  const list = await race.players({});
  assert.ok(list.rows.some((r) => r.simplified === "******"));
  assert.ok(!list.rows.some((r) => /nigger/i.test(r.simplified)));

  // Search still FINDS the record (history intact) but shows it masked.
  const s = await race.search("nigger");
  assert.equal(s.players.length, 1, "record is still searchable");
  assert.equal(s.players[0].simplified, "******");

  // In-game plain-text payloads are masked too.
  const ranks = await race.gameRanksText("e2m2");
  assert.ok(ranks.includes("******") && !/nigger/i.test(ranks));
  const top = await race.gameTopscoresText("e2m2");
  assert.ok(!/nigger/i.test(top));

  // The ORIGINAL is preserved in the database (never mutated).
  const raw = await race.one("SELECT name, trimmed FROM player WHERE trimmed = 'nigger'");
  assert.equal(raw.name, "^1Nigger^7");
});

test("maps() listing censors the WR holder name", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "wrmap", "^1Nigger^7", 40000); // this nick holds the map WR
  const list = await race.maps({});
  const row = list.rows.find((r) => r.name === "wrmap");
  assert.ok(row, "map is listed");
  assert.equal(row.wr_simplified, "******");
  assert.ok(!/nigger/i.test(row.wr_name), `wr_name leaked: ${row.wr_name}`);
});

test("a nick that only trips via leet/separators is caught", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "e1m1", "n1gg3r", 40000); // leet
  await ingest(race, "e1m1", "wh|ore", 41000); // separator evasion
  const md = await race.mapDetail((await race.one("SELECT id FROM map WHERE name='e1m1'")).id);
  const simp = md.leaderboard.map((r) => r.simplified).sort();
  assert.ok(simp.includes("******"), `leet masked: ${JSON.stringify(simp)}`); // n1gg3r -> ******
  assert.ok(simp.includes("**|***"), `separator masked: ${JSON.stringify(simp)}`); // wh|ore -> **|***
});

test("per-player overrides: allow whitelists, censor force-masks", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "cpm1", "^1Nigger^7", 40000); // auto-censored
  await ingest(race, "cpm22", "InnocentDude", 40000); // clean

  const slurId = await pidByMap(race, "cpm1");
  const cleanId = await pidByMap(race, "cpm22");

  // allow => shown in full despite the word list.
  assert.equal(await race.setPlayerCensor(slurId, "allow", "reviewed", "test"), true);
  assert.equal((await race.playerDetail(slurId)).name, "^1Nigger^7");

  // censor => a clean nick is fully masked on demand.
  assert.equal(await race.setPlayerCensor(cleanId, "censor", "manual", "test"), true);
  assert.equal((await race.playerDetail(cleanId)).simplified, "************"); // 12 chars

  // clearing restores default behaviour for both.
  await race.clearPlayerCensor(slurId);
  await race.clearPlayerCensor(cleanId);
  assert.equal((await race.playerDetail(slurId)).simplified, "******"); // back to auto-censored
  assert.equal((await race.playerDetail(cleanId)).name, "InnocentDude"); // back to clean
});

test("word-list edits take effect live", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "toxic", "Bananaman", 40000); // not offensive

  assert.equal((await race.playerDetail(await pidByMap(race, "toxic"))).name, "Bananaman");
  await race.addCensorTerm("banana", "norm", "profanity", "test"); // silly, but proves the path
  assert.equal((await race.playerDetail(await pidByMap(race, "toxic"))).simplified, "******man");
  await race.removeCensorTerm("banana");
  assert.equal((await race.playerDetail(await pidByMap(race, "toxic"))).name, "Bananaman");
});

// id of a map by its (real) name.
async function mapId(race, name) {
  return Number((await race.one("SELECT id FROM map WHERE name = $1", [name])).id);
}

test("map names are masked across display queries; real name kept for lookups", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "pneumo-shit6", "Nova", 40000); // offensive map name
  await ingest(race, "cleanmap", "Nova", 41000); // clean

  // maps() listing: offensive map masked, clean untouched.
  const list = await race.maps({});
  const names = Object.fromEntries(list.rows.map((r) => [r.id, r.name]));
  const badId = await mapId(race, "pneumo-shit6");
  assert.equal(names[badId], "pneumo-****6");
  assert.equal(names[await mapId(race, "cleanmap")], "cleanmap");

  // mapDetail top-level name + search + recent finishes all mask it.
  assert.equal((await race.mapDetail(badId)).name, "pneumo-****6");
  assert.equal((await race.search("pneumo")).maps.find((m) => m.id === badId).name, "pneumo-****6");
  const feed = await race.recentFinishes({ limit: 20 });
  assert.ok(feed.some((f) => f.map === "pneumo-****6"));
  assert.ok(!feed.some((f) => /shit/.test(f.map)));

  // The stored name is untouched — the game/site still resolve the REAL name.
  assert.equal((await race.one("SELECT name FROM map WHERE id=$1", [badId])).name, "pneumo-shit6");
  assert.ok((await race.gameRanksText("pneumo-shit6")).length, "real name still resolves in-game");
});

test("map overrides: allow whitelists, censor force-masks", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "pneumo-shit6", "Nova", 40000); // auto-censored
  await ingest(race, "coolrun", "Nova", 41000); // clean
  const badId = await mapId(race, "pneumo-shit6");
  const cleanId = await mapId(race, "coolrun");

  assert.equal(await race.setMapCensor(badId, "allow", "fine", "test"), true);
  assert.equal((await race.mapDetail(badId)).name, "pneumo-shit6"); // shown in full

  assert.equal(await race.setMapCensor(cleanId, "censor", "manual", "test"), true);
  assert.equal((await race.mapDetail(cleanId)).name, "*******"); // "coolrun" -> 7 stars

  await race.clearMapCensor(badId);
  assert.equal((await race.mapDetail(badId)).name, "pneumo-****6"); // back to auto
});

test("map overrides apply by name too (sync display / live-snapshot spots)", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "coolrun", "Nova", 40000); // clean
  await ingest(race, "ok-cuntroll", "Nova", 41000); // word-list hit
  // Word-list masking works when only the name is known.
  assert.equal(race._cnMapByName("ok-cuntroll"), "ok-****roll");
  // Force-censoring a clean map is honoured by the name-keyed override.
  await race.setMapCensor(await mapId(race, "coolrun"), "censor", "x", "test");
  assert.equal(race._cnMapByName("coolrun"), "*******");
  // Allowing a word-list hit shows it in full, by name.
  await race.setMapCensor(await mapId(race, "ok-cuntroll"), "allow", "ok", "test");
  assert.equal(race._cnMapByName("ok-cuntroll"), "ok-cuntroll");
});

test("censoredMaps lists flagged + overridden maps for the admin UI", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "ok-cuntroll", "Nova", 40000);
  await ingest(race, "nicemap", "Nova", 41000);
  await race.setMapCensor(await mapId(race, "nicemap"), "censor", "manual", "test");

  const flagged = await race.censoredMaps();
  const byName = Object.fromEntries(flagged.map((f) => [f.name, f]));
  assert.ok(byName["ok-cuntroll"], "auto-flagged map is listed");
  assert.equal(byName["ok-cuntroll"].masked, "ok-****roll");
  assert.ok(byName["ok-cuntroll"].terms.some((tm) => tm.term === "cunt"));
  assert.ok(byName["nicemap"], "force-censored map is listed");
  assert.equal(byName["nicemap"].action, "censor");
});

test("censoredPlayers lists flagged + overridden players for the admin UI", async (t) => {
  const race = await freshDb(t);
  await ingest(race, "rev", "^1Nigger^7", 40000);
  await ingest(race, "rev2", "Cleanish", 41000);
  await race.setPlayerCensor(await pidByMap(race, "rev2"), "censor", "manual", "test");

  const flagged = await race.censoredPlayers();
  const bySimp = Object.fromEntries(flagged.map((f) => [f.simplified, f]));
  assert.ok(bySimp["Nigger"], "auto-flagged slur is listed");
  assert.equal(bySimp["Nigger"].action, null); // auto (no override)
  assert.ok(bySimp["Nigger"].terms.some((tm) => tm.term === "nigger"));
  assert.ok(bySimp["Cleanish"], "force-censored player is listed");
  assert.equal(bySimp["Cleanish"].action, "censor");
});
