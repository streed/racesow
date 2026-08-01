// Admin-defined player achievements: the vetted rule catalog and its SQL.
//
// An achievement's `rule` is {kind, ...params} where `kind` names an entry in
// RULE_KINDS below. Admins compose definitions from this catalog in
// /admin/achievements — no free-form SQL/DSL ever reaches the database, so
// every rule stays a reviewed, indexed query. Each kind can build two
// closely-related statements:
//
//   qualifyQuery(def, {playerIds}) -> rows of (player_id, value, finish_id)
//     for every canonical player currently satisfying the rule, optionally
//     restricted to a set of players (the post-ingest incremental pass).
//   progressQuery(def, canonId)    -> one row (value) measuring how far a
//     single player is along the same rule with the threshold removed
//     (profile progress bars).
//
// player_id in results is ALWAYS the canonical group id
// (COALESCE(player.canonical_id, player.id)); awards are stored under it.
//
// Data sources and their horizons — worth knowing when authoring definitions:
//   finish      every completed run since 2026-07-22 (strafe_quality since
//               2026-07-30, recalibrated 2026-07-31); created_at epoch SECONDS.
//   run_tally   lifetime additive counters; predates the finish log.
//   race/best/standings
//               current PBs and the standings aggregate. standings is UNLOGGED
//               and rebuilt after ingests, so kinds reading it reflect the
//               last completed refresh — the daily sweep is the backstop.

export const TIERS = ["bronze", "silver", "gold", "legend"];

export const WINDOWS = {
  lifetime: "All time",
  month: "Calendar month (UTC)",
  day: "Calendar day (UTC)",
  rolling30: "Rolling 30 days",
};

// Epoch-seconds lower bound for a time window (0 = unbounded).
export function windowSince(timeWindow, now = new Date()) {
  if (timeWindow === "month") return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  if (timeWindow === "day")
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  if (timeWindow === "rolling30") return Math.floor(now.getTime() / 1000) - 30 * 86400;
  return 0;
}

// The award-log period key: '' for one-shot achievements, the UTC month/day
// key for repeatable windowed ones (so next month is a fresh award).
export function periodKey(def, now = new Date()) {
  if (!def.repeatable) return "";
  if (def.time_window === "month") return now.toISOString().slice(0, 7);
  if (def.time_window === "day") return now.toISOString().slice(0, 10);
  return "";
}

// Positional-parameter collector so the SQL builders can interleave clauses
// without hand-numbering $n placeholders.
class Params {
  constructor() {
    this.list = [];
  }
  add(v) {
    this.list.push(v);
    return `$${this.list.length}`;
  }
}

// Canonical group id for tables keyed by raw player.id (finish, run_tally,
// race). best/standings are already canonical.
const CID = "COALESCE(pl.canonical_id, pl.id)";

// Player restriction for a builder: the single-player progress variant, the
// incremental post-ingest id set, or nothing (full-field sweep).
function cidFilter(p, o) {
  if (o.progress) return ` AND ${CID} = ${p.add(o.canonId)}`;
  if (o.ids) return ` AND ${CID} = ANY(${p.add(o.ids)})`;
  return "";
}
function standingsFilter(p, o) {
  if (o.progress) return ` AND s.player_id = ${p.add(o.canonId)}`;
  if (o.ids) return ` AND s.player_id = ANY(${p.add(o.ids)})`;
  return "";
}

// run_tally counter columns an admin may target — whitelist, never
// interpolated from user input directly. distance is whole game units
// travelled while racing; strafes counts discrete 600+-ups strafe segments
// (both reported by servers running the 2026-07-31 metrics update — older
// servers contribute nothing).
const MOVEMENT_COLS = {
  wall_jumps: "Wall jumps",
  dashes: "Dashes",
  restarts: "Restarts",
  prejump_failures: "Prejump failures",
  distance: "Distance raced (game units)",
  strafes: "Strafes",
};

// A standings-column threshold kind (skill_rating / world_records / podiums /
// points differ only in column + labels). maxBound caps the admin-entered
// threshold at something sane for the column.
function standingsKind(col, maxBound, labels) {
  return {
    ...labels,
    windows: ["lifetime"],
    params: [{ key: "min", label: labels.paramLabel, type: "int", min: 1, max: maxBound }],
    better: "high",
    target: (rule) => rule.min,
    describe: (rule) => `${labels.label} ≥ ${rule.min}`,
    sql(rule, _win, p, o) {
      const gate = o.progress ? "" : ` AND s.${col} >= ${p.add(rule.min)}`;
      return `
        SELECT s.player_id, s.${col}::int AS value, NULL::bigint AS finish_id
        FROM standings s WHERE TRUE${gate}${standingsFilter(p, o)}`;
    },
  };
}

// The catalog. Each entry:
//   label/help    admin-form copy
//   windows       which time windows the kind supports (validated server-side)
//   params        form fields: {key, label, type: int|pct|bool|map|select, ...}
//   format        client display hint: count | pct-bp | ms | rank
//   better        'high' (value >= target) or 'low' (value <= target)
//   target(rule)  the numeric goal for progress bars
//   describe(rule) one-line rule summary for the admin list
//   sql(rule, win, p, opts) -> SELECT yielding (player_id, value, finish_id);
//     opts.progress drops the threshold and restricts to opts.canonId.
export const RULE_KINDS = {
  distinct_maps_finished: {
    label: "Distinct maps finished",
    help: "Finished N different maps. Lifetime counts the player's ALL-TIME map catalog (their PBs — predates the finish log); windowed variants count within the window, optionally only maps never finished before (“new maps”).",
    windows: ["lifetime", "month", "rolling30"],
    params: [
      { key: "count", label: "Map count", type: "int", min: 1, max: 100000 },
      { key: "newOnly", label: "First-ever finishes only (“new maps”; windowed only)", type: "bool" },
    ],
    format: "count",
    better: "high",
    target: (rule) => rule.count,
    describe: (rule) => `${rule.newOnly ? "new " : "distinct "}maps finished ≥ ${rule.count}`,
    sql(rule, win, p, o) {
      const since = windowSince(win, o.now);
      if (since === 0) {
        // Lifetime: the finish log only reaches back to 2026-07-22, so count
        // the player's PB catalog (best — one row per map ever finished, full
        // history). best is already canonical-keyed.
        const gate = o.progress ? "" : ` HAVING COUNT(*) >= ${p.add(rule.count)}`;
        const who = o.progress
          ? ` AND b.player_id = ${p.add(o.canonId)}`
          : o.ids
          ? ` AND b.player_id = ANY(${p.add(o.ids)})`
          : "";
        return `
          SELECT b.player_id, COUNT(*)::int AS value, NULL::bigint AS finish_id
          FROM best b WHERE TRUE${who}
          GROUP BY 1${gate}`;
      }
      if (rule.newOnly) {
        // A map counts when the player's first LOGGED finish of it falls
        // inside the window AND they hold no pre-window PB on it — so a
        // veteran replaying an old favourite (whose history predates the
        // finish log) doesn't score it as "new". Known small leak: improving
        // a pre-log PB replaces the race row with a fresh created_at, which
        // this can't see; rare and harmless.
        const having = o.progress ? "" : ` HAVING COUNT(*) >= ${p.add(rule.count)}`;
        const sinceP = p.add(since);
        return `
          SELECT player_id, COUNT(*)::int AS value, NULL::bigint AS finish_id FROM (
            SELECT ${CID} AS player_id, f.map_id, MIN(f.created_at) AS first_at
            FROM finish f JOIN player pl ON pl.id = f.player_id
            WHERE TRUE${cidFilter(p, o)}
            GROUP BY 1, 2
          ) firsts
          WHERE first_at >= ${sinceP}
            AND NOT EXISTS (
              SELECT 1 FROM race r JOIN player pl2 ON pl2.id = r.player_id
              WHERE r.map_id = firsts.map_id
                AND COALESCE(pl2.canonical_id, pl2.id) = firsts.player_id
                AND (r.created_at IS NULL OR r.created_at < ${sinceP})
            )
          GROUP BY player_id${having}`;
      }
      const having = o.progress ? "" : ` HAVING COUNT(DISTINCT f.map_id) >= ${p.add(rule.count)}`;
      return `
        SELECT ${CID} AS player_id, COUNT(DISTINCT f.map_id)::int AS value, NULL::bigint AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.created_at >= ${p.add(since)}${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },

  finishes: {
    label: "Total finishes",
    help: "Completed N runs. Lifetime counts come from the run tally (predates the finish log); windowed counts from the finish log.",
    windows: ["lifetime", "month", "day", "rolling30"],
    params: [{ key: "count", label: "Finish count", type: "int", min: 1, max: 10000000 }],
    format: "count",
    better: "high",
    target: (rule) => rule.count,
    describe: (rule) => `finishes ≥ ${rule.count}`,
    sql(rule, win, p, o) {
      if (win === "lifetime") {
        const having = o.progress ? "" : ` HAVING SUM(rt.finishes) >= ${p.add(rule.count)}`;
        return `
          SELECT ${CID} AS player_id, SUM(rt.finishes)::bigint AS value, NULL::bigint AS finish_id
          FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
          WHERE TRUE${cidFilter(p, o)}
          GROUP BY 1${having}`;
      }
      const since = windowSince(win, o.now);
      const having = o.progress ? "" : ` HAVING COUNT(*) >= ${p.add(rule.count)}`;
      return `
        SELECT ${CID} AS player_id, COUNT(*)::int AS value, NULL::bigint AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.created_at >= ${p.add(since)}${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },

  attempts: {
    label: "Total attempts",
    help: "Started N races (lifetime, from the run tally).",
    windows: ["lifetime"],
    params: [{ key: "count", label: "Attempt count", type: "int", min: 1, max: 100000000 }],
    format: "count",
    better: "high",
    target: (rule) => rule.count,
    describe: (rule) => `attempts ≥ ${rule.count}`,
    sql(rule, _win, p, o) {
      const having = o.progress ? "" : ` HAVING SUM(rt.attempts) >= ${p.add(rule.count)}`;
      return `
        SELECT ${CID} AS player_id, SUM(rt.attempts)::bigint AS value, NULL::bigint AS finish_id
        FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
        WHERE TRUE${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },

  strafe_quality_run: {
    label: "Strafe quality — single run",
    help: "Finished a run with strafe quality at or above the threshold. NOTE: the sampler was recalibrated to a 600-ups gate on 2026-07-31; earlier values are not comparable.",
    windows: ["lifetime"],
    params: [{ key: "minPct", label: "Minimum strafe quality (%)", type: "pct", min: 1, max: 100 }],
    format: "pct-bp",
    better: "high",
    target: (rule) => Math.round(rule.minPct * 100),
    describe: (rule) => `a run at ≥ ${rule.minPct}% strafe quality`,
    sql(rule, _win, p, o) {
      const gate = o.progress ? "" : ` AND f.strafe_quality >= ${p.add(Math.round(rule.minPct * 100))}`;
      return `
        SELECT DISTINCT ON (${CID}) ${CID} AS player_id, f.strafe_quality AS value, f.id AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.strafe_quality IS NOT NULL${gate}${cidFilter(p, o)}
        ORDER BY ${CID}, f.strafe_quality DESC`;
    },
  },

  strafe_quality_avg: {
    label: "Strafe quality — average",
    help: "Average strafe quality at or above the threshold across at least N runs.",
    windows: ["lifetime", "rolling30"],
    params: [
      { key: "minPct", label: "Minimum average (%)", type: "pct", min: 1, max: 100 },
      { key: "minRuns", label: "Minimum runs counted", type: "int", min: 1, max: 100000 },
    ],
    format: "pct-bp",
    better: "high",
    target: (rule) => Math.round(rule.minPct * 100),
    describe: (rule) => `avg strafe quality ≥ ${rule.minPct}% over ≥ ${rule.minRuns} runs`,
    sql(rule, win, p, o) {
      const since = windowSince(win, o.now);
      const having = o.progress
        ? ""
        : ` HAVING COUNT(*) >= ${p.add(rule.minRuns)} AND AVG(f.strafe_quality) >= ${p.add(Math.round(rule.minPct * 100))}`;
      return `
        SELECT ${CID} AS player_id, ROUND(AVG(f.strafe_quality))::int AS value, NULL::bigint AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.strafe_quality IS NOT NULL AND f.created_at >= ${p.add(since)}${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },

  skill_rating: standingsKind("sr", 1000, {
    label: "Skill Rating",
    paramLabel: "Minimum SR (0–1000)",
    help: "Current Skill Rating at or above the threshold.",
    format: "count",
  }),
  world_records: standingsKind("wr", 100000, {
    label: "World records held",
    paramLabel: "Minimum WR count",
    help: "Currently holds at least N world records.",
    format: "count",
  }),
  podiums: standingsKind("podium", 100000, {
    label: "Podium finishes held",
    paramLabel: "Minimum podium count",
    help: "Currently holds at least N top-3 placements.",
    format: "count",
  }),
  points: standingsKind("points", 100000000, {
    label: "Points",
    paramLabel: "Minimum points",
    help: "Current points total at or above the threshold.",
    format: "count",
  }),

  map_time: {
    label: "Beat a map under a time",
    help: "Holds a personal best at or under the target time on the named map (any game version; all-time PBs, not just the finish log).",
    windows: ["lifetime"],
    params: [
      { key: "map", label: "Map name (exact)", type: "map" },
      { key: "maxMs", label: "Target time (milliseconds)", type: "int", min: 50, max: 86400000 },
    ],
    format: "ms",
    better: "low",
    target: (rule) => rule.maxMs,
    describe: (rule) => `${rule.map} in ≤ ${rule.maxMs}ms`,
    sql(rule, _win, p, o) {
      const gate = o.progress ? "" : ` AND r.time <= ${p.add(rule.maxMs)}`;
      return `
        SELECT DISTINCT ON (${CID}) ${CID} AS player_id, r.time AS value, NULL::bigint AS finish_id
        FROM race r JOIN map m ON m.id = r.map_id JOIN player pl ON pl.id = r.player_id
        WHERE lower(m.name) = ${p.add(String(rule.map).toLowerCase())}${gate}${cidFilter(p, o)}
        ORDER BY ${CID}, r.time ASC`;
    },
  },

  map_rank: {
    label: "Leaderboard rank",
    help: "Currently ranked at or above #N — on any map, or on one named map.",
    windows: ["lifetime"],
    params: [
      { key: "maxRank", label: "Rank at or above (e.g. 10 = top 10)", type: "int", min: 1, max: 100000 },
      { key: "map", label: "Map name (blank = any map)", type: "map", optional: true },
    ],
    format: "rank",
    better: "low",
    target: (rule) => rule.maxRank,
    describe: (rule) => `top ${rule.maxRank} on ${rule.map || "any map"}`,
    sql(rule, _win, p, o) {
      const mapGate = rule.map ? ` AND lower(m.name) = ${p.add(String(rule.map).toLowerCase())}` : "";
      const gate = o.progress ? "" : ` AND b.rank <= ${p.add(rule.maxRank)}`;
      const idsGate = o.progress
        ? ` AND b.player_id = ${p.add(o.canonId)}`
        : o.ids
        ? ` AND b.player_id = ANY(${p.add(o.ids)})`
        : "";
      return `
        SELECT b.player_id, MIN(b.rank)::int AS value, NULL::bigint AS finish_id
        FROM best b JOIN map m ON m.id = b.map_id
        WHERE TRUE${mapGate}${gate}${idsGate}
        GROUP BY 1`;
    },
  },

  movement_total: {
    label: "Movement counter total",
    help: "Lifetime total of a movement counter (wall jumps, dashes, restarts, prejump failures).",
    windows: ["lifetime"],
    params: [
      {
        key: "metric",
        label: "Counter",
        type: "select",
        options: Object.entries(MOVEMENT_COLS).map(([value, label]) => ({ value, label })),
      },
      { key: "count", label: "Minimum total", type: "int", min: 1, max: 1000000000000 },
    ],
    format: "count",
    better: "high",
    target: (rule) => rule.count,
    describe: (rule) => `${MOVEMENT_COLS[rule.metric] || rule.metric} ≥ ${rule.count}`,
    sql(rule, _win, p, o) {
      // rule.metric is validated against MOVEMENT_COLS before it can be saved;
      // the lookup (never the raw value) is interpolated.
      const col = Object.prototype.hasOwnProperty.call(MOVEMENT_COLS, rule.metric) ? rule.metric : "wall_jumps";
      const having = o.progress ? "" : ` HAVING SUM(rt.${col}) >= ${p.add(rule.count)}`;
      return `
        SELECT ${CID} AS player_id, SUM(rt.${col})::bigint AS value, NULL::bigint AS finish_id
        FROM run_tally rt JOIN player pl ON pl.id = rt.player_id
        WHERE TRUE${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },

  max_speed_run: {
    label: "Top speed — single run",
    help: "Finished a run having hit at least N ups. Max speed is recorded per finish by servers running the 2026-07-31 metrics update; earlier finishes don't count.",
    windows: ["lifetime"],
    params: [{ key: "minUps", label: "Minimum speed (ups)", type: "int", min: 1, max: 100000 }],
    format: "ups",
    better: "high",
    target: (rule) => rule.minUps,
    describe: (rule) => `a run reaching ${rule.minUps} ups`,
    sql(rule, _win, p, o) {
      const gate = o.progress ? "" : ` AND f.max_speed >= ${p.add(rule.minUps)}`;
      return `
        SELECT DISTINCT ON (${CID}) ${CID} AS player_id, f.max_speed AS value, f.id AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.max_speed IS NOT NULL${gate}${cidFilter(p, o)}
        ORDER BY ${CID}, f.max_speed DESC`;
    },
  },

  play_streak: {
    label: "Consecutive-day streak",
    help: "Finished at least one run on N consecutive UTC days (the streak may have happened any time within the finish log).",
    windows: ["lifetime"],
    params: [{ key: "days", label: "Consecutive days", type: "int", min: 2, max: 3650 }],
    format: "count",
    better: "high",
    target: (rule) => rule.days,
    describe: (rule) => `a ${rule.days}-day finish streak`,
    sql(rule, _win, p, o) {
      // Gaps-and-islands: consecutive days share (day - row_number), so island
      // length = COUNT(*) per group; a player's value is their longest island.
      const having = o.progress ? "" : ` HAVING MAX(len) >= ${p.add(rule.days)}`;
      return `
        WITH d AS (
          SELECT DISTINCT ${CID} AS cid, (to_timestamp(f.created_at) AT TIME ZONE 'UTC')::date AS day
          FROM finish f JOIN player pl ON pl.id = f.player_id
          WHERE TRUE${cidFilter(p, o)}
        ),
        islands AS (
          SELECT cid, COUNT(*)::int AS len
          FROM (
            SELECT cid, day, day - (ROW_NUMBER() OVER (PARTITION BY cid ORDER BY day))::int AS grp FROM d
          ) g
          GROUP BY cid, grp
        )
        SELECT cid AS player_id, MAX(len)::int AS value, NULL::bigint AS finish_id
        FROM islands GROUP BY cid${having}`;
    },
  },

  dedication: {
    label: "Active days in a window",
    help: "Finished runs on at least N distinct UTC days within the window.",
    windows: ["month", "rolling30"],
    params: [{ key: "days", label: "Distinct active days", type: "int", min: 1, max: 31 }],
    format: "count",
    better: "high",
    target: (rule) => rule.days,
    describe: (rule) => `active on ≥ ${rule.days} days`,
    sql(rule, win, p, o) {
      const since = windowSince(win, o.now);
      const having = o.progress
        ? ""
        : ` HAVING COUNT(DISTINCT (to_timestamp(f.created_at) AT TIME ZONE 'UTC')::date) >= ${p.add(rule.days)}`;
      return `
        SELECT ${CID} AS player_id,
               COUNT(DISTINCT (to_timestamp(f.created_at) AT TIME ZONE 'UTC')::date)::int AS value,
               NULL::bigint AS finish_id
        FROM finish f JOIN player pl ON pl.id = f.player_id
        WHERE f.created_at >= ${p.add(since)}${cidFilter(p, o)}
        GROUP BY 1${having}`;
    },
  },
};

function kindOf(def) {
  const kind = def.rule && def.rule.kind;
  return Object.prototype.hasOwnProperty.call(RULE_KINDS, kind) ? RULE_KINDS[kind] : null;
}

// Everyone currently satisfying `def` — (player_id, value, finish_id) rows.
// playerIds (canonical ids) restricts the pass; null = the whole field.
export function qualifyQuery(def, { playerIds = null, now = new Date() } = {}) {
  const k = kindOf(def);
  if (!k) throw new Error(`unknown achievement rule kind: ${def.rule && def.rule.kind}`);
  const p = new Params();
  const sql = k.sql(def.rule, def.time_window, p, { ids: playerIds, progress: false, now });
  return { sql, params: p.list };
}

// One player's current value along `def`'s rule, threshold removed.
export function progressQuery(def, canonId, now = new Date()) {
  const k = kindOf(def);
  if (!k) throw new Error(`unknown achievement rule kind: ${def.rule && def.rule.kind}`);
  const p = new Params();
  const sql = k.sql(def.rule, def.time_window, p, { progress: true, canonId, now });
  return { sql, params: p.list };
}

export function targetOf(def) {
  const k = kindOf(def);
  return k ? k.target(def.rule) : null;
}

export function describeRule(def) {
  const k = kindOf(def);
  if (!k) return `unknown kind ${def.rule && def.rule.kind}`;
  const w = def.time_window !== "lifetime" ? ` · ${WINDOWS[def.time_window] || def.time_window}` : "";
  return k.describe(def.rule) + w + (def.repeatable ? " · repeatable" : "");
}

// Display metadata for a definition (client formatting hints).
export function displayMeta(def) {
  const k = kindOf(def);
  return k ? { format: k.format, better: k.better } : { format: "count", better: "high" };
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Validate + normalise an admin-form submission into a storable definition.
// `params` holds the raw form strings for the CHOSEN kind only. Returns
// { error } or { value: {title, slug, description, tier, rule, time_window,
// repeatable, hidden} } — everything typed and clamped; nothing user-supplied
// is ever interpolated into SQL (see the builders above).
export function validateDefinition({ title, slug, description, tier, kind, params = {}, window: win, repeatable, hidden }) {
  title = String(title || "").trim().slice(0, 120);
  if (!title) return { error: "A title is required." };
  slug = slugify(slug || title);
  if (!slug) return { error: "Could not derive a slug — set one explicitly (a-z, 0-9, dashes)." };
  description = String(description || "").trim().slice(0, 500);
  tier = TIERS.includes(tier) ? tier : "bronze";

  const k = Object.prototype.hasOwnProperty.call(RULE_KINDS, kind) ? RULE_KINDS[kind] : null;
  if (!k) return { error: "Pick a rule kind." };
  win = k.windows.includes(win) ? win : k.windows[0];
  repeatable = Boolean(repeatable) && (win === "month" || win === "day");
  hidden = Boolean(hidden);

  const rule = { kind };
  for (const spec of k.params) {
    const raw = params[spec.key];
    if (spec.type === "int") {
      const n = parseInt(raw, 10);
      if (Number.isNaN(n)) return { error: `${spec.label}: a whole number is required.` };
      if (n < spec.min || n > spec.max) return { error: `${spec.label}: must be between ${spec.min} and ${spec.max}.` };
      rule[spec.key] = n;
    } else if (spec.type === "pct") {
      const n = parseFloat(raw);
      if (Number.isNaN(n)) return { error: `${spec.label}: a number is required.` };
      if (n < spec.min || n > spec.max) return { error: `${spec.label}: must be between ${spec.min} and ${spec.max}.` };
      rule[spec.key] = Math.round(n * 100) / 100;
    } else if (spec.type === "bool") {
      rule[spec.key] = raw === "on" || raw === "1" || raw === "true" || raw === true;
    } else if (spec.type === "map") {
      const name = String(raw || "").trim().toLowerCase().slice(0, 128);
      if (!name && !spec.optional) return { error: `${spec.label}: a map name is required.` };
      if (name && !/^[a-z0-9 _().\-\[\]#!']+$/.test(name))
        return { error: `${spec.label}: that doesn't look like a map name.` };
      if (name) rule[spec.key] = name;
    } else if (spec.type === "select") {
      const ok = spec.options.some((op) => op.value === raw);
      if (!ok) return { error: `${spec.label}: pick one of the listed options.` };
      rule[spec.key] = raw;
    }
  }

  return { value: { title, slug, description, tier, rule, time_window: win, repeatable, hidden } };
}
