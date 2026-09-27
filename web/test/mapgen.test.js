// /api/mapgen end to end: the real server.js on a throwaway database, with the
// daily identity (mapgen-identity.js) deciding who has used their two maps.
// No REDIS_URL, so the server uses its in-process salt, exactly one process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADMIN_URL } from "./pg-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");
const BUDGET = 5;

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";

let proc;
let dbName;
let base;

async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

async function dbQuery(sql, params) {
  const c = new pg.Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`) });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

before(async () => {
  dbName = "test_mapgen_" + crypto.randomBytes(6).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  const port = 20000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`),
                MAPGEN_DAILY_BUDGET: String(BUDGET) };
  delete env.REDIS_URL;
  delete env.MAPGEN_DAILY_PER_IDENTITY;
  proc = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

// A requester is an IP (via the proxy header the server trusts) + a browser.
function as(ip, ua) {
  const headers = { "X-Forwarded-For": ip, "User-Agent": ua };
  return {
    get: async (p) => {
      const r = await fetch(`${base}/api${p}`, { headers });
      return { status: r.status, json: await r.json(), headers: r.headers };
    },
    submit: async (description) => {
      const r = await fetch(`${base}/api/mapgen`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ description }),
      });
      return { status: r.status, json: await r.json(), headers: r.headers };
    },
  };
}

const alice = as("203.0.113.10", CHROME);
const DESC = "A fast flowing course with two big drops and a long finishing straight";

test("a fresh identity has two maps today", async () => {
  const r = await alice.get("/mapgen/quota");
  assert.equal(r.status, 200);
  assert.equal(r.json.limit, 2);
  assert.equal(r.json.used, 0);
  assert.equal(r.json.remaining, 2);
  assert.equal(r.json.open, true);
  assert.equal(r.headers.get("cache-control"), "no-store");
  // Resets at the next UTC midnight.
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  assert.equal(r.json.resetsAt, next.getTime() / 1000);
});

test("descriptions must be 10-500 characters", async () => {
  assert.equal((await alice.submit("short")).status, 400);
  assert.equal((await alice.submit("x".repeat(501))).status, 400);
  // A rejected description does not use up a map.
  assert.equal((await alice.get("/mapgen/quota")).json.used, 0);
});

test("two maps, then the third is refused until midnight", async () => {
  const a = await alice.submit(DESC);
  assert.equal(a.status, 202);
  assert.equal(a.json.job.status, "queued");
  assert.match(a.json.job.token, /^[0-9a-f]{32}$/);
  assert.equal(a.json.quota.remaining, 1);
  const b = await alice.submit(DESC + " and a checkpoint");
  assert.equal(b.status, 202);
  assert.equal(b.json.quota.remaining, 0);
  const c = await alice.submit(DESC + " again");
  assert.equal(c.status, 429);
  assert.equal(c.json.reason, "identity");
  assert.ok(Number(c.headers.get("retry-after")) > 0);
});

test("a point release of the same browser is the same person", async () => {
  const patched = as("203.0.113.10", CHROME.replace("140.0.7339.80", "140.0.7339.127"));
  const r = await patched.submit(DESC);
  assert.equal(r.status, 429);
});

test("another browser or network is another identity", async () => {
  assert.equal((await as("203.0.113.10", FIREFOX).submit(DESC)).status, 202);
  assert.equal((await as("198.51.100.4", CHROME).submit(DESC)).status, 202);
});

test("IPv6 privacy addresses on one /64 share a quota", async () => {
  const one = as("2001:db8:aa:1::1", CHROME);
  const two = as("2001:db8:aa:1:ffff:1234:5678:9abc", CHROME);
  assert.equal((await one.submit(DESC)).status, 202);
  // Budget is 5: alice 2 + firefox 1 + other network 1 + this 1. The site is
  // now full, so the /64's second request hits the site ceiling, and says so.
  const r = await two.submit(DESC);
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "budget");
  assert.equal((await two.get("/mapgen/quota")).json.used, 1, "same /64, same identity");
  assert.equal((await two.get("/mapgen/quota")).json.open, false);
});

test("the site ceiling holds even for a brand-new identity", async () => {
  const r = await as("192.0.2.200", FIREFOX).submit(DESC);
  assert.equal(r.status, 429);
  assert.equal(r.json.reason, "budget");
  // And the refused request did not take one of that identity's own maps.
  assert.equal((await as("192.0.2.200", FIREFOX).get("/mapgen/quota")).json.used, 0);
});

test("'mine' lists only the asker's jobs, and a job is readable by its token", async () => {
  const mine = await alice.get("/mapgen/mine");
  assert.equal(mine.status, 200);
  assert.equal(mine.json.jobs.length, 2);
  assert.equal(mine.json.quota.remaining, 0);
  const job = mine.json.jobs[0];
  assert.equal(job.identity, undefined);
  const byToken = await as("192.0.2.99", FIREFOX).get(`/mapgen/jobs/${job.token}`);
  assert.equal(byToken.status, 200);
  assert.equal(byToken.json.description, job.description);
  assert.equal((await alice.get("/mapgen/jobs/" + "0".repeat(32))).status, 404);
  assert.equal((await alice.get("/mapgen/jobs/1")).status, 404);
});

test("the database holds 16-byte identities and never an address", async () => {
  const jobs = await dbQuery("SELECT * FROM mapgen_job");
  const quota = await dbQuery("SELECT * FROM mapgen_quota");
  assert.equal(jobs.rows.length, BUDGET);
  for (const r of [...jobs.rows, ...quota.rows]) {
    assert.equal(r.identity.length, 16);
    const text = JSON.stringify(r);
    for (const needle of ["203.0.113", "198.51.100", "2001:db8", "Chrome", "Firefox"]) {
      assert.ok(!text.includes(needle), `${needle} leaked into ${text}`);
    }
  }
});
