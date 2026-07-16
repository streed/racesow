// Manual end-to-end verification of the replay spine (not part of `npm test`;
// .mjs is outside the test glob). Ingests a WR finish + demo + ghost whose
// path lies inside 100m's real geometry, then drives headless Chromium to the
// /replay route and confirms: no console/page/network errors, the WebGL canvas
// exists and is sized, and the scene actually draws (non-background pixels).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import pg from "pg";
import puppeteer from "puppeteer-core";
import { ADMIN_URL } from "./pg-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..");
const TOKEN = "verify-token";
const CHROME = fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : "/usr/bin/google-chrome-stable";

async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

// Read the gl-space bounding box the converter stored in 100m.glb accessor 1.
function glbBounds(glbPath) {
  const buf = fs.readFileSync(glbPath);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jlen));
  const acc = json.accessors[1];
  return { min: acc.min, max: acc.max };
}

// Build a ghost that snakes through the map from one corner to another, height
// oscillating, converting each gl-space point back to Quake space (the viewer
// re-applies gl = (x, z, -y), so quake = (gx, -gz, gy)).
function makeGhost(bounds, hz, N) {
  const { min, max } = bounds;
  const lerp = (a, b, t) => a + (b - a) * t;
  const frames = [];
  let prev = null;
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const gx = lerp(min[0] + 40, max[0] - 40, u);
    const gz = lerp(min[2] + 40, max[2] - 40, u);
    const gy = lerp(min[1] + 20, min[1] + (max[1] - min[1]) * 0.5, Math.abs(Math.sin(u * Math.PI * 3)));
    const q = [gx, -gz, gy]; // gl -> quake
    let v = [0, 0, 0];
    if (prev) v = [(q[0] - prev[0]) * hz, (q[1] - prev[1]) * hz, (q[2] - prev[2]) * hz];
    const yaw = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
    // synthetic key presses: always forward, alternating strafe, periodic jump
    const keys = 1 | (i % 40 < 20 ? 4 : 8) | (i % 50 < 4 ? 32 : 0);
    frames.push([q[0], q[1], q[2], 0, yaw, 0, v[0], v[1], v[2], keys]);
    prev = q;
  }
  return frames;
}

async function main() {
  const dbName = "verify_" + crypto.randomBytes(5).toString("hex");
  await adminQuery(`CREATE DATABASE ${dbName}`);
  const ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ghosts-"));
  const port = 17123;
  const base = `http://127.0.0.1:${port}`;
  const DEMO_BASE = "http://demos.local:44445";

  const proc = spawn(process.execPath, [path.join(WEB, "server.js")], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`),
      INGEST_TOKEN: TOKEN, GHOST_DIR: ghostDir, DEMO_BASE_URL: DEMO_BASE },
    stdio: ["ignore", "pipe", "pipe"], cwd: WEB,
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));

  const fail = (m) => { console.error("FAIL:", m); cleanup(1); };
  let browser;
  async function cleanup(code) {
    try { if (browser) await browser.close(); } catch {}
    try { proc.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    await adminQuery(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    fs.rmSync(ghostDir, { recursive: true, force: true });
    process.exit(code);
  }

  // Wait for health.
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (i > 120) return fail("server did not start");
    await new Promise((r) => setTimeout(r, 150));
  }

  const HZ = 25, N = 310, TIME = Math.round(((N - 1) / HZ) * 1000);
  const post = (route, body) => fetch(`${base}/api${route}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body,
  }).then((r) => r.json());

  // 1) WR finish for 100m.
  await post("/ingest", JSON.stringify({ version: "wsw 2.1", map: "100m", source: "racelog",
    records: [{ name: "^2Verifier", login: "", time: TIME, attempts: 1, checkpoints: [4000, 8000] }] }));
  await new Promise((r) => setTimeout(r, 3600)); // aggregate refresh

  const mapId = (await (await fetch(`${base}/api/maps?q=100m`)).json()).rows[0].id;

  // 2) Ghost inside 100m's geometry + 3) demo metadata.
  const bounds = glbBounds(path.join(WEB, "public", "maps", "100m.glb"));
  const frames = makeGhost(bounds, HZ, N);
  const gres = await post("/ingest/ghost", JSON.stringify({ version: "wsw 2.1", map: "100m",
    name: "^2Verifier", time: TIME, hz: HZ, frames, cps: [100, 200] }));
  if (!gres.stored) return fail("ghost not stored: " + JSON.stringify(gres));
  await post("/ingest", JSON.stringify({ version: "wsw 2.1", map: "100m", source: "wr_demo",
    wr_demo: { name: "^2Verifier", time: TIME, demo: "100m/100m_Verifier_00-12-360.wdz20", bytes: 200000 } }));

  // 4) map detail should surface both.
  const detail = await (await fetch(`${base}/api/maps/${mapId}`)).json();
  if (!detail.wr.ghost) return fail("wr.ghost missing on map detail");
  if (!detail.wr.demo || !detail.wr.demo.url) return fail("wr.demo missing on map detail");
  console.log(`ingest OK: map ${mapId}, ghost ${frames.length} frames, demo ${detail.wr.demo.url}`);

  // 5) Drive the browser.
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--window-size=1000,720"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 720 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (/\.(js|glb)|\/ghost/.test(u)) errors.push("requestfailed: " + u + " " + (r.failure()?.errorText || ""));
  });

  await page.goto(`${base}/replay/${mapId}`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector(".rv-stage canvas", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000)); // let the render loop run

  const probe = await page.evaluate(() => {
    const c = document.querySelector(".rv-stage canvas");
    const out = { w: c ? c.width : 0, h: c ? c.height : 0, controls: !!document.querySelector(".rv-play"),
      note: (document.querySelector(".rv-note")?.textContent || "").trim(), nonBg: 0 };
    try {
      const t = document.createElement("canvas");
      t.width = c.width; t.height = c.height;
      const x = t.getContext("2d");
      x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4)
        if (Math.abs(d[i] - 10) > 14 || Math.abs(d[i + 1] - 11) > 14 || Math.abs(d[i + 2] - 15) > 14) n++;
      out.nonBg = n;
    } catch (e) { out.nonBg = "err:" + e.message; }
    return out;
  });

  const shot = "/tmp/replay-shot.png";
  await page.screenshot({ path: shot });

  console.log("browser probe:", JSON.stringify(probe));
  console.log("screenshot:", shot, fs.statSync(shot).size, "bytes");
  if (errors.length) { errors.forEach((e) => console.error("  ERR", e)); return fail(errors.length + " runtime error(s)"); }
  if (!probe.controls) return fail("replay controls missing");
  if (!(probe.w > 100 && probe.h > 100)) return fail("canvas not sized");
  if (typeof probe.nonBg !== "number" || probe.nonBg < 2000)
    return fail("scene appears blank (nonBg=" + probe.nonBg + ")");

  console.log(`\nPASS: replay rendered — ${probe.nonBg.toLocaleString()} non-background pixels, no errors.` +
    (probe.note ? `  (note: ${probe.note})` : ""));
  cleanup(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
