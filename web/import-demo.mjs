// import-demo.mjs — pull a ONE-OFF demo file into the race database.
//
// The normal demo path is scripts/ingest-demos.sh: an SFTP-dropped CLIENT demo
// is parsed by web/demo-meta.mjs (matchname/matchscore out of the metadata
// block) and POSTed to /api/ingest as a `wr_demo` pointer. That path cannot
// handle the file this tool exists for:
//   * a SERVER autorecord ("<date>_<gametype>_<map>_auto<NNNN>.wdz20") carries
//     no matchname/matchscore at all, so parseDemoMeta() rejects it outright;
//   * /api/ingest stamps every row with NOW, so a demo recovered months after
//     the fact would land in today's rolling windows rather than its own day;
//   * nothing in that path can supply strafe_quality, because the game module
//     measures it live and the demo never carried it.
// So this deliberately BYPASSES the HTTP ingest and writes the same rows
// directly, recomputing the metric from the demo (web/demo-replay.mjs) and
// dating every row from the demo's own clock.
//
// It talks to Postgres with `pg` and nothing else — no db.js import — so it can
// be bind-mounted into the DEPLOYED web image and run without shipping any
// other code:
//
//   docker compose run --rm --no-deps \
//     -v "$PWD/web/import-demo.mjs":/app/import-demo.mjs:ro \
//     -v "$PWD/web/demo-replay.mjs":/app/demo-replay.mjs:ro \
//     -v "$PWD/some.wdz20":/data/demo.wdz20:ro \
//     web node import-demo.mjs /data/demo.wdz20            # dry run
//   ... then re-run with --commit
//
// SAFE BY DEFAULT: it prints the plan and writes nothing until --commit. The
// writes it can make are deliberately narrow — see the flag docs below — and
// every one of them is guarded so a second run is a no-op rather than a
// duplicate.
//
// What it does NOT do, on purpose:
//   * create a player row. An unrecognised name is far more likely to be a
//     mis-parsed nick than a genuinely new person, and a silent fork would
//     split someone's history in two. Pass --create-player to override.
//   * bump run_tally. A run already counted by an earlier import (the legacy
//     bulk load counted finishes without logging them) would be double-counted.
//     Pass --tally when the run is genuinely new to the tally.
//   * refresh the aggregate tables or evaluate achievements — those are the web
//     process's job. A PB change prints a reminder; the daily sweep picks the
//     rest up on its own.

import fs from "node:fs";
import pg from "pg";
import { replayDemo } from "./demo-replay.mjs";

// Mirrors web/server.js sanitizeRecord / sanitizeStrafeQuality bounds, so this
// tool can never persist a value the HTTP ingest would have rejected.
const MIN_TIME_MS = 50;
const MAX_TIME_MS = 24 * 60 * 60 * 1000;
const MAX_STRAFE_QUALITY = 10000;
const MAX_SPEED_UPS = 100000;

// web/server.js validDemoPath: the relative path becomes part of a download
// URL, so it stays a tight allowlist rather than mirroring the engine's looser
// character set.
const DEMO_SEG = /^[A-Za-z0-9_.-]+$/;
function validDemoPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 256) return false;
  if (p.includes("..") || p.includes("\\") || p.startsWith("/")) return false;
  if (!/\.wdz20$/.test(p)) return false;
  const parts = p.split("/");
  return parts.length === 2 && parts.every((s) => DEMO_SEG.test(s));
}

// Byte-for-byte the engine's SV_CleanDemoName / hrace demos.as RACE_DemoCleanName
// (kept identical to web/demo-meta.mjs cleanDemoName — see demoname.test.mjs,
// which pins both against the engine C).
function cleanDemoName(raw) {
  const stripped = String(raw).replace(/\^[0-9]/g, "");
  let clean = "";
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
        c === 0x5f || c === 0x2d) clean += stripped[i];
    else if (c >= 0x20 && c < 0x7f) clean += "_";
  }
  return clean.length ? clean : "player";
}
const pad = (v, w) => String(v).padStart(w, "0");
function msToDemoTime(ms) {
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${pad(m, 2)}-${pad(s, 2)}-${pad(ms, 3)}`;
}
const demoRelPath = (map, name, timeMs) => `${map}/${map}_${cleanDemoName(name)}_${msToDemoTime(timeMs)}.wdz20`;

// The demo names the engine's game directory, not the leaderboard's version
// label, so map one onto the other. Overridable with --version because a future
// fork could report a directory this table has never seen.
function guessVersion(replay) {
  const game = (replay.stats && replay.stats.game) || "";
  const base = (replay.stats && replay.stats.basegame) || "";
  if (/warfork|wf/i.test(game) || /basewf/i.test(base)) return "wf 2.1";
  return "wsw 2.1";
}

function usage(code) {
  process.stderr.write(`usage: node import-demo.mjs [options] <demo.wdz20>

  --commit             actually write (default: print the plan and exit)
  --all-runs           import every finish in the demo, not just the fastest
  --tally              also bump run_tally (finishes/attempts) for the runs
  --player-id <n>      bind to an EXISTING player row by id, skipping name
                       matching (use when the stored nick differs from the
                       demo's — e.g. legacy rows carry a trailing colour token
                       the in-game netname does not)
  --create-player      allow creating a player row when the nick is unknown
  --no-demo-pointer    skip the player_demo row (the site download link)
  --demo-path <p>      served relative path; default "<map>/<map>_<clean>_<MM-SS-mmm>.wdz20"
  --version <name>     leaderboard version label (default: guessed from the demo)
  --server-id <n>      attribute the rows to an enrolled server
  --strafe <bp>        override the recomputed strafe quality (0..10000)
  --json               emit the plan/result as JSON
`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { flags: new Set(), opts: {}, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--demo-path" || a === "--version" || a === "--server-id" || a === "--strafe" ||
        a === "--player-id") {
      o.opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      o.flags.add(a.slice(2));
    } else if (!o.file) {
      o.file = a;
    } else usage(64);
  }
  return o;
}

// Resolve the ids an import needs WITHOUT creating anything the caller did not
// ask for. Returns { versionId, mapId, playerId, rawPlayerId } or throws with a
// reason the operator can act on.
async function resolveIds(client, { version, map, name, login, createPlayer, forcePlayerId }) {
  const one = async (sql, params) => (await client.query(sql, params)).rows[0];

  const v = await one("SELECT id FROM version WHERE name = $1", [version]);
  if (!v) throw new Error(`unknown version ${JSON.stringify(version)} (use --version)`);
  const m = await one("SELECT id FROM map WHERE name = $1", [map]);
  if (!m) throw new Error(`unknown map ${JSON.stringify(map)} — refusing to create a map row`);

  // An explicit --player-id is an operator assertion that THIS row is the
  // runner; it skips name matching entirely (and is echoed back so a typo is
  // obvious in the output rather than silently attributed to a stranger).
  if (forcePlayerId != null) {
    const p = await one("SELECT id, name, canonical_id FROM player WHERE id = $1", [forcePlayerId]);
    if (!p) throw new Error(`no player row with id ${forcePlayerId}`);
    return {
      versionId: Number(v.id), mapId: Number(m.id),
      playerId: p.canonical_id != null ? Number(p.canonical_id) : Number(p.id),
      rawPlayerId: Number(p.id), resolvedName: p.name,
    };
  }

  let p = await one("SELECT id, canonical_id FROM player WHERE name = $1 AND login = $2", [name, login]);
  if (!p) {
    if (!createPlayer) {
      // Show the near misses: an operator can usually tell at a glance whether
      // this is a genuinely new player or a colour-code/spelling variant.
      const near = (await client.query(
        `SELECT id, name FROM player WHERE simplified = $1 LIMIT 5`,
        [String(name).replace(/\^[0-9]/g, "")]
      )).rows;
      throw new Error(
        `no player row for ${JSON.stringify(name)} (login ${JSON.stringify(login)}).` +
        (near.length ? ` Similar: ${near.map((r) => `#${r.id} ${JSON.stringify(r.name)}`).join(", ")}.` : "") +
        ` Pass --create-player to add a new identity.`
      );
    }
    p = await one(
      `INSERT INTO player (name, login, simplified) VALUES ($1, $2, $3)
       ON CONFLICT (name, login) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, canonical_id`,
      [name, login, String(name).replace(/\^[0-9]/g, "")]
    );
  }
  const rawPlayerId = Number(p.id);
  // Replays/leaderboards key on the CANONICAL player (aliases are one person).
  const playerId = p.canonical_id != null ? Number(p.canonical_id) : rawPlayerId;
  return { versionId: Number(v.id), mapId: Number(m.id), playerId, rawPlayerId };
}

// Insert one finish row, dated from the demo. Guarded against a re-run: the
// finish log has no natural key, so match on (player, map, version, time, day)
// — a genuine repeat of the identical time on the same day is vanishingly rare
// next to the cost of duplicating history on every re-run.
async function insertFinish(client, ids, run, at, serverId, strafeBp) {
  const dup = (await client.query(
    `SELECT id FROM finish
      WHERE player_id = $1 AND map_id = $2 AND version_id = $3 AND time = $4
        AND created_at BETWEEN $5 - 86400 AND $5 + 86400`,
    [ids.playerId, ids.mapId, ids.versionId, run.timeMs, at]
  )).rows[0];
  if (dup) return { skipped: true, id: Number(dup.id) };

  const r = (await client.query(
    `INSERT INTO finish (player_id, map_id, version_id, time, server_id, created_at,
                         strafe_quality, max_speed, start_speed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      ids.playerId, ids.mapId, ids.versionId, run.timeMs, serverId, at,
      strafeBp, clampSpeed(run.maxSpeed), clampSpeed(run.startSpeed),
    ]
  )).rows[0];
  return { skipped: false, id: Number(r.id) };
}

const clampSpeed = (v) =>
  Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_SPEED_UPS) : null;

// The PB upsert, mirroring db.js _ingestTx: strictly-faster-only, the old row
// (and its splits) removed, a strictly higher id from the monotonic counter
// (the Discord announcer's detection contract), then the map's ranks rebuilt.
// Column list is deliberately minimal so this works against both the deployed
// schema and the newer one that adds race.strafe_quality/attempts.
async function upsertRace(client, ids, run, at, serverId, strafeBp) {
  const existing = (await client.query(
    "SELECT id, time FROM race WHERE player_id = $1 AND map_id = $2 AND version_id = $3",
    [ids.playerId, ids.mapId, ids.versionId]
  )).rows[0];
  if (existing && Number(existing.time) <= run.timeMs) {
    // The PB row stays as it is — but if it is THIS run (same millisecond) and
    // the schema has the denormalised PB strafe column, fill it in. Otherwise
    // the whole point of the import is lost for the leaderboard: db.js only
    // writes race.strafe_quality on insert/improve, so a re-imported equal time
    // would leave the board showing no strafe figure for a run we just measured.
    // Guarded on the column existing (it arrives with a migration that may not
    // be deployed yet) and on it being NULL, so a live value is never clobbered.
    let pbStrafe = null;
    if (Number(existing.time) === run.timeMs && strafeBp != null) {
      const hasCol = (await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'race' AND column_name = 'strafe_quality'`
      )).rowCount > 0;
      if (hasCol) {
        const r = await client.query(
          "UPDATE race SET strafe_quality = $2 WHERE id = $1 AND strafe_quality IS NULL",
          [existing.id, strafeBp]
        );
        pbStrafe = r.rowCount ? "filled" : "already set";
      } else pbStrafe = "column not deployed";
    }
    return { action: "unchanged", existingTime: Number(existing.time), pbStrafe };
  }
  if (existing) {
    await client.query("DELETE FROM checkpoint WHERE race_id = $1", [existing.id]);
    await client.query("DELETE FROM race WHERE id = $1", [existing.id]);
  }
  const cur = (await client.query("SELECT value FROM config WHERE key = 'next_race_id' FOR UPDATE")).rows[0];
  const raceId = cur ? parseInt(cur.value, 10) : 1;
  await client.query(
    `INSERT INTO config (key, value) VALUES ('next_race_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(raceId + 1)]
  );
  await client.query(
    `INSERT INTO race (id, version_id, player_id, map_id, time, server_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [raceId, ids.versionId, ids.playerId, ids.mapId, run.timeMs, serverId, at]
  );
  await client.query(
    `UPDATE race SET global_rank = ranked.gr, version_rank = ranked.vr
       FROM (SELECT id, RANK() OVER (ORDER BY time) AS gr,
                    RANK() OVER (PARTITION BY version_id ORDER BY time) AS vr
               FROM race WHERE map_id = $1) AS ranked
      WHERE race.id = ranked.id`,
    [ids.mapId]
  );
  return { action: existing ? "improved" : "inserted", raceId, previousTime: existing ? Number(existing.time) : null };
}

async function main() {
  const { flags, opts, file } = parseArgs(process.argv.slice(2));
  if (!file) usage(64);
  if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(66); }

  const replay = replayDemo(file);
  if (!replay.runs.length) { console.error("demo contains no finished runs"); process.exit(2); }

  const runs = flags.has("all-runs") ? replay.runs : [replay.best];
  const version = opts.version || guessVersion(replay);
  const serverId = opts["server-id"] != null ? Number(opts["server-id"]) : null;
  const strafeOverride = opts.strafe != null ? Number(opts.strafe) : null;
  const bytes = fs.statSync(file).size;

  const plan = { file, map: replay.map, version, commit: flags.has("commit"), runs: [] };
  for (const run of runs) {
    if (!Number.isInteger(run.timeMs) || run.timeMs < MIN_TIME_MS || run.timeMs > MAX_TIME_MS)
      throw new Error(`run time ${run.timeMs}ms out of range`);
    let strafeBp = strafeOverride != null ? strafeOverride : run.strafeQualityBp;
    // -1 is the sampler's "no strafe frames" sentinel; store NULL so it stays
    // distinct from a real 0% (web/server.js sanitizeStrafeQuality).
    if (!Number.isInteger(strafeBp) || strafeBp < 0) strafeBp = null;
    else strafeBp = Math.min(strafeBp, MAX_STRAFE_QUALITY);

    const relPath = opts["demo-path"] || demoRelPath(replay.map, run.player, run.timeMs);
    if (!flags.has("no-demo-pointer") && !validDemoPath(relPath))
      throw new Error(`demo path ${JSON.stringify(relPath)} would be rejected by the site`);

    plan.runs.push({
      player: run.player, playerClean: run.playerClean, timeMs: run.timeMs,
      strafeQualityBp: strafeBp, maxSpeed: run.maxSpeed, startSpeed: run.startSpeed,
      // Every row this run writes is dated from the demo's own clock, not now.
      at: run.finishedAt, atISO: run.finishedAt ? new Date(run.finishedAt * 1000).toISOString() : null,
      demoPath: relPath, awards: run.awards, provenance: run.provenance,
    });
  }

  if (!plan.commit) {
    if (flags.has("json")) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    else printPlan(plan, flags);
    process.stderr.write("\n(dry run — nothing written. Re-run with --commit)\n");
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set"); process.exit(78); }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const p of plan.runs) {
      if (!Number.isInteger(p.at)) throw new Error("demo carries no usable timestamp — refusing to date rows with now()");
      const ids = await resolveIds(client, {
        version, map: replay.map, name: p.player, login: "",
        createPlayer: flags.has("create-player"),
        forcePlayerId: opts["player-id"] != null ? Number(opts["player-id"]) : null,
      });
      const fin = await insertFinish(client, ids, p, p.at, serverId, p.strafeQualityBp);
      const race = await upsertRace(client, ids, p, p.at, serverId, p.strafeQualityBp);

      let tally = null;
      if (flags.has("tally")) {
        await client.query(
          `INSERT INTO run_tally (player_id, map_id, version_id, finishes, attempts, last_finish, last_attempt)
           VALUES ($1, $2, $3, 1, 1, $4, $4)
           ON CONFLICT (player_id, map_id, version_id)
           DO UPDATE SET finishes = run_tally.finishes + 1, attempts = run_tally.attempts + 1,
                         last_finish = GREATEST(COALESCE(run_tally.last_finish, 0), $4),
                         last_attempt = GREATEST(COALESCE(run_tally.last_attempt, 0), $4)`,
          [ids.playerId, ids.mapId, ids.versionId, p.at]
        );
        tally = "bumped";
      }

      let demo = null;
      if (!flags.has("no-demo-pointer")) {
        const r = await client.query(
          `INSERT INTO player_demo (map_id, player_id, version_id, time, demo_path, bytes, server_id, captured_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (map_id, player_id) DO UPDATE SET
             version_id = EXCLUDED.version_id, time = EXCLUDED.time, demo_path = EXCLUDED.demo_path,
             bytes = EXCLUDED.bytes, server_id = EXCLUDED.server_id, captured_at = EXCLUDED.captured_at
           WHERE EXCLUDED.time <= player_demo.time`,
          [ids.mapId, ids.playerId, ids.versionId, p.timeMs, p.demoPath, bytes, serverId, p.at]
        );
        demo = r.rowCount ? "written" : "kept (existing demo is for a faster time)";
      }
      results.push({
        player: p.player, timeMs: p.timeMs, playerId: ids.playerId,
        resolvedName: ids.resolvedName ?? p.player, finish: fin, race, tally, demo,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }

  const out = { ...plan, results };
  if (flags.has("json")) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    printPlan(plan, flags);
    process.stdout.write("\nWrote:\n");
    for (const r of results) {
      process.stdout.write(
        `  ${r.player} ${(r.timeMs / 1000).toFixed(3)}s -> player #${r.playerId} ${JSON.stringify(r.resolvedName)}` +
        `, finish ${r.finish.skipped ? `already present (#${r.finish.id})` : `#${r.finish.id}`}` +
        `, race ${r.race.action}${r.race.pbStrafe ? ` (PB strafe ${r.race.pbStrafe})` : ""}` +
        `${r.tally ? `, tally ${r.tally}` : ""}` +
        `${r.demo ? `, demo pointer ${r.demo}` : ""}\n`
      );
    }
    if (results.some((r) => r.race.action !== "unchanged"))
      process.stdout.write("\nA PB changed — the web replicas rebuild aggregates on their own refresh tick.\n");
    if (results.some((r) => r.demo === "written"))
      process.stdout.write("The download link resolves only once the FILE is delivered to the served demos tree.\n");
  }
}

function printPlan(plan, flags) {
  const w = process.stdout;
  w.write(`demo:    ${plan.file}\n`);
  w.write(`map:     ${plan.map}   version: ${plan.version}\n`);
  w.write(`runs:    ${plan.runs.length}${flags.has("all-runs") ? " (all finishes)" : " (fastest only)"}\n\n`);
  for (const r of plan.runs) {
    const pv = r.provenance || {};
    w.write(`  ${r.player}\n`);
    w.write(`    time          ${(r.timeMs / 1000).toFixed(3)}s${r.awards && r.awards.length ? `   [${r.awards.join(", ")}]` : ""}\n`);
    w.write(`    dated         ${r.atISO} (from the demo, not now)\n`);
    w.write(`    strafe        ${r.strafeQualityBp == null ? "n/a" : (r.strafeQualityBp / 100).toFixed(2) + "%"}` +
            `   recomputed from ${pv.strafeSampledFrames}/${pv.samples} snapshots @ ${pv.snapPeriodMs}ms\n`);
    if (pv.bpKeyLag0 != null)
      w.write(`                  spread: naive key phase ${(pv.bpKeyLag0 / 100).toFixed(2)}%,` +
              ` sub-stepped gain ${(pv.bpSubSteppedGain / 100).toFixed(2)}%,` +
              ` ground rule ${(pv.bpNoGround / 100).toFixed(2)}%..${(pv.bpGroundHalo / 100).toFixed(2)}%\n`);
    w.write(`    speed         max ${r.maxSpeed} (${pv.speedSource ? pv.speedSource.max : "?"}),` +
            ` start ${r.startSpeed} (${pv.speedSource ? pv.speedSource.start : "?"})\n`);
    w.write(`    demo path     ${r.demoPath}\n`);
  }
}

main().catch((e) => {
  console.error("import-demo: " + (e && e.message ? e.message : e));
  process.exit(1);
});
