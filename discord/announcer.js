// Racesow Discord announcer.
//
// Watches the race database for newly-inserted records and posts a rich embed
// to a Discord webhook for each one worth shouting about (world records by
// default). New rows are detected by race id — every new run gets a higher id
// than the last, so we simply remember the highest id we have already handled.
//
// On first run it records the current maximum id as a baseline WITHOUT posting
// anything, so it never floods a channel with the entire back catalogue.
//
// Optionally it can refresh the database from a remote URL before each poll
// (e.g. the livesow snapshot), which is what makes "new records" actually
// appear in a static file over time.
import Database from "better-sqlite3";
import { writeFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CFG = {
  webhook: process.env.DISCORD_WEBHOOK_URL || "",
  dbPath: process.env.DB_PATH || "/data/db.sqlite",
  statePath: process.env.STATE_PATH || "/state/announcer.json",
  pollSeconds: Math.max(15, parseInt(process.env.POLL_INTERVAL || "300", 10)),
  // Announce records whose global rank is <= this (1 = world records only,
  // 3 = podiums, etc.).
  maxRank: Math.max(1, parseInt(process.env.ANNOUNCE_MAX_RANK || "1", 10)),
  // Safety cap on how many embeds to post per poll.
  maxPerPoll: Math.max(1, parseInt(process.env.MAX_PER_POLL || "10", 10)),
  // If set, download a fresh DB from here before each poll.
  remoteDbUrl: process.env.REMOTE_DB_URL || "",
  username: process.env.WEBHOOK_USERNAME || "Racesow",
  siteUrl: process.env.SITE_URL || "", // optional link back to the stats site
};

const EMBED_COLOR = 0xff6a1a; // warsow orange
const WR_COLOR = 0xffd24a; // gold

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

/* milliseconds -> race clock */
function fmtTime(ms) {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = String(ms % 1000).padStart(3, "0");
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}.${mss}` : `${s}.${mss}`;
}

/* Strip Warsow ^0-^9 colour codes for plain-text display in Discord. */
function stripColors(name) {
  return String(name || "").replace(/\^[0-9]/g, "");
}

async function loadState() {
  try {
    if (existsSync(CFG.statePath)) {
      return JSON.parse(await readFile(CFG.statePath, "utf8"));
    }
  } catch (e) {
    log("could not read state:", e.message);
  }
  return { lastId: null };
}

async function saveState(state) {
  try {
    const dir = path.dirname(CFG.statePath);
    if (!existsSync(dir)) return log(`state dir ${dir} missing; not persisting`);
    await writeFile(CFG.statePath, JSON.stringify(state), "utf8");
  } catch (e) {
    log("could not write state:", e.message);
  }
}

async function refreshDb() {
  if (!CFG.remoteDbUrl) return;
  log(`refreshing DB from ${CFG.remoteDbUrl} ...`);
  const res = await fetch(CFG.remoteDbUrl);
  if (!res.ok) throw new Error(`remote DB fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = CFG.dbPath + ".tmp";
  await writeFile(tmp, buf);
  await rename(tmp, CFG.dbPath);
  log(`DB refreshed (${(buf.length / 1024 / 1024).toFixed(1)} MiB)`);
}

function openDb() {
  const db = new Database(CFG.dbPath, { readonly: true, fileMustExist: true });
  return db;
}

function findNewRecords(db, lastId) {
  return db
    .prepare(
      `SELECT r.id, r.time, r.global_rank, r.version_rank, r.version_id,
              m.id AS map_id, m.name AS map,
              p.name AS raw_name, p.simplified AS player
       FROM race r
       JOIN map m ON m.id = r.map_id
       JOIN player p ON p.id = r.player_id
       WHERE r.id > ? AND r.global_rank <= ?
       ORDER BY r.id ASC
       LIMIT ?`
    )
    .all(lastId, CFG.maxRank, CFG.maxPerPoll);
}

// Margin to the next-best time on the same map (how far ahead this run is).
function marginToNext(db, mapId, time) {
  const row = db
    .prepare(
      `SELECT MIN(time) AS t FROM (
         SELECT player_id, MIN(time) AS time FROM race WHERE map_id = ? GROUP BY player_id
       ) WHERE time > ?`
    )
    .get(mapId, time);
  return row && row.t != null ? row.t - time : null;
}

function versionName(db, id, cache) {
  if (cache.has(id)) return cache.get(id);
  const row = db.prepare("SELECT name FROM version WHERE id = ?").get(id);
  const name = row ? row.name : String(id);
  cache.set(id, name);
  return name;
}

function buildEmbed(rec, db, vcache) {
  const isWR = rec.global_rank === 1;
  const player = rec.player || stripColors(rec.raw_name) || "unknown";
  const fields = [
    { name: "Map", value: "`" + rec.map + "`", inline: true },
    { name: "Time", value: "`" + fmtTime(rec.time) + "`", inline: true },
    { name: "Rank", value: `#${rec.global_rank}`, inline: true },
  ];
  if (isWR) {
    const margin = marginToNext(db, rec.map_id, rec.time);
    if (margin != null) {
      fields.push({ name: "Ahead of #2 by", value: "`" + fmtTime(margin) + "`", inline: true });
    }
  }
  fields.push({ name: "Version", value: versionName(db, rec.version_id, vcache), inline: true });

  const title = isWR ? "🏆 New World Record!" : `🏁 New Top-${CFG.maxRank} Record`;
  const embed = {
    title,
    description: `**${player}** just set a ${isWR ? "world record" : "record"} on **${rec.map}**`,
    color: isWR ? WR_COLOR : EMBED_COLOR,
    fields,
    footer: { text: "Racesow · Warsow Race" },
    timestamp: new Date().toISOString(),
  };
  if (CFG.siteUrl) embed.url = `${CFG.siteUrl.replace(/\/$/, "")}/#/map/${rec.map_id}`;
  return embed;
}

async function postEmbeds(embeds) {
  // Discord allows up to 10 embeds per message.
  for (let i = 0; i < embeds.length; i += 10) {
    const batch = embeds.slice(i, i + 10);
    const res = await fetch(CFG.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: CFG.username, embeds: batch }),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || 2;
      log(`rate limited, waiting ${retry}s`);
      await new Promise((r) => setTimeout(r, retry * 1000));
      i -= 10; // retry this batch
      continue;
    }
    if (!res.ok) throw new Error(`webhook POST ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 400)); // gentle pacing
  }
}

async function poll(state) {
  if (CFG.remoteDbUrl) {
    try {
      await refreshDb();
    } catch (e) {
      log("DB refresh failed (using existing file):", e.message);
    }
  }

  let db;
  try {
    db = openDb();
  } catch (e) {
    log("cannot open DB:", e.message);
    return state;
  }

  try {
    const maxRow = db.prepare("SELECT MAX(id) AS m FROM race").get();
    const maxId = maxRow ? maxRow.m : 0;

    if (state.lastId == null) {
      // First run: baseline, do not announce history.
      state.lastId = maxId;
      await saveState(state);
      log(`baseline established at race id ${maxId} (no historical announcements)`);
      return state;
    }

    if (maxId <= state.lastId) {
      log(`no new records (max id ${maxId})`);
      return state;
    }

    const recs = findNewRecords(db, state.lastId);
    if (!recs.length) {
      // New rows exist but none met the rank threshold; advance the cursor.
      state.lastId = maxId;
      await saveState(state);
      return state;
    }

    log(`announcing ${recs.length} new record(s)`);
    const vcache = new Map();
    const embeds = recs.map((r) => buildEmbed(r, db, vcache));
    if (CFG.webhook) {
      await postEmbeds(embeds);
    } else {
      log("DISCORD_WEBHOOK_URL not set — would post:", JSON.stringify(embeds, null, 2));
    }

    // Advance cursor to the highest id we processed (or the true max if the
    // threshold filtered out the tail).
    state.lastId = Math.max(maxId, recs[recs.length - 1].id);
    await saveState(state);
  } catch (e) {
    log("poll error:", e.message);
  } finally {
    db.close();
  }
  return state;
}

async function main() {
  if (!CFG.webhook) {
    log("WARNING: DISCORD_WEBHOOK_URL is not set — running in dry-run (log only) mode.");
  }
  log(`announcer starting: db=${CFG.dbPath} poll=${CFG.pollSeconds}s maxRank=${CFG.maxRank}` +
      (CFG.remoteDbUrl ? ` remote=${CFG.remoteDbUrl}` : ""));

  let state = await loadState();
  // Run immediately, then on an interval.
  const tick = async () => {
    state = await poll(state);
  };
  await tick();
  setInterval(tick, CFG.pollSeconds * 1000);
}

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
