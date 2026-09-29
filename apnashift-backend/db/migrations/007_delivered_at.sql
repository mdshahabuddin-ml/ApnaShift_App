-- Migration 007: bookings.delivered_at (kab deliver hua).
-- Note: file db/migrations/007_delivered_at.sql hai — 006 idempotency le chuka hai,
-- runner db/migrations/*.sql ko order me chalata hai. Chalao: npm run db:migrate
--
-- delivered_at sirf status='delivered' par set hota hai (driver status route dekho):
--   in_transit -> delivered par now(), baaki transitions par untouched (NULL rehta hai).
-- Backfill: purani delivered rows me updated_at (delivery ke waqt ka trigger time)
--   sabse kareebi andaza hai, nahi to created_at.
-- CHECK invariant: delivered <=> delivered_at NOT NULL (app + DB dono par pakka).
-- admin stats aur driver earnings completed/revenue ke liye delivered_at use karte hain
-- (created_at sirf "kitni bookings bani" ginti ke liye).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Purani delivered rows (migrate se pehle ki): timestamp lagao.
UPDATE bookings
SET delivered_at = COALESCE(updated_at, created_at)
WHERE status = 'delivered' AND delivered_at IS NULL;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_delivered_at_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_delivered_at_check CHECK (
  (status = 'delivered' AND delivered_at IS NOT NULL)
  OR (status <> 'delivered' AND delivered_at IS NULL)
);

-- earnings (driver_id + delivered_at range) aur stats (delivered_at range) ke liye.
CREATE INDEX IF NOT EXISTS idx_bookings_driver_delivered
  ON bookings (driver_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_delivered_at
  ON bookings (delivered_at DESC);
