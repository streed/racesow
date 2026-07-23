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
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const cookie = `rs_admin=${cookieValue(login, "rs_admin")}`;

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
  assert.ok(!/href="\/admin\/logs"/.test(flagsHtml), "no logs link for moderator");

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
  for (const p of ["/admin/motd", "/admin/logs", "/admin/servers/987654/rcon"]) {
    assert.equal(
      (await fetch(`${base}${p}`, { headers: { cookie: mod }, redirect: "manual" })).status,
      403,
      `moderator GET ${p} should be forbidden`
    );
  }
  // Denied (admin-only) POSTs -> 403 (the role gate runs before CSRF/handler,
  // so a valid CSRF token does not help a moderator here).
  for (const p of ["/admin/motd", "/admin/maintenance", "/admin/broadcast", "/admin/servers/987654/rcon"]) {
    assert.equal(
      (await fetch(`${base}${p}`, form(mod, { action: "on", message: "x", motd: "x", command: "status" }))).status,
      403,
      `moderator POST ${p} should be forbidden`
    );
  }

  // The admin tier (ADMIN_USER was seeded WITHOUT a role column -> DEFAULT
  // 'admin', proving backward compatibility) keeps the full admin-only surface.
  const adm = await login(ADMIN_USER, ADMIN_PASS);
  for (const p of ["/admin/motd", "/admin/logs"]) {
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
