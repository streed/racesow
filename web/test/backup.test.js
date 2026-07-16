// End-to-end tests for the public database backup (backup/backup.sh).
//
// A fresh throwaway database is seeded with race records AND every kind of
// secret the backup must NOT leak (an ingest token hash + server IP, a
// moderator account + session, a map-flag report with a reporter-IP hash).
// backup.sh then runs against it and we assert on the produced SQL:
//   * race records are present, server names are present;
//   * no token, IP, admin credential, session, CSRF, or reporter hash appears;
//   * the excluded tables are not even defined.
// Finally the dump is restored into a second empty database to prove it is
// valid and that the sensitive rows/tables really are gone after a round-trip.
//
// Skips cleanly if pg_dump/psql/zip/unzip are not on PATH (matches the sidecar's
// runtime, which ships them via the postgres:16 image).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { openDatabase } from "../db.js";
import { createTestDb } from "./pg-util.js";

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_SH = path.resolve(__dirname, "../../backup/backup.sh");

function haveTools() {
  try {
    for (const t of ["pg_dump", "psql", "zip", "unzip"]) execFileSync("sh", ["-c", `command -v ${t}`]);
    return true;
  } catch {
    return false;
  }
}
const TOOLS = haveTools();

// Distinctive sentinels so grepping the dump is unambiguous.
const SECRETS = {
  token: "TOKENHASH_deadbeefdeadbeefdeadbeef",
  address: "10.11.12.13:44400",
  adminUser: "moderator_backuptest",
  pwHash: "scrypt$SALTSENTINEL$HASHSENTINEL_cafef00d",
  session: "SESSIONHASH_0badc0de0badc0de",
  csrf: "CSRFSENTINEL_feedface",
  reporter: "REPORTERHASH_8badf00d8badf00d",
};
const PUBLIC = {
  map: "backuptest_map",
  player: "BackupTestRacer",
  login: "backuptestlogin",
  server: "BackupTest EU Node",
  time: 123456,
};

async function seed(pool) {
  const now = 1_700_000_000;
  await pool.query(`INSERT INTO version (id, name) VALUES (1, 'wsw 2.1')`);
  await pool.query(`INSERT INTO map (id, name) VALUES (1, $1)`, [PUBLIC.map]);
  await pool.query(
    `INSERT INTO player (id, name, simplified, trimmed, login) VALUES (1, $1, $1, $1, $2)`,
    [PUBLIC.player, PUBLIC.login]
  );
  await pool.query(
    `INSERT INTO server (id, name, token_hash, status, created_at, last_seen_at, records, address)
     VALUES (1, $1, $2, 'trusted', $3, $3, 1, $4)`,
    [PUBLIC.server, SECRETS.token, now, SECRETS.address]
  );
  await pool.query(
    `INSERT INTO race (id, version_id, player_id, map_id, time, version_rank, global_rank, server_id, created_at)
     VALUES (1, 1, 1, 1, $1, 1, 1, 1, $2)`,
    [PUBLIC.time, now]
  );
  await pool.query(`INSERT INTO checkpoint (race_id, number, time) VALUES (1, 1, 50000)`);
  await pool.query(
    `INSERT INTO run_tally (player_id, map_id, version_id, finishes, attempts, last_finish)
     VALUES (1, 1, 1, 1, 3, $1)`,
    [now]
  );
  // Secrets that must never appear in a public backup.
  await pool.query(
    `INSERT INTO admin_user (id, username, password_hash, created_at) VALUES (1, $1, $2, $3)`,
    [SECRETS.adminUser, SECRETS.pwHash, now]
  );
  await pool.query(
    `INSERT INTO admin_session (token_hash, admin_id, csrf, created_at, expires_at)
     VALUES ($1, 1, $2, $3, $4)`,
    [SECRETS.session, SECRETS.csrf, now, now + 3600]
  );
  await pool.query(
    `INSERT INTO map_flag (map_id, reason, reporter_hash, created_at) VALUES (1, 'broken', $1, $2)`,
    [SECRETS.reporter, now]
  );
}

// Run backup.sh against `dbUrl`, unzip into `dir`, return { sql, files, meta }.
async function runBackup(dbUrl, dir) {
  await execFile("sh", [BACKUP_SH], {
    env: { ...process.env, DATABASE_URL: dbUrl, OUT_DIR: dir, BACKUP_KEEP: "3" },
  });
  const out = path.join(dir, "extracted");
  await execFile("unzip", ["-o", "-q", path.join(dir, "racesow-db-latest.zip"), "-d", out]);
  const files = await readdir(out);
  const sqlName = files.find((f) => f.endsWith(".sql"));
  const sql = await readFile(path.join(out, sqlName), "utf8");
  const meta = JSON.parse(await readFile(path.join(dir, "racesow-db-latest.json"), "utf8"));
  return { sql, files, meta };
}

test("backup keeps race records and drops every secret", { skip: !TOOLS && "pg_dump/psql/zip/unzip not on PATH" }, async (t) => {
  const { url, drop } = await createTestDb();
  const race = await openDatabase(url);
  const dir = await mkdtemp(path.join(os.tmpdir(), "rs-backup-"));
  t.after(async () => {
    await race.close();
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  await seed(race.pool);
  const { sql, files, meta } = await runBackup(url, dir);

  // --- Public race data survives -------------------------------------------
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm/, "pg_trgm needed by the trigram indexes");
  assert.ok(sql.includes(PUBLIC.map), "map name present");
  assert.ok(sql.includes(PUBLIC.player), "player name present");
  assert.ok(sql.includes(PUBLIC.login), "player login present (public identity)");
  assert.ok(sql.includes(String(PUBLIC.time)), "race time present");
  assert.ok(sql.includes(PUBLIC.server), "server name present");
  // Server data is re-added through the sanitized column list.
  assert.match(sql, /COPY public\.server \(id, name, status, created_at, last_seen_at, records\)/);

  // --- Every secret is gone -------------------------------------------------
  for (const [label, value] of Object.entries(SECRETS)) {
    assert.ok(!sql.includes(value), `secret ${label} must not appear in the backup`);
  }
  // The private / moderation tables are not even defined in the dump.
  for (const tbl of ["admin_user", "admin_session", "map_flag", "map_block"]) {
    assert.ok(!sql.includes(`CREATE TABLE public.${tbl}`), `${tbl} must not be dumped`);
  }

  // --- Archive + metadata ---------------------------------------------------
  assert.ok(files.includes("README.txt") && files.includes("manifest.json"), "archive has README + manifest");
  assert.equal(meta.download_url, "/backup/racesow-db-latest.zip");
  assert.equal(meta.row_counts.race, 1);
  assert.ok(/^[0-9a-f]{64}$/.test(meta.sha256), "sha256 recorded");
  assert.ok(meta.excluded.join(" ").toLowerCase().includes("token"), "excludes are advertised");
});

test("backup restores into an empty database with secrets absent", { skip: !TOOLS && "pg_dump/psql/zip/unzip not on PATH" }, async (t) => {
  const src = await createTestDb();
  const race = await openDatabase(src.url);
  const dest = await createTestDb(); // left empty — the dump must build it
  const dir = await mkdtemp(path.join(os.tmpdir(), "rs-backup-"));
  const client = new pg.Client({ connectionString: dest.url });
  t.after(async () => {
    await client.end().catch(() => {});
    await race.close();
    await src.drop();
    await dest.drop();
    await rm(dir, { recursive: true, force: true });
  });

  await seed(race.pool);
  const { files } = await runBackup(src.url, dir);
  const sqlName = files.find((f) => f.endsWith(".sql"));
  const sqlPath = path.join(dir, "extracted", sqlName);

  // Restore into the empty DB. No ON_ERROR_STOP: a client newer than the server
  // (dev box pg_dump 17 vs pg 16) emits a harmless unknown-GUC SET; the row/
  // table assertions below are the real proof the restore succeeded.
  await execFile("psql", [dest.url, "-q", "-f", sqlPath]);
  await client.connect();

  const n = async (sql) => Number((await client.query(sql)).rows[0].n);
  assert.equal(await n("SELECT count(*) n FROM race"), 1, "races restored");
  assert.equal(await n("SELECT count(*) n FROM checkpoint"), 1, "checkpoints restored");
  assert.equal(await n("SELECT count(*) n FROM run_tally"), 1, "tallies restored");

  // Excluded tables never came back.
  for (const tbl of ["admin_user", "admin_session", "map_flag", "map_block"]) {
    const reg = (await client.query("SELECT to_regclass($1) AS r", [`public.${tbl}`])).rows[0].r;
    assert.equal(reg, null, `${tbl} must not exist after restore`);
  }
  // The server row is there by name, but its secrets are NULL.
  const srv = (await client.query("SELECT name, token_hash, address FROM server WHERE id = 1")).rows[0];
  assert.equal(srv.name, PUBLIC.server);
  assert.equal(srv.token_hash, null, "token_hash stripped");
  assert.equal(srv.address, null, "address stripped");

  // A restored instance can still enroll a new server (identity sequence set).
  await assert.doesNotReject(
    client.query("INSERT INTO server (name, status, created_at) VALUES ('new', 'trusted', 1) RETURNING id")
  );
});

// Boot the real server against a fresh DB + an empty BACKUP_DIR and drive the
// two HTTP routes: 404 before any backup exists, then correct serving once the
// sidecar's output (metadata + zip) is present. No pg_dump/zip needed here.
test("web routes serve the backup and 404 before it exists", async (t) => {
  const { url, drop } = await createTestDb();
  const backupDir = await mkdtemp(path.join(os.tmpdir(), "rs-backupdir-"));
  const port = 18500 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: url, BACKUP_DIR: backupDir, REDIS_URL: "" },
    stdio: "ignore",
  });
  t.after(async () => {
    proc.kill("SIGKILL");
    await drop();
    await rm(backupDir, { recursive: true, force: true });
  });

  // Wait for readiness (server runs migrations on boot).
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not become ready");
    await new Promise((r) => setTimeout(r, 200));
  }

  // Before the first backup: both routes 404 cleanly (JSON, not a crash).
  const meta404 = await fetch(`${base}/api/backup`);
  assert.equal(meta404.status, 404);
  assert.equal((await meta404.json()).error, "no backup available yet");
  assert.equal((await fetch(`${base}/backup/racesow-db-latest.zip`)).status, 404);

  // Publish a backup the way the sidecar does (metadata + zip in BACKUP_DIR).
  const meta = { filename: "racesow-db-20260101.zip", bytes: 5, sha256: "a".repeat(64), download_url: "/backup/racesow-db-latest.zip" };
  const zipBytes = Buffer.from("PK!"); // arbitrary bytes; the route only streams the file
  await writeFile(path.join(backupDir, "racesow-db-latest.json"), JSON.stringify(meta));
  await writeFile(path.join(backupDir, "racesow-db-latest.zip"), zipBytes);

  const metaRes = await fetch(`${base}/api/backup`);
  assert.equal(metaRes.status, 200);
  assert.deepEqual(await metaRes.json(), meta);

  const zipRes = await fetch(`${base}/backup/racesow-db-latest.zip`);
  assert.equal(zipRes.status, 200);
  assert.match(zipRes.headers.get("content-type") || "", /application\/zip/);
  assert.match(zipRes.headers.get("content-disposition") || "", /attachment/);
  assert.deepEqual(Buffer.from(await zipRes.arrayBuffer()), zipBytes);
});
