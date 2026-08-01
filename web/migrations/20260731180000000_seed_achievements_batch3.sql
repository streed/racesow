-- Seed batch 3: accessible map challenges, entry rungs, and gap-fillers.
-- Same contract as the prior seed migrations: every rule is machine-checked by
-- test/achievements.test.js against web/achievements.js RULE_KINDS,
-- created_by='seed', idempotent via ON CONFLICT (slug) DO NOTHING.
--
-- Thresholds verified read-only against production on 2026-07-31:
--   map cuts: aurora-sunday ≤17.8s: 33 · pornstar-dangerzone ≤13.75s: 29
--             lovet-ghost2 ≤13.6s: 12 · gpl-strangeland-strafe ≤19.7s: 16
--   skill rating ≥350: 28.3% (the v3 padded floor parks ~92% above 300, so 350
--   is the lowest rung that means anything); points ≥100: 10.1%
--   12-finish days: done by 12 players in the log's first 9 days
--   forward-accruing: 50 distinct maps/30d (best seen 29 in 9 days), 14-day
--   streak (log too young), prejump 500 (max 142 so far)

-- Up Migration
INSERT INTO achievement (slug, title, description, tier, rule, time_window, repeatable, hidden, active, created_at, created_by) VALUES

-- ---- Signature-map challenges, silver tier (batch 2 skewed gold) ------------
('sunday-driver', 'Sunday Driver', 'Finish aurora-sunday in 17.8 seconds. Leisurely name, not-so-leisurely pace.',
 'silver', '{"kind":"map_time","map":"aurora-sunday","maxMs":17800}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('danger-zone', 'Danger Zone', 'Finish pornstar-dangerzone in 13.75 seconds.',
 'silver', '{"kind":"map_time","map":"pornstar-dangerzone","maxMs":13750}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('ghost-hunter', 'Ghost Hunter', 'Finish lovet-ghost2 in 13.6 seconds — fast enough to scare the ghosts.',
 'gold', '{"kind":"map_time","map":"lovet-ghost2","maxMs":13600}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('stranger-things', 'Stranger Things', 'Finish gpl-strangeland-strafe in 19.7 seconds.',
 'gold', '{"kind":"map_time","map":"gpl-strangeland-strafe","maxMs":19700}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Entry rungs the ladders were missing -----------------------------------
('rising-star', 'Rising Star', 'Reach a Skill Rating of 350.',
 'bronze', '{"kind":"skill_rating","min":350}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('pocket-change', 'Pocket Change', 'Collect your first 100 points.',
 'bronze', '{"kind":"points","min":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('daily-dozen', 'Daily Dozen', 'Finish 12 runs in a single day (UTC).',
 'bronze', '{"kind":"finishes","count":12}', 'day', TRUE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Activity gap-fillers ---------------------------------------------------
('variety-pack', 'Variety Pack', 'Finish 50 different maps within 30 days.',
 'silver', '{"kind":"distinct_maps_finished","count":50,"newOnly":false}', 'rolling30', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('two-week-streak', 'Two Weeks Deep', 'Finish runs on 14 days in a row.',
 'gold', '{"kind":"play_streak","days":14}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Hidden — revealed only when earned -------------------------------------
('glutton-for-punishment', 'Glutton for Punishment', 'Get caught prejumping 500 times. At this point it''s a strategy.',
 'silver', '{"kind":"movement_total","metric":"prejump_failures","count":500}', 'lifetime', FALSE, TRUE, TRUE, extract(epoch from now())::bigint, 'seed')

ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM player_achievement WHERE achievement_id IN (SELECT id FROM achievement WHERE slug IN
  ('sunday-driver','danger-zone','ghost-hunter','stranger-things','rising-star','pocket-change',
   'daily-dozen','variety-pack','two-week-streak','glutton-for-punishment'));
DELETE FROM achievement WHERE slug IN
  ('sunday-driver','danger-zone','ghost-hunter','stranger-things','rising-star','pocket-change',
   'daily-dozen','variety-pack','two-week-streak','glutton-for-punishment');
