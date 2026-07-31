-- Admin-defined player achievements.
--
-- `achievement` holds the definitions moderators create in /admin/achievements:
-- a display block (title/description/tier) plus a machine-evaluable rule — a
-- kind from the vetted catalog in web/achievements.js and its params as JSONB
-- (e.g. {"kind":"distinct_maps_finished","count":100,"newOnly":true}). No
-- free-form SQL ever comes from the admin form; the kind selects a prepared,
-- indexed query. Definitions are created INACTIVE so an admin can dry-run
-- ("who would earn this right now?") before switching one on.
--
-- `player_achievement` is the award log. Append-only in spirit: rows survive a
-- definition being edited or deactivated (like sr_history survives formula
-- changes). The composite PK makes awarding IDEMPOTENT — the evaluator runs on
-- both web replicas, after every ingest and in the daily sweep, and INSERT ..
-- ON CONFLICT DO NOTHING can never double-award. `period` is '' for one-shot
-- achievements and the UTC period key ('2026-07' monthly / '2026-07-31' daily)
-- for repeatable ones, so "100 new maps this month" can be earned again next
-- month as a distinct row.
--
-- player_id is the CANONICAL representative id at award time (aliases collapse
-- by nick — see db.js _resolvePlayer). Reads must span the canonical group the
-- way sr_history reads do (player_id IN (SELECT id FROM player WHERE
-- canonical_id = $1)): if the representative later flips, earlier rows stay
-- under the old id.
--
-- Timestamps are epoch SECONDS (house style; matches finish.created_at).

-- Up Migration
CREATE TABLE achievement (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tier        TEXT NOT NULL DEFAULT 'bronze'
              CHECK (tier IN ('bronze','silver','gold','legend')),
  rule        JSONB NOT NULL,
  -- "window" is reserved in Postgres; time_window avoids quoting it everywhere.
  -- 'lifetime' also covers the standings-based "current value" kinds
  -- (skill_rating, world_records, ...) where a time window is meaningless.
  time_window TEXT NOT NULL DEFAULT 'lifetime'
              CHECK (time_window IN ('lifetime','month','day','rolling30')),
  repeatable  BOOLEAN NOT NULL DEFAULT FALSE,
  hidden      BOOLEAN NOT NULL DEFAULT FALSE,
  active      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  BIGINT NOT NULL,
  created_by  TEXT,
  updated_at  BIGINT,
  updated_by  TEXT
);

CREATE TABLE player_achievement (
  achievement_id BIGINT NOT NULL REFERENCES achievement(id),
  player_id      BIGINT NOT NULL REFERENCES player(id),
  period         TEXT NOT NULL DEFAULT '',
  awarded_at     BIGINT NOT NULL,
  -- The specific run that earned an event-scoped award (e.g. the >=50%-strafe
  -- finish). SET NULL rather than blocking if an admin map delete ever prunes
  -- the finish log.
  finish_id      BIGINT REFERENCES finish(id) ON DELETE SET NULL,
  -- Snapshot of the qualifying value ({"value": N}) so the award explains
  -- itself even after the underlying stats move on.
  detail         JSONB,
  PRIMARY KEY (achievement_id, player_id, period)
);
CREATE INDEX idx_pach_player ON player_achievement (player_id, awarded_at DESC);
CREATE INDEX idx_pach_awarded ON player_achievement (awarded_at DESC);

-- Down Migration
DROP TABLE IF EXISTS player_achievement;
DROP TABLE IF EXISTS achievement;
