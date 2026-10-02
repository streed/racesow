// Integration tests for the admin area + public map-flag endpoint: spawn the
// real server.js on a throwaway PostgreSQL database and drive it over HTTP,
// exercising the login/session/CSRF flow exactly as a browser would (manual
// redirect + cookie handling, since Node's fetch has no cookie jar).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADMIN_URL } from "./pg-util.js";
import { hashPassword } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");

const ADMIN_USER = "tester";
const ADMIN_PASS = "test-password-123";
const INGEST_TOKEN = "admin-test-ingest-token";

let proc;
let dbName;
let base;
let db; // persistent client on the test DB for seeding + assertions
let mapId;

async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

before(async () => {
  dbName = "test_admin_" + crypto.randomBytes(6).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, ADMIN_COOKIE_INSECURE: "1", INGEST_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
  // Migrations have run (health is up) — seed a map to flag and an admin login.
  db = new pg.Client({ connectionString: dbUrl });
  await db.connect();
  const now = Math.floor(Date.now() / 1000);
  mapId = Number((await db.query("INSERT INTO map (name) VALUES ($1) RETURNING id", ["flagmap"])).rows[0].id);
  await db.query("INSERT INTO admin_user (username, password_hash, created_at) VALUES ($1,$2,$3)", [
    ADMIN_USER,
    hashPassword(ADMIN_PASS),
    now,
  ]);
});

after(async () => {
  if (db) await db.end().catch(() => {});
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

function cookieValue(res, name) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

// Memoised admin login: the POST /admin/login route is rate-limited to 10/min
// per IP (loginLimiter), and every test in this file hits it from 127.0.0.1
// inside one window, so tests that only need "an admin session" share a single
// login instead of each spending one against that budget.
let _adminCookie = null;
async function adminCookie() {
  if (_adminCookie) return _adminCookie;
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const token = cookieValue(login, "rs_admin");
  assert.ok(token, "shared admin login failed");
  _adminCookie = `rs_admin=${token}`;
  return _adminCookie;
}

async function postJson(p, body) {
  const r = await fetch(`${base}/api${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// --- Public flag endpoint ---
test("public flag: valid report is accepted, then deduped for the same reporter", async () => {
  const a = await postJson(`/maps/${mapId}/flag`, { reason: "broken", note: "cp2 teleport dead" });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { ok: true, duplicate: false });

  const dup = await postJson(`/maps/${mapId}/flag`, { reason: "broken", note: "again" });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.duplicate, true);

  const row = (await db.query("SELECT reason, note, status, reporter_hash FROM map_flag WHERE map_id=$1", [mapId])).rows;
  assert.equal(row.length, 1); // deduped to a single open row
  assert.equal(row[0].status, "open");
  assert.equal(row[0].note, "cp2 teleport dead"); // first note kept
  assert.ok(row[0].reporter_hash && !row[0].reporter_hash.includes(".")); // hashed, not a raw IP
});

test("public flag: bad reason 400, unknown map 404", async () => {
  assert.equal((await postJson(`/maps/${mapId}/flag`, { reason: "nonsense" })).status, 400);
  assert.equal((await postJson(`/maps/${mapId}/flag`, {})).status, 400);
  assert.equal((await postJson(`/maps/424242/flag`, { reason: "broken" })).status, 404);
});

// --- In-game /flag endpoint (token-authed, by map name) ---
test("game /flag: token-authed, by map name, deduped per player; 401 without token", async () => {
  const post = (body, token) =>
    fetch(`${base}/api/game/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  assert.equal((await post({ map: "flagmap", reason: "broken", login: "bob" }, null)).status, 401);
  assert.equal((await post({ map: "flagmap" }, "wrong")).status, 401);

  const ok = await post({ map: "flagmap", reason: "broken", player: "^1Bob", login: "bob" }, INGEST_TOKEN);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).duplicate, false);

  // The reporter's display name is stored (colour codes stripped), pulled from
  // the client by the /flag command.
  const bobRow = (
    await db.query("SELECT reporter_name FROM map_flag WHERE reporter_name IS NOT NULL ORDER BY id DESC LIMIT 1")
  ).rows[0];
  assert.equal(bobRow.reporter_name, "Bob");

  // Same player + map again -> deduped.
  const dup = await post({ map: "flagmap", reason: "broken", player: "^1Bob", login: "bob" }, INGEST_TOKEN);
  assert.equal((await dup.json()).duplicate, true);

  // Unknown map -> 404.
  assert.equal((await post({ map: "no-such-map", reason: "broken", login: "bob" }, INGEST_TOKEN)).status, 404);

  // A bad reason falls back to "other" (not a 400) — the in-game command is forgiving.
  const other = await post({ map: "flagmap", reason: "nonsense", player: "Carol", login: "carol" }, INGEST_TOKEN);
  assert.equal(other.status, 200);
  const row = (await db.query("SELECT reason FROM map_flag WHERE reporter_hash IS NOT NULL ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(row.reason, "other");
});

// --- Admin gate + login ---
test("admin pages require a session; login page is reachable", async () => {
  const gated = await fetch(`${base}/admin/flags`, { redirect: "manual" });
  assert.equal(gated.status, 302);
  assert.equal(gated.headers.get("location"), "/admin/login");
  // Not indexable.
  assert.match(gated.headers.get("x-robots-tag") || "", /noindex/);

  const login = await fetch(`${base}/admin/login`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /Sign in/);
});

test("login rejects a wrong password and issues a session for the right one", async () => {
  const bad = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: "wrong" }),
  });
  assert.equal(bad.status, 303);
  assert.match(bad.headers.get("location"), /error=1/);
  assert.equal(cookieValue(bad, "rs_admin"), null); // no session on failure

  const ok = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/admin/flags");
  const token = cookieValue(ok, "rs_admin");
  assert.match(token || "", /^[a-f0-9]{64}$/);
  // Session persisted (hashed) with a csrf token.
  const s = (await db.query("SELECT csrf FROM admin_session")).rows;
  assert.equal(s.length, 1);
  assert.ok(s[0].csrf);
});

test("login refuses an explicitly cross-site POST (login-CSRF / fixation guard)", async () => {
  // Foreign Origin -> 403, and no session is minted into the victim's browser.
  const xsite = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(xsite.status, 403);
  assert.equal(cookieValue(xsite, "rs_admin"), null);

  // Sec-Fetch-Site is browser-set; a cross-site value is refused even without Origin.
  const sfs = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  assert.equal(sfs.status, 403);
});

// --- Authenticated review flow (login -> queue -> resolve -> logout) ---
test("full review flow: queue shows the flag, CSRF-guarded resolve closes it, logout ends the session", async () => {
  // Log in and grab the cookie.
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const token = cookieValue(login, "rs_admin");
  const cookie = `rs_admin=${token}`;

  // The queue lists the flagged map and embeds a CSRF token.
  const queue = await fetch(`${base}/admin/flags`, { headers: { cookie } });
  assert.equal(queue.status, 200);
  const html = await queue.text();
  assert.match(html, /flagmap/);
  const csrf = html.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf, "csrf token present in the queue page");

  const flagId = (await db.query("SELECT id FROM map_flag WHERE map_id=$1 AND status='open'", [mapId])).rows[0].id;

  // Resolve WITHOUT a csrf token -> 403, flag stays open.
  const noCsrf = await fetch(`${base}/admin/flags/${flagId}/resolve`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(
    (await db.query("SELECT status FROM map_flag WHERE id=$1", [flagId])).rows[0].status,
    "open"
  );

  // Resolve WITHOUT a cookie -> 401 (unauthenticated POST).
  const noAuth = await fetch(`${base}/admin/flags/${flagId}/resolve`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(noAuth.status, 401);

  // Correct cookie + csrf -> 303 and the flag is resolved by this admin.
  const good = await fetch(`${base}/admin/flags/${flagId}/resolve`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(good.status, 303);
  const closed = (await db.query("SELECT status, resolved_by FROM map_flag WHERE id=$1", [flagId])).rows[0];
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolved_by, ADMIN_USER);

  // Logout invalidates the session; the cookie no longer opens the queue.
  const logout = await fetch(`${base}/admin/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(logout.status, 303);
  const after = await fetch(`${base}/admin/flags`, { headers: { cookie }, redirect: "manual" });
  assert.equal(after.status, 302); // session gone -> bounced to login
});

test("admin map-detail and account pages render for a signed-in moderator", async () => {
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const cookie = `rs_admin=${cookieValue(login, "rs_admin")}`;

  const mapPage = await fetch(`${base}/admin/flags/map/${mapId}`, { headers: { cookie } });
  assert.equal(mapPage.status, 200);
  assert.match(await mapPage.text(), /flagmap/);
  // Unknown map -> 404, not a rendered shell.
  assert.equal((await fetch(`${base}/admin/flags/map/424242`, { headers: { cookie } })).status, 404);

  const acct = await fetch(`${base}/admin/account`, { headers: { cookie } });
  assert.equal(acct.status, 200);
  assert.match(await acct.text(), /Change password/);

  // Unknown /admin path 404s (never falls through to the public SPA shell).
  const bogus = await fetch(`${base}/admin/nope`, { headers: { cookie }, redirect: "manual" });
  assert.equal(bogus.status, 404);
});

test("admin blocks a map: it appears on the game + JSON blocked endpoints, its flags close, then unblock", async () => {
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const cookie = `rs_admin=${cookieValue(login, "rs_admin")}`;
  const page = await (await fetch(`${base}/admin/flags/map/${mapId}`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf);

  assert.equal((await (await fetch(`${base}/api/game/blocked-maps`)).text()).trim(), ""); // nothing blocked yet

  const block = await fetch(`${base}/admin/flags/map/${mapId}/block`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(block.status, 303);

  // Surfaced on the game text endpoint and the JSON endpoint; open flags closed.
  assert.match(await (await fetch(`${base}/api/game/blocked-maps`)).text(), /flagmap/);
  const json = await (await fetch(`${base}/api/maps/blocked`)).json();
  assert.equal(json.maps.some((m) => m.name === "flagmap"), true);
  assert.equal((await db.query("SELECT count(*) c FROM map_block WHERE map_id=$1", [mapId])).rows[0].c, "1");
  assert.equal(
    (await db.query("SELECT count(*) c FROM map_flag WHERE map_id=$1 AND status='open'", [mapId])).rows[0].c,
    "0"
  );

  const unblock = await fetch(`${base}/admin/maps/${mapId}/unblock`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }),
  });
  assert.equal(unblock.status, 303);
  assert.equal((await (await fetch(`${base}/api/game/blocked-maps`)).text()).trim(), "");
});

test("admin edits the MOTD: sanitized, then served on /api/game/motd", async () => {
  const cookie = await adminCookie();

  // Anonymous access bounces to login; the editor shows the seeded default.
  const anon = await fetch(`${base}/admin/motd`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  const page = await (await fetch(`${base}/admin/motd`, { headers: { cookie } })).text();
  assert.match(page, /Welcome to a Dockerized Warsow race server/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf);

  // Missing CSRF -> 403, nothing saved.
  const forged = await fetch(`${base}/admin/motd`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ motd: "hax" }),
  });
  assert.equal(forged.status, 403);

  // Save a messy value: CRLF newlines, a double quote (would break the
  // `motd 1 "<text>"` game command quoting) and a control char.
  const save = await fetch(`${base}/admin/motd`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, motd: 'Race night ^2Friday!\r\nSay "hi" in chat\x07' }),
  });
  assert.equal(save.status, 303);

  const body = await (await fetch(`${base}/api/game/motd`)).text();
  assert.equal(body, "RSMOTD\nRace night ^2Friday!\nSay 'hi' in chat");

  // Clearing is a real state (no MOTD popup), not an error.
  const clear = await fetch(`${base}/admin/motd`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, motd: "" }),
  });
  assert.equal(clear.status, 303);
  assert.equal(await (await fetch(`${base}/api/game/motd`)).text(), "RSMOTD\n");
});

test("admin toggles whether generated maps count toward ratings", async () => {
  const cookie = await adminCookie();
  const anon = await fetch(`${base}/admin/mapgen`, { redirect: "manual" });
  assert.equal(anon.status, 302);

  // Default: off, and the page says so.
  const page = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(page, /Generated maps currently <b>do not count<\/b>/);
  assert.match(page, /never changed: the default applies/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf);

  const post = (fields) => fetch(`${base}/admin/mapgen`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  // Missing CSRF -> 403, nothing saved.
  assert.equal((await post({ rated: "1" })).status, 403);
  assert.equal((await db.query("SELECT value FROM site_setting WHERE key = 'mapgen_rated'")).rows.length, 0);

  // Turn it on: stored as "1", attributed, and the page flips.
  assert.equal((await post({ _csrf: csrf, rated: "1" })).status, 303);
  const row = (await db.query("SELECT value, updated_by FROM site_setting WHERE key = 'mapgen_rated'")).rows[0];
  assert.equal(row.value, "1");
  assert.ok(row.updated_by);
  const on = await (await fetch(`${base}/admin/mapgen?ok=1`, { headers: { cookie } })).text();
  assert.match(on, /Generated maps currently <b>count<\/b>/);
  assert.match(on, /The standings are being rebuilt/);

  // Anything but "1" means off.
  assert.equal((await post({ _csrf: csrf, rated: "yes" })).status, 303);
  assert.equal(
    (await db.query("SELECT value FROM site_setting WHERE key = 'mapgen_rated'")).rows[0].value, "0");
});

test("admin map requests skip the per-person limit and the site budget", async () => {
  const cookie = await adminCookie();
  const page = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(page, /Request a map/);
  assert.match(page, /No admin requests yet/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  const post = (fields) => fetch(`${base}/admin/mapgen/request`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

  assert.equal((await post({ description: "No token on this one, so refused" })).status, 403);
  const short = await post({ _csrf: csrf, description: "tiny" });
  assert.equal(short.status, 303);
  assert.match(short.headers.get("location"), /\/admin\/mapgen\?error=length/);

  // Well past the public default of one a day: every request is queued and
  // opens its public job page.
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const r = await post({ _csrf: csrf, description: `An admin test course number ${i} with \u202etricks` });
    assert.equal(r.status, 303);
    const m = r.headers.get("location").match(/^\/mapgen\/([0-9a-f]{32})$/);
    assert.ok(m, r.headers.get("location"));
    tokens.push(m[1]);
  }
  const jobs = (await db.query(
    "SELECT * FROM mapgen_job WHERE token = ANY($1) ORDER BY id", [tokens])).rows;
  assert.equal(jobs.length, 4);
  for (const j of jobs) {
    assert.equal(j.status, "queued");
    assert.equal(j.identity, null);
    assert.equal(j.quota_day, null);
    assert.ok(j.requested_by, "attributed to the admin");
    assert.ok(!/[\u202e]/.test(j.description), "cleaned like a public request");
  }
  // Neither limit moved.
  assert.equal((await db.query("SELECT COALESCE(SUM(used), 0)::int AS n FROM mapgen_quota")).rows[0].n, 0);
  assert.equal((await db.query("SELECT COALESCE(SUM(used), 0)::int AS n FROM mapgen_budget")).rows[0].n, 0);

  const after = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(after, new RegExp(`/mapgen/${tokens[3]}`));
});

test("a map-editor course waits for an admin: approve queues it, reject refunds it", async () => {
  const cookie = await adminCookie();
  const course = (title) => ({ name: "gen_review_test", title, width: 384,
    segments: [{ type: "straight", length: 768 }, { type: "ramp", length: 768, rise: -256, ice: true }, { type: "straight", length: 512 }] });
  const send = (ip, title) => fetch(`${base}/api/mapgen/spec`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, "User-Agent": "Mozilla/5.0 Firefox/143.0" },
    body: JSON.stringify({ spec: course(title) }),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const a = await send("198.51.100.71", "Glacier Approve");
  const b = await send("198.51.100.72", "Glacier Reject");
  assert.equal(a.status, 202);
  assert.equal(a.json.job.status, "review");
  assert.equal(b.json.job.status, "review");
  const used = async () => (await db.query("SELECT COALESCE(SUM(used), 0)::int AS n FROM mapgen_quota")).rows[0].n;
  const budget = async () => (await db.query("SELECT COALESCE(SUM(used), 0)::int AS n FROM mapgen_budget")).rows[0].n;
  const used0 = await used(), budget0 = await budget();

  const page = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(page, /Awaiting approval/);
  assert.match(page, /Glacier Approve/);
  assert.match(page, new RegExp(`/mapgen/editor\\?from=${a.json.job.token}`), "a 3-D preview link");
  assert.match(page, /1 icy/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  const post = (path, fields) => fetch(`${base}/admin/mapgen/${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  assert.equal((await post("approve", { token: a.json.job.token })).status, 403, "CSRF required");
  const anon = await fetch(`${base}/admin/mapgen/approve`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: a.json.job.token }) });
  assert.notEqual(anon.status, 303, "no session, no approval");

  // Approve: into the worker's queue, with who and when.
  const ok = await post("approve", { _csrf: csrf, token: a.json.job.token });
  assert.equal(ok.status, 303);
  assert.match(ok.headers.get("location"), /approved=1/);
  const ra = (await db.query("SELECT status, reviewed_by, reviewed_at FROM mapgen_job WHERE token = $1", [a.json.job.token])).rows[0];
  assert.equal(ra.status, "queued");
  assert.equal(ra.reviewed_by, ADMIN_USER);
  assert.ok(Number(ra.reviewed_at) > 0);
  assert.match((await post("approve", { _csrf: csrf, token: a.json.job.token })).headers.get("location"), /gone=1/,
    "deciding twice is refused");

  // Reject: never built, the reason shown, the map and the budget given back.
  const no = await post("reject", { _csrf: csrf, token: b.json.job.token, note: "  walls\u202e everywhere  " });
  assert.match(no.headers.get("location"), /rejected=1/);
  const rb = (await (await fetch(`${base}/api/mapgen/jobs/${b.json.job.token}`)).json());
  assert.equal(rb.status, "rejected");
  assert.equal(rb.error, "An admin turned this course down: walls everywhere It didn't count toward your daily maps.");
  assert.equal(await used(), used0 - 1);
  assert.equal(await budget(), budget0 - 1);
  assert.match((await post("reject", { _csrf: csrf, token: b.json.job.token })).headers.get("location"), /gone=1/);

  const after = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(after, /Nothing waiting/);
});

test("admin hides a built map from the public gallery and shows it again", async () => {
  const cookie = await adminCookie();
  const token = "cd".repeat(16);
  await db.query(
    `INSERT INTO mapgen_job (token, description, status, map_name, created_at, published_at)
     VALUES ($1, 'a course with words nobody should list', 'published', 'gen_gallery_hide_cdcdcd', 1, 2)`,
    [token]);
  const listed = async () => (await (await fetch(`${base}/api/mapgen/gallery`)).json()).maps
    .some((m) => m.token === token);
  assert.equal(await listed(), true);

  const page = await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text();
  assert.match(page, /gen_gallery_hide_cdcdcd/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  const post = (fields) => fetch(`${base}/admin/mapgen/hide`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  assert.equal((await post({ token, hidden: "1" })).status, 403, "CSRF required");
  assert.equal(await listed(), true);
  assert.equal((await post({ _csrf: csrf, token: "ef".repeat(16), hidden: "1" })).status, 404);

  assert.equal((await post({ _csrf: csrf, token, hidden: "1" })).status, 303);
  assert.equal(await listed(), false);
  const row = (await db.query("SELECT hidden_at, hidden_by FROM mapgen_job WHERE token = $1", [token])).rows[0];
  assert.ok(row.hidden_at && row.hidden_by);
  // Its own page still works.
  assert.equal((await fetch(`${base}/api/mapgen/jobs/${token}`)).status, 200);
  assert.match(await (await fetch(`${base}/admin/mapgen`, { headers: { cookie } })).text(), />Show</);

  assert.equal((await post({ _csrf: csrf, token, hidden: "0" })).status, 303);
  assert.equal(await listed(), true);
});

test("admin edits announcements: one per line, sanitized, then served on /api/game/announcements", async () => {
  const cookie = await adminCookie();

  // Anonymous access bounces to login; the editor shows the seeded rotation.
  const anon = await fetch(`${base}/admin/announcements`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  const page = await (await fetch(`${base}/admin/announcements`, { headers: { cookie } })).text();
  assert.match(page, /In-game announcements/);
  assert.match(page, /racesow\.org/);
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf);

  // Missing CSRF -> 403, nothing saved.
  const forged = await fetch(`${base}/admin/announcements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ text: "hax" }),
  });
  assert.equal(forged.status, 403);

  // Save a messy list: CRLF newlines, a blank line (dropped), a control char
  // (stripped), and leading/trailing whitespace (trimmed) per line.
  const save = await fetch(`${base}/admin/announcements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, text: "  ^1First message  \r\n\r\n\tSecond line\x07  \r\n" }),
  });
  assert.equal(save.status, 303);

  const body = await (await fetch(`${base}/api/game/announcements`)).text();
  assert.equal(body, "RSANN\n^1First message\nSecond line");

  // Clearing is a real state (rotation off), not an error.
  const clear = await fetch(`${base}/admin/announcements`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, text: "" }),
  });
  assert.equal(clear.status, 303);
  assert.equal(await (await fetch(`${base}/api/game/announcements`)).text(), "RSANN\n");
});

// --- Admin / moderator role tiers ---
test("moderator tier: flags + map-block + restart allowed; admin-only surface is 403", async () => {
  const now = Math.floor(Date.now() / 1000);
  const MOD_USER = "modtester";
  const MOD_PASS = "mod-password-123";
  await db.query(
    "INSERT INTO admin_user (username, password_hash, role, created_at) VALUES ($1,$2,'moderator',$3)",
    [MOD_USER, hashPassword(MOD_PASS), now]
  );
  const modMapId = Number(
    (await db.query("INSERT INTO map (name) VALUES ($1) RETURNING id", ["modblockmap"])).rows[0].id
  );

  const login = async (u, p) => {
    const r = await fetch(`${base}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: u, password: p }),
    });
    const token = cookieValue(r, "rs_admin");
    assert.ok(token, `login failed for ${u}`);
    return `rs_admin=${token}`;
  };
  const pageText = async (cookie, p) => (await fetch(`${base}${p}`, { headers: { cookie } })).text();

  const mod = await login(MOD_USER, MOD_PASS);

  // Allowed pages: flag review, blocked maps, servers (reduced), own account.
  for (const p of ["/admin/flags", "/admin/flags/all", "/admin/blocked", "/admin/servers", "/admin/account"]) {
    assert.equal(
      (await fetch(`${base}${p}`, { headers: { cookie: mod }, redirect: "manual" })).status,
      200,
      `moderator GET ${p} should be allowed`
    );
  }

  // The moderator's /servers is the reduced view: no maintenance / broadcast /
  // RCON console; and the flag-queue nav hides the admin-only links.
  const serversHtml = await pageText(mod, "/admin/servers");
  assert.ok(!/action="\/admin\/maintenance"/.test(serversHtml), "no maintenance form for moderator");
  assert.ok(!/action="\/admin\/broadcast"/.test(serversHtml), "no broadcast form for moderator");
  assert.ok(!/\/rcon"/.test(serversHtml), "no RCON console link for moderator");
  const flagsHtml = await pageText(mod, "/admin/flags");
  assert.ok(!/href="\/admin\/motd"/.test(flagsHtml), "no MOTD link for moderator");
  assert.ok(!/href="\/admin\/announcements"/.test(flagsHtml), "no announcements link for moderator");
  assert.ok(!/href="\/admin\/logs"/.test(flagsHtml), "no logs link for moderator");
  assert.ok(!/href="\/admin\/mapgen"/.test(flagsHtml), "no generated-maps link for moderator");
  assert.equal((await fetch(`${base}/admin/mapgen`, { headers: { cookie: mod } })).status, 403,
    "the rating flag is admin-only");
  assert.equal((await fetch(`${base}/admin/mapgen/request`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: mod, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ description: "A moderator's course request" }),
  })).status, 403, "unlimited map requests are admin-only");
  assert.equal((await fetch(`${base}/admin/mapgen/hide`, {
    method: "POST", redirect: "manual",
    headers: { cookie: mod, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "cd".repeat(16), hidden: "1" }),
  })).status, 403, "moderator cannot hide gallery entries");

  // Allowed action: block then unblock a map (CSRF from any moderator page).
  const csrf = flagsHtml.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf, "moderator page carries a CSRF token");
  const form = (cookie, extra = {}) => ({
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...extra }),
  });

  assert.equal((await fetch(`${base}/admin/flags/map/${modMapId}/block`, form(mod))).status, 303, "moderator can block");
  assert.match(await pageText(mod, "/admin/blocked"), /modblockmap/, "blocked map shows on the list");
  assert.equal((await fetch(`${base}/admin/maps/${modMapId}/unblock`, form(mod))).status, 303, "moderator can unblock");
  assert.doesNotMatch(await pageText(mod, "/admin/blocked"), /modblockmap/, "unblocked map is gone");

  // Restart passes the gate: a bogus id 404s (handler ran), it is NOT a 403.
  assert.equal(
    (await fetch(`${base}/admin/servers/987654/restart`, { headers: { cookie: mod }, redirect: "manual" })).status,
    404,
    "moderator is allowed through the restart gate"
  );

  // Denied (admin-only) GETs -> 403 "Admins only".
  for (const p of ["/admin/motd", "/admin/announcements", "/admin/logs", "/admin/servers/987654/rcon"]) {
    assert.equal(
      (await fetch(`${base}${p}`, { headers: { cookie: mod }, redirect: "manual" })).status,
      403,
      `moderator GET ${p} should be forbidden`
    );
  }
  // Denied (admin-only) POSTs -> 403 (the role gate runs before CSRF/handler,
  // so a valid CSRF token does not help a moderator here).
  for (const p of ["/admin/motd", "/admin/announcements", "/admin/maintenance", "/admin/broadcast", "/admin/servers/987654/rcon"]) {
    assert.equal(
      (await fetch(`${base}${p}`, form(mod, { action: "on", message: "x", motd: "x", text: "x", command: "status" }))).status,
      403,
      `moderator POST ${p} should be forbidden`
    );
  }

  // The admin tier (ADMIN_USER was seeded WITHOUT a role column -> DEFAULT
  // 'admin', proving backward compatibility) keeps the full admin-only surface.
  const adm = await login(ADMIN_USER, ADMIN_PASS);
  for (const p of ["/admin/motd", "/admin/announcements", "/admin/logs"]) {
    assert.equal(
      (await fetch(`${base}${p}`, { headers: { cookie: adm }, redirect: "manual" })).status,
      200,
      `admin GET ${p} should be allowed`
    );
  }
  // And the admin's /servers shows the full console (maintenance + broadcast).
  const admServers = await pageText(adm, "/admin/servers");
  assert.match(admServers, /action="\/admin\/maintenance"/, "admin sees the maintenance form");
  assert.match(admServers, /action="\/admin\/broadcast"/, "admin sees the broadcast form");
});

// --- Blog / site updates ---------------------------------------------------
// The public read paths are covered in blog.test.js; what matters here is the
// admin flow around them: the tier gate, CSRF, slug derivation, and the fact
// that "publish" is the single control deciding whether the world sees a post.

async function blogPage(pathname) {
  const r = await fetch(`${base}${pathname}`, { headers: { cookie: await adminCookie() } });
  const html = await r.text();
  return { status: r.status, html, csrf: html.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1] };
}

async function blogPost(pathname, fields, csrf) {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: await adminCookie(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, ...fields }),
  });
}

test("blog: a post is created with a derived slug and is public only once published", async () => {
  const form = await blogPage("/admin/blog/new");
  assert.equal(form.status, 200);

  // Created as a DRAFT (publish unchecked -> the field is simply absent, which
  // is how an HTML checkbox says "off").
  const created = await blogPost("/admin/blog/new", {
    title: "373 New Maps!",
    tag: "maps",
    summary: "",
    body: "We added **373** maps.\n\n- surf\n- slick",
  }, form.csrf);
  assert.equal(created.status, 303);

  const row = (await db.query("SELECT * FROM blog_post")).rows[0];
  assert.equal(row.slug, "373-new-maps", "slug derived from the title");
  assert.equal(row.tag, "maps");
  assert.equal(row.published_at, null, "unchecked publish => draft");
  assert.equal(row.author, ADMIN_USER);

  // A draft is invisible everywhere public.
  assert.equal((await fetch(`${base}/api/blog/373-new-maps`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/blog`)).json()).total, 0);

  // Publish it from the list, then it appears.
  const list = await blogPage("/admin/blog");
  assert.match(list.html, /373 New Maps!/);
  const pub = await blogPost(`/admin/blog/${row.id}/publish`, {}, list.csrf);
  assert.equal(pub.status, 303);

  const now = await (await fetch(`${base}/api/blog/373-new-maps`)).json();
  assert.equal(now.title, "373 New Maps!");
  assert.match(now.html, /<strong>373<\/strong>/);
  // The teaser falls back to the body when no summary was given.
  assert.match(now.teaser, /373/);
});

test("blog: a duplicate slug is reported, not thrown, and never clobbers the original", async () => {
  const form = await blogPage("/admin/blog/new");
  const dup = await blogPost("/admin/blog/new", {
    title: "373 New Maps!", tag: "update", summary: "", body: "different body",
  }, form.csrf);
  // Re-renders the form with an error rather than redirecting or 500ing.
  assert.equal(dup.status, 200);
  assert.match(await dup.text(), /already taken/i);

  const rows = (await db.query("SELECT body FROM blog_post WHERE slug = '373-new-maps'")).rows;
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /We added/, "the original post is untouched");
});

test("blog: editing keeps the slug and can pull a post back to draft", async () => {
  const id = (await db.query("SELECT id FROM blog_post WHERE slug='373-new-maps'")).rows[0].id;
  const page = await blogPage(`/admin/blog/${id}`);
  assert.equal(page.status, 200);
  assert.match(page.html, /Preview/, "the saved body is previewed as rendered");

  // Save with publish unchecked -> back to draft, slug unchanged.
  const saved = await blogPost(`/admin/blog/${id}`, {
    title: "373 new maps (edited)", tag: "maps", summary: "Now with a teaser.", body: "edited body",
  }, page.csrf);
  assert.equal(saved.status, 303);

  const row = (await db.query("SELECT * FROM blog_post WHERE id=$1", [id])).rows[0];
  assert.equal(row.slug, "373-new-maps", "the slug is not rewritten by a re-title");
  assert.equal(row.title, "373 new maps (edited)");
  assert.equal(row.published_at, null);
  assert.equal((await fetch(`${base}/api/blog/373-new-maps`)).status, 404);
});

test("blog: a bad publish date is refused instead of stamping the epoch", async () => {
  const id = (await db.query("SELECT id FROM blog_post WHERE slug='373-new-maps'")).rows[0].id;
  const page = await blogPage(`/admin/blog/${id}`);
  const r = await blogPost(`/admin/blog/${id}`, {
    title: "T", tag: "maps", summary: "", body: "b", publish: "on", published_at: "not-a-date",
  }, page.csrf);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /publish date/i);
  const row = (await db.query("SELECT published_at FROM blog_post WHERE id=$1", [id])).rows[0];
  assert.equal(row.published_at, null, "still a draft, not published at 1970");
});

test("blog: an explicit backdate is honoured", async () => {
  const id = (await db.query("SELECT id FROM blog_post WHERE slug='373-new-maps'")).rows[0].id;
  const page = await blogPage(`/admin/blog/${id}`);
  const r = await blogPost(`/admin/blog/${id}`, {
    title: "T", tag: "maps", summary: "", body: "b", publish: "on", published_at: "2026-08-12T09:30",
  }, page.csrf);
  assert.equal(r.status, 303);
  const row = (await db.query("SELECT published_at FROM blog_post WHERE id=$1", [id])).rows[0];
  // The form has no timezone; the site reads it as UTC.
  assert.equal(Number(row.published_at), Math.floor(Date.parse("2026-08-12T09:30:00Z") / 1000));
});

test("blog: writes need CSRF and an admin session", async () => {
  const id = (await db.query("SELECT id FROM blog_post WHERE slug='373-new-maps'")).rows[0].id;

  // No CSRF token.
  const noCsrf = await fetch(`${base}/admin/blog/${id}/publish`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: await adminCookie(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({}),
  });
  assert.equal(noCsrf.status, 403);

  // No session at all -> bounced to the login page, not served.
  const anon = await fetch(`${base}/admin/blog`, { redirect: "manual" });
  assert.ok([302, 303].includes(anon.status), `expected a redirect, got ${anon.status}`);
});

test("blog: a non-numeric post id is a 404, not a 500", async () => {
  const r = await fetch(`${base}/admin/blog/not-an-id`, { headers: { cookie: await adminCookie() } });
  assert.equal(r.status, 404);
});

test("blog: delete removes the post", async () => {
  const id = (await db.query("SELECT id FROM blog_post WHERE slug='373-new-maps'")).rows[0].id;
  const page = await blogPage(`/admin/blog/${id}`);
  const r = await blogPost(`/admin/blog/${id}/delete`, {}, page.csrf);
  assert.equal(r.status, 303);
  assert.equal((await db.query("SELECT id FROM blog_post")).rows.length, 0);
});
