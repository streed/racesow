// Who is asking for a generated map, without knowing who anyone is.
//
// A port of Tastatur's visitor identity (streed/tastatur,
// app/lib/ingest/identifier.rb and salt_store.rb), used here for one thing:
// letting each person generate MAPGEN_DAILY_PER_IDENTITY maps a day without
// accounts, cookies, or storing an IP.
//
//   identity = HMAC-SHA256(daily_salt, "mapgen" ‖ ip ‖ coarse browser profile)[0:16]
//
// The rules that make it private are Tastatur's, and they are load-bearing:
//
//   1. The IP and user-agent string are used in memory, inside identify(), and
//      then dropped. Neither is stored, logged or put in a Redis key. The only
//      thing that leaves this module is the 128-bit digest.
//   2. The salt is 32 random bytes that live ONLY in Redis (persistence off in
//      docker-compose.yml: --save "" --appendonly no), never in PostgreSQL. A
//      database dump therefore holds identities nobody can link to an address.
//   3. The salt is replaced every UTC day and the old one expires. After that,
//      nobody (us included) can recompute yesterday's identities. The date
//      NAMES the Redis key; it never DERIVES the value. Deriving the salt from
//      a long-lived secret and the date would make every past salt
//      regenerable forever.
//   4. Nothing accepts a salt from outside: there is no setter or seed.
//
// Two deliberate differences from Tastatur:
//
//   - One day, in UTC, for everyone. A map quota has no per-site reporting
//     timezone to follow, and the whole site already buckets by UTC day.
//   - No "previous" salt. Tastatur keeps yesterday's salt for 24 hours so an
//     in-flight browsing session can cross midnight. A quota has no sessions:
//     at midnight everyone simply gets a fresh identity, which IS the daily
//     reset. So the salt expires minutes after its day ends rather than a
//     day later, and the window in which it exists at all is shorter.
//
// The quota is only as strong as the identity. Like Tastatur's visitor count,
// it treats one IP + one browser as one person: a shared IP (a LAN, a
// carrier NAT) with the same browser shares a quota, and switching browser or
// network gets a new one. That is the right trade for a courtesy limit. The
// hard cost ceiling is the global MAPGEN_DAILY_BUDGET in server.js, which no
// identity can get around.
import crypto from "node:crypto";
import net from "node:net";
import { createClient } from "redis";

const KEY_PREFIX = "racesow:mapgen:salt:";
const SALT_BYTES = 32;
const DIGEST_BYTES = 16;
// A salt outlives its UTC day by this much, so a request that read the date
// just before midnight can still find the salt it was about to use.
const GRACE_SECONDS = 300;
const REDIS_TIMEOUT_MS = 500;

export class SaltUnavailableError extends Error {
  constructor(cause) {
    super("identity salt store unavailable");
    this.cause = cause;
  }
}

// The UTC day a moment belongs to, and when that day ends.
export function utcDay(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const day = d.toISOString().slice(0, 10);
  const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return { day, endMs };
}

// IPv6 is reduced to its /64. Privacy extensions (RFC 4941) rotate the low 64
// bits several times a day, so hashing the full address would hand one person
// a fresh quota every time their interface identifier changed. The /64 is the
// network they are on, the part that behaves like an IPv4 address. An
// IPv4-mapped IPv6 address (::ffff:1.2.3.4, what Node reports on a dual-stack
// socket) is unwrapped to the IPv4 it is.
export function normalizeIp(ip) {
  const s = String(ip || "").trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return mapped[1];
  if (net.isIPv4(s)) return s;
  if (net.isIPv6(s)) return ipv6Prefix64(s);
  // Unparseable still has to hash to something stable.
  return s;
}

function ipv6Prefix64(s) {
  // Expand "::" so there are always eight groups, then keep the first four.
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = s.includes("::") && tail ? tail.split(":") : [];
  const groups = s.includes("::")
    ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
    : h;
  return groups
    .slice(0, 4)
    .map((g) => parseInt(g || "0", 16).toString(16))
    .join(":") + "::/64";
}

// The coarse facts about a browser that Tastatur's UserAgent#fingerprint keeps:
// browser family and major version, OS family, and one of
// desktop / mobile / tablet. Never the raw string, for two reasons.
// First, a point release must not split one person into two identities.
// Second, the raw header is far more identifying than a quota needs.
// Tastatur uses DeviceDetector; this is a dependency-free regex pass over the
// same handful of families, and anything unrecognised is "other".
export function agentProfile(ua) {
  const s = String(ua || "");
  let browser = "other";
  let version = "";
  const rules = [
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /OPR\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [name, re] of rules) {
    const m = re.exec(s);
    if (m) {
      browser = name;
      version = m[1];
      break;
    }
  }
  let os = "other";
  if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Macintosh|Mac OS X/.test(s)) os = "macOS";
  else if (/Linux/.test(s)) os = "Linux";
  let device = "desktop";
  if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = "tablet";
  else if (/Mobi|iPhone|iPod/.test(s)) device = "mobile";
  return { browser, version, os, device };
}

// 0x1f (unit separator) cannot occur in any component, so the join is
// unambiguous: "Chrome 1" cannot collide with "Chrome" at version "1".
export function agentFingerprint(ua) {
  const p = agentProfile(ua);
  return [p.browser, p.version, p.os, p.device].join("\x1f");
}

// HMAC, not SHA256(salt ‖ message): the bare concatenation is length-extension
// weak, and HMAC is the construction built for keyed hashing at the same cost.
// "mapgen" is in the message so this identity can never be compared with any
// other hash the site might one day make from the same inputs.
export function digest(salt, ip, ua) {
  return crypto
    .createHmac("sha256", salt)
    .update(`mapgen\x00${normalizeIp(ip)}\x00${agentFingerprint(ua)}`)
    .digest()
    .subarray(0, DIGEST_BYTES);
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error("redis timeout")), ms);
      t.unref?.();
    }),
  ]).finally(() => clearTimeout(t));
}

// Redis-backed salt store. SET NX EX is one atomic command, so the two web
// replicas racing on the first request after midnight cannot each install a
// different salt and hand the same person two quotas.
export function redisSaltStore(url) {
  const client = createClient({
    url,
    socket: { reconnectStrategy: (n) => Math.min(n * 200, 5000) },
    disableOfflineQueue: true,
  });
  client.on("error", () => {}); // surfaced per call as SaltUnavailableError
  const connecting = client.connect().catch(() => {});
  return {
    kind: "redis",
    async current(nowMs = Date.now()) {
      const { day, endMs } = utcDay(nowMs);
      const key = KEY_PREFIX + day;
      try {
        // Bounded: with a reconnect strategy, connect() never settles while
        // Redis is down, and an unbounded await would hang the request
        // instead of refusing it.
        await withTimeout(connecting, REDIS_TIMEOUT_MS);
        let salt = await withTimeout(client.get(key), REDIS_TIMEOUT_MS);
        if (!salt) {
          const ttl = Math.ceil((endMs - nowMs) / 1000) + GRACE_SECONDS;
          const fresh = crypto.randomBytes(SALT_BYTES).toString("hex");
          await withTimeout(client.set(key, fresh, { NX: true, EX: ttl }), REDIS_TIMEOUT_MS);
          salt = await withTimeout(client.get(key), REDIS_TIMEOUT_MS);
        }
        if (!salt) throw new Error("salt vanished between SET NX and GET");
        return { salt, day, endMs };
      } catch (e) {
        throw new SaltUnavailableError(e);
      }
    },
    async close() {
      try { await client.quit(); } catch { /* already gone */ }
    },
  };
}

// Process-local salts, for development and the test suite, where there is one
// web process and no Redis. Never used in production: docker-compose.yml sets
// REDIS_URL, and with two web replicas each would mint its own salt and give
// everyone two quotas. Old days are dropped as new ones are minted.
export function memorySaltStore() {
  const salts = new Map();
  return {
    kind: "memory",
    async current(nowMs = Date.now()) {
      const { day, endMs } = utcDay(nowMs);
      if (!salts.has(day)) {
        salts.clear();
        salts.set(day, crypto.randomBytes(SALT_BYTES).toString("hex"));
      }
      return { salt: salts.get(day), day, endMs };
    },
    async close() {},
  };
}

export function createSaltStore(env = process.env) {
  return env.REDIS_URL ? redisSaltStore(env.REDIS_URL) : memorySaltStore();
}

// The request's identity for today. Returns { id: Buffer(16), day, resetsAt }.
// Throws SaltUnavailableError when Redis is configured but unreachable. The
// caller must refuse the request then, never fall back to an unsalted hash.
export async function identify(store, { ip, userAgent, nowMs = Date.now() }) {
  const { salt, day, endMs } = await store.current(nowMs);
  return { id: digest(salt, ip, userAgent), day, resetsAt: Math.floor(endMs / 1000) };
}
