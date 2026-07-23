-- Two-tier admin accounts. Adds a role to admin_user so the admin area can
-- distinguish full admins from moderators:
--   * admin     — full access (unchanged: everything in /admin).
--   * moderator — map blocking, flag handling, and server restart only.
-- Every existing account defaults to 'admin', so behaviour is unchanged until a
-- moderator is explicitly created (node admin.js admin-add <u> --role moderator).
-- The CHECK keeps the column to the two known tiers.

-- Up Migration
ALTER TABLE admin_user
  ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('admin', 'moderator'));

-- Down Migration
ALTER TABLE admin_user DROP COLUMN IF EXISTS role;
