-- Migration 002: bookings flow (user + driver endpoints ke liye).
-- Table naam SAME hain (users, drivers, bookings...). Sirf bookings me:
--   1. Naye columns: pickup/drop lat-lng + item_description.
--   2. Status machine: pending -> accepted -> arrived -> in_transit -> delivered
--      (+ cancelled). Purana set (requested/in_progress/completed) map ho jayega.
-- Chalao: npm run db:migrate (migrations folder order me chalta hai).

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS pickup_lng DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS drop_lat DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS drop_lng DOUBLE PRECISION;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS item_description TEXT NOT NULL DEFAULT '';

-- Purane statuses ko naye set me map karo (fresh MVP me rows nahi hongi, par safe).
UPDATE bookings SET status = 'pending' WHERE status = 'requested';
UPDATE bookings SET status = 'in_transit' WHERE status = 'in_progress';
UPDATE bookings SET status = 'delivered' WHERE status = 'completed';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (
  status IN ('pending', 'accepted', 'arrived', 'in_transit', 'delivered', 'cancelled')
);
ALTER TABLE bookings ALTER COLUMN status SET DEFAULT 'pending';
