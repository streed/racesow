-- Seed the starter achievement set. Each rule must be a valid instance of a
-- kind in web/achievements.js RULE_KINDS (the admin form's validateDefinition
-- is bypassed here, so test/achievements.test.js machine-checks every seeded
-- row: kind exists, qualify SQL executes). ON CONFLICT DO NOTHING keeps this
-- idempotent and lets an admin freely edit/rename after seeding.
--
-- ACTIVE vs INACTIVE split: kinds backed by long-standing data (run_tally,
-- finish log since 2026-07-22, standings) ship active — the evaluator awards
-- retroactively on its next full pass. Kinds backed by the metrics that only
-- began flowing on 2026-07-31 (strafe quality's recalibrated 600-ups sampler,
-- distance, strafes, max speed) ship INACTIVE with provisional thresholds:
-- activate them from /admin/achievements once a few days of data show whether
-- the numbers are sane (the preview page is the tuning tool).
--
-- Standings-based kinds (skill_rating / world_records / podiums / points) all
-- take their threshold as "min" — that is the catalog's param key for the
-- whole standingsKind family, not a typo.

-- Up Migration
INSERT INTO achievement (slug, title, description, tier, rule, time_window, repeatable, hidden, active, created_at, created_by) VALUES

-- ---- Bronze: getting started (active) -------------------------------------
('first-steps', 'First Steps', 'Finish your first race.',
 'bronze', '{"kind":"finishes","count":1}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('off-and-running', 'Off and Running', 'Finish 10 races.',
 'bronze', '{"kind":"finishes","count":10}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('map-curious', 'Map Curious', 'Finish 5 different maps.',
 'bronze', '{"kind":"distinct_maps_finished","count":5,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('explorer', 'Explorer', 'Finish 25 different maps.',
 'bronze', '{"kind":"distinct_maps_finished","count":25,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('persistent', 'Persistent', 'Start 100 races.',
 'bronze', '{"kind":"attempts","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('never-say-die', 'Never Say Die', 'Restart 100 runs — /kill is a lifestyle.',
 'bronze', '{"kind":"movement_total","metric":"restarts","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('warming-up', 'Warming Up', 'Finish runs on 3 days in a row.',
 'bronze', '{"kind":"play_streak","days":3}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('regular', 'Regular', 'Race on 7 different days within 30 days.',
 'bronze', '{"kind":"dedication","days":7}', 'rolling30', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('top-ten-material', 'Top Ten Material', 'Hold a top-10 time on any map.',
 'bronze', '{"kind":"map_rank","maxRank":10}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Silver: putting in the work (active) ---------------------------------
('century-club', 'Century Club', 'Finish 100 races.',
 'silver', '{"kind":"finishes","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('atlas', 'Atlas', 'Finish 100 different maps.',
 'silver', '{"kind":"distinct_maps_finished","count":100,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('novelty-seeker', 'Novelty Seeker', 'Finish 25 maps you had never finished before, within one calendar month.',
 'silver', '{"kind":"distinct_maps_finished","count":25,"newOnly":true}', 'month', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('grinder', 'Grinder', 'Start 1,000 races.',
 'silver', '{"kind":"attempts","count":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('on-the-podium', 'On the Podium', 'Hold a top-3 time on any map.',
 'silver', '{"kind":"podiums","min":1}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('wall-hugger', 'Wall Hugger', 'Land 1,000 wall jumps in races.',
 'silver', '{"kind":"movement_total","metric":"wall_jumps","count":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('dash-addict', 'Dash Addict', 'Dash 1,000 times in races.',
 'silver', '{"kind":"movement_total","metric":"dashes","count":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('seven-day-streak', 'Seven-Day Streak', 'Finish runs on 7 days in a row.',
 'silver', '{"kind":"play_streak","days":7}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('proven-racer', 'Proven Racer', 'Reach a Skill Rating of 500.',
 'silver', '{"kind":"skill_rating","min":500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('point-collector', 'Point Collector', 'Collect 1,000 points.',
 'silver', '{"kind":"points","min":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('big-day-out', 'Big Day Out', 'Finish 25 runs in a single day (UTC).',
 'silver', '{"kind":"finishes","count":25}', 'day', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Gold: serious dedication (active) ------------------------------------
('cartographer', 'Cartographer', 'Finish 100 maps you had never finished before, within one calendar month.',
 'gold', '{"kind":"distinct_maps_finished","count":100,"newOnly":true}', 'month', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('millennium-club', 'Millennium Club', 'Finish 1,000 races.',
 'gold', '{"kind":"finishes","count":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('world-record-holder', 'World Record Holder', 'Hold a world record.',
 'gold', '{"kind":"world_records","min":1}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('podium-regular', 'Podium Regular', 'Hold 25 top-3 times at once.',
 'gold', '{"kind":"podiums","min":25}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('elite', 'Elite', 'Reach a Skill Rating of 750.',
 'gold', '{"kind":"skill_rating","min":750}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('point-hoarder', 'Point Hoarder', 'Collect 10,000 points.',
 'gold', '{"kind":"points","min":10000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('marathon-month', 'Marathon Month', 'Race on 20 different days in one calendar month.',
 'gold', '{"kind":"dedication","days":20}', 'month', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('globetrotter', 'Globetrotter', 'Finish 250 different maps.',
 'gold', '{"kind":"distinct_maps_finished","count":250,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Legend: the long haul (active) ---------------------------------------
('record-machine', 'Record Machine', 'Hold 10 world records at once.',
 'legend', '{"kind":"world_records","min":10}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('master-class', 'Master Class', 'Reach a Skill Rating of 950.',
 'legend', '{"kind":"skill_rating","min":950}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('iron-streak', 'Iron Streak', 'Finish runs on 30 days in a row.',
 'legend', '{"kind":"play_streak","days":30}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('five-thousand-club', 'Five Thousand Club', 'Finish 5,000 races.',
 'legend', '{"kind":"finishes","count":5000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('completionist', 'Completionist', 'Finish 500 different maps.',
 'legend', '{"kind":"distinct_maps_finished","count":500,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- New-metric achievements (activated 2026-08-01 after a day of data) -----
-- Shipped INACTIVE on 2026-07-31, then previewed against live data and
-- activated. The strafe pair was RETUNED first: the 600-ups recalibrated
-- sampler only samples genuine high-speed strafing, so run quality averages
-- ~78% on the new scale (~25% on the old) — the original 50%-run/40%-avg cuts
-- would have been participation badges. 90% single-run had exactly 1 holder
-- at activation; 80% avg sits above the field's median run.
('near-perfect', 'Near Perfect', 'Finish a run at 90% strafe quality.',
 'gold', '{"kind":"strafe_quality_run","minPct":90}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('smooth-operator', 'Smooth Operator', 'Average 80% strafe quality across 50 runs in 30 days.',
 'gold', '{"kind":"strafe_quality_avg","minPct":80,"minRuns":50}', 'rolling30', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('need-for-speed', 'Need for Speed', 'Hit 2,000 ups in a finished run.',
 'silver', '{"kind":"max_speed_run","minUps":2000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('ludicrous-speed', 'Ludicrous Speed', 'Hit 3,000 ups in a finished run.',
 'legend', '{"kind":"max_speed_run","minUps":3000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('road-trip', 'Road Trip', 'Travel 10 million units in races.',
 'silver', '{"kind":"movement_total","metric":"distance","count":10000000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('the-long-haul', 'The Long Haul', 'Travel 100 million units in races.',
 'gold', '{"kind":"movement_total","metric":"distance","count":100000000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('around-the-world', 'Around the World', 'Travel 1 billion units in races.',
 'legend', '{"kind":"movement_total","metric":"distance","count":1000000000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('strafe-machine', 'Strafe Machine', 'Rack up 10,000 counted strafes in races.',
 'silver', '{"kind":"movement_total","metric":"strafes","count":10000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Hidden (active) — revealed only when earned ---------------------------
('jumping-the-gun', 'Jumping the Gun', 'Get caught prejumping 100 times. We see you.',
 'bronze', '{"kind":"movement_total","metric":"prejump_failures","count":100}', 'lifetime', FALSE, TRUE, TRUE, extract(epoch from now())::bigint, 'seed')

ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM player_achievement WHERE achievement_id IN (SELECT id FROM achievement WHERE created_by = 'seed');
DELETE FROM achievement WHERE created_by = 'seed';
