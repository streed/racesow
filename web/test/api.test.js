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

test("/api/game/topscores serves the EXACT topscores file format the gametype parses", async () => {
  const r = await fetch(`${base}/api/game/topscores?map=testmap1`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/plain/);
  const lines = (await r.text()).split("\n");
  // Contract with RACE_LoadTopScores/RACE_WriteTopScores (hrace gametype):
  // header comment, blank line, then '"time" "name" "numSectors" "cp..." '
  // per player — best time per player, fastest first, trailing space intact.
  assert.equal(lines[0], "//testmap1 top scores");
  assert.equal(lines[1], "");
  assert.equal(lines[2], '"48000" "^1No^7va" "2" "10000" "28000" ');
  assert.equal(lines[3], '"49000" "^4Wa^5ve" "2" "9800" "27500" ');
  // path-unsafe and unknown map names must 404, never touch the filesystem
  assert.equal((await fetch(`${base}/api/game/topscores?map=..%2F..%2Fetc%2Fpasswd`)).status, 404);
  assert.equal((await fetch(`${base}/api/game/topscores?map=doesnotexist`)).status, 404);
  assert.equal((await fetch(`${base}/api/game/topscores`)).status, 404);
});

test("/api/live returns the (empty) presence snapshot shape", async () => {
  const live = await get("/live");
  assert.ok(Array.isArray(live.servers));
  assert.equal(live.servers.length, 0); // no enrolled servers with an address
});

test("/player/:id serves the SPA shell with player-specific OG tags", async () => {
  // "Nova" (raw name ^1No^7va) was ingested and aggregate-refreshed by the
  // earlier finish test — the colour codes must be stripped in the tags.
  const found = await get("/players?q=Nova");
  assert.equal(found.rows.length, 1);
  const id = found.rows[0].id;

  const r = await fetch(`${base}/player/${id}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<meta property="og:title" content="Nova — Racesow player stats">/);
  assert.match(html, /<meta property="og:type" content="profile">/);
  assert.match(html, /world record/); // stats line in og:description
  assert.match(html, new RegExp(`<meta property="og:url" content="http://[^"]+/player/${id}">`));
  assert.match(html, new RegExp(`<meta property="og:image" content="http://[^"]+/og/player/${id}.png">`));
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.doesNotMatch(html, /\^1/); // colour codes never leak into tags

  // The per-player card renders as a real PNG.
  const img = await fetch(`${base}/og/player/${id}.png`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]); // PNG magic
  assert.ok(bytes.length > 10000, `card suspiciously small: ${bytes.length}`);
  assert.equal((await fetch(`${base}/og/player/99999999.png`)).status, 404);

  // Unknown player id falls through to the plain shell with the default tags
  // (absolute og:image — crawlers ignore relative URLs).
  const fallback = await (await fetch(`${base}/player/99999999`)).text();
  assert.match(fallback, /<meta property="og:type" content="website">/);
  assert.match(fallback, /<meta property="og:image" content="http:\/\/[^"]+\/assets\/img\/warsow-logo.png">/);
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
