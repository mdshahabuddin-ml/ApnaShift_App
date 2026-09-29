-- Migration 005: common queries par composite indexes.
-- Chalao: npm run db:migrate
--
--   bookings(status, vehicle_type, created_at) — driver available list.
--   bookings(user_id, created_at DESC)        — user ki list (ORDER BY samet).
--   bookings(driver_id, created_at DESC)      — driver history (ORDER BY samet).
-- Ek-ek column wale purane indexes rehte hain (count/filter me kaam aate hain).

CREATE INDEX IF NOT EXISTS idx_bookings_available
  ON bookings (status, vehicle_type, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_created
  ON bookings (driver_id, created_at DESC);
