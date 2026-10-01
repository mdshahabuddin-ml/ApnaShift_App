-- Migration 007: bookings.delivered_at (delivery timestamp).
-- Note: file is db/migrations/007_delivered_at.sql — 006 already covers idempotency,
-- runner executes db/migrations/*.sql in order. Run: npm run db:migrate
--
-- delivered_at is set only when status='delivered' (see driver status route):
--   in_transit -> delivered sets now(), other transitions untouched (stays NULL).
-- Backfill: for old delivered rows, updated_at (trigger time at delivery)
--   is the closest estimate, else created_at.
-- CHECK invariant: delivered <=> delivered_at NOT NULL (enforced in app + DB).
-- admin stats and driver earnings use delivered_at for completed/revenue
-- (created_at only counts "bookings created").

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- Old delivered rows (pre-migration): backfill timestamps.
UPDATE bookings
SET delivered_at = COALESCE(updated_at, created_at)
WHERE status = 'delivered' AND delivered_at IS NULL;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_delivered_at_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_delivered_at_check CHECK (
  (status = 'delivered' AND delivered_at IS NOT NULL)
  OR (status <> 'delivered' AND delivered_at IS NULL)
);

-- For earnings (driver_id + delivered_at range) and stats (delivered_at range).
CREATE INDEX IF NOT EXISTS idx_bookings_driver_delivered
  ON bookings (driver_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_delivered_at
  ON bookings (delivered_at DESC);
