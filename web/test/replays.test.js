// Integration tests for the replay feature: WR demo metadata + ghost
// trajectory ingest/serving. Spawns the real server.js on a throwaway DB with
// an isolated GHOST_DIR and drives it over HTTP, exercising the exact JSON the
// game module's natives will emit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADMIN_URL } from "./pg-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");

const TOKEN = "test-shared-token-replays";
const DEMO_BASE = "http://demos.example.test:44445";
let proc;
let dbName;
let ghostDir;
let base;

async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function ingest(body, token = TOKEN, route = "/ingest") {
  const headers = { "Content-Type": "application/json" };
  if (token != null) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api${route}`, { method: "POST", headers, body });
  return { status: r.status, json: await r.json() };
}

async function getJson(p) {
  const r = await fetch(`${base}/api${p}`);
  assert.equal(r.status, 200, `GET ${p} -> ${r.status}`);
  return r.json();
}

// A finish exactly as g_rs_api.cpp emits it (drives the leaderboard + WR).
function finishBody({ map, name, login = "", time, cps = [] }) {
  return (
    `{"version":"wsw 2.1","map":${JSON.stringify(map)},"source":"racelog",` +
    `"records":[{"name":${JSON.stringify(name)},"login":${JSON.stringify(login)},` +
    `"time":${time},"attempts":1,"checkpoints":[${cps.join(",")}]}]}`
  );
}

before(async () => {
  dbName = "test_replay_" + crypto.randomBytes(6).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), "racesow-ghosts-"));
  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`),
      INGEST_TOKEN: TOKEN,
      GHOST_DIR: ghostDir,
      DEMO_BASE_URL: DEMO_BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (dbName) await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  if (ghostDir) fs.rmSync(ghostDir, { recursive: true, force: true });
});

test("WR demo + ghost ingest, then surface on the map and serve to browser + game", async () => {
  const DEMO_PATH = "ghostmap/ghostmap_Runner_00-12-000.wdz20";
  const frames = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [10, 0, 5, 0, 90, 0, 400, 0, 50],
    [20, 5, 8, 0, 92, 0, 420, 10, 20],
    [30, 12, 8, 0, 95, 0, 430, 20, 0],
    [40, 20, 6, 0, 100, 0, 440, 30, -10],
  ];

  // 1) A finish makes this the world record (rank 1 on an empty map).
  assert.equal((await ingest(finishBody({ map: "ghostmap", name: "Runner", time: 12000, cps: [5000, 9000] }))).status, 200);
  // Wait out the aggregate-refresh debounce so map_index has the WR.
  await new Promise((r) => setTimeout(r, 3600));

  const maps = await getJson("/maps?q=ghostmap");
  const mapId = maps.rows[0].id;

  // 2) WR demo metadata (source: wr_demo).
  const demoBody = JSON.stringify({
    version: "wsw 2.1",
    map: "ghostmap",
    source: "wr_demo",
    wr_demo: { name: "Runner", login: "", time: 12000, demo: DEMO_PATH, bytes: 123456 },
  });
  assert.deepEqual((await ingest(demoBody)).json, { ok: true });

  // 3) Ghost trajectory.
  const ghostBody = JSON.stringify({
    version: "wsw 2.1",
    map: "ghostmap",
    name: "Runner",
    login: "",
    time: 12000,
    hz: 25,
    frames,
    cps: [1, 3],
  });
  assert.deepEqual((await ingest(ghostBody, TOKEN, "/ingest/ghost")).json, { ok: true, stored: true });

  // 4) The map detail surfaces raceId + demo + ghost, tied to the current WR.
  const detail = await getJson(`/maps/${mapId}`);
  assert.ok(detail.wr, "map has a WR");
  assert.ok(Number.isInteger(detail.wr.raceId), "wr.raceId surfaced");
  assert.equal(detail.wr.demo.url, `${DEMO_BASE}/demos/${DEMO_PATH}`);
  assert.equal(detail.wr.demo.time, 12000);
  assert.equal(detail.wr.demo.bytes, 123456);
  assert.equal(detail.wr.ghost.url, `/api/maps/${mapId}/ghost`);
  assert.equal(detail.wr.ghost.hz, 25);
  assert.equal(detail.wr.ghost.frames, frames.length);

  // 5) The browser ghost endpoint serves the canonical JSON (gzip transparently
  // decoded by fetch).
  const gr = await fetch(`${base}/api/maps/${mapId}/ghost`);
  assert.equal(gr.status, 200);
  assert.match(gr.headers.get("content-type"), /application\/json/);
  const ghost = await gr.json();
  assert.equal(ghost.v, 1);
  assert.equal(ghost.hz, 25);
  assert.equal(ghost.time, 12000);
  assert.deepEqual(ghost.cps, [1, 3]);
  assert.equal(ghost.frames.length, frames.length);
  assert.deepEqual(ghost.frames[3], frames[3]);

  // 6) The game endpoint serves the flat text the AngelScript reader parses.
  const tr = await fetch(`${base}/api/game/ghost?map=ghostmap`);
  assert.equal(tr.status, 200);
  assert.match(tr.headers.get("content-type"), /text\/plain/);
  const lines = (await tr.text()).split("\n");
  assert.equal(lines[0], `RSGHOST 1 25 12000 ${frames.length}`);
  assert.equal(lines[1], "Runner"); // holder name on its own line
  assert.equal(lines[2], "1 3"); // checkpoint frame indices
  assert.equal(lines[3], "0 0 0 0 0 0 0 0 0"); // first frame
  assert.equal(lines[4], "10 0 5 0 90 0 400 0 50");

  // 7) A ghost file exists on disk under the isolated GHOST_DIR.
  assert.ok(fs.existsSync(path.join(ghostDir, `${mapId}.json.gz`)));
});

test("faster-only guard: a slower ghost never overwrites a faster one", async () => {
  const detail = await getJson(`/maps/${(await getJson("/maps?q=ghostmap")).rows[0].id}`);
  const mapId = detail.id;
  const before = fs.readFileSync(path.join(ghostDir, `${mapId}.json.gz`));

  const slower = JSON.stringify({
    version: "wsw 2.1",
    map: "ghostmap",
    name: "Slowpoke",
    time: 99000, // slower than the stored 12000
    hz: 25,
    frames: [[1, 2, 3, 0, 0, 0, 0, 0, 0]],
  });
  assert.deepEqual((await ingest(slower, TOKEN, "/ingest/ghost")).json, { ok: true, stored: false });
  const afterBuf = fs.readFileSync(path.join(ghostDir, `${mapId}.json.gz`));
  assert.deepEqual(afterBuf, before, "file unchanged by the slower upload");
});

test("invalid demo paths and ghosts are rejected", async () => {
  const bad = (demo) =>
    ingest(
      JSON.stringify({ version: "v", map: "ghostmap", source: "wr_demo", wr_demo: { name: "x", time: 1000, demo } })
    );
  assert.equal((await bad("../../etc/passwd")).status, 400);
  assert.equal((await bad("/abs/path.wdz20")).status, 400);
  assert.equal((await bad("no_subdir.wdz20")).status, 400);
  assert.equal((await bad("map/file.txt")).status, 400);
  assert.equal((await bad("map/a\\b.wdz20")).status, 400);

  // Ghost with a wrong-arity frame is rejected.
  const badGhost = JSON.stringify({
    version: "v",
    map: "ghostmap",
    name: "x",
    time: 1000,
    hz: 25,
    frames: [[1, 2, 3]],
  });
  assert.equal((await ingest(badGhost, TOKEN, "/ingest/ghost")).status, 400);
});

test("a faster record without a replay still surfaces the best captured replay (isWr=false)", async () => {
  // A brand-new, faster WR by someone else, with NO demo/ghost uploaded — the
  // 12000 run's replay is the best we have, so it's still shown, flagged as
  // not the outright record ("use the latest fastest time to make the replay").
  assert.equal((await ingest(finishBody({ map: "ghostmap", name: "Faster", time: 11000, cps: [4500, 8000] }))).status, 200);
  await new Promise((r) => setTimeout(r, 3600)); // aggregate refresh

  const detail = await getJson(`/maps/${(await getJson("/maps?q=ghostmap")).rows[0].id}`);
  assert.equal(detail.wr.time, 11000, "WR is now the faster run");
  // Replay still surfaced, carrying its OWN time + holder, flagged not-the-WR.
  assert.ok(detail.wr.ghost, "ghost still surfaced");
  assert.equal(detail.wr.ghost.isWr, false, "ghost flagged as not the WR");
  assert.equal(detail.wr.ghost.time, 12000, "ghost carries its own time");
  assert.equal(detail.wr.ghost.holder, "Runner");
  assert.ok(detail.wr.demo, "demo still surfaced");
  assert.equal(detail.wr.demo.isWr, false);
});
