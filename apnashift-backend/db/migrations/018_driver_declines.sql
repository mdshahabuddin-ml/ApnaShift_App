-- Migration 018: driver decline records for the pull-based dispatch pool.
-- Run: npm run db:migrate
--
-- Design (append-only, nothing rewritten):
--   - Accept stays exactly as-is (single atomic UPDATE ... WHERE
--     status='pending' — one winner, rest 409 already_accepted).
--   - Decline NEVER touches bookings rows (no assignment, no status flip,
--     no deletes) — the booking stays pending and available to others.
--   - driver_declines only hides the trip from the decliner's own
--     available list. UNIQUE(driver_id, booking_id) makes double-decline
--     a 409 instead of a duplicate row.

CREATE TABLE IF NOT EXISTS driver_declines (
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_id, booking_id)
);
CREATE INDEX IF NOT EXISTS idx_driver_declines_booking
  ON driver_declines (booking_id, created_at DESC);
