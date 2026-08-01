-- Tournaments: time-boxed, map-limited competitions layered over the normal
-- leaderboard.
--
-- The central idea is that a tournament OWNS NO RUNS. A finish is ingested
-- exactly as it always was (race/finish/run_tally), counts for the global
-- leaderboard exactly as it always did, and a tournament is nothing but a
-- FILTER over the finish log:
--
--     finishes on tournament_map's maps
--     between tournament.starts_at and tournament.ends_at
--     by a player who redeemed an entry code before setting them
--
-- so nothing about the ingest wire format changes, a tournament can be defined
-- after the fact, and a mistake in a tournament definition can never corrupt
-- the real records. Standings are computed live while a tournament runs and
-- FROZEN into tournament_standing when it ends (see web/tournaments.js), so a
-- historical result never drifts when the finish log or the canonical-alias
-- grouping later moves under it.
--
-- Joining is two-sided on purpose. The website mints an entry CODE (unclaimed
-- tournament_entrant row); the player redeems it in-game with "/tournament
-- <code>", which is what binds the entry to a real in-game identity — the site
-- has no player accounts, so the code IS the proof-of-nick. A player already
-- in-game can skip the website entirely with "/tournament join", which mints
-- an already-claimed row for the nick they are playing under.
--
-- All timestamps are epoch SECONDS (house style; matches finish.created_at).
-- player_id columns hold the CANONICAL representative id at write time, and
-- reads must span the alias group the way sr_history/player_achievement reads
-- do (player_id IN (SELECT id FROM player WHERE canonical_id = $1)).

-- Up Migration
CREATE TABLE IF NOT EXISTS tournament (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- Half-open window [starts_at, ends_at): a finish at exactly ends_at belongs
  -- to whatever comes next, so back-to-back editions can share a boundary
  -- second without double-counting a run.
  starts_at    BIGINT NOT NULL,
  ends_at      BIGINT NOT NULL,
  -- 'draft'     admin-only, invisible on the site, mints no codes
  -- 'published' public; the phase (upcoming/live/ended) is derived from the
  --             window, never stored, so it can never go stale
  -- 'finalized' over AND snapshotted into tournament_standing + trophies
  -- 'cancelled' called off; keeps its row (and its slot in the calendar
  --             history) but scores nothing and blocks no future scheduling
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','published','finalized','cancelled')),
  -- 'points'   per-map placement points (the site's own top-15 curve), summed
  -- 'time_sum' classic race format: total of best times, only players who
  --            finished EVERY map are ranked
  scoring      TEXT NOT NULL DEFAULT 'points'
               CHECK (scoring IN ('points','time_sum')),
  -- Whether new entries may still be created. Independent of the window: an
  -- admin can open signups a week early, or close them at the start so nobody
  -- joins a tournament halfway through.
  join_open    BOOLEAN NOT NULL DEFAULT TRUE,
  -- Recurring series: when > 0, finalizing this edition schedules the next one
  -- with the same maps, starting repeat_gap_days after this one ends. 0 = a
  -- one-off. The gap is what keeps a series from overlapping itself.
  repeat_every_days INTEGER NOT NULL DEFAULT 0 CHECK (repeat_every_days >= 0),
  repeat_gap_days   INTEGER NOT NULL DEFAULT 1 CHECK (repeat_gap_days >= 0),
  -- Series bookkeeping: editions of one recurring series share a series_key and
  -- number upward, so "Weekly Sprint #7" can find its predecessors.
  series_key   TEXT,
  -- Editions number from 1; a 0 or negative edition would render as
  -- "Weekly Sprint #0" on the calendar and break the successor lookup.
  edition      INTEGER NOT NULL DEFAULT 1 CHECK (edition >= 1),
  finalized_at BIGINT,
  created_at   BIGINT NOT NULL,
  created_by   TEXT,
  updated_at   BIGINT,
  updated_by   TEXT,
  CHECK (ends_at > starts_at)
);
-- The calendar, the overlap check and "what is live right now" all range-scan
-- the window.
CREATE INDEX IF NOT EXISTS idx_tournament_window ON tournament (starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_tournament_series ON tournament (series_key, edition)
  WHERE series_key IS NOT NULL;

-- The map pool. `position` only orders the display/rotation; scoring treats
-- every map equally. Deleting a map from the site cascades the pool entry away
-- rather than leaving a tournament scoring a map that no longer exists.
CREATE TABLE IF NOT EXISTS tournament_map (
  tournament_id BIGINT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  map_id        BIGINT NOT NULL REFERENCES map(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tournament_id, map_id)
);
CREATE INDEX IF NOT EXISTS idx_tmap_map ON tournament_map (map_id);

-- One row per entry. Created UNCLAIMED (player_id NULL) by the website with a
-- fresh `code`, or already-claimed by the in-game "/tournament join".
--
-- `code` is stored uppercase and dash-free; the redeem path normalises before
-- looking up, so "rs9k-4mtb", "RS9K4MTB" and "Rs9k 4mtb" are one code. It stays
-- on the row after redemption so a player can look their own entry up again.
CREATE TABLE IF NOT EXISTS tournament_entrant (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id   BIGINT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  code            TEXT NOT NULL UNIQUE,
  -- Nick typed on the website at signup. Display/diagnostic only — it is NEVER
  -- what binds the entry (that is the redeem), so a typo here costs nothing.
  claimed_name    TEXT,
  -- Canonical player id, set at redeem time. NULL = code minted, not yet used.
  player_id       BIGINT REFERENCES player(id) ON DELETE SET NULL,
  registered_name TEXT,     -- the in-game nick that redeemed it
  server_id       BIGINT,   -- which game server the redeem came from
  created_at      BIGINT NOT NULL,
  registered_at   BIGINT
);
-- One entry per person per tournament. Partial so any number of codes can sit
-- unredeemed side by side.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tentrant_player
  ON tournament_entrant (tournament_id, player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tentrant_tournament ON tournament_entrant (tournament_id);
CREATE INDEX IF NOT EXISTS idx_tentrant_player ON tournament_entrant (player_id)
  WHERE player_id IS NOT NULL;

-- Frozen final standings, written once when a tournament is finalized. Live
-- standings are computed from the finish log on demand; this table is the
-- historical record, so a later alias re-grouping or map deletion cannot
-- rewrite a result that has already been awarded.
CREATE TABLE IF NOT EXISTS tournament_standing (
  tournament_id BIGINT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  player_id     BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  place         INTEGER NOT NULL,
  points        INTEGER NOT NULL DEFAULT 0,
  maps_played   INTEGER NOT NULL DEFAULT 0,
  map_wins      INTEGER NOT NULL DEFAULT 0,
  total_time    BIGINT,           -- ms summed over the player's best times
  -- Did they finish EVERY pool map? Snapshotted rather than re-derived from
  -- maps_played vs the pool size, because the pool can be edited after a
  -- tournament ends and "was this entry complete" is a fact about the moment it
  -- was frozen. Only meaningful for time_sum scoring, where an incomplete entry
  -- is unranked (and never takes a podium trophy).
  complete      BOOLEAN NOT NULL DEFAULT TRUE,
  -- Per-map breakdown at freeze time: [{mapId, map, time, rank, points}, ...]
  detail        JSONB,
  PRIMARY KEY (tournament_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_tstanding_player ON tournament_standing (player_id);

-- Profile trophies. place 1/2/3 = podium, 0 = took part (finished at least one
-- tournament map). The composite PK makes minting IDEMPOTENT, which is what
-- lets the finalizer run on both web replicas and in the daily sweep without
-- ever double-awarding — same contract as player_achievement.
CREATE TABLE IF NOT EXISTS tournament_trophy (
  tournament_id BIGINT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  player_id     BIGINT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  place         INTEGER NOT NULL,
  points        INTEGER NOT NULL DEFAULT 0,
  awarded_at    BIGINT NOT NULL,
  PRIMARY KEY (tournament_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ttrophy_player ON tournament_trophy (player_id, awarded_at DESC);

-- Down Migration
DROP TABLE IF EXISTS tournament_trophy CASCADE;
DROP TABLE IF EXISTS tournament_standing CASCADE;
DROP TABLE IF EXISTS tournament_entrant CASCADE;
DROP TABLE IF EXISTS tournament_map CASCADE;
DROP TABLE IF EXISTS tournament CASCADE;
