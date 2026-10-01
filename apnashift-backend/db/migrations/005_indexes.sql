-- Migration 005: composite indexes for common queries.
-- Run: npm run db:migrate
--
--   bookings(status, vehicle_type, created_at) — driver available list.
--   bookings(user_id, created_at DESC)        — user list (with ORDER BY).
--   bookings(driver_id, created_at DESC)      — driver history (with ORDER BY).
-- Single-column indexes remain (useful for count/filter).

CREATE INDEX IF NOT EXISTS idx_bookings_available
  ON bookings (status, vehicle_type, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_created
  ON bookings (driver_id, created_at DESC);
