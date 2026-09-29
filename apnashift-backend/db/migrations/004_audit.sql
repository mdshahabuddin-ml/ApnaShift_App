-- Migration 004: admin tools (audit log, pricing history, driver rejection).
-- Note: file db/migrations/004_audit.sql hai — 003 ratings le chuka hai aur
-- runner db/migrations/*.sql ko order me chalata hai (db/003_audit.sql nahi).
-- Chalao: npm run db:migrate
--
-- Naya:
--   audit_logs      — kaunse admin ne kya kiya, kab (verify/reject/assign/pricing).
--   pricing_history — rate badalne par purana + naya, kisne badla.
--   drivers.rejection_reason — reject par wajah (verify par NULL).
-- Auto-ban kahin nahi.

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_history (
  id SERIAL PRIMARY KEY,
  vehicle_type TEXT NOT NULL,
  old_base_rs NUMERIC(10, 2),
  old_per_km_rs NUMERIC(10, 2),
  old_helper_rs NUMERIC(10, 2),
  new_base_rs NUMERIC(10, 2) NOT NULL,
  new_per_km_rs NUMERIC(10, 2) NOT NULL,
  new_helper_rs NUMERIC(10, 2) NOT NULL,
  changed_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_hist_vehicle ON pricing_history (vehicle_type);

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
