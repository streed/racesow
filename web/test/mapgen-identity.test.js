// The map-generation identity (mapgen-identity.js), a port of Tastatur's
// visitor hash. These pin the properties the quota and the privacy promise
// both rest on.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeIp,
  agentProfile,
  agentFingerprint,
  digest,
  identify,
  memorySaltStore,
  utcDay,
} from "../mapgen-identity.js";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36";
const CHROME_WIN_PATCH = CHROME_WIN.replace("140.0.7339.80", "140.0.7339.127");
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const EDGE = CHROME_WIN + " Edg/140.0.3485.54";

test("IPv6 is reduced to its /64; IPv4 and mapped IPv4 are kept whole", () => {
  assert.equal(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  // Privacy extensions change only the low 64 bits: same network, same identity.
  assert.equal(normalizeIp("2001:db8:1:2::1"), normalizeIp("2001:db8:1:2:ffff::9"));
  assert.notEqual(normalizeIp("2001:db8:1:2::1"), normalizeIp("2001:db8:1:3::1"));
  assert.equal(normalizeIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeIp("203.0.113.7"), "203.0.113.7");
});

test("the profile is coarse: families and major versions only", () => {
  assert.deepEqual(agentProfile(CHROME_WIN), { browser: "Chrome", version: "140", os: "Windows", device: "desktop" });
  assert.deepEqual(agentProfile(FIREFOX_LINUX), { browser: "Firefox", version: "143", os: "Linux", device: "desktop" });
  assert.deepEqual(agentProfile(SAFARI_IPHONE), { browser: "Safari", version: "18", os: "iOS", device: "mobile" });
  // Edge carries a Chrome token too; the more specific family wins.
  assert.equal(agentProfile(EDGE).browser, "Edge");
  assert.equal(agentProfile("curl/8.5.0").browser, "other");
});

test("a point release does not change the identity", () => {
  assert.equal(agentFingerprint(CHROME_WIN), agentFingerprint(CHROME_WIN_PATCH));
});

test("same person, same day, same identity; any input change is a different one", () => {
  const salt = "a".repeat(64);
  const a = digest(salt, "203.0.113.7", CHROME_WIN);
  assert.equal(a.length, 16);
  assert.deepEqual(digest(salt, "203.0.113.7", CHROME_WIN_PATCH), a);
  assert.notDeepEqual(digest(salt, "203.0.113.8", CHROME_WIN), a);
  assert.notDeepEqual(digest(salt, "203.0.113.7", FIREFOX_LINUX), a);
  assert.notDeepEqual(digest("b".repeat(64), "203.0.113.7", CHROME_WIN), a);
});

test("a new UTC day is a new salt, so the same person gets a fresh identity", async () => {
  const store = memorySaltStore();
  const t0 = Date.UTC(2026, 8, 27, 23, 59, 0);
  const t1 = Date.UTC(2026, 8, 28, 0, 1, 0);
  const req = { ip: "203.0.113.7", userAgent: CHROME_WIN };
  const a = await identify(store, { ...req, nowMs: t0 });
  const a2 = await identify(store, { ...req, nowMs: t0 + 30_000 });
  const b = await identify(store, { ...req, nowMs: t1 });
  assert.deepEqual(a.id, a2.id);
  assert.equal(a.day, "2026-09-27");
  assert.equal(b.day, "2026-09-28");
  assert.notDeepEqual(a.id, b.id);
  assert.equal(a.resetsAt, Date.UTC(2026, 8, 28) / 1000);
});

test("the salt is random, never derived from the date", async () => {
  // Two independent stores on the same day must disagree. If the salt were a
  // function of the date (plus any fixed secret), they would match, and every
  // past day's identities could be recomputed.
  const now = Date.UTC(2026, 8, 27, 12);
  const a = await memorySaltStore().current(now);
  const b = await memorySaltStore().current(now);
  assert.notEqual(a.salt, b.salt);
  assert.match(a.salt, /^[0-9a-f]{64}$/);
});

test("utcDay ends at the next UTC midnight", () => {
  const { day, endMs } = utcDay(Date.UTC(2026, 11, 31, 18));
  assert.equal(day, "2026-12-31");
  assert.equal(endMs, Date.UTC(2027, 0, 1));
});
