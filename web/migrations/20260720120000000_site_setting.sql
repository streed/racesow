-- Site-wide key/value settings edited in the admin area. First use: the game
-- servers' message of the day. The gametype polls GET /api/game/motd (~60s,
-- hrace/motd.as) and sets the engine's sv_MOTDString cvar, so an admin edit
-- reaches connecting players without a server restart. Seeded with the message
-- that used to be hardcoded in server/configs/server.cfg so upgrading changes
-- nothing until an admin actually edits it.

-- Up Migration
CREATE TABLE IF NOT EXISTS site_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  updated_by TEXT           -- admin username or "cli"
);

INSERT INTO site_setting (key, value, updated_at, updated_by)
VALUES ('motd', 'Welcome to a Dockerized Warsow race server - go fast!',
        EXTRACT(EPOCH FROM now())::bigint, 'migration')
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS site_setting CASCADE;
