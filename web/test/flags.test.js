// Unit tests for the map-flag review feature and the admin account/session
// layer that gates it: password hashing, flag insert + per-reporter dedupe, the
// admin queue summary, flag resolution, and session lifecycle.
//
// Every test opens a fresh throwaway PostgreSQL database (see pg-util.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, hashPassword, verifyPassword, sha256, FLAG_REASONS } from "../db.js";
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

// Insert a bare map row directly (the flag tests don't need races/aggregates).
async function makeMap(race, name) {
  const r = await race.one("INSERT INTO map (name) VALUES ($1) RETURNING id", [name]);
  return Number(r.id);
}

test("password hashing: verifies the right password and rejects everything else", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.match(stored, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]+$/);
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
  assert.equal(verifyPassword("", stored), false);
  // Two hashes of the same password differ (random salt) but both verify.
  assert.notEqual(stored, hashPassword("correct horse battery staple"));
  // Malformed stored values never throw and never verify.
  for (const bad of ["", "plaintext", "scrypt$$", "scrypt$zz$zz", "md5$a$b", null, undefined]) {
    assert.equal(verifyPassword("x", bad), false);
  }
  assert.ok(FLAG_REASONS.includes("broken") && FLAG_REASONS.includes("other"));
});

test("flagMap: creates a flag, dedupes the same reporter+reason, keeps distinct ones", async (t) => {
  const race = await freshDb(t);
  const mapId = await makeMap(race, "coldrun");
  const rep = sha256("mapflag:1.2.3.4");
  const rep2 = sha256("mapflag:5.6.7.8");

  const a = await race.flagMap({ mapId, reason: "broken", note: "cp2 teleport is dead", reporterHash: rep });
  assert.deepEqual([a.ok, a.created, a.duplicate], [true, true, false]);

  // Same reporter + same reason again -> no new row (deduped).
  const dup = await race.flagMap({ mapId, reason: "broken", note: "still broken", reporterHash: rep });
  assert.deepEqual([dup.ok, dup.created, dup.duplicate], [true, false, true]);

  // Same reporter, DIFFERENT reason -> new row.
  const other = await race.flagMap({ mapId, reason: "offensive", reporterHash: rep });
  assert.equal(other.created, true);

  // DIFFERENT reporter, same reason -> new row.
  const b = await race.flagMap({ mapId, reason: "broken", reporterHash: rep2 });
  assert.equal(b.created, true);

  // Unknown map -> ok:false, no throw.
  const miss = await race.flagMap({ mapId: 999999, reason: "broken", reporterHash: rep });
  assert.equal(miss.ok, false);


  const summary = await race.openFlagSummary();
  assert.equal(summary.length, 1);
  const g = summary[0];
  assert.equal(g.mapId, mapId);
  assert.equal(g.name, "coldrun");
  assert.equal(g.openCount, 3); // broken×2 + offensive×1
  assert.equal(g.reasons.broken, 2);
  assert.equal(g.reasons.offensive, 1);
  assert.ok(g.latestNote); // most recent non-empty note surfaces
});

test("closing flags: resolve one, resolve-all, and re-flag after closure", async (t) => {
  const race = await freshDb(t);
  const mapId = await makeMap(race, "wbomb3");
  const rep = sha256("mapflag:9.9.9.9");
  await race.flagMap({ mapId, reason: "broken", reporterHash: rep });
  await race.flagMap({ mapId, reason: "offensive", reporterHash: rep });

  const open = await race.listFlags({ status: "open" });
  assert.equal(open.length, 2);

  // Resolve one.
  const n1 = await race.setFlagStatus(open[0].id, "resolved", "tester");
  assert.equal(n1, 1);
  // Idempotent: a second close of the same (now non-open) flag affects 0 rows.
  assert.equal(await race.setFlagStatus(open[0].id, "resolved", "tester"), 0);

  // Bulk-close the rest.
  const n2 = await race.resolveMapFlags(mapId, "dismissed", "tester");
  assert.equal(n2, 1);
  assert.equal((await race.listFlags({ status: "open" })).length, 0);

  // With no OPEN flag for (map, broken, reporter), the partial unique index no
  // longer blocks — the same reporter can flag the map again.
  const again = await race.flagMap({ mapId, reason: "broken", reporterHash: rep });
  assert.equal(again.created, true);
  assert.equal((await race.listFlags({ status: "open" })).length, 1);

  const closedBy = (await race.flagsForMap(mapId)).find((f) => f.resolved_by === "tester");
  assert.ok(closedBy && closedBy.resolved_at);
});

test("map blocking: block resolves open flags, lists, is idempotent, and unblocks", async (t) => {
  const race = await freshDb(t);
  const mapId = await makeMap(race, "badmap");
  await race.flagMap({ mapId, reason: "broken", reporterHash: sha256("mapflag:1") });
  await race.flagMap({ mapId, reason: "offensive", reporterHash: sha256("mapflag:2") });
  assert.equal((await race.listFlags({ status: "open" })).length, 2);

  // Blocking closes the map's open flags in the same transaction.
  const b = await race.blockMap(mapId, "unfinishable", "tester");
  assert.deepEqual([b.ok, b.resolvedFlags], [true, 2]);
  assert.equal(await race.isMapBlocked(mapId), true);
  assert.equal((await race.listFlags({ status: "open" })).length, 0);

  assert.deepEqual(await race.blockedMapNames(), ["badmap"]);
  const list = await race.blockedMaps();
  assert.equal(list[0].name, "badmap");
  assert.equal(list[0].reason, "unfinishable");
  assert.equal(list[0].blocked_by, "tester");

  // Re-block is an idempotent upsert (updates reason/who, no error).
  await race.blockMap(mapId, "still bad", "tester2");
  const relisted = await race.blockedMaps();
  assert.equal(relisted.length, 1);
  assert.equal(relisted[0].reason, "still bad");

  assert.equal(await race.unblockMap(mapId), 1);
  assert.equal(await race.isMapBlocked(mapId), false);
  assert.deepEqual(await race.blockedMapNames(), []);

  // Unknown map -> ok:false (FK violation caught), no throw.
  assert.equal((await race.blockMap(999999, "x", "tester")).ok, false);
});

test("admin accounts: create, unique username, password reset, remove", async (t) => {
  const race = await freshDb(t);
  const created = await race.createAdmin("elchupa", hashPassword("first-password"));
  assert.ok(created && created.id);
  assert.equal(await race.countAdmins(), 1);

  // Duplicate username -> null (no throw, no second row).
  assert.equal(await race.createAdmin("elchupa", hashPassword("other")), null);

  const acct = await race.getAdminByUsername("elchupa");
  assert.equal(verifyPassword("first-password", acct.password_hash), true);

  assert.equal(await race.setAdminPassword("elchupa", hashPassword("second-password")), 1);
  const acct2 = await race.getAdminByUsername("elchupa");
  assert.equal(verifyPassword("second-password", acct2.password_hash), true);
  assert.equal(verifyPassword("first-password", acct2.password_hash), false);

  assert.equal((await race.listAdmins())[0].username, "elchupa");
  assert.equal(await race.removeAdmin("elchupa"), 1);
  assert.equal(await race.getAdminByUsername("elchupa"), null);
});

test("sessions: valid lookup, expiry self-cleans, delete, and cascade on admin removal", async (t) => {
  const race = await freshDb(t);
  const admin = await race.createAdmin("mod", hashPassword("password-123"));
  const raw = "a".repeat(64);
  const now = 1_000_000;
  await race.createSession({
    tokenHash: sha256(raw),
    adminId: admin.id,
    csrf: "csrf-token",
    expiresAt: now + 3600,
    ip: "1.1.1.1",
    userAgent: "test",
    now,
  });

  const live = await race.getSession(sha256(raw), now + 10);
  assert.equal(live.adminId, admin.id);
  assert.equal(live.username, "mod");
  assert.equal(live.csrf, "csrf-token");

  // Past expiry -> null AND the row is swept.
  assert.equal(await race.getSession(sha256(raw), now + 4000), null);
  assert.equal(await race.getSession(sha256(raw), now + 10), null); // gone now

  // Second session + delete + expired-sweep helper.
  const raw2 = "b".repeat(64);
  await race.createSession({ tokenHash: sha256(raw2), adminId: admin.id, csrf: "c2", expiresAt: now + 3600, now });
  await race.deleteSession(sha256(raw2));
  assert.equal(await race.getSession(sha256(raw2), now + 10), null);

  // Removing the admin cascades any remaining sessions.
  const raw3 = "c".repeat(64);
  await race.createSession({ tokenHash: sha256(raw3), adminId: admin.id, csrf: "c3", expiresAt: now + 3600, now });
  await race.removeAdmin("mod");
  assert.equal(await race.getSession(sha256(raw3), now + 10), null);
});

// A map that crashes the server on load has, by definition, never been
// finished — so it has no `map` row and nothing to hang a flag on. This is the
// get-or-create that lets a trusted server report one anyway.
test("ensureMapByName: creates unknown maps, is idempotent, and rejects junk names", async (t) => {
  const race = await freshDb(t);

  // Creates a row that did not exist.
  assert.equal(await race.mapIdByName("neverfinished1"), null);
  const id = await race.ensureMapByName("neverfinished1");
  assert.ok(Number.isInteger(id) && id > 0);
  assert.equal(await race.mapIdByName("neverfinished1"), id);

  // Idempotent: the same name returns the same id rather than raising a unique
  // violation. Four game servers can hit the same broken map at once.
  assert.equal(await race.ensureMapByName("neverfinished1"), id);

  // Returns the EXISTING id for a map that was already there — it must never
  // duplicate or renumber a real map.
  const existing = await makeMap(race, "coldrun");
  assert.equal(await race.ensureMapByName("coldrun"), existing);
  // Case is normalised the same way mapIdByName normalises it.
  assert.equal(await race.ensureMapByName("ColdRun"), existing);

  // Junk never mints a row: path traversal, spaces, leading punctuation,
  // separators that would break the generated cfg lines, and empties. Refusal
  // is null — never a partial row.
  const junk = ["../../etc/passwd", "a b", "", "  ", "-leading", ".leading", "/abs",
                "semi;colon", "quo\"te", "UPPER SPACE", null, undefined];
  for (const bad of junk) {
    assert.equal(await race.ensureMapByName(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  const { c } = await race.one("SELECT COUNT(*) c FROM map");
  assert.equal(Number(c), 2, "junk names must not have created any rows");

  // The flag then lands on the created row like any other, and reaches the queue.
  const newId = await race.ensureMapByName("neverfinished2");
  const r = await race.flagMap({ mapId: newId, reason: "broken", reporterHash: sha256("gameflag:crashguard") });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  const summary = await race.openFlagSummary();
  assert.ok(summary.some((g) => g.name === "neverfinished2"), "the new map shows in the moderator queue");
});

// Map quarantine: the network-wide half of bad-map recovery. A map that kills a
// server on load is reported by that box's crash guard; once the evidence is
// strong enough the name joins the blocked-maps feed every node already
// consumes, so one node's crash protects the other three.
test("map quarantine: activates on repeat failures, on two servers, and reaches blockedMapNames", async (t) => {
  const race = await freshDb(t);
  const now = 1780000000;
  const srv = async (name) =>
    Number((await race.one(
      "INSERT INTO server (name, token_hash, status, created_at) VALUES ($1, $2, 'trusted', $3) RETURNING id",
      [name, sha256(name), now]
    )).id);
  const eu = await srv("EU"), us = await srv("US");

  // One failure is not enough — a single fault can be the host, not the map.
  const a = await race.recordMapLoadFailure({ mapName: "badmap1", serverId: eu, note: "NULL model", now });
  assert.equal(a.active, false, "one failure must not quarantine");
  assert.equal(a.failCount, 1);
  assert.deepEqual(await race.blockedMapNames(now), []);

  // A second failure on the SAME server crosses the default threshold of 2.
  const b = await race.recordMapLoadFailure({ mapName: "badmap1", serverId: eu, now: now + 5 });
  assert.equal(b.active, true);
  assert.equal(b.activatedNow, true, "the caller must be told it JUST activated");
  assert.deepEqual(await race.blockedMapNames(now + 5), ["badmap1"]);

  // Re-reporting an already-active map must not claim it activated again (that
  // would file a duplicate moderator flag on every relaunch of a crash loop).
  const c = await race.recordMapLoadFailure({ mapName: "badmap1", serverId: eu, now: now + 6 });
  assert.equal(c.activatedNow, false);

  // TWO DISTINCT servers escalate immediately, before the count threshold:
  // two boxes cannot both hold the same locally-corrupt pk3.
  const d = await race.recordMapLoadFailure({ mapName: "badmap2", serverId: eu, now });
  assert.equal(d.active, false);
  const e = await race.recordMapLoadFailure({ mapName: "badmap2", serverId: us, now });
  assert.equal(e.active, true, "two distinct servers must escalate on the first failure each");
  assert.equal(e.serverCount, 2);

  // One server reporting many times is still ONE server.
  for (let i = 0; i < 5; i++) await race.recordMapLoadFailure({ mapName: "badmap3", serverId: eu, now: now + i });
  const f = await race.recordMapLoadFailure({ mapName: "badmap3", serverId: eu, now: now + 99 });
  assert.equal(f.serverCount, 1, "repeat reports from one box must not look like many boxes");

  // Thin evidence expires so a transient local fault self-heals; strong
  // evidence never does. NB badmap1 is at 3 failures by now (a, b, c), so it is
  // permanent — use a map that stops at exactly two.
  assert.ok(b.expiresAt, "a 2-failure quarantine should carry an expiry");
  assert.equal(f.expiresAt, null, "a >=3-failure quarantine should never expire");
  await race.recordMapLoadFailure({ mapName: "blip1", serverId: eu, now });
  const g = await race.recordMapLoadFailure({ mapName: "blip1", serverId: eu, now: now + 1 });
  assert.equal(g.active, true);
  assert.ok(g.expiresAt, "2 failures => expiring quarantine");
  assert.ok((await race.blockedMapNames(now + 2)).includes("blip1"), "served while unexpired");
  assert.ok(!(await race.blockedMapNames(g.expiresAt + 1)).includes("blip1"),
    "an expired quarantine must stop being served");
  assert.ok((await race.blockedMapNames(now + 2)).includes("badmap1"),
    "a >=3-failure quarantine stays served indefinitely");

  // Moderator clears it -> gone from the feed, evidence retained.
  assert.equal(await race.clearMapQuarantine("badmap3", "mod"), 1);
  assert.ok(!(await race.blockedMapNames(now + 100)).includes("badmap3"));
  const rows = await race.all("SELECT count(*)::int c FROM map_load_failure WHERE map_name = 'badmap3'");
  assert.equal(rows[0].c, 6, "clearing keeps the evidence");

  // Junk never creates state.
  const bad = await race.recordMapLoadFailure({ mapName: "../../etc/passwd", serverId: eu, now });
  assert.equal(bad.ok, false);

  // A moderator block and a machine quarantine coexist without duplicating.
  const mid = await race.ensureMapByName("badmap2");
  await race.blockMap(mid, "manual", "mod");
  const names = await race.blockedMapNames(now);
  assert.equal(names.filter((n) => n === "badmap2").length, 1, "UNION must not duplicate");
  // The admin's blocked-maps table stays moderator-only.
  const adminList = (await race.blockedMaps()).map((r) => r.name);
  assert.deepEqual(adminList, ["badmap2"], "machine quarantines must not appear as moderator blocks");
});
