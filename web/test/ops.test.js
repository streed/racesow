// Integration tests for the operator console: per-server RCON, the maintenance
// toggle, the console log-ingest endpoint, and the /admin/servers + /admin/logs
// pages. Spawns the real server.js on a throwaway PostgreSQL database (like
// admin.test.js) and drives it over HTTP, with an in-process fake rcon server
// standing in for a game server so broadcasts/console commands resolve for real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADMIN_URL } from "./pg-util.js";
import { openDatabase, hashPassword } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");
const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

const ADMIN_USER = "opstester";
const ADMIN_PASS = "ops-password-123";
const SRV_TOKEN = "ops-test-server-token";
const RCON_PW = "rcon-secret";

let proc, dbName, dbUrl, base, race, serverId;
let rconPort, rconRx; // fake rcon server: port + received commands

async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

// In-process fake rcon server: records the commands it receives and replies
// with a print echo (or a refusal on a bad password).
function startFakeRcon() {
  rconRx = [];
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    fakeRconSock = sock;
    sock.on("message", (msg, rinfo) => {
      if (!msg.subarray(0, 4).equals(OOB)) return;
      const m = msg.subarray(4).toString("latin1").match(/^rcon (\S+) ([\s\S]*)$/);
      if (!m) return;
      const cmd = m[2].replace(/\n$/, "");
      rconRx.push({ pass: m[1], cmd });
      const body = m[1] === RCON_PW ? "print\nran: " + cmd : "print\nBad rcon_password.\n";
      sock.send(Buffer.concat([OOB, Buffer.from(body, "latin1")]), rinfo.port, rinfo.address);
    });
    sock.bind(0, "127.0.0.1", () => resolve(sock.address().port));
  });
}
let fakeRconSock;

before(async () => {
  dbName = "test_ops_" + crypto.randomBytes(6).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  const port = 18500 + Math.floor(Math.random() * 1400);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: dbUrl, ADMIN_COOKIE_INSECURE: "1" },
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
  // Migrations have run — open our own handle for seeding + db-method assertions.
  race = await openDatabase(dbUrl);
  const now = Math.floor(Date.now() / 1000);
  await race.pool.query("INSERT INTO admin_user (username, password_hash, created_at) VALUES ($1,$2,$3)", [
    ADMIN_USER,
    hashPassword(ADMIN_PASS),
    now,
  ]);
  rconPort = await startFakeRcon();
  const { id } = await race.enrollServer("EU Frankfurt", SRV_TOKEN);
  serverId = id;
  await race.setServerAddress(id, `127.0.0.1:${rconPort}`);
  await race.setServerRcon(id, RCON_PW);
});

after(async () => {
  if (race) await race.close().catch(() => {});
  if (fakeRconSock) try { fakeRconSock.close(); } catch {}
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

async function login() {
  const res = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  let token = null;
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = c.match(/^rs_admin=([^;]*)/);
    if (m) token = m[1];
  }
  assert.ok(token, "got a session cookie");
  const cookie = `rs_admin=${token}`;
  const page = await (await fetch(`${base}/admin/servers`, { headers: { cookie } })).text();
  const csrf = page.match(/name="_csrf" value="([0-9a-f]+)"/)?.[1];
  assert.ok(csrf, "csrf token present");
  return { cookie, csrf };
}

function postForm(p, cookie, body) {
  return fetch(`${base}${p}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

// ---------------------------------------------------------------- DB layer ---
test("serversAdmin exposes an rcon flag but never the password; servers() is clean too", async () => {
  const admin = (await race.serversAdmin()).find((s) => s.id === serverId);
  assert.equal(admin.rcon, true);
  assert.ok(!("rcon_password" in admin), "serversAdmin must not leak the secret");
  const pub = (await race.servers()).find((s) => s.id === serverId);
  assert.ok(!("rcon_password" in pub), "servers() must not leak the secret");
  const byId = await race.serverById(serverId);
  assert.equal(byId.rcon_password, RCON_PW); // admin-only reader does see it
});

test("rconTargets includes address+password servers and excludes others", async () => {
  const { id: bare } = await race.enrollServer("no-rcon", "tok-" + crypto.randomBytes(4).toString("hex"));
  await race.setServerAddress(bare, "127.0.0.1:44400"); // address but no rcon password
  const ids = (await race.rconTargets()).map((t) => t.id);
  assert.ok(ids.includes(serverId));
  assert.ok(!ids.includes(bare));
});

test("getConfig/setConfig round-trip and delete", async () => {
  await race.setConfig("t_key", "hello");
  assert.equal(await race.getConfig("t_key"), "hello");
  await race.setConfig("t_key", null);
  assert.equal(await race.getConfig("t_key"), null);
});

test("maintenanceState + claimMaintenanceRebroadcast are atomic-claim safe", async () => {
  const now = Math.floor(Date.now() / 1000);
  await race.setConfig("maintenance_active", "1");
  await race.setConfig("maintenance_since", String(now));
  await race.setConfig("maintenance_message", "brb");
  await race.setConfig("maintenance_rebroadcast_at", String(now + 100)); // not due yet
  const s = await race.maintenanceState();
  assert.equal(s.active, true);
  assert.equal(s.message, "brb");
  assert.equal(await race.claimMaintenanceRebroadcast(now, 180), false); // not due
  assert.equal(await race.claimMaintenanceRebroadcast(now + 200, 180), true); // due -> claimed once
  assert.equal(await race.claimMaintenanceRebroadcast(now + 200, 180), false); // already advanced
  // reset so it doesn't perturb the HTTP maintenance test
  for (const k of ["maintenance_active", "maintenance_since", "maintenance_message", "maintenance_rebroadcast_at"])
    await race.setConfig(k, k === "maintenance_active" ? "0" : null);
});

test("appendServerLog / recentServerLogs / pruneServerLogs", async () => {
  await race.appendServerLog([
    { serverId, source: "system", line: "l1" },
    { serverId, source: "system", line: "l2" },
    { serverId: null, source: "system", line: "l3-orphan" },
  ]);
  const rows = await race.recentServerLogs({ source: "system", limit: 100 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].line, "l3-orphan"); // newest first
  assert.equal(rows[2].line, "l1");
  const forServer = await race.recentServerLogs({ serverId, source: "system", limit: 100 });
  assert.equal(forServer.length, 2);
  assert.equal(forServer[0].serverName, "EU Frankfurt"); // join populates the name
  await race.pruneServerLogs(2);
  assert.ok((await race.recentServerLogs({ limit: 100 })).length <= 2);
});

// --------------------------------------------------------------- HTTP layer --
test("POST /api/ingest/log stores console lines for the authed server; 401 without token", async () => {
  const noauth = await fetch(`${base}/api/ingest/log`, { method: "POST", body: "x" });
  assert.equal(noauth.status, 401);

  const res = await fetch(`${base}/api/ingest/log`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SRV_TOKEN}`, "Content-Type": "text/plain" },
    body: "]map coldrun\nclient connected\n",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).stored, 2);
  const rows = (
    await race.pool.query("SELECT source, server_id, line FROM server_log WHERE source='console' ORDER BY id")
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(Number(rows[0].server_id), serverId);
  assert.match(rows[0].line, /map coldrun/);

  const empty = await fetch(`${base}/api/ingest/log`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SRV_TOKEN}`, "Content-Type": "text/plain" },
    body: "\n\n",
  });
  assert.equal((await empty.json()).stored, 0);
});

test("admin ops pages render behind a session", async () => {
  const { cookie } = await login();
  const servers = await fetch(`${base}/admin/servers`, { headers: { cookie } });
  assert.equal(servers.status, 200);
  const html = await servers.text();
  assert.match(html, /EU Frankfurt/);
  assert.match(html, /Maintenance mode/);
  assert.equal((await fetch(`${base}/admin/logs`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/admin/servers/${serverId}/rcon`, { headers: { cookie } })).status, 200);
  // Gated without a session.
  const gated = await fetch(`${base}/admin/servers`, { redirect: "manual" });
  assert.equal(gated.status, 302);
});

test("broadcast sends a say to every rcon server", async () => {
  const { cookie, csrf } = await login();
  rconRx.length = 0;
  const r = await postForm("/admin/broadcast", cookie, { _csrf: csrf, message: "New maps added" });
  assert.equal(r.status, 303);
  // Give the UDP round-trip a moment.
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(rconRx.some((x) => /say ".*New maps added.*"/.test(x.cmd)), "fake server received the say");
  const logged = (await race.pool.query("SELECT line FROM server_log WHERE source='rcon' ORDER BY id DESC LIMIT 5")).rows;
  assert.ok(logged.some((l) => /broadcast/.test(l.line)));
});

test("maintenance toggle flips /api/live and re-broadcasts", async () => {
  const { cookie, csrf } = await login();
  rconRx.length = 0;
  const on = await postForm("/admin/maintenance", cookie, { _csrf: csrf, action: "on", message: "^3Down for 5 min" });
  assert.equal(on.status, 303);
  const live = await (await fetch(`${base}/api/live`)).json();
  assert.equal(live.maintenance.active, true);
  assert.match(live.maintenance.message, /Down for 5 min/);
  assert.ok(rconRx.some((x) => /say/.test(x.cmd)), "maintenance notice broadcast");

  const off = await postForm("/admin/maintenance", cookie, { _csrf: csrf, action: "off" });
  assert.equal(off.status, 303);
  const live2 = await (await fetch(`${base}/api/live`)).json();
  assert.equal(live2.maintenance.active, false);
});

test("rcon console runs benign commands and guards dangerous ones behind confirm", async () => {
  const { cookie, csrf } = await login();
  // Benign command runs and shows the fake server's echo.
  const ok = await postForm(`/admin/servers/${serverId}/rcon`, cookie, { _csrf: csrf, command: "status" });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /ran: status/);

  // A dangerous command without confirm is blocked (not sent).
  rconRx.length = 0;
  const blocked = await postForm(`/admin/servers/${serverId}/rcon`, cookie, { _csrf: csrf, command: "quit" });
  assert.match(await blocked.text(), /blocked/i);
  assert.ok(!rconRx.some((x) => x.cmd === "quit"), "quit not sent without confirm");

  // ';'-chaining must not smuggle a dangerous command past the guard.
  rconRx.length = 0;
  const chained = await postForm(`/admin/servers/${serverId}/rcon`, cookie, { _csrf: csrf, command: "status; quit" });
  assert.match(await chained.text(), /blocked/i);
  assert.ok(!rconRx.some((x) => /quit/.test(x.cmd)), "chained quit not sent without confirm");

  // With confirm it goes through.
  const confirmed = await postForm(`/admin/servers/${serverId}/rcon`, cookie, {
    _csrf: csrf,
    command: "quit",
    confirm: "1",
  });
  assert.equal(confirmed.status, 200);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(rconRx.some((x) => x.cmd === "quit"), "quit sent with confirm");
});

test("per-server restart sends RCON quit behind a confirmation page + CSRF", async () => {
  const { cookie, csrf } = await login();

  // The servers list offers a Restart action for the rcon-enabled server.
  const list = await (await fetch(`${base}/admin/servers`, { headers: { cookie } })).text();
  assert.match(list, new RegExp(`/admin/servers/${serverId}/restart`));

  // GET renders a confirmation interstitial (no side effect) with a POST form.
  rconRx.length = 0;
  const confirmPage = await fetch(`${base}/admin/servers/${serverId}/restart`, { headers: { cookie } });
  assert.equal(confirmPage.status, 200);
  const confirmHtml = await confirmPage.text();
  assert.match(confirmHtml, /Restart now/);
  assert.match(confirmHtml, new RegExp(`action="/admin/servers/${serverId}/restart"`));
  assert.ok(!rconRx.some((x) => x.cmd === "quit"), "GET must not send quit");

  // Invalid CSRF is rejected — no quit sent.
  rconRx.length = 0;
  const bad = await postForm(`/admin/servers/${serverId}/restart`, cookie, { _csrf: "deadbeef" });
  assert.equal(bad.status, 403);
  assert.ok(!rconRx.some((x) => x.cmd === "quit"), "no quit on CSRF failure");

  // POST with CSRF actually sends `quit` and redirects with a success notice.
  rconRx.length = 0;
  const done = await postForm(`/admin/servers/${serverId}/restart`, cookie, { _csrf: csrf });
  assert.equal(done.status, 303);
  assert.match(done.headers.get("location"), /done=/);
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(rconRx.some((x) => x.cmd === "quit"), "restart sent quit over rcon");

  // ...and it is audit-logged as a restart.
  const logged = (await race.pool.query("SELECT line FROM server_log WHERE source='rcon' ORDER BY id DESC LIMIT 5")).rows;
  assert.ok(logged.some((l) => /restart by .*quit sent/.test(l.line)), "restart audit-logged");
});

test("rcon/broadcast POSTs require a valid CSRF token", async () => {
  const { cookie } = await login();
  const bad = await postForm("/admin/broadcast", cookie, { _csrf: "deadbeef", message: "nope" });
  assert.equal(bad.status, 403);
});
