-- Rotating in-game announcements, one message per line, stored in the shared
-- site_setting key/value table under key 'announcements'. The game servers poll
-- GET /api/game/announcements (~60s, hrace/announcement.as via the
-- RS_ApiFetchAnnounce native) and broadcast one message every
-- rs_announce_interval seconds (default 600), rotating through the list. An
-- admin edits the list at /admin/announcements and it rotates in live, no
-- server restart. Seeded with three defaults so the rotation has something to
-- broadcast out of the box; messages carry Warsow ^colors verbatim (compose
-- them with the /colors tester on the website).

-- Up Migration
INSERT INTO site_setting (key, value, updated_at, updated_by)
VALUES ('announcements',
        E'^7Head to ^3https://racesow.org^7 to view your times and records\n^7Every run is ranked — see the global leaderboards at ^3racesow.org\n^7Make your own colored name with the tester at ^3racesow.org/colors',
        EXTRACT(EPOCH FROM now())::bigint, 'migration')
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM site_setting WHERE key = 'announcements';
