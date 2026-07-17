-- Collapse leaderboard identities by NICK instead of by login.
--
-- Background: canonKey() historically keyed a player's identity on the
-- matchmaker `login` when it was non-empty, falling back to the colour-stripped
-- nick (identKey) only for anonymous rows. The auth servers are gone, so every
-- NEW record has an empty login and already groups by nick — but rows recorded
-- during the auth era still carry non-empty logins. A single human who raced
-- anonymously AND under one or more old logins (e.g. "sjn|gibbz") was therefore
-- split into several canonical groups, each surfacing as its own Hall-of-Fame /
-- per-map leaderboard row with an independent points/WR/map total.
--
-- This migration recomputes the DERIVED grouping (player.canonical_id and the
-- `canonical` key table) purely from the nick, matching the new login-agnostic
-- canonKey() in db.js. It is a presentation cleanup, NOT a data change: it
-- deletes no race / time / player rows and leaves player.login untouched, so
-- login-first grouping stays fully reversible (see the Down migration). The
-- refreshAggregates() that runs right after migrations on boot then rebuilds the
-- best/standings/map_index tables from the new grouping, so the merged rows show
-- up immediately.
--
-- The nick key mirrors identKey(simplified): `simplified` is already
-- colour-stripped, so we only lowercase, drop a trailing "(N)" collision suffix,
-- and trim; an empty result maps to the same "?empty?" sentinel canonKey() uses.
-- The representative per group is the row with the most recent race (tie-break
-- highest id) — identical to rebuildCanonical()'s rank() in db.js, so a later
-- admin `rebuild-canonical` produces the same result.

-- Up Migration
-- Session-scoped temp table (explicitly dropped below rather than ON COMMIT
-- DROP) so the grouping survives across the UPDATE/DELETE/INSERT whether the
-- runner wraps the migration in one transaction or autocommits each statement.
DROP TABLE IF EXISTS nick_group;
CREATE TEMP TABLE nick_group AS
  WITH nick AS (
    SELECT p.id,
           COALESCE(
             NULLIF(btrim(regexp_replace(lower(p.simplified), '\s*\(\d+\)\s*$', '')), ''),
             '?empty?'
           ) AS gkey
    FROM player p
  ),
  latest AS (
    SELECT player_id, MAX(id) AS mx FROM race GROUP BY player_id
  ),
  ranked AS (
    SELECT n.id, n.gkey, COALESCE(l.mx, -1) AS mx
    FROM nick n LEFT JOIN latest l ON l.player_id = n.id
  ),
  rep AS (
    SELECT DISTINCT ON (gkey) gkey, id AS rep_id
    FROM ranked
    ORDER BY gkey, mx DESC, id DESC
  )
  SELECT ranked.id, ranked.gkey, rep.rep_id
  FROM ranked JOIN rep ON rep.gkey = ranked.gkey;

UPDATE player p SET canonical_id = ng.rep_id
FROM nick_group ng WHERE p.id = ng.id;

DELETE FROM canonical;
INSERT INTO canonical (key, player_id)
SELECT DISTINCT gkey, rep_id FROM nick_group;

DROP TABLE nick_group;

-- Down Migration
-- Restore login-first grouping: key on the lowercased/trimmed login when it is
-- non-empty, else on the nick key. Pairs with reverting the canonKey() change.
DROP TABLE IF EXISTS login_group;
CREATE TEMP TABLE login_group AS
  WITH keyed AS (
    SELECT p.id,
           CASE
             WHEN btrim(lower(p.login)) <> '' THEN btrim(lower(p.login))
             ELSE COALESCE(
               NULLIF(btrim(regexp_replace(lower(p.simplified), '\s*\(\d+\)\s*$', '')), ''),
               '?empty?'
             )
           END AS gkey
    FROM player p
  ),
  latest AS (
    SELECT player_id, MAX(id) AS mx FROM race GROUP BY player_id
  ),
  ranked AS (
    SELECT k.id, k.gkey, COALESCE(l.mx, -1) AS mx
    FROM keyed k LEFT JOIN latest l ON l.player_id = k.id
  ),
  rep AS (
    SELECT DISTINCT ON (gkey) gkey, id AS rep_id
    FROM ranked
    ORDER BY gkey, mx DESC, id DESC
  )
  SELECT ranked.id, ranked.gkey, rep.rep_id
  FROM ranked JOIN rep ON rep.gkey = ranked.gkey;

UPDATE player p SET canonical_id = lg.rep_id
FROM login_group lg WHERE p.id = lg.id;

DELETE FROM canonical;
INSERT INTO canonical (key, player_id)
SELECT DISTINCT gkey, rep_id FROM login_group;

DROP TABLE login_group;
