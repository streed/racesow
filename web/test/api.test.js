// Integration tests for the HTTP API: spawn the real server.js on a fresh
// database and drive it over HTTP, including the exact JSON contract the game
// module's RS_ApiReportRace native emits.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");

const TOKEN = "test-shared-token-1234";
let proc;
let dir;
let base;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "raceapi-"));
  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(dir, "db.sqlite"),
      INGEST_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  // Wait for /api/health.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(() => {
  if (proc) proc.kill("SIGTERM");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The byte-exact body shape g_rs_api.cpp builds (field order and all).
function gameBody({ version = "wsw 2.1", map, name, login = "", time, cps = [] }) {
  return (
    `{"version":${JSON.stringify(version)},"map":${JSON.stringify(map)},` +
    `"source":"racelog","records":[{"name":${JSON.stringify(name)},` +
    `"login":${JSON.stringify(login)},"time":${time},"checkpoints":[${cps.join(",")}]}]}`
  );
}

async function ingest(body, token = TOKEN) {
  const headers = { "Content-Type": "application/json" };
  if (token != null) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api/ingest`, { method: "POST", headers, body });
  return { status: r.status, json: await r.json() };
}

async function get(p) {
  const r = await fetch(`${base}/api${p}`);
  assert.equal(r.status, 200, `GET ${p} -> ${r.status}`);
  return r.json();
}

test("ingest rejects missing/wrong bearer tokens", async () => {
  assert.equal((await ingest(gameBody({ map: "m", name: "x", time: 1000 }), null)).status, 401);
  assert.equal((await ingest(gameBody({ map: "m", name: "x", time: 1000 }), "wrong")).status, 401);
});

test("ingest validates the payload", async () => {
  assert.equal((await ingest(`{"map":"m","records":[]}`)).status, 400); // no version
  assert.equal((await ingest(`{"version":"v","map":"m","records":[]}`)).status, 400); // empty records
  assert.equal((await ingest(`not json`)).status, 400);
  // Records with a non-positive or absurd time are dropped; all-invalid -> 400.
  assert.equal(
    (await ingest(gameBody({ map: "m", name: "x", time: -5 }))).status,
    400
  );
});

test("a finish POSTed exactly as the game module sends it lands in the DB and the API", async () => {
  // Player joins, runs the map three times: 52.0s, PR 48.0s, then 50.0s.
  const cpRuns = [
    { time: 52000, cps: [11000, 30000] },
    { time: 48000, cps: [10000, 28000] },
    { time: 50000, cps: [10500, 29000] },
  ];
  for (const run of cpRuns) {
    const { status, json } = await ingest(
      gameBody({ map: "testmap1", name: "^1No^7va", time: run.time, cps: run.cps })
    );
    assert.equal(status, 200, JSON.stringify(json));
  }

  // A second player, one finish (colour-coded name exercises simplification).
  assert.equal(
    (await ingest(gameBody({ map: "testmap1", name: "^4Wa^5ve", time: 49000, cps: [9800, 27500] }))).status,
    200
  );

  // Aggregates refresh is debounced (3s) — wait it out, then check the API.
  await new Promise((r) => setTimeout(r, 4000));

  const maps = await get("/maps?q=testmap1");
  assert.equal(maps.total, 1);
  const m = maps.rows[0];
  assert.equal(m.finishes, 4); // every attempt counted
  assert.equal(m.players, 2);
  assert.equal(m.wr_time, 48000);

  const detail = await get(`/maps/${m.id}?limit=10000`);
  // Records for ALL players: one PR each, ordered fastest first.
  assert.equal(detail.leaderboard.length, 2);
  assert.deepEqual(
    detail.leaderboard.map((r) => [r.simplified, r.time]),
    [["Nova", 48000], ["Wave", 49000]]
  );
  // WR splits are the PR run's checkpoints.
  assert.deepEqual(detail.wr.splits, [10000, 28000]);
  // Best possible split time: best of each segment across both players.
  // Segments: min(10000, 9800)=9800; min(18000, 17700)=17700; min(20000, 21500)=20000.
  assert.ok(detail.perfect && detail.perfect.complete);
  assert.equal(detail.perfect.time, 9800 + 17700 + 20000);
  assert.ok(detail.perfect.time <= detail.wr.time);

  // The player page shows the PR and the attempt count.
  const player = detail.leaderboard[0];
  const pd = await get(`/players/${player.playerId}`);
  assert.equal(pd.records.rows.length, 1);
  assert.equal(pd.records.rows[0].time, 48000);
  assert.equal(pd.finishes, 3);

  // Overview totals reflect the ingested world.
  const ov = await get("/overview");
  assert.equal(ov.totals.finishes, 4);
  assert.equal(ov.totals.records, 2);
  assert.ok(ov.recent.length >= 1); // recent-records feed has entries
});

test("re-sending the same finish is idempotent for records", async () => {
  const body = gameBody({ map: "testmap2", name: "Rep", time: 30000, cps: [15000] });
  const first = await ingest(body);
  assert.deepEqual(first.json, { inserted: 1, improved: 0, unchanged: 0 });
  const second = await ingest(body);
  assert.deepEqual(second.json, { inserted: 0, improved: 0, unchanged: 1 });
});

test("names are truncated and checkpoint garbage is normalised, not fatal", async () => {
  const longName = "N".repeat(200);
  const { status } = await ingest(
    `{"version":"wsw 2.1","map":"testmap3","source":"racelog","records":[{"name":${JSON.stringify(
      longName
    )},"login":"","time":25000,"checkpoints":[-5,"junk",12000]}]}`
  );
  assert.equal(status, 200);
  await new Promise((r) => setTimeout(r, 3500));
  const maps = await get("/maps?q=testmap3");
  assert.equal(maps.rows[0].wr_time, 25000);
});
