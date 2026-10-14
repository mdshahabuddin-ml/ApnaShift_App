-- 022: admin role tiers (admin < super_admin).
-- Additive only: existing rows default to 'admin', behavior unchanged.
-- Fresh installs get the same column from db/schema.sql (admins block).
-- Rollback (test/dev only): ALTER TABLE admins DROP COLUMN role;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'super_admin'));
CREATE INDEX IF NOT EXISTS idx_admins_role ON admins (role);
