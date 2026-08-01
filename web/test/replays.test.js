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

// Query the throwaway test DB itself (adminQuery talks to the maintenance DB) —
// used to simulate the production data state a lost legacy ghost leaves behind.
async function dbQuery(sql, params = []) {
  const c = new pg.Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`) });
  await c.connect();
  try {
    return await c.query(sql, params);
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

  // 7) A per-player ghost file exists on disk (layout <mapId>/<playerId>.json.gz).
  assert.ok(
    fs.readdirSync(path.join(ghostDir, String(mapId))).some((f) => f.endsWith(".json.gz")),
    "a per-player ghost file exists under the map subdir"
  );
});

test("faster-only guard (per player): a slower run by the same player never overwrites their faster one", async () => {
  const mapId = (await getJson("/maps?q=ghostmap")).rows[0].id;
  const dir = path.join(ghostDir, String(mapId));
  const ghostFile = () => path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".json.gz")));
  const before = fs.readFileSync(ghostFile());

  const slower = JSON.stringify({
    version: "wsw 2.1",
    map: "ghostmap",
    name: "Runner", // SAME player as the stored 12000 ghost — the guard is per (map, player)
    login: "",
    time: 99000, // slower than their stored 12000
    hz: 25,
    frames: [[1, 2, 3, 0, 0, 0, 0, 0, 0]],
  });
  assert.deepEqual((await ingest(slower, TOKEN, "/ingest/ghost")).json, { ok: true, stored: false });
  assert.deepEqual(fs.readFileSync(ghostFile()), before, "file unchanged by the slower same-player upload");
});

test("per-player: a different player's slower run is stored as their own PB", async () => {
  const mapId = (await getJson("/maps?q=ghostmap")).rows[0].id;
  const slower = JSON.stringify({
    version: "wsw 2.1",
    map: "ghostmap",
    name: "Slowpoke",
    login: "",
    time: 99000, // slower than Runner's WR, but it's Slowpoke's own first run
    hz: 25,
    frames: [[1, 2, 3, 0, 0, 0, 0, 0, 0]],
  });
  assert.deepEqual((await ingest(slower, TOKEN, "/ingest/ghost")).json, { ok: true, stored: true });
  // The map's WR replay is still Runner's faster ghost, not Slowpoke's.
  const detail = await getJson(`/maps/${mapId}`);
  assert.equal(detail.wr.ghost.time, 12000, "WR ghost stays the fastest recorded run");
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

test("ghost durability: a lost file is served + restored from the DB payload", async () => {
  const frames = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [10, 0, 5, 0, 90, 0, 400, 0, 50],
    [20, 5, 8, 0, 92, 0, 420, 10, 20],
  ];
  assert.equal((await ingest(finishBody({ map: "durmap", name: "Dur", time: 20000, cps: [8000] }))).status, 200);
  await new Promise((r) => setTimeout(r, 3600));
  const mapId = (await getJson("/maps?q=durmap")).rows[0].id;
  assert.deepEqual(
    (await ingest(JSON.stringify({ version: "wsw 2.1", map: "durmap", name: "Dur", login: "", time: 20000, hz: 25, frames, cps: [1] }), TOKEN, "/ingest/ghost")).json,
    { ok: true, stored: true }
  );

  // The ghost file was written to disk...
  const dir = path.join(ghostDir, String(mapId));
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".json.gz")));
  assert.ok(fs.existsSync(file), "ghost file written");

  // ...now simulate losing it (a volume reset). The DB payload must survive.
  fs.rmSync(file);
  assert.ok(!fs.existsSync(file), "file removed");

  // The browser endpoint still serves the ghost (from the DB payload)...
  const gr = await fetch(`${base}/api/maps/${mapId}/ghost`);
  assert.equal(gr.status, 200, "served from DB payload after file loss");
  assert.equal((await gr.json()).frames.length, frames.length);
  // ...and the file has been restored on disk for subsequent reads + the heatmap.
  assert.ok(fs.existsSync(file), "ghost file restored from the DB payload");
});

test("WR ghost: a lost fastest ghost falls through to the fastest recoverable one (not blank)", async () => {
  // Regression: the map's fastest player_ghost row is an orphan captured before
  // the payload column whose file was lost to a volume reset (no file AND no
  // payload). It must not shadow the intact, slower ghosts behind it — otherwise
  // the map serves NO WR ghost at all (the in-game ghost racer + browser replay
  // go blank) even though recoverable ghosts exist. Reproduces the aurora-speed1
  // production state (fastest two rows payloadless + fileless, five intact behind).
  const fast = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [5, 0, 2, 0, 45, 0, 200, 0, 10]];
  const slow = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [9, 1, 3, 0, 60, 0, 250, 5, 0], [18, 4, 6, 0, 70, 0, 260, 8, -5]];

  assert.equal((await ingest(finishBody({ map: "shadowmap", name: "FastLost", time: 5000, cps: [2000] }))).status, 200);
  assert.equal((await ingest(finishBody({ map: "shadowmap", name: "SlowIntact", time: 9000, cps: [4000] }))).status, 200);
  await new Promise((r) => setTimeout(r, 3600)); // aggregate refresh so /maps sees it
  const mapId = (await getJson("/maps?q=shadowmap")).rows[0].id;

  assert.deepEqual((await ingest(JSON.stringify({ version: "wsw 2.1", map: "shadowmap", name: "FastLost", login: "", time: 5000, hz: 25, frames: fast, cps: [1] }), TOKEN, "/ingest/ghost")).json, { ok: true, stored: true });
  assert.deepEqual((await ingest(JSON.stringify({ version: "wsw 2.1", map: "shadowmap", name: "SlowIntact", login: "", time: 9000, hz: 25, frames: slow, cps: [2] }), TOKEN, "/ingest/ghost")).json, { ok: true, stored: true });

  // Make the fastest (FastLost) ghost unrecoverable: delete its file AND null its
  // DB payload — exactly what a lost pre-payload-column orphan looks like.
  const lost = (await dbQuery("SELECT player_id FROM player_ghost WHERE map_id = $1 AND time = 5000", [mapId])).rows[0].player_id;
  fs.rmSync(path.join(ghostDir, String(mapId), `${lost}.json.gz`));
  await dbQuery("UPDATE player_ghost SET payload = NULL WHERE map_id = $1 AND player_id = $2", [mapId, lost]);

  // Game endpoint: must fall through to SlowIntact's ghost, not 404 / "no ghost".
  const tr = await fetch(`${base}/api/game/ghost?map=shadowmap`);
  assert.equal(tr.status, 200, "game ghost served despite the lost fastest row");
  const lines = (await tr.text()).split("\n");
  assert.equal(lines[0], `RSGHOST 1 25 9000 ${slow.length}`, "serves the fastest RECOVERABLE ghost");
  assert.equal(lines[1], "SlowIntact");

  // Browser endpoint: same fall-through.
  const gr = await fetch(`${base}/api/maps/${mapId}/ghost`);
  assert.equal(gr.status, 200, "browser ghost served despite the lost fastest row");
  const ghost = await gr.json();
  assert.equal(ghost.time, 9000);
  assert.equal(ghost.frames.length, slow.length);
});

test("demo directory: index lists maps with demos + a map lists its per-player download links", async () => {
  const MAP = "demodir";
  const demoA = "demodir/demodir_Alpha_00-08-000.wdz20";
  const demoB = "demodir/demodir_Bravo_00-09-500.wdz20";
  // Two distinct players each upload a PB demo for the same map (faster-only
  // upsert keeps one row per player, so both land as separate rows).
  for (const [name, time, demo, bytes] of [["Alpha", 8000, demoA, 4096], ["Bravo", 9500, demoB, 8192]]) {
    const r = await ingest(JSON.stringify({
      version: "wsw 2.1",
      map: MAP,
      source: "wr_demo",
      wr_demo: { name, login: "", time, demo, bytes },
    }));
    assert.deepEqual(r.json, { ok: true });
  }

  // Index: the map appears with a demo count of 2 and the fastest time.
  const idx = await getJson("/demos?q=demodir");
  const row = idx.rows.find((m) => m.name === MAP);
  assert.ok(row, "map appears in the demo directory index");
  assert.equal(row.demos, 2);
  assert.equal(row.fastest, 8000);
  assert.ok(row.latest > 0, "latest captured_at surfaced");

  // Per-map: both demos, fastest first, each with its own download URL + size.
  const detail = await getJson(`/demos/${row.id}`);
  assert.equal(detail.map.id, row.id);
  assert.equal(detail.map.name, MAP);
  assert.equal(detail.demos.length, 2);
  assert.equal(detail.demos[0].name, "Alpha");
  assert.equal(detail.demos[0].time, 8000);
  assert.equal(detail.demos[0].url, `${DEMO_BASE}/demos/${demoA}`);
  assert.equal(detail.demos[0].bytes, 4096);
  assert.ok(detail.demos[0].captured_at > 0);
  assert.equal(detail.demos[1].name, "Bravo");
  assert.equal(detail.demos[1].time, 9500);
  assert.equal(detail.demos[1].url, `${DEMO_BASE}/demos/${demoB}`);

  // An unknown map id 404s rather than returning an empty list.
  assert.equal((await fetch(`${base}/api/demos/99999999`)).status, 404);
});

test("demo feed: /demos/all inlines every map's demos with player, capture time + download link", async () => {
  const MAP = "demofeed";
  const demoA = "demofeed/demofeed_Carol_00-07-000.wdz20";
  const demoB = "demofeed/demofeed_Dave_00-11-250.wdz20";
  for (const [name, time, demo, bytes] of [["Carol", 7000, demoA, 2048], ["Dave", 11250, demoB, 3072]]) {
    const r = await ingest(JSON.stringify({
      version: "wsw 2.1",
      map: MAP,
      source: "wr_demo",
      wr_demo: { name, login: "", time, demo, bytes },
    }));
    assert.deepEqual(r.json, { ok: true });
  }

  const feed = await getJson("/demos/all?q=demofeed");
  assert.equal(feed.maps.length, 1, "?q= narrows the feed to the matching map");
  const m = feed.maps[0];
  assert.equal(m.name, MAP);
  assert.equal(m.count, 2);
  assert.equal(m.fastest, 7000);
  assert.equal(m.demos.length, 2);
  // Fastest first, each row carrying who ran it, when, and the direct link.
  assert.equal(m.demos[0].name, "Carol");
  assert.equal(m.demos[0].time, 7000);
  assert.equal(m.demos[0].bytes, 2048);
  assert.ok(m.demos[0].captured_at > 0);
  assert.equal(m.demos[0].url, `${DEMO_BASE}/demos/${demoA}`);
  assert.equal(m.demos[1].name, "Dave");
  assert.equal(m.demos[1].url, `${DEMO_BASE}/demos/${demoB}`);

  // Unfiltered, the feed is paged by map and every listed map carries its demos.
  const all = await getJson("/demos/all");
  assert.ok(all.total >= 2, "other demo maps from earlier tests are counted too");
  assert.ok(all.maps.length >= 1);
  for (const row of all.maps) {
    assert.equal(row.demos.length, row.count, `${row.name}: inlined demos match the count`);
    for (const d of row.demos) assert.ok(d.url && d.playerId > 0 && d.path);
  }

  // "all" must not be mistaken for a map id by the /demos/:mapId route.
  assert.equal((await fetch(`${base}/api/demos/all`)).status, 200);
});
