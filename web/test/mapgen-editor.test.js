// /api/mapgen/spec end to end: a course built in the map editor, queued on the
// real server.js over a throwaway database. The editor's spec is checked with
// the generator's own rules before it can cost anyone their map, shares the
// daily quota with described maps, and reaches the job (and the worker) as
// given, marked as an editor job.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ADMIN_URL } from "./pg-util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.80 Safari/537.36";

let proc, dbName, base;
const dbUrl = () => ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
async function query(url, sql, params) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

before(async () => {
  dbName = "test_mapgen_editor_" + crypto.randomBytes(6).toString("hex");
  await query(ADMIN_URL, `CREATE DATABASE ${dbName}`);
  const port = 22000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATABASE_URL: dbUrl(), MAPGEN_DAILY_BUDGET: "10" };
  delete env.REDIS_URL;
  delete env.MAPGEN_DAILY_PER_IDENTITY;
  proc = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("server did not come up");
    await new Promise((r) => setTimeout(r, 150));
  }
});

after(async () => {
  if (proc) proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  if (dbName) await query(ADMIN_URL, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
});

function as(ip) {
  const headers = { "X-Forwarded-For": ip, "User-Agent": CHROME };
  const call = async (method, p, body) => {
    const r = await fetch(`${base}/api${p}`, {
      method, headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

const ICY = {
  name: "gen_glacier_run", title: "Glacier Run", width: 448,
  segments: [
    { type: "straight", length: 768 },
    { type: "ramp", length: 1024, rise: -512, ice: true },
    { type: "turn", direction: "left", angle: 135, radius: 768, ice: true },
    { type: "straight", length: 1024, ice: true },
    { type: "gap", length: 160, drop: 64 },
    { type: "straight", length: 640 },
  ],
};

test("a refused course costs nothing and says why", async () => {
  const bob = as("203.0.113.20");
  const r = await bob.post("/mapgen/spec", { spec: { ...ICY, segments: [
    { type: "ramp", length: 512, rise: -128 }, { type: "gap", length: 96, drop: 0 }, { type: "straight", length: 512 }] } });
  assert.equal(r.status, 400);
  assert.ok(r.json.problems.some((p) => p.includes("run-up")), r.json.problems.join(" | "));
  const bad = await bob.post("/mapgen/spec", { spec: { ...ICY, title: "<script>" } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.problems.some((p) => p.startsWith("title")));
  for (const junk of [{}, { spec: [] }, { spec: { segments: "x" } }, { spec: { segments: [null] } },
    { spec: { ...ICY, segments: Array(200).fill({ type: "straight", length: 128 }) } }]) {
    assert.equal((await bob.post("/mapgen/spec", junk)).status, 400, JSON.stringify(junk).slice(0, 60));
  }
  assert.equal((await bob.get("/mapgen/quota")).json.used, 0);
});

test("an accepted course waits for an admin, as an editor job, spec and all", async () => {
  const carol = as("203.0.113.30");
  const r = await carol.post("/mapgen/spec", { spec: { ...ICY, junk: "dropped",
    segments: ICY.segments.map((s) => ({ ...s, also: "dropped" })) } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  // Not in the worker's queue: an admin approves it first (/admin/mapgen).
  assert.equal(r.json.job.status, "review");
  assert.equal(r.json.job.source, "editor");
  assert.equal(r.json.job.description, "Built in the map editor: Glacier Run");
  assert.equal(r.json.quota.remaining, 0);

  const page = await as("192.0.2.1").get(`/mapgen/jobs/${r.json.job.token}`);
  assert.equal(page.status, 200);
  assert.deepEqual(page.json.spec, ICY, "only the spec's own keys are kept");

  assert.equal(page.json.queue, null, "no place in a queue it is not in yet");
  const row = (await query(dbUrl(), "SELECT source, spec, description, status FROM mapgen_job WHERE token = $1", [r.json.job.token])).rows[0];
  assert.equal(row.status, "review");
  assert.equal(row.source, "editor");
  assert.deepEqual(row.spec, ICY);

  // The quota is the same one a description uses.
  const again = await carol.post("/mapgen", { description: "A long icy downhill with one big jump at the end" });
  assert.equal(again.status, 429);
});

// ?ev= is the editor's cache buster, and it is a hand-kept list: assetVersion()
// answers "" for a file that is not there, so a name left behind after a module
// is deleted hashes to nothing and a module left OUT never busts the cache at
// all — a browser keeps the editor it already has. Walk the editor's own
// imports instead of trusting the list.
test("?ev= hashes exactly the modules the editor imports", () => {
  const src = readFileSync(SERVER_JS, "utf8");
  const m = src.match(/\.update\((\[[^\]]*\])\s*\n\s*\.map\(\(m\) => assetVersion/);
  assert.ok(m, "EDITOR_V's module list is not where this test looks for it");
  const dir = path.join(__dirname, "..", "public", "assets", "js");
  const seen = new Set(["mapgen-editor"]);
  const stack = ["mapgen-editor"];
  while (stack.length) {
    const mod = stack.pop();
    for (const hit of readFileSync(path.join(dir, `${mod}.js`), "utf8").matchAll(/from "\.\/([\w-]+)\.js"/g)) {
      if (!seen.has(hit[1])) { seen.add(hit[1]); stack.push(hit[1]); }
    }
  }
  assert.deepEqual(JSON.parse(m[1]).sort(), [...seen].sort());
});

test("a described map is still a 'describe' job, with no spec until it is planned", async () => {
  const dave = as("203.0.113.40");
  const r = await dave.post("/mapgen", { description: "A long icy downhill with one big jump at the end" });
  assert.equal(r.status, 202);
  assert.equal(r.json.job.source, "describe");
  assert.equal(r.json.job.status, "queued", "described maps need no approval");
  const page = await dave.get(`/mapgen/jobs/${r.json.job.token}`);
  assert.equal(page.json.spec, null);
});
