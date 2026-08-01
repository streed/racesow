// Tournaments: entry codes, scoring SQL and admin-form validation.
//
// Companion to migration 20260801120000000_tournaments.sql. Everything here is
// pure — no database handle — so db.js can import it without a cycle and the
// tests can exercise the scoring shape and the code alphabet directly.
//
// A tournament owns no runs (see the migration's header): scoring is a filter
// over the finish log. standingsQuery() builds that filter once and is used for
// BOTH the live board and the frozen snapshot written at finalize time, so a
// result can never change shape between "what players watched" and "what was
// awarded" — only its upper time bound differs.

// Per-map placement points. Deliberately the SAME curve as the site-wide
// standings (db.js POINTS) so a tournament board reads like a small Hall of
// Fame instead of a second, unfamiliar scale. web/test/tournaments.test.js
// asserts the two stay identical.
export const MAP_POINTS = [100, 85, 75, 68, 62, 57, 53, 49, 46, 43, 40, 38, 36, 34, 32];

// SQL form of MAP_POINTS over a caller-supplied rank expression. Taking the
// expression as an argument keeps every call site qualified (`r.rank`) — bare
// `rank` is also a window-function name, and leaving it unqualified is exactly
// the sort of thing that parses today and turns ambiguous the moment another
// ranked relation joins in.
const pointsCase = (rankExpr) => `CASE ${rankExpr}
  WHEN 1 THEN 100 WHEN 2 THEN 85 WHEN 3 THEN 75 WHEN 4 THEN 68 WHEN 5 THEN 62
  WHEN 6 THEN 57 WHEN 7 THEN 53 WHEN 8 THEN 49 WHEN 9 THEN 46 WHEN 10 THEN 43
  WHEN 11 THEN 40 WHEN 12 THEN 38 WHEN 13 THEN 36 WHEN 14 THEN 34 WHEN 15 THEN 32
  ELSE 0 END`;

export const SCORINGS = {
  points: "Placement points — the site's top-15 curve on every map, summed",
  time_sum: "Total time — sum of your best times; only players who finish EVERY map are ranked",
};

export const STATUSES = ["draft", "published", "finalized", "cancelled"];

// Entry-code alphabet: uppercase Crockford-ish, with 0/O/1/I/L/U dropped so a
// code read off the website and typed into a game console can't be misheard.
// 8 chars over 31 symbols is ~8.5e11 combinations — collisions are handled by
// a unique-index retry, not by hoping.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const CODE_LEN = 8;

// A fresh code, using the caller's CSPRNG. Rejection-samples so every symbol is
// equally likely (256 % 30 != 0, and a biased join code is a bad look even
// though nothing security-critical rides on it).
export function generateCode(randomBytes) {
  let out = "";
  while (out.length < CODE_LEN) {
    for (const b of randomBytes(CODE_LEN * 2)) {
      if (b >= 256 - (256 % CODE_ALPHABET.length)) continue; // reject the biased tail
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return out;
}

// Normalise anything a human might type or paste into the stored form: drop
// separators and whitespace, uppercase, and require every remaining character
// to be in the alphabet. Deliberately NO glyph folding — an O or a 1 can only
// be a mis-read, and guessing which real symbol it stood for would turn "that
// isn't a valid code" into the far more confusing "no such code". Returns ""
// for anything unusable so callers reject it without a database hit.
export function normalizeCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== CODE_LEN) return "";
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return "";
  return s;
}

// Human-friendly rendering of a stored code: "RS9K4MTB" -> "RS9K-4MTB".
export function formatCode(code) {
  const s = String(code || "");
  return s.length === CODE_LEN ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

// Where a tournament is in its life, derived from the clock every time rather
// than stored — a stored phase is a phase that goes stale at 03:00 with nobody
// watching. 'finalized' and 'cancelled' are terminal and outrank the clock.
export function phaseOf(t, nowSec = Math.floor(Date.now() / 1000)) {
  if (!t) return null;
  if (t.status === "cancelled") return "cancelled";
  if (t.status === "finalized") return "finalized";
  if (t.status === "draft") return "draft";
  if (nowSec < Number(t.starts_at)) return "upcoming";
  if (nowSec < Number(t.ends_at)) return "live";
  return "ended"; // over, awaiting the finalizer
}

export const PHASE_LABEL = {
  draft: "Draft",
  upcoming: "Upcoming",
  live: "Live now",
  ended: "Finished",
  finalized: "Final",
  cancelled: "Cancelled",
};

// Can this tournament still take entries? Signups stay open right up to the
// end: every run inside the window counts regardless of WHEN the entrant
// redeemed their code (see standingsQuery), so late-joining is fair and
// closing signups early would only punish people who heard about it late.
export function joinOpen(t, nowSec = Math.floor(Date.now() / 1000)) {
  if (!t || !t.join_open) return false;
  const phase = phaseOf(t, nowSec);
  return phase === "upcoming" || phase === "live";
}

// The standings query: every registered entrant's best time per tournament map
// inside the window, ranked per map, aggregated per player.
//
// Two things are resolved at READ time on purpose:
//   - the entrant set expands through the CURRENT canonical grouping, so an
//     alias re-merge after signup can't silently drop somebody from the board;
//   - the map set comes from tournament_map, so editing the pool re-scores
//     immediately instead of needing a rebuild.
//
// The upper time bound is always the tournament's own ends_at, for the live
// board and the freeze alike — never "now". A live board that stopped at the
// current second and a snapshot that stopped at ends_at would disagree about a
// run landing in the last minute; using the window's own end for both means the
// board players were watching IS the board that gets awarded.
export function standingsQuery(t, { limit = 500 } = {}) {
  const timeSum = t.scoring === "time_sum";
  // time_sum ranks only complete entries; ordering is by fewest maps missed
  // first so an incomplete run still appears below the ranked field rather
  // than vanishing (the client greys it out).
  const order = timeSum
    ? "complete DESC, total_time ASC, maps_played DESC, player_id ASC"
    : "points DESC, map_wins DESC, maps_played DESC, total_time ASC, player_id ASC";
  return {
    sql: `
      WITH entrants AS (
        SELECT DISTINCT COALESCE(pl.canonical_id, pl.id) AS cid
        FROM tournament_entrant te
        JOIN player pl ON pl.id = te.player_id
        WHERE te.tournament_id = $1 AND te.player_id IS NOT NULL
      ),
      tmaps AS (
        SELECT map_id FROM tournament_map WHERE tournament_id = $1
      ),
      bests AS (
        SELECT COALESCE(pl.canonical_id, pl.id) AS player_id,
               f.map_id,
               MIN(f.time) AS time
        FROM finish f
        JOIN player pl ON pl.id = f.player_id
        WHERE f.map_id IN (SELECT map_id FROM tmaps)
          AND f.created_at >= $2
          AND f.created_at <  $3
          AND COALESCE(pl.canonical_id, pl.id) IN (SELECT cid FROM entrants)
        GROUP BY 1, 2
      ),
      ranked AS (
        SELECT b.player_id, b.map_id, b.time,
               RANK() OVER (PARTITION BY b.map_id ORDER BY b.time) AS rank
        FROM bests b
      )
      SELECT r.player_id,
             SUM(${pointsCase("r.rank")})::int                     AS points,
             COUNT(*)::int                                         AS maps_played,
             SUM(CASE WHEN r.rank = 1 THEN 1 ELSE 0 END)::int      AS map_wins,
             SUM(r.time)::bigint                                   AS total_time,
             (COUNT(*) = (SELECT COUNT(*) FROM tmaps))             AS complete,
             jsonb_agg(jsonb_build_object(
               'mapId', r.map_id, 'map', m.name, 'time', r.time,
               'rank', r.rank, 'points', ${pointsCase("r.rank")}
             ) ORDER BY r.rank, r.map_id)                          AS detail
      FROM ranked r
      JOIN map m ON m.id = r.map_id
      GROUP BY r.player_id
      ORDER BY ${order}
      LIMIT $4`,
    params: [t.id, Number(t.starts_at), Number(t.ends_at), limit],
  };
}

// Per-map leaderboards for a tournament's detail page: every entrant's best
// time on each pool map inside the window, fastest first.
export function mapBoardsQuery(t, { perMap = 25 } = {}) {
  return {
    sql: `
      WITH entrants AS (
        SELECT DISTINCT COALESCE(pl.canonical_id, pl.id) AS cid
        FROM tournament_entrant te
        JOIN player pl ON pl.id = te.player_id
        WHERE te.tournament_id = $1 AND te.player_id IS NOT NULL
      ),
      bests AS (
        SELECT COALESCE(pl.canonical_id, pl.id) AS player_id,
               f.map_id,
               MIN(f.time) AS time
        FROM finish f
        JOIN player pl ON pl.id = f.player_id
        WHERE f.map_id IN (SELECT map_id FROM tournament_map WHERE tournament_id = $1)
          AND f.created_at >= $2
          AND f.created_at <  $3
          AND COALESCE(pl.canonical_id, pl.id) IN (SELECT cid FROM entrants)
        GROUP BY 1, 2
      ),
      ranked AS (
        SELECT b.*, RANK() OVER (PARTITION BY b.map_id ORDER BY b.time) AS rank
        FROM bests b
      )
      SELECT r.map_id, r.player_id, r.time, r.rank,
             ${pointsCase("r.rank")} AS points,
             p.name, p.simplified
      FROM ranked r
      JOIN player p ON p.id = r.player_id
      WHERE r.rank <= $4
      ORDER BY r.map_id, r.rank, r.time`,
    params: [t.id, Number(t.starts_at), Number(t.ends_at), perMap],
  };
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// Parse an admin-entered "YYYY-MM-DD HH:MM" (or the browser's
// "YYYY-MM-DDTHH:MM" from <input type=datetime-local>) as UTC epoch seconds.
// UTC, not the box's local zone: the production boxes run UTC, players are
// spread across the world, and every other timestamp in this codebase is UTC —
// a form that silently meant "Europe/Berlin" would put a tournament's start an
// hour off from the calendar rendering it. Returns null when unparseable.
export function parseAdminTime(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00"] = m;
  const ts = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec);
  if (!Number.isFinite(ts)) return null;
  // Reject a date the calendar could never render sensibly (e.g. month 13
  // rolling over silently in Date.UTC).
  const back = new Date(ts);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d) return null;
  return Math.floor(ts / 1000);
}

// Epoch seconds -> the value a datetime-local input wants (UTC).
//
// Seconds are INCLUDED (slice 19, not 16) and the input carries step="1". The
// half-open [starts_at, ends_at) window lets back-to-back editions share a
// boundary second; a form that rendered "18:00:30" as "18:00" would silently
// move that boundary every time an admin re-saved an unrelated field.
export function toAdminTime(ts) {
  if (ts == null) return "";
  return new Date(Number(ts) * 1000).toISOString().slice(0, 19);
}

const MIN_DURATION = 3600; // an hour: shorter is a mis-typed form, not a tournament
const MAX_DURATION = 90 * 86400; // "a day to multiple weeks", with room to spare

// Validate + normalise an admin tournament form. Returns {error} or {value}.
// Map names are validated but NOT resolved here (that needs the database); the
// caller turns `maps` into map ids and reports the ones it couldn't find.
export function validateTournament({
  name, slug, description, startsAt, endsAt, scoring, status, joinOpen: jo,
  maps, repeatEveryDays, repeatGapDays,
}) {
  name = String(name || "").trim().slice(0, 120);
  if (!name) return { error: "A tournament name is required." };
  slug = slugify(slug || name);
  if (!slug) return { error: "Could not derive a URL slug — set one explicitly (a-z, 0-9, dashes)." };
  description = String(description || "").trim().slice(0, 2000);

  const s = parseAdminTime(startsAt);
  if (s == null) return { error: "Start: use YYYY-MM-DD HH:MM (UTC)." };
  const e = parseAdminTime(endsAt);
  if (e == null) return { error: "End: use YYYY-MM-DD HH:MM (UTC)." };
  if (e - s < MIN_DURATION) return { error: "A tournament must run for at least an hour." };
  if (e - s > MAX_DURATION) return { error: "A tournament may run for at most 90 days." };

  scoring = Object.prototype.hasOwnProperty.call(SCORINGS, scoring) ? scoring : "points";
  status = STATUSES.includes(status) ? status : "draft";
  // 'finalized' is something the finalizer does, never something a form sets —
  // it would mint trophies from an empty snapshot.
  if (status === "finalized") return { error: "A tournament becomes final when its finalizer runs, not from this form." };

  const mapList = (Array.isArray(maps) ? maps : String(maps || "").split(/[\r\n,]+/))
    .map((m) => String(m).trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set();
  const mapNames = [];
  for (const m of mapList) {
    if (m.length > 128) return { error: `Map name too long: ${m.slice(0, 40)}…` };
    if (!/^[a-z0-9][a-z0-9 _().\-\[\]#!']*$/.test(m)) return { error: `That doesn't look like a map name: ${m}` };
    if (seen.has(m)) continue;
    seen.add(m);
    mapNames.push(m);
  }
  if (!mapNames.length) return { error: "Add at least one map to the pool." };
  if (mapNames.length > 64) return { error: "A tournament pool is capped at 64 maps." };

  const rep = Math.max(0, Math.min(365, parseInt(repeatEveryDays, 10) || 0));
  const gap = Math.max(0, Math.min(365, parseInt(repeatGapDays, 10) || 0));

  return {
    value: {
      name, slug, description,
      starts_at: s, ends_at: e,
      scoring, status,
      join_open: Boolean(jo),
      repeat_every_days: rep,
      repeat_gap_days: gap,
      mapNames,
    },
  };
}

// Does [aStart, aEnd) intersect [bStart, bEnd)? Half-open, so an edition
// ending exactly when the next begins does NOT count as an overlap.
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return Number(aStart) < Number(bEnd) && Number(bStart) < Number(aEnd);
}

// The plain-text payload the game servers poll (hrace/tournament.as via the
// RS_ApiFetchTourney native). Same shape as the other game feeds: a sentinel
// first line the native uses to reject captive-portal / proxy bodies that
// answer 200, then tab-delimited records.
//
//   RSTOURNEY
//   T\t<id>\t<slug>\t<startsAt>\t<endsAt>\t<name>
//   S\t<live|soon>\t<secondsLeft>\t<entrants>
//   M\t<mapname>
//   M\t<mapname>
//
// Exactly one T line (the tournament that is live NOW, or the next one starting
// if none is) followed by its state and its pool, or just the header when there
// is nothing scheduled — an empty body after the header is a real state, not an
// error. Tabs and control characters are stripped from the free-text name so an
// admin-entered title can't break the line shape.
//
// The S line exists because AngelScript has no wall clock: the game cannot
// compare the window it was sent against "now", so without it a server can only
// state the window as absolute dates and can never say "this is on RIGHT NOW,
// come and join". `secondsLeft` counts to the END when live and to the START
// when not, and is resolved HERE, at fetch time — the feed refreshes every ~60s,
// so the game prints it coarsely (days/hours) and the staleness never shows.
// Unknown line kinds are skipped by the game parser, so this is additive: an
// older server ignores it and behaves exactly as before.
export function gameTourneyText(t, mapNames, { nowSec = Math.floor(Date.now() / 1000), entrants = 0 } = {}) {
  const strip = (s) => String(s || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  let body = "RSTOURNEY\n";
  if (!t) return body;
  body += `T\t${t.id}\t${strip(t.slug)}\t${Number(t.starts_at)}\t${Number(t.ends_at)}\t${strip(t.name)}\n`;
  const live = phaseOf(t, nowSec) === "live";
  const target = live ? Number(t.ends_at) : Number(t.starts_at);
  const left = Math.max(0, target - Number(nowSec));
  body += `S\t${live ? "live" : "soon"}\t${left}\t${Math.max(0, Math.trunc(Number(entrants) || 0))}\n`;
  for (const m of mapNames || []) body += `M\t${strip(m).toLowerCase()}\n`;
  return body;
}
