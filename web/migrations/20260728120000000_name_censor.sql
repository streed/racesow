-- Player-name censoring. We censor OFFENSIVE NICKS at DISPLAY time only: the
-- original player.name / simplified / trimmed columns are never touched, so all
-- records, history, ghosts and canonical grouping stay exactly as-is. A name is
-- masked (offending letters -> '*') wherever it is shown to a human: website,
-- OG/Discord cards, the Discord announcer feed, and the plain-text topscores /
-- ranks the game servers fetch. Because it is applied on read against the live
-- word list, EXISTING and FUTURE offensive names are handled by the same path —
-- a new bad nick is masked the moment it is first displayed, no backfill needed.
--
-- Two tables:
--   censor_term    the word list. Matching runs on the colour- AND
--                  punctuation-stripped, leet-folded form of a name (see
--                  web/censor.js), so "^1wh|0re", "n1gg3r" and "f u c k" are all
--                  caught. mode='norm' matches anywhere in that aggressive form
--                  (best for slurs); mode='word' matches only as a whole word in
--                  the colour-stripped name (fewer false positives for short
--                  tokens like "cum"/"cock").
--   player_censor  per-player overrides that beat the word list, keyed by the
--                  player row whose name is shown. action='allow' whitelists a
--                  false positive (e.g. "Cock Leo"); action='censor' force-masks
--                  a name the word list missed. Mirrors the map_block pattern.

-- Up Migration
CREATE TABLE IF NOT EXISTS censor_term (
  term      TEXT PRIMARY KEY,                       -- normalised (lowercase, alphanumerics) match string
  mode      TEXT NOT NULL DEFAULT 'norm'            -- 'norm' (substring on stripped form) | 'word' (whole word)
              CHECK (mode IN ('norm', 'word')),
  severity  TEXT NOT NULL DEFAULT 'profanity'       -- slur | hate | sexual | profanity  (informational, for the admin UI)
              CHECK (severity IN ('slur', 'hate', 'sexual', 'profanity')),
  active    BOOLEAN NOT NULL DEFAULT true,
  added_at  BIGINT NOT NULL,
  added_by  TEXT                                    -- admin username or "seed"/"cli"
);

CREATE TABLE IF NOT EXISTS player_censor (
  player_id BIGINT PRIMARY KEY REFERENCES player(id) ON DELETE CASCADE ON UPDATE CASCADE,
  action    TEXT NOT NULL CHECK (action IN ('allow', 'censor')),
  reason    TEXT,
  set_at    BIGINT NOT NULL,
  set_by    TEXT
);

-- Seed the word list. Unambiguous slurs / hate / explicit terms use 'norm' so
-- they cannot be dodged with separators; short, false-positive-prone tokens use
-- 'word'. Admins edit this list at /admin/names. epoch 1753660800 = 2026-07-28.
INSERT INTO censor_term (term, mode, severity, added_at, added_by) VALUES
  ('nigger',     'norm', 'slur',      1753660800, 'seed'),
  ('nigga',      'norm', 'slur',      1753660800, 'seed'),
  ('sandnigger', 'norm', 'slur',      1753660800, 'seed'),
  ('jiggaboo',   'norm', 'slur',      1753660800, 'seed'),
  ('chink',      'norm', 'slur',      1753660800, 'seed'),
  ('kike',       'norm', 'slur',      1753660800, 'seed'),
  ('gook',       'norm', 'slur',      1753660800, 'seed'),
  ('wetback',    'norm', 'slur',      1753660800, 'seed'),
  ('faggot',     'norm', 'slur',      1753660800, 'seed'),
  ('fag',        'norm', 'slur',      1753660800, 'seed'),
  ('tranny',     'norm', 'slur',      1753660800, 'seed'),
  ('retard',     'norm', 'slur',      1753660800, 'seed'),
  ('coon',       'word', 'slur',      1753660800, 'seed'),
  ('spic',       'word', 'slur',      1753660800, 'seed'),
  ('negro',      'word', 'slur',      1753660800, 'seed'),
  ('dyke',       'word', 'slur',      1753660800, 'seed'),
  ('hitler',     'norm', 'hate',      1753660800, 'seed'),
  ('heilhitler', 'norm', 'hate',      1753660800, 'seed'),
  ('whitepower', 'norm', 'hate',      1753660800, 'seed'),
  ('gaschamber', 'norm', 'hate',      1753660800, 'seed'),
  ('1488',       'norm', 'hate',      1753660800, 'seed'),
  ('nazi',       'word', 'hate',      1753660800, 'seed'),
  ('kkk',        'word', 'hate',      1753660800, 'seed'),
  ('cunt',       'norm', 'sexual',    1753660800, 'seed'),
  ('rapist',     'word', 'sexual',    1753660800, 'seed'),   -- 'word' so "the-rapist" stays clean
  ('pedophile',  'norm', 'sexual',    1753660800, 'seed'),
  ('cumshot',    'norm', 'sexual',    1753660800, 'seed'),
  ('blowjob',    'norm', 'sexual',    1753660800, 'seed'),
  ('dildo',      'norm', 'sexual',    1753660800, 'seed'),
  ('pussy',      'word', 'sexual',    1753660800, 'seed'),
  ('rape',       'word', 'sexual',    1753660800, 'seed'),
  ('pedo',       'word', 'sexual',    1753660800, 'seed'),
  ('molest',     'word', 'sexual',    1753660800, 'seed'),
  ('jizz',       'word', 'sexual',    1753660800, 'seed'),
  ('cum',        'word', 'sexual',    1753660800, 'seed'),
  ('penis',      'word', 'sexual',    1753660800, 'seed'),
  ('vagina',     'word', 'sexual',    1753660800, 'seed'),
  ('fuck',       'norm', 'profanity', 1753660800, 'seed'),
  ('shit',       'norm', 'profanity', 1753660800, 'seed'),
  ('bitch',      'norm', 'profanity', 1753660800, 'seed'),
  ('whore',      'norm', 'profanity', 1753660800, 'seed'),
  ('slut',       'word', 'profanity', 1753660800, 'seed'),
  ('cock',       'word', 'profanity', 1753660800, 'seed'),
  ('twat',       'word', 'profanity', 1753660800, 'seed'),
  ('wanker',     'word', 'profanity', 1753660800, 'seed'),
  ('asshole',    'norm', 'profanity', 1753660800, 'seed'),
  ('douche',     'word', 'profanity', 1753660800, 'seed')
ON CONFLICT (term) DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS player_censor CASCADE;
DROP TABLE IF EXISTS censor_term CASCADE;
