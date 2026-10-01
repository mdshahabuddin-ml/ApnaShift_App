-- Migration 002: bookings flow (for user + driver endpoints).
-- Table names stay SAME (users, drivers, bookings...). Only in bookings:
--   1. New columns: pickup/drop lat-lng + item_description.
--   2. Status machine: pending -> accepted -> arrived -> in_transit -> delivered
--      (+ cancelled). Old set (requested/in_progress/completed) will be mapped.
-- Run: npm run db:migrate (runs migrations folder in order).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS drop_lat DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS drop_lng DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS item_description TEXT NOT NULL DEFAULT '';

-- Map old statuses to the new set (fresh MVP has no rows, but safe).
UPDATE bookings SET status = 'pending' WHERE status = 'requested';
UPDATE bookings SET status = 'in_transit' WHERE status = 'in_progress';
UPDATE bookings SET status = 'delivered' WHERE status = 'completed';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (
  status IN ('pending', 'accepted', 'arrived', 'in_transit', 'delivered', 'cancelled')
);
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending';
