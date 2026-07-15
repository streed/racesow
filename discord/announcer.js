// Racesow Discord announcer — API edition.
//
// Polls the stats web service for newly-inserted records and posts a rich
// embed to a Discord webhook for each one worth shouting about (world records
// by default). New rows are detected by race id — every new run gets a higher
// id than the last (the API preserves the monotonic-id contract), so we
// simply remember the highest id we have already handled.
//
// On first run it records the current maximum id as a baseline WITHOUT
// posting anything, so it never floods a channel with the back catalogue.
//
// This service has NO database access: GET /api/records?after_id= returns the
// new records with the margin-to-#2 and version name precomputed. (The old
// better-sqlite3 + REMOTE_DB_URL snapshot mode died with the move to
// PostgreSQL — see git history.)
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const CFG = {
  webhook: process.env.DISCORD_WEBHOOK_URL || "",
  apiUrl: (process.env.API_URL || "http://web:8080").replace(/\/+$/, ""),
  statePath: process.env.STATE_PATH || "/state/announcer.json",
  pollSeconds: Math.max(15, parseInt(process.env.POLL_INTERVAL || "300", 10)),
  // Announce records whose global rank is <= this (1 = world records only).
  maxRank: Math.max(1, parseInt(process.env.ANNOUNCE_MAX_RANK || "1", 10)),
  // Safety cap on how many embeds to post per poll.
  maxPerPoll: Math.max(1, parseInt(process.env.MAX_PER_POLL || "10", 10)),
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

async function fetchRecords(afterId) {
  const url =
    `${CFG.apiUrl}/api/records?after_id=${afterId}` +
    `&max_rank=${CFG.maxRank}&limit=${CFG.maxPerPoll}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /api/records ${res.status}`);
  return res.json(); // { maxId, records: [...] }
}

function buildEmbed(rec) {
  const isWR = rec.global_rank === 1;
  const player = rec.player || stripColors(rec.raw_name) || "unknown";
  const fields = [
    { name: "Map", value: "`" + rec.map + "`", inline: true },
    { name: "Time", value: "`" + fmtTime(rec.time) + "`", inline: true },
    { name: "Rank", value: `#${rec.global_rank}`, inline: true },
  ];
  if (isWR && rec.margin != null) {
    fields.push({ name: "Ahead of #2 by", value: "`" + fmtTime(rec.margin) + "`", inline: true });
  }
  fields.push({ name: "Version", value: rec.version, inline: true });

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
  let data;
  try {
    data = await fetchRecords(state.lastId ?? 0);
  } catch (e) {
    log("cannot reach the stats API:", e.message);
    return state;
  }

  try {
    if (state.lastId == null) {
      // First run: baseline, do not announce history.
      state.lastId = data.maxId;
      await saveState(state);
      log(`baseline established at race id ${data.maxId} (no historical announcements)`);
      return state;
    }

    if (data.maxId <= state.lastId) {
      log(`no new records (max id ${data.maxId})`);
      return state;
    }

    const recs = data.records;
    if (!recs.length) {
      // New rows exist but none met the rank threshold; advance the cursor.
      state.lastId = data.maxId;
      await saveState(state);
      return state;
    }

    log(`announcing ${recs.length} new record(s)`);
    const embeds = recs.map(buildEmbed);
    if (CFG.webhook) {
      await postEmbeds(embeds);
    } else {
      log("DISCORD_WEBHOOK_URL not set — would post:", JSON.stringify(embeds, null, 2));
    }

    // Advance the cursor to the highest id we processed (or the true max if
    // the threshold filtered out the tail).
    state.lastId = Math.max(data.maxId, recs[recs.length - 1].id);
    await saveState(state);
  } catch (e) {
    log("poll error:", e.message);
  }
  return state;
}

async function main() {
  if (!CFG.webhook) {
    log("WARNING: DISCORD_WEBHOOK_URL is not set — running in dry-run (log only) mode.");
  }
  log(`announcer starting: api=${CFG.apiUrl} poll=${CFG.pollSeconds}s maxRank=${CFG.maxRank}`);

  let state = await loadState();
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
