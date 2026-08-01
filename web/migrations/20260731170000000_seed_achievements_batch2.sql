-- Seed batch 2: signature-map challenges + high-end ladder extensions.
-- Same contract as 20260731160000000_seed_achievements.sql: every rule must be
-- a valid instance of a kind in web/achievements.js RULE_KINDS (machine-checked
-- by test/achievements.test.js), created_by='seed', idempotent via ON CONFLICT.
--
-- Thresholds verified read-only against production on 2026-07-31:
--   map cuts (race = all-time PBs, so these award retroactively):
--     aurora-speed1  168 PB holders — ≤11.5s: 70, ≤11.0s: 44, ≤10.6s: 11
--     scratchystrafe1 ≤8.0s: 6   bull-highway ≤18.5s: 6
--     czsk2007-bardok ≤14.0s: 9  stammer-strafecave ≤31.0s: 7
--     pornstar-slopin ≤27.5s: 9
--   standings high end: points ≥50k: 9, podiums ≥100: 16, WRs ≥50: 7
--   volume: best single day 62 finishes, best month-pace ~650 — the 100/day and
--   500/month goals are forward-accruing, as is restarts ≥10k (max 6,829 in the
--   counter's first 9 days).

-- Up Migration
INSERT INTO achievement (slug, title, description, tier, rule, time_window, repeatable, hidden, active, created_at, created_by) VALUES

-- ---- Signature-map challenges (active — all-time PBs, award retroactively) --
('northern-lights', 'Northern Lights', 'Finish aurora-speed1 in 11.5 seconds. The people''s speed map — everyone starts here.',
 'bronze', '{"kind":"map_time","map":"aurora-speed1","maxMs":11500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('aurora-ace', 'Aurora Ace', 'Finish aurora-speed1 in 11 seconds flat.',
 'silver', '{"kind":"map_time","map":"aurora-speed1","maxMs":11000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('aurora-perfection', 'Aurora Perfection', 'Finish aurora-speed1 in 10.6 seconds — within striking distance of the record.',
 'gold', '{"kind":"map_time","map":"aurora-speed1","maxMs":10600}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('strafe-surgeon', 'Strafe Surgeon', 'Finish scratchystrafe1 in 8 seconds. Pure air control, no excuses.',
 'gold', '{"kind":"map_time","map":"scratchystrafe1","maxMs":8000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('highway-star', 'Highway Star', 'Finish bull-highway in 18.5 seconds.',
 'gold', '{"kind":"map_time","map":"bull-highway","maxMs":18500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('bardok-breaker', 'Bardok Breaker', 'Finish czsk2007-bardok in 14 seconds — route knowledge required.',
 'gold', '{"kind":"map_time","map":"czsk2007-bardok","maxMs":14000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('cave-dweller', 'Cave Dweller', 'Finish stammer-strafecave in 31 seconds.',
 'gold', '{"kind":"map_time","map":"stammer-strafecave","maxMs":31000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('slopin-smooth', 'Slopin'' Smooth', 'Finish pornstar-slopin in 27.5 seconds without touching the brakes.',
 'gold', '{"kind":"map_time","map":"pornstar-slopin","maxMs":27500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Standings high end (active — legend rungs above the batch-1 ladder) ----
('point-tycoon', 'Point Tycoon', 'Collect 50,000 points.',
 'legend', '{"kind":"points","min":50000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('podium-powerhouse', 'Podium Powerhouse', 'Hold 100 top-3 times at once.',
 'legend', '{"kind":"podiums","min":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('record-empire', 'Record Empire', 'Hold 50 world records at once.',
 'legend', '{"kind":"world_records","min":50}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Volume goals (active — forward-accruing stretch targets) ---------------
('century-day', 'Century Day', 'Finish 100 runs in a single day (UTC).',
 'gold', '{"kind":"finishes","count":100}', 'day', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('monthly-machine', 'Monthly Machine', 'Finish 500 runs in one calendar month.',
 'gold', '{"kind":"finishes","count":500}', 'month', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('unbreakable', 'Unbreakable', 'Restart 10,000 runs. The run isn''t over until it''s perfect.',
 'gold', '{"kind":"movement_total","metric":"restarts","count":10000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed')

ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM player_achievement WHERE achievement_id IN (SELECT id FROM achievement WHERE slug IN
  ('northern-lights','aurora-ace','aurora-perfection','strafe-surgeon','highway-star','bardok-breaker',
   'cave-dweller','slopin-smooth','point-tycoon','podium-powerhouse','record-empire','century-day',
   'monthly-machine','unbreakable'));
DELETE FROM achievement WHERE slug IN
  ('northern-lights','aurora-ace','aurora-perfection','strafe-surgeon','highway-star','bardok-breaker',
   'cave-dweller','slopin-smooth','point-tycoon','podium-powerhouse','record-empire','century-day',
   'monthly-machine','unbreakable');
