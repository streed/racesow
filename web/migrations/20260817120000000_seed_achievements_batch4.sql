-- Seed batch 4: the map-category ladders, the overall-standings ladder, and
-- the rungs the existing ladders were missing.
--
-- Same contract as the prior seed migrations: every rule is machine-checked by
-- test/achievements.test.js against web/achievements.js RULE_KINDS,
-- created_by='seed', idempotent via ON CONFLICT (slug) DO NOTHING.
--
-- This batch is the first to use four rule kinds added alongside it:
-- map_category_finished (map_weapon: strafe / slick / weapon / per-weapon),
-- global_rank (standings.rank), start_speed_run (finish.start_speed) and
-- pb_attempts (race.attempts). The first two read history-complete tables and
-- award immediately; the last two read columns only written since the
-- 2026-07-31 metrics update, so they start thin and accrue.
--
-- Holder counts below are not estimates: each one is COUNT(*) over this
-- definition's own qualifyQuery(), generated from web/achievements.js and run
-- read-only against production on 2026-08-17 (12,009 players, 9,208 ranked).
-- Category counts come from `best`, so they include pre-finish-log history.
--   strafe   25:723  100:287  250:133  750:30        (max 2,161)
--   slick     5:635   25:179   75:52   150:13        (max 329)
--   weapon   10:756   50:281  150:106               (max 1,278)
--   rl 50:216 · pg 50:186
--   overall rank is dense, so top-100/top-10/#1 hold exactly 100/10/1
--   strafe quality (post-recal runs only): 65%:30 · 78%:22 · 95%:2
--   max speed 1000ups:36 · start speed 700:9 · 1100:4
--   PB within 1 attempt:10 · within 5:20  (only 50 players have any
--     attempts-to-PB recorded yet — it is captured only as a PB is set)
--   wall jumps 100:41 · 5000:4 · dashes 100:23 · 2500:2  (metrics are ~2.5
--     weeks old; these accrue)
--   distinct maps 1000:40
--   map cuts: bronze 22-32 holders, silver 12-18, gold 4-9 — in line with the
--     batch-2 golds (6-16). coldrun and the-strafe are EXCLUDED: both carry a
--     corrupt "WR" (16ms / 1.568s) that makes any cut on them meaningless.

-- AFTER DEPLOY: these ship active, and a migration-seeded active definition
-- does NOT trigger the retroactive pass that flipping one active in /admin
-- does — it would otherwise sit unawarded until the next UTC daily sweep. Run
-- one pass by hand to grant the 4,130 backlogged awards these 40 rules imply:
--   docker compose exec -T web node --input-type=module -e "import { openDatabase } \
--     from './db.js'; const db = await openDatabase(process.env.DATABASE_URL); \
--     await db.evaluateAchievements(null); process.exit(0);" </dev/null

-- Up Migration
INSERT INTO achievement (slug, title, description, tier, rule, time_window, repeatable, hidden, active, created_at, created_by) VALUES

-- ---- Strafe-map ladder -------------------------------------------------------
('strafe-starter', 'Strafe Starter', 'Finish 25 different strafe maps — no weapons, just movement.',
 'bronze', '{"kind":"map_category_finished","category":"strafe","count":25}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('strafe-specialist', 'Strafe Specialist', 'Finish 100 different strafe maps.',
 'silver', '{"kind":"map_category_finished","category":"strafe","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('strafe-devotee', 'Strafe Devotee', 'Finish 250 different strafe maps.',
 'gold', '{"kind":"map_category_finished","category":"strafe","count":250}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('strafe-purist', 'Strafe Purist', 'Finish 750 different strafe maps. Weapons are for other people.',
 'legend', '{"kind":"map_category_finished","category":"strafe","count":750}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Slick/ice ladder --------------------------------------------------------
('ice-breaker', 'Ice Breaker', 'Finish 5 different slick maps. Friction is optional.',
 'bronze', '{"kind":"map_category_finished","category":"slick","count":5}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('slip-n-slide', 'Slip ''n'' Slide', 'Finish 25 different slick maps.',
 'silver', '{"kind":"map_category_finished","category":"slick","count":25}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('ice-road-trucker', 'Ice Road Trucker', 'Finish 75 different slick maps.',
 'gold', '{"kind":"map_category_finished","category":"slick","count":75}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('frictionless', 'Frictionless', 'Finish 150 different slick maps. At this point you just live there.',
 'legend', '{"kind":"map_category_finished","category":"slick","count":150}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Weapon-map ladder -------------------------------------------------------
('armed-and-dangerous', 'Armed and Dangerous', 'Finish 10 different maps that carry weapons.',
 'bronze', '{"kind":"map_category_finished","category":"weapon","count":10}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('gun-show', 'Gun Show', 'Finish 50 different weapon maps.',
 'silver', '{"kind":"map_category_finished","category":"weapon","count":50}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('arsenal', 'Arsenal', 'Finish 150 different weapon maps.',
 'gold', '{"kind":"map_category_finished","category":"weapon","count":150}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('rocket-man', 'Rocket Man', 'Finish 50 different maps carrying a rocket launcher.',
 'silver', '{"kind":"map_category_finished","category":"w:rl","count":50}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('plasma-drifter', 'Plasma Drifter', 'Finish 50 different maps carrying a plasmagun.',
 'silver', '{"kind":"map_category_finished","category":"w:pg","count":50}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Overall standings ladder (per-map rank was the only rank rule) ----------
('top-one-hundred', 'Top One Hundred', 'Reach the top 100 of the overall rankings.',
 'silver', '{"kind":"global_rank","maxRank":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('top-ten-overall', 'Top Ten Overall', 'Reach the top 10 of the overall rankings.',
 'gold', '{"kind":"global_rank","maxRank":10}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('number-one', 'Number One', 'Stand at the very top of the overall rankings.',
 'legend', '{"kind":"global_rank","maxRank":1}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Strafe quality: the ladder only had a 90% gold --------------------------
('clean-lines', 'Clean Lines', 'Finish a run at 65% strafe quality.',
 'bronze', '{"kind":"strafe_quality_run","minPct":65}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('smooth-mover', 'Smooth Mover', 'Finish a run at 78% strafe quality.',
 'silver', '{"kind":"strafe_quality_run","minPct":78}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('perfect-form', 'Perfect Form', 'Finish a run at 95% strafe quality. Very nearly the theoretical line.',
 'legend', '{"kind":"strafe_quality_run","minPct":95}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Speed: an entry rung, and the launch-speed metric nothing used ----------
('breaking-away', 'Breaking Away', 'Hit 1000 ups in a run.',
 'bronze', '{"kind":"max_speed_run","minUps":1000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('flying-start', 'Flying Start', 'Cross the start line at 700 ups.',
 'silver', '{"kind":"start_speed_run","minUps":700}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('slingshot', 'Slingshot', 'Cross the start line at 1100 ups.',
 'gold', '{"kind":"start_speed_run","minUps":1100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Tries-to-PB -------------------------------------------------------------
('first-try', 'First Try', 'Set a personal best on your very first run of a map.',
 'gold', '{"kind":"pb_attempts","maxAttempts":1}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('quick-study', 'Quick Study', 'Set a personal best within 5 tries of a map.',
 'silver', '{"kind":"pb_attempts","maxAttempts":5}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Movement counters: entry + top rungs ------------------------------------
('wall-tapper', 'Wall Tapper', 'Wall jump 100 times.',
 'bronze', '{"kind":"movement_total","metric":"wall_jumps","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('wall-master', 'Wall Master', 'Wall jump 5,000 times.',
 'gold', '{"kind":"movement_total","metric":"wall_jumps","count":5000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('dash-dabbler', 'Dash Dabbler', 'Dash 100 times.',
 'bronze', '{"kind":"movement_total","metric":"dashes","count":100}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('dash-master', 'Dash Master', 'Dash 2,500 times.',
 'gold', '{"kind":"movement_total","metric":"dashes","count":2500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- The catalogue rung above Completionist ---------------------------------
('grand-tour', 'Grand Tour', 'Finish 1,000 different maps.',
 'legend', '{"kind":"distinct_maps_finished","count":1000,"newOnly":false}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),

-- ---- Signature-map challenges (batch 2 skewed gold; this spreads the tiers) --
('friday-feeling', 'Friday Feeling', 'Finish aurora-friday in 17 seconds.',
 'silver', '{"kind":"map_time","map":"aurora-friday","maxMs":17000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('second-wind', 'Second Wind', 'Finish aurora-speed2 in 19.5 seconds.',
 'silver', '{"kind":"map_time","map":"aurora-speed2","maxMs":19500}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('avp-ace', 'AVP Ace', 'Finish bardok-avp in 13.35 seconds.',
 'silver', '{"kind":"map_time","map":"bardok-avp","maxMs":13350}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('recapture-the-flag', 'Recapture', 'Finish zeel-recapture in 25.6 seconds.',
 'silver', '{"kind":"map_time","map":"zeel-recapture","maxMs":25600}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('dini-dash', 'Dini Dash', 'Finish dinirun4 in 15.05 seconds.',
 'silver', '{"kind":"map_time","map":"dinirun4","maxMs":15050}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('killua-instinct', 'Killer Instinct', 'Finish killua-pornstar in 13 seconds.',
 'gold', '{"kind":"map_time","map":"killua-pornstar","maxMs":13000}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('lambda-slide', 'Lambda Slide', 'Finish pornstar-lamba-slick in 16.7 seconds — on ice.',
 'gold', '{"kind":"map_time","map":"pornstar-lamba-slick","maxMs":16700}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('scratchy-two', 'Scratchy Two', 'Finish scratchystrafe2 in 8.62 seconds.',
 'gold', '{"kind":"map_time","map":"scratchystrafe2","maxMs":8620}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('long-road-home', 'Long Road Home', 'Finish pornstar-redemption-long in 21.4 seconds.',
 'bronze', '{"kind":"map_time","map":"pornstar-redemption-long","maxMs":21400}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('four-and-counting', 'Four and Counting', 'Finish 4and in 18.67 seconds.',
 'bronze', '{"kind":"map_time","map":"4and","maxMs":18670}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed'),
('diebaso-dash', 'Diebaso Dash', 'Finish pornstar-diebaso in 17.15 seconds.',
 'bronze', '{"kind":"map_time","map":"pornstar-diebaso","maxMs":17150}', 'lifetime', FALSE, FALSE, TRUE, extract(epoch from now())::bigint, 'seed')

ON CONFLICT (slug) DO NOTHING;

-- Down Migration
DELETE FROM player_achievement WHERE achievement_id IN (SELECT id FROM achievement WHERE slug IN
  ('strafe-starter','strafe-specialist','strafe-devotee','strafe-purist',
   'ice-breaker','slip-n-slide','ice-road-trucker','frictionless',
   'armed-and-dangerous','gun-show','arsenal','rocket-man','plasma-drifter',
   'top-one-hundred','top-ten-overall','number-one',
   'clean-lines','smooth-mover','perfect-form',
   'breaking-away','flying-start','slingshot',
   'first-try','quick-study',
   'wall-tapper','wall-master','dash-dabbler','dash-master','grand-tour',
   'friday-feeling','second-wind','avp-ace','recapture-the-flag','dini-dash',
   'killua-instinct','lambda-slide','scratchy-two','long-road-home',
   'four-and-counting','diebaso-dash'));
DELETE FROM achievement WHERE created_by = 'seed' AND slug IN
  ('strafe-starter','strafe-specialist','strafe-devotee','strafe-purist',
   'ice-breaker','slip-n-slide','ice-road-trucker','frictionless',
   'armed-and-dangerous','gun-show','arsenal','rocket-man','plasma-drifter',
   'top-one-hundred','top-ten-overall','number-one',
   'clean-lines','smooth-mover','perfect-form',
   'breaking-away','flying-start','slingshot',
   'first-try','quick-study',
   'wall-tapper','wall-master','dash-dabbler','dash-master','grand-tour',
   'friday-feeling','second-wind','avp-ace','recapture-the-flag','dini-dash',
   'killua-instinct','lambda-slide','scratchy-two','long-road-home',
   'four-and-counting','diebaso-dash');
