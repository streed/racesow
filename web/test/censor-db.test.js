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
