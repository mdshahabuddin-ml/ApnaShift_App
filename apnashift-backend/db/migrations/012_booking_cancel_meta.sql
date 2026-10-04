-- Migration 012: customer cancellation metadata on bookings.
-- Cancel itself stays an atomic status flip (pending/accepted -> cancelled);
-- these columns only record WHY/WHO/WHEN. Booking rows are never deleted.
-- cancelled_by is a role string ('user' today; driver/admin flows can reuse
-- the same columns later without a new migration).
-- Run: npm run db:migrate (runs migrations folder in order).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Fixed reason set (API validates the same list via Zod — belt and braces).
-- NULL always allowed (non-cancelled bookings); non-cancelled rows must not
-- carry cancellation metadata.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancel_reason_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_reason_ck CHECK (
      cancel_reason IS NULL OR cancel_reason IN (
        'wrong_pickup', 'wrong_drop', 'wrong_vehicle',
        'changed_plan', 'duplicate', 'driver_issue', 'other'
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancelled_by_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancelled_by_ck CHECK (
      cancelled_by IS NULL OR cancelled_by IN ('user', 'driver', 'admin', 'system')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancel_meta_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_meta_ck CHECK (
      (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL)
      OR (status = 'cancelled')
    );
  END IF;
END
$$;

-- Admin/support lookup: cancelled bookings newest first.
CREATE INDEX IF NOT EXISTS idx_bookings_cancelled_at
  ON bookings (status, cancelled_at DESC);
