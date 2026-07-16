// Live local preview of the WR replay viewer. Starts the real server on a
// throwaway Postgres DB, ingests the 100m world record + a ghost that flies
// through 100m's real geometry + demo metadata, then stays up so you can open
// the interactive 3D replay in a browser. Ctrl+C to stop (drops the temp DB).
//
//   node preview-replay.mjs            # needs the racesow-pg-test container
//   TEST_PG_URL=postgres://... node preview-replay.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.TEST_PG_URL || "postgres://racesow:racesow@127.0.0.1:5433/racesow";
const PORT = process.env.PORT || 8090;
const TOKEN = "preview-token";

async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
function glbBounds(p) {
  const buf = fs.readFileSync(p);
  const jlen = buf.readUInt32LE(12);
  const acc = JSON.parse(buf.toString("utf8", 20, 20 + jlen)).accessors[1];
  return { min: acc.min, max: acc.max };
}
function makeGhost({ min, max }, hz, N) {
  const L = (a, b, t) => a + (b - a) * t;
  const f = [];
  let prev = null;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const gx = L(min[0] + 40, max[0] - 40, u);
    const gz = L(min[2] + 40, max[2] - 40, u);
    const gy = L(min[1] + 20, min[1] + (max[1] - min[1]) * 0.5, Math.abs(Math.sin(u * Math.PI * 3)));
    const q = [gx, -gz, gy];
    let v = [0, 0, 0];
    if (prev) v = [(q[0] - prev[0]) * hz, (q[1] - prev[1]) * hz, (q[2] - prev[2]) * hz];
    const keys = 1 | (i % 40 < 20 ? 4 : 8) | (i % 50 < 4 ? 32 : 0);
    f.push([q[0], q[1], q[2], 0, (Math.atan2(v[1], v[0]) * 180) / Math.PI, 0, v[0], v[1], v[2], keys]);
    prev = q;
  }
  return f;
}

const dbName = "preview_" + crypto.randomBytes(4).toString("hex");
await admin(`CREATE DATABASE ${dbName}`);
const ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-ghosts-"));
const base = `http://127.0.0.1:${PORT}`;

const proc = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`),
    INGEST_TOKEN: TOKEN, GHOST_DIR: ghostDir, DEMO_BASE_URL: "http://127.0.0.1:44445" },
  stdio: ["ignore", "inherit", "inherit"], cwd: __dirname,
});

async function cleanup() {
  try { proc.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
  fs.rmSync(ghostDir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  if (i > 120) { console.error("server did not start"); await cleanup(); }
  await new Promise((r) => setTimeout(r, 150));
}

const HZ = 25, N = 310, TIME = Math.round(((N - 1) / HZ) * 1000);
const post = (route, body) => fetch(`${base}/api${route}`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body,
}).then((r) => r.json());

await post("/ingest", JSON.stringify({ version: "wsw 2.1", map: "100m", source: "racelog",
  records: [{ name: "^3Preview^7Runner", login: "", time: TIME, attempts: 1, checkpoints: [4000, 8000] }] }));
await new Promise((r) => setTimeout(r, 3600));
const mapId = (await (await fetch(`${base}/api/maps?q=100m`)).json()).rows[0].id;
await post("/ingest/ghost", JSON.stringify({ version: "wsw 2.1", map: "100m", name: "^3Preview^7Runner",
  time: TIME, hz: HZ, frames: makeGhost(glbBounds(path.join(__dirname, "public", "maps", "100m.glb")), HZ, N), cps: [100, 200] }));
await post("/ingest", JSON.stringify({ version: "wsw 2.1", map: "100m", source: "wr_demo",
  wr_demo: { name: "^3Preview^7Runner", time: TIME, demo: "100m/100m_PreviewRunner_00-12-360.wdz20", bytes: 200000 } }));

console.log(`\n\n============================================================`);
console.log(`  Replay preview ready. Open in your browser:`);
console.log(`      ${base}/replay/${mapId}`);
console.log(`  (or the map page with the Watch/Download buttons: ${base}/map/${mapId})`);
console.log(`  Ctrl+C to stop and drop the temp database.`);
console.log(`============================================================\n`);
