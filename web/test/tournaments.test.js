// Tests for tournaments: entry-code minting and redemption, the scoring
// queries, the freeze-on-finalize contract (including its idempotency and its
// tie handling), trophies, recurring-series scheduling, and the plain-text feed
// the game servers poll.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js), so
// tests are independent and order-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, POINTS } from "../db.js";
import {
  MAP_POINTS,
  generateCode,
  normalizeCode,
  formatCode,
  parseAdminTime,
  toAdminTime,
  phaseOf,
  joinOpen,
  overlaps,
  validateTournament,
  gameTourneyText,
  CODE_LEN,
} from "../tournaments.js";
import { createTestDb } from "./pg-util.js";
import crypto from "node:crypto";

async function freshDb(t) {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  // The achievements seed migration ships starter definitions; tournaments add
  // none, but the evaluator would fire on ingest and slow every test here for
  // nothing.
  await race.pool.query("DELETE FROM achievement WHERE created_by = 'seed'");
  t.after(async () => {
    await race.close();
    await drop();
  });
  return race;
}

const VER = "wsw 2.1";
const HOUR = 3600;
const DAY = 86400;

async function ingestAt(race, map, name, time, at) {
  const r = await race.ingest({
    version: VER,
    map,
    source: "racelog",
    records: [{ name, login: "", time, checkpoints: [] }],
  });
  // The finish log stamps created_at = now; back-date it so a test can place a
  // run inside or outside a tournament window without waiting.
  if (at != null) {
    await race.pool.query(
      `UPDATE finish SET created_at = $1 WHERE id = (SELECT MAX(id) FROM finish)`,
      [at]
    );
  }
  return r;
}

// Create a published tournament over [start, end) with the given pool.
async function makeTournament(race, { slug = "cup", name = "Cup", start, end, maps, scoring = "points", repeat = 0 }) {
  const v = validateTournament({
    name,
    slug,
    description: "",
    startsAt: toAdminTime(start),
    endsAt: toAdminTime(end),
    scoring,
    status: "published",
    joinOpen: true,
    maps,
    repeatEveryDays: repeat,
    repeatGapDays: 1,
  });
  assert.equal(v.error, undefined, `unexpected validation error: ${v.error}`);
  const created = await race.createTournament(v.value, "test-admin");
  assert.ok(created, "createTournament returned null (slug collision?)");
  return race.tournamentById(created.id);
}

// Mint a code and redeem it for `name`, asserting success.
async function enter(race, tournamentId, name, now) {
  const entry = await race.createEntryCode(tournamentId, name);
  assert.ok(entry && entry.code, "no entry code minted");
  const r = await race.redeemEntryCode({ code: entry.code, name, login: "" }, now);
  assert.equal(r.ok, true, `redeem failed: ${r.reason}`);
  return entry.code;
}

/* ------------------------------- pure module ------------------------------ */

test("the tournament points curve is the site's own points curve", () => {
  // A tournament board that scored on a different scale to the Hall of Fame
  // would be a second, unfamiliar currency for the same act. Kept in lockstep
  // deliberately — this test is the lock.
  assert.deepEqual(MAP_POINTS, POINTS);
});

test("entry codes are typable, unambiguous and round-trip through normalisation", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const c = generateCode((n) => crypto.randomBytes(n));
    assert.equal(c.length, CODE_LEN);
    // No glyphs a player could misread off a screen and into a game console.
    assert.ok(!/[01ILOU]/.test(c), `ambiguous character in ${c}`);
    seen.add(c);
    // However a human retypes it, it must resolve to the same stored code.
    assert.equal(normalizeCode(c), c);
    assert.equal(normalizeCode(formatCode(c)), c);
    assert.equal(normalizeCode(formatCode(c).toLowerCase()), c);
    assert.equal(normalizeCode(` ${formatCode(c)} `), c);
  }
  assert.ok(seen.size > 490, `codes are not random enough: ${seen.size}/500 distinct`);
});

test("normalizeCode rejects rather than guessing at an impossible character", () => {
  // An O or a 1 can only be a mis-read. Folding it onto a plausible neighbour
  // would turn "that isn't a valid code" into the far more confusing
  // "no such code".
  assert.equal(normalizeCode("ABCDEFGO"), "");
  assert.equal(normalizeCode("ABCDEFG1"), "");
  assert.equal(normalizeCode("ABCDEFG"), ""); // too short
  assert.equal(normalizeCode("ABCDEFGHJ"), ""); // too long
  assert.equal(normalizeCode(""), "");
  assert.equal(normalizeCode(null), "");
});

test("admin times parse and round-trip as UTC, seconds included", () => {
  const ts = parseAdminTime("2026-08-05 18:30");
  assert.equal(new Date(ts * 1000).toISOString(), "2026-08-05T18:30:00.000Z");
  assert.equal(parseAdminTime("2026-08-05T18:30"), ts);
  // Seconds survive the round trip — back-to-back editions share a boundary
  // second, and re-saving a form must not move it.
  const withSecs = parseAdminTime("2026-08-05 18:30:45");
  assert.equal(parseAdminTime(toAdminTime(withSecs)), withSecs);
  // Nonsense dates are rejected, not silently rolled over by Date.UTC.
  assert.equal(parseAdminTime("2026-13-05 18:30"), null);
  assert.equal(parseAdminTime("2026-02-30 18:30"), null);
  assert.equal(parseAdminTime("whenever"), null);
});

test("phase is derived from the clock and terminal statuses outrank it", () => {
  const t = { status: "published", starts_at: 1000, ends_at: 2000 };
  assert.equal(phaseOf(t, 999), "upcoming");
  assert.equal(phaseOf(t, 1000), "live");
  assert.equal(phaseOf(t, 1999), "live");
  assert.equal(phaseOf(t, 2000), "ended"); // half-open window
  assert.equal(phaseOf({ ...t, status: "finalized" }, 1500), "finalized");
  assert.equal(phaseOf({ ...t, status: "cancelled" }, 1500), "cancelled");
  assert.equal(phaseOf({ ...t, status: "draft" }, 1500), "draft");
});

test("signups stay open for the whole window and close with it", () => {
  const t = { status: "published", starts_at: 1000, ends_at: 2000, join_open: true };
  assert.equal(joinOpen(t, 500), true); // before the start
  assert.equal(joinOpen(t, 1999), true); // right at the end
  assert.equal(joinOpen(t, 2000), false);
  assert.equal(joinOpen({ ...t, join_open: false }, 1500), false);
});

test("back-to-back editions sharing a boundary second do not count as overlapping", () => {
  assert.equal(overlaps(0, 10, 10, 20), false);
  assert.equal(overlaps(0, 11, 10, 20), true);
  assert.equal(overlaps(10, 20, 0, 15), true);
});

test("the admin form rejects the mistakes the schema cannot catch", () => {
  const base = {
    name: "Cup", slug: "", description: "", startsAt: "2026-08-01 00:00",
    endsAt: "2026-08-08 00:00", scoring: "points", status: "published",
    joinOpen: true, maps: "a\nb", repeatEveryDays: 0, repeatGapDays: 1,
  };
  assert.equal(validateTournament(base).error, undefined);
  assert.equal(validateTournament({ ...base, slug: "" }).value.slug, "cup"); // derived
  assert.match(validateTournament({ ...base, name: "" }).error, /name is required/);
  assert.match(validateTournament({ ...base, maps: "" }).error, /at least one map/);
  assert.match(validateTournament({ ...base, endsAt: "2026-08-01 00:30" }).error, /at least an hour/);
  assert.match(validateTournament({ ...base, endsAt: "2027-08-01 00:00" }).error, /at most 90 days/);
  assert.match(validateTournament({ ...base, startsAt: "nope" }).error, /YYYY-MM-DD/);
  // 'finalized' is something the finalizer does, never something a form sets.
  assert.match(validateTournament({ ...base, status: "finalized" }).error, /finalizer runs/);
  // Duplicate pool entries collapse rather than double-scoring a map.
  assert.deepEqual(validateTournament({ ...base, maps: "a\nb\na" }).value.mapNames, ["a", "b"]);
});

test("the game feed carries a multi-word name intact and survives an empty calendar", () => {
  assert.equal(gameTourneyText(null, []), "RSTOURNEY\n");
  const body = gameTourneyText(
    { id: 7, slug: "summer-sprint", starts_at: 100, ends_at: 200, name: "Summer\tSprint #3" },
    ["Hrace_Line", "pornstar"]
  );
  const lines = body.split("\n");
  assert.equal(lines[0], "RSTOURNEY");
  // Tabs inside the free-text name are scrubbed — they are the field delimiter.
  assert.equal(lines[1], "T\t7\tsummer-sprint\t100\t200\tSummer Sprint #3");
  assert.equal(lines[1].split("\t").length, 6);
  assert.equal(lines[2], "M\thrace_line"); // lowercased for the game
  assert.equal(lines[3], "M\tpornstar");
});

/* --------------------------------- database ------------------------------- */

test("a code binds an entry to the in-game identity that redeems it", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });

  const entry = await race.createEntryCode(tour.id, "typed on the website");
  assert.equal(normalizeCode(entry.code), entry.code);
  // Unclaimed codes are invisible to every public read.
  assert.equal((await race.tournamentEntrants(tour.id)).length, 0);

  const r = await race.redeemEntryCode({ code: entry.code, name: "^1Fast^7Guy", login: "" }, now);
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  const entrants = await race.tournamentEntrants(tour.id);
  assert.equal(entrants.length, 1);
  assert.equal(entrants[0].simplified, "FastGuy");

  // Redeeming again is a no-op success, not an error — a player who forgets
  // they entered should be told they are in, not that they did something wrong.
  const again = await race.redeemEntryCode({ code: entry.code, name: "^1Fast^7Guy", login: "" }, now);
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  assert.equal((await race.tournamentEntrants(tour.id)).length, 1);
});

test("a claimed code cannot be stolen, and nonsense codes are rejected cleanly", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });
  const entry = await race.createEntryCode(tour.id, "alice");
  await race.redeemEntryCode({ code: entry.code, name: "alice", login: "" }, now);

  const thief = await race.redeemEntryCode({ code: entry.code, name: "mallory", login: "" }, now);
  assert.equal(thief.ok, false);
  assert.equal(thief.reason, "code_used");

  const nobody = await race.redeemEntryCode({ code: "ZZZZZZZZ", name: "bob", login: "" }, now);
  assert.equal(nobody.ok, false);
  assert.equal(nobody.reason, "unknown_code");
});

test("a code cannot be redeemed once the tournament is over", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - 2 * DAY, end: now - DAY, maps: ["m1"] });
  const entry = await race.createEntryCode(tour.id, "late");
  const r = await race.redeemEntryCode({ code: entry.code, name: "late", login: "" }, now);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "closed");
});

test("in-game join enrols the nick outright and is idempotent", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });

  const first = await race.joinTournamentInGame({ tournamentId: tour.id, name: "solo", login: "" }, now);
  assert.equal(first.ok, true);
  assert.equal(first.already, false);
  assert.equal(normalizeCode(first.code), first.code);

  const second = await race.joinTournamentInGame({ tournamentId: tour.id, name: "solo", login: "" }, now);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal((await race.tournamentEntrants(tour.id)).length, 1);
});

test("only registered entrants' in-window runs on pool maps score", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - DAY;
  const end = now + DAY;
  const tour = await makeTournament(race, { start, end, maps: ["m1", "m2"] });

  await enter(race, tour.id, "alice", now);
  await enter(race, tour.id, "bob", now);
  // charlie never enters.

  await ingestAt(race, "m1", "alice", 10_000, now - HOUR);
  await ingestAt(race, "m1", "bob", 12_000, now - HOUR);
  await ingestAt(race, "m1", "charlie", 5_000, now - HOUR); // unregistered: ignored
  await ingestAt(race, "m2", "alice", 20_000, now - HOUR);
  await ingestAt(race, "m2", "bob", 19_000, now - HOUR);
  // Off-pool map, and an in-pool run outside the window: neither counts.
  await ingestAt(race, "other", "alice", 1_000, now - HOUR);
  await ingestAt(race, "m1", "bob", 1, start - HOUR);

  const board = await race.tournamentStandings(tour);
  assert.equal(board.length, 2, "an unregistered player leaked onto the board");
  const byName = Object.fromEntries(board.map((r) => [r.simplified, r]));

  // alice: m1 rank 1 (100) + m2 rank 2 (85) = 185. bob: m1 rank 2 (85) + m2 rank 1 (100) = 185.
  assert.equal(byName.alice.points, 185);
  assert.equal(byName.bob.points, 185);
  assert.equal(byName.alice.mapWins, 1);
  assert.equal(byName.bob.mapWins, 1);
  // Tied on points and wins, so total time decides the display order.
  assert.equal(byName.alice.totalTime, 30_000);
  assert.equal(byName.bob.totalTime, 31_000);
  assert.equal(board[0].simplified, "alice");
  // The out-of-window 1ms run must not have become bob's counted m1 time.
  assert.equal(byName.bob.detail.find((d) => d.map === "m1").time, 12_000);
});

test("a run set before entering still counts — entering late is not a penalty", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });
  // Race first...
  await ingestAt(race, "m1", "late", 9_000, now - 2 * HOUR);
  // ...then enter.
  await enter(race, tour.id, "late", now);
  const board = await race.tournamentStandings(tour);
  assert.equal(board.length, 1);
  assert.equal(board[0].points, 100);
});

test("time_sum ranks only players who finished every pool map", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, {
    start: now - DAY, end: now + DAY, maps: ["m1", "m2"], scoring: "time_sum",
  });
  await enter(race, tour.id, "complete", now);
  await enter(race, tour.id, "partial", now);
  await ingestAt(race, "m1", "complete", 10_000, now - HOUR);
  await ingestAt(race, "m2", "complete", 10_000, now - HOUR);
  await ingestAt(race, "m1", "partial", 1_000, now - HOUR); // faster, but incomplete

  const board = await race.tournamentStandings(tour);
  assert.equal(board[0].simplified, "complete", "an incomplete entry outranked a complete one");
  assert.equal(board[0].complete, true);
  assert.equal(board[1].complete, false);
});

test("finalizing freezes the standings, mints trophies, and is idempotent", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 2 * DAY;
  const end = now - HOUR; // already over
  const tour = await makeTournament(race, { start, end, maps: ["m1"] });
  for (const n of ["gold", "silver", "bronze", "fourth"]) await enter(race, tour.id, n, start);
  await ingestAt(race, "m1", "gold", 1_000, start + HOUR);
  await ingestAt(race, "m1", "silver", 2_000, start + HOUR);
  await ingestAt(race, "m1", "bronze", 3_000, start + HOUR);
  await ingestAt(race, "m1", "fourth", 4_000, start + HOUR);

  const r = await race.finalizeTournament(tour.id, now);
  assert.equal(r.finalized, true);
  assert.equal(r.standings, 4);
  assert.equal(r.trophies, 4);

  const after = await race.tournamentById(tour.id);
  assert.equal(after.status, "finalized");
  assert.equal(after.finalized_at, now);

  // The board now reads from the frozen snapshot.
  const frozen = await race.tournamentStandings(after);
  assert.deepEqual(frozen.map((s) => s.simplified), ["gold", "silver", "bronze", "fourth"]);
  assert.deepEqual(frozen.map((s) => s.place), [1, 2, 3, 4]);

  // Podium trophies for the top three, a participation trophy for the rest.
  const trophies = Object.fromEntries(
    (await race.all("SELECT player_id, place FROM tournament_trophy WHERE tournament_id = $1", [tour.id])).map((x) => [
      Number(x.player_id),
      Number(x.place),
    ])
  );
  assert.deepEqual(Object.values(trophies).sort(), [0, 1, 2, 3]);

  // Running again — both web replicas do, every sweep — changes nothing.
  const twice = await race.finalizeTournament(tour.id, now);
  assert.equal(twice.finalized, false);
  assert.equal(
    Number((await race.one("SELECT COUNT(*) c FROM tournament_trophy WHERE tournament_id = $1", [tour.id])).c),
    4
  );
});

test("a still-running tournament cannot be finalized", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });
  const r = await race.finalizeTournament(tour.id, now);
  assert.equal(r.finalized, false);
  assert.equal((await race.tournamentById(tour.id)).status, "published");
});

test("a dead tie shares a place instead of inventing a winner", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 2 * DAY;
  const end = now - HOUR;
  const tour = await makeTournament(race, { start, end, maps: ["m1"] });
  await enter(race, tour.id, "aaa", start);
  await enter(race, tour.id, "zzz", start);
  // Exact millisecond tie — common on short maps.
  await ingestAt(race, "m1", "aaa", 5_000, start + HOUR);
  await ingestAt(race, "m1", "zzz", 5_000, start + HOUR);

  await race.finalizeTournament(tour.id, now);
  const places = await race.all(
    "SELECT place FROM tournament_standing WHERE tournament_id = $1 ORDER BY player_id",
    [tour.id]
  );
  assert.deepEqual(places.map((p) => Number(p.place)), [1, 1], "a tie was broken by player id");
  const trophyPlaces = await race.all(
    "SELECT place FROM tournament_trophy WHERE tournament_id = $1",
    [tour.id]
  );
  assert.deepEqual(trophyPlaces.map((p) => Number(p.place)), [1, 1]);
});

test("the LIVE board breaks ties exactly the way the frozen one will", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - DAY;
  const tour = await makeTournament(race, { start, end: now + DAY, maps: ["m1"] });
  await enter(race, tour.id, "aaa", start);
  await enter(race, tour.id, "zzz", start);
  await ingestAt(race, "m1", "aaa", 5_000, start + HOUR);
  await ingestAt(race, "m1", "zzz", 5_000, start + HOUR);

  const live = await race.tournamentStandings(tour);
  assert.deepEqual(live.map((s) => s.place), [1, 1], "the live board invented a winner for a dead tie");
});

test("time_sum never hands a podium trophy to an incomplete entry", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 2 * DAY;
  const end = now - HOUR;
  const tour = await makeTournament(race, {
    start, end, maps: ["m1", "m2"], scoring: "time_sum",
  });
  await enter(race, tour.id, "finisher", start);
  await enter(race, tour.id, "quitter", start);
  await ingestAt(race, "m1", "finisher", 10_000, start + HOUR);
  await ingestAt(race, "m2", "finisher", 10_000, start + HOUR);
  await ingestAt(race, "m1", "quitter", 1, start + HOUR); // fastest, but skipped m2

  await race.finalizeTournament(tour.id, now);
  const rows = await race.all(
    `SELECT p.simplified, s.place, s.complete, tt.place AS trophy
     FROM tournament_standing s
     JOIN player p ON p.id = s.player_id
     JOIN tournament_trophy tt ON tt.tournament_id = s.tournament_id AND tt.player_id = s.player_id
     WHERE s.tournament_id = $1 ORDER BY s.place`,
    [tour.id]
  );
  const by = Object.fromEntries(rows.map((r) => [r.simplified, r]));
  assert.equal(Number(by.finisher.place), 1);
  assert.equal(Number(by.finisher.trophy), 1, "the only complete entry did not take the win");
  assert.equal(by.quitter.complete, false, "the incomplete entry was not flagged in the snapshot");
  assert.equal(
    Number(by.quitter.trophy), 0,
    "an entry that skipped a pool map took a podium trophy in a format that does not rank it"
  );
  // The frozen board still carries the flag, so the site can grey the row out.
  const frozen = await race.tournamentStandings(await race.tournamentById(tour.id));
  assert.equal(frozen.find((s) => s.simplified === "quitter").complete, false);
});

test("a scheduled next edition always lands with its map pool", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 8 * DAY;
  const prev = await makeTournament(race, {
    slug: "series", name: "Series", start, end: now - HOUR, maps: ["m1", "m2"], repeat: 7,
  });
  await race.finalizeTournament(prev.id, now);
  const next = await race.scheduleNextEdition(await race.tournamentById(prev.id), now);
  assert.ok(next, "no next edition scheduled");
  // The slug carries the edition without mangling a series name that itself
  // ends in digits.
  assert.equal(next.slug, "series-2");
  assert.deepEqual(
    (await race.tournamentMaps(next.id)).map((m) => m.name),
    ["m1", "m2"],
    "the next edition committed without its pool"
  );
  // Idempotent: the same call again collides on the slug and changes nothing.
  assert.equal(await race.scheduleNextEdition(await race.tournamentById(prev.id), now), null);
});

test("a series whose name ends in digits keeps a sane slug", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const prev = await makeTournament(race, {
    slug: "sprint-2026", name: "Sprint 2026", start: now - 8 * DAY, end: now - HOUR,
    maps: ["m1"], repeat: 7,
  });
  await race.finalizeTournament(prev.id, now);
  const next = await race.scheduleNextEdition(await race.tournamentById(prev.id), now);
  assert.equal(next.slug, "sprint-2026-2", "the year was mistaken for an edition number");
});

test("trophies show on a profile and survive the canonical representative", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 2 * DAY;
  const tour = await makeTournament(race, { start, end: now - HOUR, maps: ["m1"] });
  await enter(race, tour.id, "winner", start);
  await ingestAt(race, "m1", "winner", 1_000, start + HOUR);
  await race.finalizeTournament(tour.id, now);

  const pid = Number((await race.one("SELECT id FROM player WHERE simplified = 'winner'")).id);
  const trophies = await race.playerTrophies(pid);
  assert.equal(trophies.length, 1);
  assert.equal(trophies[0].place, 1);
  assert.equal(trophies[0].slug, "cup");
  assert.equal(trophies[0].field, 1);

  // The profile payload carries them so the badge renders without a second fetch.
  const detail = await race.playerDetail(pid, {});
  assert.equal(detail.trophies.length, 1);
});

test("a registered player is still found after the canonical representative flips", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now - DAY, end: now + DAY, maps: ["m1"] });
  await enter(race, tour.id, "player", now);
  const pid = Number((await race.one("SELECT id FROM player WHERE simplified = 'player'")).id);

  assert.ok(await race.playerTournamentEntry(tour.id, "player"), "entry not found before the flip");

  // Simulate an alias re-grouping that moves the representative elsewhere: the
  // stored entrant id is no longer what the nick resolves to.
  const other = await race.one(
    `INSERT INTO player (name, simplified, trimmed, login) VALUES ('player2','player2','player2','')
     RETURNING id`
  );
  await race.pool.query("UPDATE player SET canonical_id = $1 WHERE id IN ($1, $2)", [Number(other.id), pid]);

  assert.ok(
    await race.playerTournamentEntry(tour.id, "player"),
    "the entry vanished when the canonical representative moved"
  );
});

test("overlap detection ignores cancelled tournaments and the row being edited", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const a = await makeTournament(race, { slug: "a", name: "A", start: now, end: now + DAY, maps: ["m1"] });

  assert.equal((await race.overlappingTournaments(now + HOUR, now + 2 * HOUR)).length, 1);
  // Editing A itself must not report A as a clash.
  assert.equal((await race.overlappingTournaments(now + HOUR, now + 2 * HOUR, a.id)).length, 0);
  // Back-to-back is not an overlap (half-open windows).
  assert.equal((await race.overlappingTournaments(now + DAY, now + 2 * DAY)).length, 0);
  // A cancelled tournament frees its slot.
  await race.setTournamentStatus(a.id, "cancelled", "test-admin");
  assert.equal((await race.overlappingTournaments(now + HOUR, now + 2 * HOUR)).length, 0);
});

test("a recurring series schedules its next edition, and the sweep heals a missed one", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const start = now - 8 * DAY;
  const end = now - HOUR;
  const tour = await makeTournament(race, {
    slug: "weekly", name: "Weekly", start, end, maps: ["m1"], repeat: 7,
  });

  // Finalize WITHOUT scheduling — exactly what a container recreate between the
  // commit and the follow-on step would leave behind.
  await race.finalizeTournament(tour.id, now);
  assert.equal(
    Number((await race.one("SELECT COUNT(*) c FROM tournament")).c),
    1,
    "finalize should not have scheduled anything by itself"
  );

  // The sweep's reconciliation pass notices the orphaned series and heals it.
  const swept = await race.finalizeDueTournaments(now);
  assert.equal(swept.scheduled.length, 1);
  const next = await race.tournamentBySlug(swept.scheduled[0].slug);
  assert.ok(next, "the next edition was not created");
  assert.equal(next.edition, 2);
  assert.equal(next.status, "published");
  assert.ok(next.starts_at > end, "the next edition starts before the last one ended");
  assert.equal(next.ends_at - next.starts_at, end - start, "the duration changed between editions");
  // Same pool, copied forward.
  assert.deepEqual((await race.tournamentMaps(next.id)).map((m) => m.name), ["m1"]);

  // Re-running the sweep does not schedule a third edition.
  const again = await race.finalizeDueTournaments(now);
  assert.equal(again.scheduled.length, 0);
});

test("the game feed serves the live tournament, else the next one up", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  await makeTournament(race, { slug: "soon", name: "Soon", start: now + DAY, end: now + 2 * DAY, maps: ["later"] });
  const body = await race.gameTourneyText(now);
  assert.match(body, /^RSTOURNEY\n/);
  assert.match(body, /\tsoon\t/);
  assert.match(body, /^M\tlater$/m);

  await makeTournament(race, { slug: "onnow", name: "On Now", start: now - HOUR, end: now + HOUR, maps: ["nowmap"] });
  const live = await race.gameTourneyText(now);
  assert.match(live, /\tonnow\t/, "a live tournament must win over an upcoming one");
  assert.match(live, /^M\tnowmap$/m);
});

test("the game feed answers with a bare header when nothing is scheduled", async (t) => {
  const race = await freshDb(t);
  assert.equal(await race.gameTourneyText(1_800_000_000), "RSTOURNEY\n");
});

test("pool maps are created on demand and never-raced ones are flagged, not dropped", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  await ingestAt(race, "known", "someone", 5_000, now - DAY);
  const tour = await makeTournament(race, { start: now, end: now + DAY, maps: ["known", "brandnew"] });

  const maps = await race.tournamentMaps(tour.id);
  assert.deepEqual(maps.map((m) => m.name), ["known", "brandnew"], "a new map was dropped from the pool");
  const r = await race.setTournamentMaps(tour.id, ["known", "brandnew"]);
  assert.deepEqual(r.unraced, ["brandnew"], "the never-raced map was not flagged for the admin");
});

test("a tournament with entrants cannot be deleted", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const tour = await makeTournament(race, { start: now, end: now + DAY, maps: ["m1"] });
  assert.equal(await race.deleteTournament(tour.id), 1, "an empty tournament should be deletable");

  const other = await makeTournament(race, { slug: "b", name: "B", start: now + 2 * DAY, end: now + 3 * DAY, maps: ["m1"] });
  await enter(race, other.id, "entrant", now);
  assert.equal(await race.deleteTournament(other.id), 0, "deleting took an entrant's signup with it");
});

test("drafts stay out of every public read", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const v = validateTournament({
    name: "Secret", slug: "secret", description: "", startsAt: toAdminTime(now),
    endsAt: toAdminTime(now + DAY), scoring: "points", status: "draft",
    joinOpen: true, maps: "m1", repeatEveryDays: 0, repeatGapDays: 1,
  });
  await race.createTournament(v.value, "test-admin");
  assert.equal((await race.tournaments()).rows.length, 0);
  assert.equal(await race.tournamentBySlug("secret"), null);
  assert.equal((await race.tournaments({ includeDrafts: true })).rows.length, 1);
  assert.equal(await race.gameTourneyText(now), "RSTOURNEY\n");
});
