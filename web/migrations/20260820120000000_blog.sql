-- Short-form site updates ("what's new") — new map batches, feature launches,
-- server changes. Written by an admin at /admin/blog, read publicly at /blog,
-- /api/blog and the /blog.xml feed.
--
-- Design notes:
--   * `slug` is the public identity, not the id: post URLs are shared and
--     indexed, so they must survive a re-title. The admin form derives it from
--     the title once, on create, and then leaves it alone.
--   * `published_at` doubles as the draft flag (NULL = draft, never served
--     publicly) AND as the display/sort date, so a post can be backdated to
--     when the change actually shipped rather than when it was written up.
--     Sorting is (published_at DESC, id DESC) so same-day posts stay stable.
--   * `body` is stored as the author typed it (markdown-lite, see web/blog.js)
--     and rendered on read. Storing the source, not the HTML, keeps the
--     renderer's escaping rules a runtime decision — a tightened sanitizer
--     applies to old posts too, instead of leaving pre-rendered HTML behind.
--   * `summary` is optional; the API falls back to an excerpt derived from the
--     body, so a post never has an empty teaser in the list, OG card or feed.

-- Up Migration
CREATE TABLE IF NOT EXISTS blog_post (
  id           SERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  tag          TEXT NOT NULL DEFAULT 'update',
  published_at BIGINT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  author       TEXT
);

-- The public list/feed query: published posts, newest first. Partial index so
-- drafts (the NULLs) stay out of it entirely.
CREATE INDEX IF NOT EXISTS blog_post_published_idx
  ON blog_post (published_at DESC, id DESC)
  WHERE published_at IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS blog_post_published_idx;
DROP TABLE IF EXISTS blog_post;
