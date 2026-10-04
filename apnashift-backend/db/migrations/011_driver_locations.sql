-- Migration 011: live driver tracking — location history.
-- One row per driver GPS report during an ACTIVE booking
-- (accepted/arrived/in_transit). Lifecycle gating is enforced in the
-- API layer (see src/services/tracking.js + routes); this table only
-- stores what the API accepts.
-- Run: npm run db:migrate (runs migrations folder in order).
--
-- Privacy/retention: keep only operational points. Prune old rows via:
--   npm run tracking:prune   (deletes rows older than 30 days)
-- No customer phone/address lives here — only booking/driver ids + coords.

CREATE TABLE IF NOT EXISTS driver_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m NUMERIC(8, 2) CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 10000)),
  speed_mps NUMERIC(6, 2) CHECK (speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps <= 100)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest-point-per-booking reads (customer live view, admin actives).
CREATE INDEX IF NOT EXISTS idx_driver_locations_booking_time
  ON driver_locations (booking_id, recorded_at DESC);

-- Per-driver recent reads + prune scans.
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_time
  ON driver_locations (driver_id, recorded_at DESC);

-- Retention prune helper index (range delete on age).
CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded
  ON driver_locations (recorded_at DESC);
