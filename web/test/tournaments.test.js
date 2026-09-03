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
  monthPeriodKey,
  monthlyWindow,
  prevMonthWindow,
  prevPeriodKey,
  decideMonthlyPool,
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
    { id: 7, slug: "summer-sprint", starts_at: 100, ends_at: 200, status: "published", name: "Summer\tSprint #3" },
    ["Hrace_Line", "pornstar"],
    { nowSec: 150, entrants: 12 }
  );
  const lines = body.split("\n");
  assert.equal(lines[0], "RSTOURNEY");
  // Tabs inside the free-text name are scrubbed — they are the field delimiter.
  assert.equal(lines[1], "T\t7\tsummer-sprint\t100\t200\tSummer Sprint #3");
  assert.equal(lines[1].split("\t").length, 6);
  assert.equal(lines[2], "S\tlive\t50\t12"); // in the window: 50s to the END
  assert.equal(lines[3], "M\thrace_line"); // lowercased for the game
  assert.equal(lines[4], "M\tpornstar");
});

test("the game feed resolves the countdown the game cannot compute itself", () => {
  const t = { id: 7, slug: "s", starts_at: 100, ends_at: 200, status: "published", name: "S" };
  // Before the window the countdown runs to the START, and nothing is live —
  // the game announces only what is actually on.
  assert.match(gameTourneyText(t, [], { nowSec: 40 }), /^S\tsoon\t60\t0$/m);
  // The boundary second belongs to whatever comes next (half-open window).
  assert.match(gameTourneyText(t, [], { nowSec: 200 }), /^S\tsoon\t0\t0$/m);
  assert.match(gameTourneyText(t, [], { nowSec: 199 }), /^S\tlive\t1\t0$/m);
  // A draft never reaches the feed, but if one did it must not read as live.
  assert.match(gameTourneyText({ ...t, status: "draft" }, [], { nowSec: 150 }), /^S\tsoon\t/m);
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

test("the calendar is exclusive — a second tournament cannot share the window", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  await makeTournament(race, { slug: "a", name: "A", start: now, end: now + DAY, maps: ["m1"] });

  // Straight at db.createTournament, bypassing the admin form's check: the form
  // is not the only writer (the series scheduler and the status flip are too),
  // so the schema has to be the thing that holds.
  const clashing = validateTournament({
    name: "B", slug: "b", description: "", startsAt: toAdminTime(now + HOUR),
    endsAt: toAdminTime(now + 2 * DAY), scoring: "points", status: "published",
    joinOpen: true, maps: "m1", repeatEveryDays: 0, repeatGapDays: 1,
  });
  assert.deepEqual(
    await race.createTournament(clashing.value, "test-admin"),
    { conflict: "overlap" },
    "two tournaments were allowed to run at once"
  );

  // Back-to-back stays legal — the window is half-open.
  const next = validateTournament({
    name: "C", slug: "c", description: "", startsAt: toAdminTime(now + DAY),
    endsAt: toAdminTime(now + 2 * DAY), scoring: "points", status: "published",
    joinOpen: true, maps: "m1", repeatEveryDays: 0, repeatGapDays: 1,
  });
  const created = await race.createTournament(next.value, "test-admin");
  assert.ok(created && created.id, "a back-to-back edition was refused");
});

test("cancelling frees a slot, and bringing the cancelled one back cannot double-book it", async (t) => {
  const race = await freshDb(t);
  const now = 1_800_000_000;
  const a = await makeTournament(race, { slug: "a", name: "A", start: now, end: now + DAY, maps: ["m1"] });
  assert.equal(await race.setTournamentStatus(a.id, "cancelled", "test-admin"), 1);

  // The freed window is fair game — this is what cancelling is FOR.
  const b = await makeTournament(race, { slug: "b", name: "B", start: now, end: now + DAY, maps: ["m1"] });

  assert.deepEqual(
    await race.setTournamentStatus(a.id, "published", "test-admin"),
    { conflict: "overlap" },
    "un-cancelling put two tournaments in the same window"
  );
  // ...and it works again once the window is genuinely free.
  assert.equal(await race.setTournamentStatus(b.id, "cancelled", "test-admin"), 1);
  assert.equal(await race.setTournamentStatus(a.id, "published", "test-admin"), 1);
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

// ===================== The Monthly Cup =====================================
// The automatic monthly series: calendar arithmetic, the popularity metric and
// its exclusions, the skip rule, and the exactly-once claim that lets the
// generator run on both web replicas every five minutes.
// Design + rationale: docs/monthly-cup-design.md.

// Epoch seconds for a UTC wall-clock, so a test can state the date it means.
const utc = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) / 1000;

// Seed `n` finishes on `map` by `n` distinct players, inside the given month.
async function seedFinishes(race, map, n, at, { players = n, base = 30_000 } = {}) {
  for (let i = 0; i < n; i++) {
    await ingestAt(race, map, `p${i % players}`, base + i, at + i);
  }
}

test("monthlyWindow is exactly one week, half-open, for every month 2026-2030", () => {
  const WEEK = 7 * DAY;
  for (let y = 2026; y <= 2030; y++) {
    for (let m = 1; m <= 12; m++) {
      const period = `${y}-${String(m).padStart(2, "0")}`;
      const w = monthlyWindow(period);
      assert.equal(w.endsAt - w.startsAt, WEEK, `${period} is not a week long`);
      // Anchored to day-of-month, so month length and leap years are irrelevant.
      assert.equal(w.startsAt, utc(y, m, 1, 18), `${period} starts on the wrong day`);
      assert.equal(w.endsAt, utc(y, m, 8, 18), `${period} ends on the wrong day`);
    }
  }
});

test("period keys round-trip through the window without shifting a month", () => {
  // monthPeriodKey is 1-BASED and Date.UTC is 0-BASED. A round-trip that shifts
  // by one would compute the right-looking window while measuring popularity
  // over the CURRENT, still-incomplete month — silent wrong data.
  for (let m = 1; m <= 12; m++) {
    const mid = utc(2026, m, 15, 12);
    const period = monthPeriodKey(mid);
    assert.equal(period, `2026-${String(m).padStart(2, "0")}`);
    const w = monthlyWindow(period);
    assert.equal(w.startsAt, utc(2026, m, 1, 18));
    // The measurement window is the WHOLE previous calendar month, and its
    // upper bound is the deciding month's 00:00.
    const p = prevMonthWindow(period);
    assert.equal(p.until, utc(2026, m, 1, 0), `${period} measures the wrong upper bound`);
  }
});

test("prevMonthWindow rolls back across the year boundary and respects month lengths", () => {
  const jan = prevMonthWindow("2027-01");
  assert.equal(jan.since, utc(2026, 12, 1), "2027-01 must look back at December 2026");
  assert.equal(jan.until, utc(2027, 1, 1));
  assert.equal((jan.until - jan.since) / DAY, 31, "December is 31 days");
  assert.equal((prevMonthWindow("2027-03").until - prevMonthWindow("2027-03").since) / DAY, 28, "Feb 2027");
  assert.equal((prevMonthWindow("2028-03").until - prevMonthWindow("2028-03").since) / DAY, 29, "Feb 2028 is a leap year");
  assert.equal((prevMonthWindow("2026-05").until - prevMonthWindow("2026-05").since) / DAY, 30, "April");
  assert.equal(prevPeriodKey("2027-01"), "2026-12");
});

test("the pool is the previous month's most-FINISHED maps", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  await seedFinishes(race, "alpha", 9, jul, { players: 3 });
  await seedFinishes(race, "bravo", 6, jul, { players: 2 });
  await seedFinishes(race, "charlie", 4, jul, { players: 2 });
  await seedFinishes(race, "delta", 3, jul, { players: 2 });
  await seedFinishes(race, "echo", 2, jul, { players: 2 });
  const p = prevMonthWindow("2026-08");
  const got = await race.monthlyPoolCandidates({ since: p.since, until: p.until });
  assert.deepEqual(got.slice(0, 4).map((c) => c.mapName), ["alpha", "bravo", "charlie", "delta"]);
  assert.equal(got[0].finishes, 9);
  assert.equal(got[0].finishers, 3);
});

test("popularity excludes blocked, reversed, mixed-case and single-finisher maps", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  await seedFinishes(race, "keeper", 6, jul, { players: 2 });
  // 22 finishes but only ONE player — exactly the grinder shape the floor exists
  // to stop from owning a raw-count metric.
  await seedFinishes(race, "grinder", 22, jul, { players: 1 });
  await seedFinishes(race, "blocked-map", 8, jul, { players: 3 });
  await seedFinishes(race, "coldrun-reversed", 8, jul, { players: 3 });
  await race.pool.query(
    "INSERT INTO map_block (map_id, blocked_at, blocked_by) SELECT id, 1, 'test' FROM map WHERE name = 'blocked-map'"
  );
  // A map row whose name is not canonical lower-case: the auto pool inserts by
  // id but setTournamentMaps re-resolves by lower-cased NAME, so pooling this
  // would silently move the pool to a different, empty map row on any re-save.
  await race.pool.query("INSERT INTO map (name) VALUES ('MixedCase')");
  await race.pool.query(
    `INSERT INTO finish (player_id, map_id, version_id, time, created_at)
     SELECT 1, (SELECT id FROM map WHERE name='MixedCase'), 1, 1000, $1`, [jul]
  );

  const p = prevMonthWindow("2026-08");
  const names = (await race.monthlyPoolCandidates({ since: p.since, until: p.until })).map((c) => c.mapName);
  assert.ok(names.includes("keeper"));
  assert.ok(!names.includes("grinder"), "single-finisher map survived the floor");
  assert.ok(!names.includes("blocked-map"), "a blocked map is unreachable in-game and must not be pooled");
  assert.ok(!names.includes("coldrun-reversed"), "no pk3 contains a -reversed .bsp");
  assert.ok(!names.includes("MixedCase"), "a non-canonical-case map would round-trip to an empty map row");

  // ...and the floor is the only thing keeping the grinder out.
  const loose = await race.monthlyPoolCandidates({ since: p.since, until: p.until, minFinishers: 1 });
  assert.ok(loose.map((c) => c.mapName).includes("grinder"), "minFinishers=1 must disable the floor");
});

test("the candidate order is total and stable regardless of insert order", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  // A dead tie on BOTH finishes and finishers, to force the name key.
  for (const m of ["zulu", "alpha", "mike"]) await seedFinishes(race, m, 4, jul, { players: 2 });
  const p = prevMonthWindow("2026-08");
  const first = (await race.monthlyPoolCandidates({ since: p.since, until: p.until })).map((c) => c.mapName);
  const again = (await race.monthlyPoolCandidates({ since: p.since, until: p.until })).map((c) => c.mapName);
  assert.deepEqual(first, again, "the same inputs produced a different order");
  assert.deepEqual(first, ["alpha", "mike", "zulu"], "the name tie-break must be alphabetical and byte-stable");
});

test("finishes inside a tournament's own window on its own pool maps do not count", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  await seedFinishes(race, "hot", 12, jul, { players: 3 });
  await seedFinishes(race, "organic", 5, jul, { players: 2 });
  const p = prevMonthWindow("2026-08");

  // Before: the concentrated map leads.
  const before = await race.monthlyPoolCandidates({ since: p.since, until: p.until });
  assert.equal(before[0].mapName, "hot");

  // A published tournament covering those finishes, pooling that very map. The
  // tournament is what concentrated the play, so counting it would make the pool
  // a fixed point.
  await makeTournament(race, {
    slug: "jul", name: "Jul", start: utc(2026, 7, 1), end: utc(2026, 7, 20), maps: ["hot"],
  });
  const after = await race.monthlyPoolCandidates({ since: p.since, until: p.until });
  assert.ok(!after.map((c) => c.mapName).includes("hot"), "tournament-driven play still counted");
  assert.ok(after.map((c) => c.mapName).includes("organic"), "ordinary play must be unaffected");

  // A DRAFT concentrates no play at all, so it must not subtract anything —
  // otherwise a forgotten long draft silently erases months of popularity data.
  await race.pool.query("UPDATE tournament SET status = 'draft' WHERE slug = 'jul'");
  const draft = await race.monthlyPoolCandidates({ since: p.since, until: p.until });
  assert.ok(draft.map((c) => c.mapName).includes("hot"), "a draft must not subtract play");

  // ...and the exclusion can be turned off entirely.
  await race.pool.query("UPDATE tournament SET status = 'published' WHERE slug = 'jul'");
  const off = await race.monthlyPoolCandidates({
    since: p.since, until: p.until, excludeTournamentWindows: false,
  });
  assert.ok(off.map((c) => c.mapName).includes("hot"));
});

test("decideMonthlyPool: the skip rule, thin months and the forced escalation", () => {
  const cand = (...names) => names.map((n, i) => ({ mapId: i + 1, mapName: n, finishes: 10 - i, finishers: 3 }));
  const pool4 = cand("a", "b", "c", "d");

  // No previous edition — the bootstrap path.
  assert.equal(decideMonthlyPool({ candidates: pool4, prevPoolIds: [] }).decision, "scheduled");
  // Disjoint from the previous edition.
  assert.equal(decideMonthlyPool({ candidates: pool4, prevPoolIds: [99] }).decision, "scheduled");
  // ONE shared map is enough to skip the whole month.
  const one = decideMonthlyPool({ candidates: pool4, prevPoolIds: [2] });
  assert.equal(one.decision, "skipped_overlap");
  assert.deepEqual(one.detail.collided, ["b"], "the colliding map must be named");
  assert.deepEqual(one.pool, [], "a skipped month must not carry a pool");

  // Thin months skip rather than run short, and the thin check wins over the
  // overlap check — reporting a collision about a pool that was never viable
  // would send an operator hunting the wrong problem.
  assert.equal(decideMonthlyPool({ candidates: [], prevPoolIds: [] }).decision, "skipped_thin");
  const thin = decideMonthlyPool({ candidates: cand("a", "b", "c"), prevPoolIds: [1] });
  assert.equal(thin.decision, "skipped_thin");
  assert.equal(thin.detail.candidates.length, 3, "the ranked candidates must be recorded for diagnosis");
  // ...unless a shorter pool is explicitly allowed.
  assert.equal(decideMonthlyPool({ candidates: cand("a", "b", "c"), prevPoolIds: [], minPool: 3 }).decision, "scheduled");

  // The escalation. Without it the rule DEADLOCKS rather than alternating: its
  // comparand only advances when an edition actually runs.
  assert.equal(decideMonthlyPool({ candidates: pool4, prevPoolIds: [2], skipStreak: 1 }).decision, "skipped_overlap");
  const forced = decideMonthlyPool({ candidates: pool4, prevPoolIds: [2], skipStreak: 2 });
  assert.equal(forced.decision, "forced");
  assert.equal(forced.pool.length, 4, "a forced month must still carry its pool");
  // ...and it can be switched off to keep the rule absolutely literal.
  assert.equal(
    decideMonthlyPool({ candidates: pool4, prevPoolIds: [2], skipStreak: 9, maxSkipStreak: 0 }).decision,
    "skipped_overlap"
  );
});

test("the generator materialises an edition with its pool, exactly once", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4], ["echo", 3]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1); // 01:00 on the 1st, before the 18:00 window

  const r = await race.scheduleMonthlyEdition({ now });
  assert.equal(r.decision, "scheduled");
  assert.equal(r.wrote, true);
  assert.equal(r.slug, "monthly-cup-2026-08");
  assert.deepEqual(r.pool.map((p) => p.mapName), ["alpha", "bravo", "charlie", "delta"]);

  const t1 = await race.tournamentBySlug("monthly-cup-2026-08");
  assert.equal(t1.status, "published");
  assert.equal(t1.starts_at, utc(2026, 8, 1, 18));
  assert.equal(t1.ends_at, utc(2026, 8, 8, 18));
  assert.equal(t1.scoring, "points");
  // repeat_every_days MUST be 0 — that is what keeps the fixed-day chain
  // scheduler from also driving this series.
  assert.equal(t1.repeat_every_days, 0);
  assert.equal(t1.series_key, "monthly-cup");
  assert.deepEqual((await race.tournamentMaps(t1.id)).map((m) => m.name),
    ["alpha", "bravo", "charlie", "delta"]);

  // Idempotent: a second pass is a no-op and creates no second edition.
  const again = await race.scheduleMonthlyEdition({ now });
  assert.equal(again.wrote, false);
  assert.equal(again.decision, "scheduled");
  const all = await race.tournaments({ includeDrafts: true });
  assert.equal(all.rows.filter((x) => x.series_key === "monthly-cup").length, 1);
});

test("two replicas racing produce exactly one edition, and the loser never inserts", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);
  // Both replicas run the same sweep at the same moment.
  const [a, b] = await Promise.all([
    race.scheduleMonthlyEdition({ now }),
    race.scheduleMonthlyEdition({ now }),
  ]);
  const wrote = [a, b].filter((r) => r.wrote);
  assert.equal(wrote.length, 1, "both replicas claimed the month");
  // Assert the MECHANISM, not just the count. Two outcomes are legitimate and
  // Promise.all does not guarantee which: a true overlap makes the loser bail on
  // the period claim ('already-decided'), while a fully-serialised pair makes it
  // short-circuit on the committed terminal decision ('scheduled', wrote:false).
  // What must NEVER happen is the loser reaching the tournament INSERT and being
  // rescued by a slug collision — that is what the naive version does, and it
  // stops working the moment the slug is free.
  const loser = [a, b].find((r) => !r.wrote);
  assert.ok(
    loser.decision === "already-decided" || loser.decision === "scheduled",
    `loser bailed via ${loser.decision}, not the period claim or the terminal short-circuit`
  );
  assert.notEqual(loser.decision, "slug-taken", "the loser reached the tournament INSERT");
  const all = await race.tournaments({ includeDrafts: true });
  assert.equal(all.rows.filter((x) => x.series_key === "monthly-cup").length, 1);
});

test("the loser of a replica race adopts its own edition instead of blocking on it", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);

  const winner = await race.scheduleMonthlyEdition({ now });
  assert.equal(winner.wrote, true);

  // Replay the losing replica's exact interleaving. Its decision-row read and
  // its slug read both ran BEFORE the winner committed (so both came back
  // empty), and only the calendar scan — one statement later — sees the
  // winner's edition. That gap is a few milliseconds wide in the wild, so it is
  // staged here: drop the decision row, and blind the one slug lookup.
  await race.pool.query("DELETE FROM tournament_auto_period WHERE series_key = 'monthly-cup'");
  const realOne = race.one.bind(race);
  race.one = async (sql, params) =>
    /FROM tournament WHERE slug/.test(sql) ? null : realOne(sql, params);
  let loser;
  try {
    loser = await race.scheduleMonthlyEdition({ now });
  } finally {
    race.one = realOne;
  }

  // The month must never be reported as blocked BY ITSELF: that tells an
  // operator to go and cancel the very cup the generator just created.
  assert.notEqual(loser.decision, "blocked", "the month blocked on its own edition");
  assert.equal(loser.decision, "scheduled");
  assert.equal(loser.tournamentId, winner.tournamentId, "the loser adopted a different tournament");
  const all = await race.tournaments({ includeDrafts: true });
  assert.equal(all.rows.filter((x) => x.series_key === "monthly-cup").length, 1);
  // ...and the rebuilt decision row points back at the surviving edition, so the
  // next sweep short-circuits on it rather than re-running this recovery.
  const ap = await race.autoPeriod("monthly-cup", "2026-08");
  assert.equal(ap.decision, "scheduled");
  assert.equal(Number(ap.tournament_id), winner.tournamentId);
});

test("the skip rule compares against the last edition that RAN, and never against itself", async (t) => {
  const race = await freshDb(t);
  const jun = utc(2026, 6, 10);
  const jul = utc(2026, 7, 10);
  // July's edition pools alpha/bravo/charlie/delta.
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jun, { players: 2 });
  }
  const julNow = utc(2026, 7, 1, 1);
  const july = await race.scheduleMonthlyEdition({ now: julNow });
  assert.equal(july.decision, "scheduled");

  // Re-deciding the SAME month must report already-decided — never
  // skipped_overlap against its own pool. With a `starts_at <= now` comparand
  // this is exactly the case that silently cancels a live tournament.
  const redo = await race.scheduleMonthlyEdition({ now: julNow });
  assert.equal(redo.decision, "scheduled");
  assert.equal(redo.wrote, false);

  // August measures July. Overlapping maps -> the month is skipped.
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const augNow = utc(2026, 8, 1, 1);
  const aug = await race.scheduleMonthlyEdition({ now: augNow, excludeTournamentWindows: false });
  assert.equal(aug.decision, "skipped_overlap");
  assert.ok((aug.detail.collided || []).length > 0);
  assert.equal(await race.tournamentBySlug("monthly-cup-2026-08"), null, "a skipped month must create nothing");

  // The streak counts only consecutive terminal skips.
  assert.equal(await race.monthlySkipStreak("monthly-cup", "2026-09"), 1);
  assert.equal(await race.monthlySkipStreak("monthly-cup", "2026-08"), 0);
});

test("a cancelled edition is not the comparand, and a cancelled blocker frees the month", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);

  // A hand-booked tournament straddling day 1 takes the slot: first come, first
  // served, and the automatic series does NOT outrank a deliberate booking.
  const blocker = await makeTournament(race, {
    slug: "clash", name: "Clash", start: utc(2026, 7, 30), end: utc(2026, 8, 3), maps: ["alpha"],
  });
  const blocked = await race.scheduleMonthlyEdition({ now });
  assert.equal(blocked.decision, "blocked");
  assert.equal(blocked.wrote, true, "the first block must be recorded");
  assert.equal(blocked.detail.blockedBy[0].slug, "clash", "the blocker must be named so it can be cleared");

  // Blocked is logged ONCE, not every sweep — a week-long block would otherwise
  // emit ~2000 identical warnings.
  for (let i = 0; i < 5; i++) {
    assert.equal((await race.scheduleMonthlyEdition({ now })).wrote, false, "a repeat block re-logged");
  }

  // Cancelling the blocker HEALS the month with no operator action: `blocked` is
  // deliberately non-terminal.
  await race.setTournamentStatus(blocker.id, "cancelled", "test-admin");
  const healed = await race.scheduleMonthlyEdition({ now });
  assert.equal(healed.decision, "scheduled");
  assert.equal(healed.wrote, true);
  assert.ok(await race.tournamentBySlug("monthly-cup-2026-08"));
});

test("a DRAFT tournament also blocks the slot, because drafts hold the calendar", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const blocker = await makeTournament(race, {
    slug: "hidden", name: "Hidden", start: utc(2026, 7, 30), end: utc(2026, 8, 3), maps: ["alpha"],
  });
  await race.setTournamentStatus(blocker.id, "draft", "test-admin");
  const r = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  assert.equal(r.decision, "blocked", "the exclusion constraint covers drafts (status <> 'cancelled')");
});

test("a month whose window has already opened is not a skip and records nothing", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  // One second after the window opens. A month the generator could not reach in
  // time was never a decision — recording it as a skip is the exact confusion
  // the durable record exists to prevent, and it is what would otherwise fire an
  // alarm on the day this ships.
  const late = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 18) + 1 });
  assert.equal(late.decision, "window-open");
  assert.equal(late.wrote, false);
  assert.equal(await race.autoPeriod("monthly-cup", "2026-08"), null, "a late month must leave no row");

  // An hour before, it still materialises.
  const ok = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 17) });
  assert.equal(ok.decision, "scheduled");
});

test("a squatted slug is reported as actionable, not mistaken for a peer race", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  // A pre-existing row holding the slug at a NON-overlapping window. Postgres
  // raises the slug 23505 before the window 23P01, so a handler that did not
  // discriminate would read this as "the other replica won" and loop forever
  // with no decision row and no log line.
  await makeTournament(race, {
    slug: "monthly-cup-2026-08", name: "Squatter",
    start: utc(2026, 9, 1), end: utc(2026, 9, 2), maps: ["alpha"],
  });
  const r = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  assert.equal(r.decision, "slug-taken");
  assert.equal(r.wrote, false);
});

test("a finalized auto edition is invisible to the fixed-day chain scheduler", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const r = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  await race.finalizeTournament(r.tournamentId, utc(2026, 8, 8, 19));
  // finalizeDueTournaments' orphan reconciliation gates on repeat_every_days > 0.
  // If an auto edition ever leaked a non-zero value, two schedulers would drive
  // the same series — one of them with arithmetic that cannot express a month.
  const out = await race.finalizeDueTournaments(utc(2026, 8, 8, 20));
  assert.deepEqual(out.scheduled, [], "the chain scheduler picked up a Monthly Cup edition");
  assert.deepEqual(out.failed, []);
});

test("an admin save cannot hand an auto edition back to the chain scheduler", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const r = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  const t1 = await race.tournamentById(r.tournamentId);
  const v = validateTournament({
    name: t1.name, slug: t1.slug, description: t1.description,
    startsAt: toAdminTime(t1.starts_at), endsAt: toAdminTime(t1.ends_at),
    scoring: t1.scoring, status: "published", joinOpen: true,
    maps: ["alpha", "bravo"], repeatEveryDays: 30, repeatGapDays: 1,
  });
  await race.updateTournament(t1.id, v.value, "test-admin");
  const after = await race.tournamentById(t1.id);
  assert.equal(after.repeat_every_days, 0, "the form put the chain scheduler back on an auto edition");
  assert.equal(after.repeat_gap_days, 0);
  // The pool edit itself must still work — it is the correction path for a bad
  // automatic selection.
  assert.deepEqual((await race.tournamentMaps(t1.id)).map((m) => m.name), ["alpha", "bravo"]);
});

test("the force button re-decides a skipped month, bypassing only the overlap rule", async (t) => {
  const race = await freshDb(t);
  const jun = utc(2026, 6, 10);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jun, { players: 2 });
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  await race.scheduleMonthlyEdition({ now: utc(2026, 7, 1, 1) });
  const aug = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1), excludeTournamentWindows: false });
  assert.equal(aug.decision, "skipped_overlap");

  const before = utc(2026, 8, 1, 1); // still inside the pre-window slack
  assert.equal(await race.forceMonthlyPeriod("monthly-cup", "2026-08", "admin", before), 1);
  const forced = await race.scheduleMonthlyEdition({ now: before, excludeTournamentWindows: false });
  assert.equal(forced.decision, "forced");
  assert.ok(await race.tournamentBySlug("monthly-cup-2026-08"));

  // A month that already produced an edition cannot be forced — that would be a
  // request to double-book the calendar.
  // ...checked while July's own window is still ahead, so the refusal is about
  // the decision being terminal rather than about the clock.
  assert.equal(await race.forceMonthlyPeriod("monthly-cup", "2026-07", "admin", utc(2026, 7, 1, 1)), 0);
});

test("a force is refused once the window has opened, instead of silently doing nothing", async (t) => {
  const race = await freshDb(t);
  const jun = utc(2026, 6, 10);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jun, { players: 2 });
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  await race.scheduleMonthlyEdition({ now: utc(2026, 7, 1, 1) });
  await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1), excludeTournamentWindows: false });

  // The generator does nothing once now >= startsAt, so a force accepted here
  // would be a permanent no-op that reported success — AND, because 'forced' is
  // non-terminal, it would stop the month counting toward the escalation streak.
  const late = await race.forceMonthlyPeriod("monthly-cup", "2026-08", "admin", utc(2026, 8, 1, 18) + 1);
  assert.ok(late && late.error, "a force after the window opened must be refused");
  assert.equal((await race.autoPeriod("monthly-cup", "2026-08")).decision, "skipped_overlap",
    "the skip record must survive a refused force");
});

test("a forced month that never materialised still counts as a skip", async (t) => {
  const race = await freshDb(t);
  await race.recordAutoPeriod("monthly-cup", "2026-06", "skipped_overlap", {}, 1);
  await race.pool.query(
    `INSERT INTO tournament_auto_period (series_key, period, decision, detail, decided_at)
     VALUES ('monthly-cup','2026-07','forced','{}'::jsonb, 1)`
  );
  // Two months in a row that did not run. A mistaken force must not reset the
  // escalation and push the automatic rescue further away.
  assert.equal(await race.monthlySkipStreak("monthly-cup", "2026-08"), 2);
});

test("a terminal decision can never be downgraded by a later pass", async (t) => {
  const race = await freshDb(t);
  await race.recordAutoPeriod("monthly-cup", "2026-08", "scheduled", { pool: [] }, 1);
  const r = await race.recordAutoPeriod("monthly-cup", "2026-08", "blocked", { reason: "nope" }, 2);
  assert.equal(r.changed, false);
  assert.equal(r.blockedByTerminal, true);
  assert.equal((await race.autoPeriod("monthly-cup", "2026-08")).decision, "scheduled",
    "a committed decision was overwritten");
});

test("a blocked record refreshes its detail while still logging only on a change", async (t) => {
  const race = await freshDb(t);
  const a = await race.recordAutoPeriod("monthly-cup", "2026-08", "blocked", { blockedBy: [{ slug: "one" }] }, 1);
  assert.equal(a.changed, true, "the first block must log");
  const b = await race.recordAutoPeriod("monthly-cup", "2026-08", "blocked", { blockedBy: [{ slug: "two" }] }, 2);
  assert.equal(b.changed, false, "an unchanged decision must not re-log");
  // ...but the durable record must not go on naming a blocker that has been
  // replaced, or an operator chases a tournament that is no longer in the way.
  const row = await race.autoPeriod("monthly-cup", "2026-08");
  assert.equal(row.detail.blockedBy[0].slug, "two", "the detail went stale");
  assert.equal(row.decided_at, 2);
});

test("an existing edition is the answer, not a blocker, when the decision row is lost", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);
  const first = await race.scheduleMonthlyEdition({ now });
  assert.equal(first.decision, "scheduled");

  // Lose the decision row but keep the tournament — a partial restore, or a
  // restore of a dump predating this table. The edition necessarily overlaps its
  // own window, so treating it as a blocker would make the month block itself
  // forever while telling the operator to cancel the very cup being blocked.
  await race.pool.query("DELETE FROM tournament_auto_period");
  const healed = await race.scheduleMonthlyEdition({ now });
  assert.equal(healed.decision, "scheduled", `the edition blocked itself (${healed.decision})`);
  assert.equal(healed.tournamentId, first.tournamentId);
  const row = await race.autoPeriod("monthly-cup", "2026-08");
  assert.equal(row.decision, "scheduled");
  assert.equal(row.tournament_id, first.tournamentId, "the rebuilt record must point at the edition");
});

test("cancelling this month's cup is a terminal decision, not an endless slug collision", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);
  const first = await race.scheduleMonthlyEdition({ now });
  await race.setTournamentStatus(first.tournamentId, "cancelled", "admin");
  await race.pool.query("DELETE FROM tournament_auto_period");

  // A cancelled row is invisible to the calendar constraint but still owns the
  // UNIQUE slug, so without an explicit branch this retries the same doomed
  // INSERT every five minutes until the window opens.
  const r = await race.scheduleMonthlyEdition({ now });
  assert.equal(r.decision, "cancelled");
  const again = await race.scheduleMonthlyEdition({ now });
  assert.equal(again.wrote, false, "a cancelled month must stop being re-decided");
});

test("an operator's force survives a block that lands before the next sweep", async (t) => {
  const race = await freshDb(t);
  const jun = utc(2026, 6, 10);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jun, { players: 2 });
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  const now = utc(2026, 8, 1, 1);
  await race.scheduleMonthlyEdition({ now: utc(2026, 7, 1, 1) });
  await race.scheduleMonthlyEdition({ now, excludeTournamentWindows: false });
  await race.forceMonthlyPeriod("monthly-cup", "2026-08", "admin", now);

  // Somebody books the slot; the generator records `blocked`, overwriting the
  // 'forced' decision. The override must not be destroyed by that.
  const blocker = await makeTournament(race, {
    slug: "clash", name: "Clash", start: utc(2026, 7, 30), end: utc(2026, 8, 3), maps: ["alpha"],
  });
  assert.equal((await race.scheduleMonthlyEdition({ now, excludeTournamentWindows: false })).decision, "blocked");
  await race.setTournamentStatus(blocker.id, "cancelled", "admin");

  const after = await race.scheduleMonthlyEdition({ now, excludeTournamentWindows: false });
  assert.equal(after.decision, "forced", `the force was lost (${after.decision})`);
  assert.ok(await race.tournamentBySlug("monthly-cup-2026-08"));
});

test("the game feed for an auto edition is shaped exactly like a hand-made one", async (t) => {
  const race = await freshDb(t);
  const jul = utc(2026, 7, 10);
  for (const [m, n] of [["alpha", 9], ["bravo", 7], ["charlie", 5], ["delta", 4]]) {
    await seedFinishes(race, m, n, jul, { players: 2 });
  }
  await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  const feed = await race.gameTourneyText(utc(2026, 8, 2, 12));
  const lines = feed.trim().split("\n");
  assert.equal(lines[0], "RSTOURNEY");
  assert.equal(lines.filter((l) => l.startsWith("T\t")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("S\t")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("M\t")).length, 4);
  assert.match(lines.find((l) => l.startsWith("S\t")), /^S\tlive\t/);
});

test("a skipped month leaves the game feed silent rather than stale", async (t) => {
  const race = await freshDb(t);
  // Nothing raced last month at all -> skipped_thin, no edition, no feed body.
  const r = await race.scheduleMonthlyEdition({ now: utc(2026, 8, 1, 1) });
  assert.equal(r.decision, "skipped_thin");
  assert.equal(await race.gameTourneyText(utc(2026, 8, 2, 12)), "RSTOURNEY\n");
});
