-- Migration 014: driver UPI ID, per-vehicle commission, booking snapshot,
-- UPI payment method, dispute flag.
-- Extends the existing payments ledger (013) — no duplicate tables:
--   * drivers.upi_id — driver ka UPI handle (profile/register se).
--   * pricing_rules.commission_percent — per-vehicle rate (default 15).
--   * bookings.commission_percent — creation-time snapshot (rate lock).
--   * bookings.payment_method — 'upi' added, default 'upi' (old 'cash' rows stay valid).
--   * bookings.disputed / dispute_reason — safety-net flag (no auto money change).
-- Run: npm run db:migrate (runs migrations folder in order).

-- 1. Driver UPI ID (nullable; format mirrored in Zod).
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id TEXT;

DO $$
DECLARE
  upi_def TEXT;
BEGIN
  -- NOTE: Zod me spec regex {2,256} hai; Postgres bound cap 255 rakhta hai,
  -- isliye DB backup CHECK {2,255} hai (1-char tighter, practically same).
  SELECT pg_get_constraintdef(oid) INTO upi_def FROM pg_constraint
   WHERE conname = 'drivers_upi_id_ck';
  -- Pehle draft me {2,256} chala gaya tha (Postgres evaluate par fail) — swap karo.
  IF upi_def IS NOT NULL AND upi_def LIKE '%{2,256}%' THEN
    ALTER TABLE drivers DROP CONSTRAINT drivers_upi_id_ck;
    upi_def := NULL;
  END IF;
  IF upi_def IS NULL THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_upi_id_ck CHECK (
      upi_id IS NULL OR upi_id ~ '^[\w.\-]{2,255}@[a-zA-Z]{2,64}$'
    );
  END IF;
END
$$;

-- 2. Per-vehicle commission rate (existing rows get 15 via DEFAULT).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5, 2);

ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_commission_pct_ck') THEN
    ALTER TABLE pricing_rules ADD CONSTRAINT pricing_commission_pct_ck CHECK (
      commission_percent >= 0 AND commission_percent <= 100
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_commission_pct_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_commission_pct_ck CHECK (
      commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)
    );
  END IF;
END
$$;

-- 3. UPI payment method: widen CHECK (keep cash/online valid), default upi.
ALTER TABLE bookings ALTER COLUMN payment_method SET DEFAULT 'upi';

DO $$
DECLARE
  old_ck TEXT;
  old_def TEXT;
BEGIN
  -- Any payment_method CHECK (013's inline-named or auto-named variant).
  SELECT conname, pg_get_constraintdef(oid) INTO old_ck, old_def FROM pg_constraint
   WHERE conrelid = 'bookings'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%payment_method%'
   LIMIT 1;
  -- Drop it when it lacks 'upi' (old cash/online list from 013).
  IF old_ck IS NOT NULL AND old_def NOT LIKE '%upi%' THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', old_ck);
    old_ck := NULL;
  END IF;
  IF old_ck IS NULL THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_ck CHECK (
      payment_method IN ('cash', 'online', 'upi')
    );
  END IF;
END
$$;

-- 4. Dispute flag (driver ya user laga sakta hai; paisa auto-change nahi hota).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS disputed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_dispute_reason_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_dispute_reason_ck CHECK (
      dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 3 AND 500
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_bookings_disputed ON bookings (disputed, created_at DESC);

-- payments table ka apna method CHECK bhi widen karo (bookings default ab upi hai).
DO $$
DECLARE
  old_ck TEXT;
  old_def TEXT;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO old_ck, old_def FROM pg_constraint
   WHERE conrelid = 'payments'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%payment_method%'
   LIMIT 1;
  IF old_ck IS NOT NULL AND old_def NOT LIKE '%upi%' THEN
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', old_ck);
    old_ck := NULL;
  END IF;
  IF old_ck IS NULL THEN
    ALTER TABLE payments ADD CONSTRAINT payments_payment_method_ck CHECK (
      payment_method IN ('cash', 'online', 'upi')
    );
  END IF;
END
$$;
