-- Player-requested generated maps: the job queue and the daily quota.
--
-- A player describes a map on /mapgen; tools/mapgen/worker.py turns it into a
-- compiled, checked .pk3 (see docs/map-generation-design.md). Nobody logs in.
-- Each request is attributed to an IDENTITY, a 128-bit HMAC of the requester's
-- IP and coarse browser profile under a salt that lives only in Redis and is
-- replaced every UTC day (web/mapgen-identity.js, a port of Tastatur's visitor
-- hash). The database never sees an IP, a user-agent, or the salt. Once a day's
-- salt is gone, the identities stored under it cannot be recomputed or linked
-- to anyone.
--
-- mapgen_quota: how many maps each identity has requested today. One row per
--   (day, identity), incremented by a single conditional upsert
--   (... ON CONFLICT DO UPDATE ... WHERE used < limit RETURNING used), which is
--   atomic across both web replicas without a lock: a request that would go
--   over the limit gets no row back. Rows older than yesterday are deleted on
--   the next submission, so the table only ever holds about two days.
--
-- mapgen_budget: the site-wide count per day, claimed in the same transaction.
--   This is the real cost ceiling. The per-identity quota is a courtesy that a
--   new browser or network gets around; this one no requester can.
--
-- mapgen_job: one row per request. `token` is the only handle ever given out.
--   It is random, so job ids cannot be walked to read other people's
--   descriptions. `identity` and `quota_day` are kept only so the requester
--   can list today's jobs and a build failure can refund the quota. They are
--   cleared after two days, together with the quota rows.
--   Status runs queued -> planning -> building -> publishing -> published, or
--   ends in failed. There is no human step: a map that passes every automated
--   check is copied into the shared map store (publishing), and it is
--   published once a game server reports that its map scan loaded it.
--
--   requested_by is set only for a request an admin made from /admin/mapgen:
--   those have no identity or quota day, skip both limits and are never
--   refunded, and the column says who made them.
--
--   llm_usage is what planning the job cost: token counts per API call and a
--   list-price estimate (tools/mapgen/describe.py usage_summary). Written for
--   failed plans too. It is for the operator only; the web never serves it.
--
-- mapgen_seen: which game server has confirmed which published map, and when.
--   Game servers poll /api/game/map-sync every ~30 s (hrace/blockedmaps.as);
--   the reply names the maps they should look for, and the next poll reports
--   the ones their engine's map list now holds.
--
-- mapgen_server: when each game server last polled map-sync. A server that
--   polled in the last few minutes is "active", and a map is on every server
--   once every active server has confirmed it.

-- Up Migration
CREATE TABLE IF NOT EXISTS mapgen_quota (
  day      DATE    NOT NULL,
  identity BYTEA   NOT NULL CHECK (octet_length(identity) = 16),
  used     INTEGER NOT NULL CHECK (used >= 0),
  PRIMARY KEY (day, identity)
);

CREATE TABLE IF NOT EXISTS mapgen_budget (
  day  DATE    PRIMARY KEY,
  used INTEGER NOT NULL CHECK (used >= 0)
);

CREATE TABLE IF NOT EXISTS mapgen_job (
  id          BIGSERIAL PRIMARY KEY,
  token       TEXT    NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}$'),
  description TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'planning', 'building', 'publishing',
                                'published', 'failed')),
  quota_day   DATE,
  identity    BYTEA   CHECK (identity IS NULL OR octet_length(identity) = 16),
  map_name    TEXT,
  spec        JSONB,
  report      JSONB,
  error       TEXT,
  created_at  BIGINT  NOT NULL,
  started_at  BIGINT,
  finished_at BIGINT,
  published_at BIGINT,   -- copied into the map store
  live_at      BIGINT,   -- first game server confirmed it
  llm_usage    JSONB,    -- Claude tokens + list-price estimate for planning it
  requested_by TEXT      -- admin username for an admin request (no quota, no budget)
);

-- The worker claims the oldest queued job with FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS mapgen_job_queued ON mapgen_job (id) WHERE status = 'queued';
-- "My requests today".
CREATE INDEX IF NOT EXISTS mapgen_job_identity ON mapgen_job (quota_day, identity)
  WHERE identity IS NOT NULL;

-- Maps a game server should be asked about: recently copied to the store.
CREATE INDEX IF NOT EXISTS mapgen_job_published ON mapgen_job (published_at)
  WHERE published_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS mapgen_seen (
  job_id      BIGINT NOT NULL REFERENCES mapgen_job (id) ON DELETE CASCADE,
  server_name TEXT   NOT NULL,
  seen_at     BIGINT NOT NULL,
  PRIMARY KEY (job_id, server_name)
);

CREATE TABLE IF NOT EXISTS mapgen_server (
  server_name TEXT   PRIMARY KEY,
  last_sync   BIGINT NOT NULL
);

-- Down Migration
DROP TABLE IF EXISTS mapgen_server CASCADE;
DROP TABLE IF EXISTS mapgen_seen CASCADE;
DROP TABLE IF EXISTS mapgen_job CASCADE;
DROP TABLE IF EXISTS mapgen_budget CASCADE;
DROP TABLE IF EXISTS mapgen_quota CASCADE;
