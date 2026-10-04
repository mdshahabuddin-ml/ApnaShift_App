-- Migration 013: cash payment ledger, commission, driver settlements.
-- Money is exact: NUMERIC(10,2) columns hold only whole-paise values
-- (backend computes in integer paise — see src/services/money.js).
-- Ledger rules (enforced here + API layer):
--   * one payment per delivered booking (UNIQUE booking_id), never deleted;
--   * payments rows immutable for money fields (gross/commission/earning/rate);
--     corrections go to payment_adjustments (append-only, signed paise deltas);
--   * settlement bookkeeping (settled_amount/status) advances FIFO per driver;
--   * settlements never deleted; reference_no unique when present.
-- Run: npm run db:migrate (runs migrations folder in order).

-- Payment method on the booking (chosen at creation, immutable after).
-- Only 'cash' is creatable today; 'online' is reserved for a future gateway
-- (API rejects it with unsupported_payment_method until then).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_payment_method_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_ck CHECK (
      payment_method IN ('cash', 'online')
    );
  END IF;
END
$$;

-- One financial transaction per delivered booking.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  gross_amount NUMERIC(10, 2) NOT NULL CHECK (gross_amount >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'online')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('collected', 'pending', 'failed', 'refunded')),
  driver_earning NUMERIC(10, 2) NOT NULL CHECK (driver_earning >= 0),
  platform_commission NUMERIC(10, 2) NOT NULL CHECK (platform_commission >= 0),
  commission_pct NUMERIC(5, 2) NOT NULL CHECK (commission_pct >= 0 AND commission_pct <= 100),
  settlement_status TEXT NOT NULL DEFAULT 'owed' CHECK (settlement_status IN ('owed', 'partial', 'settled')),
  settled_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_split_ck CHECK (driver_earning + platform_commission = gross_amount)
  -- NOTE: no settled_amount<=commission CHECK on purpose — a positive
  -- commission adjustment can legitimately raise owed above the snapshot.
  -- Over-settlement is prevented by the FIFO outstanding check in code.
);

CREATE INDEX IF NOT EXISTS idx_payments_driver ON payments (driver_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_settlement ON payments (settlement_status, collected_at DESC);

-- Append-only corrections (never UPDATE/DELETE here — enforced by API design;
-- REVOKE write from app role is out of scope for single-role local Postgres).
CREATE TABLE IF NOT EXISTS payment_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  commission_delta_paise INTEGER NOT NULL,
  earning_delta_paise INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_adjustments_nonzero_ck CHECK (
    commission_delta_paise <> 0 OR earning_delta_paise <> 0
  )
);

CREATE INDEX IF NOT EXISTS idx_payment_adjustments_payment
  ON payment_adjustments (payment_id, created_at ASC);

-- Driver -> platform commission settlements (append-only, never deleted).
CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'upi')),
  reference_no TEXT UNIQUE CHECK (reference_no IS NULL OR char_length(reference_no) BETWEEN 2 AND 100),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlements_driver ON settlements (driver_id, settled_at DESC);

-- Platform settings (key-value). commission = { pct: 15.00 }.
-- Frontend never hard-codes the rate — it always reads GET /api/admin/commission
-- (admin) or server-computed estimates (driver).
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value)
VALUES ('commission', '{"pct": 15.00}')
ON CONFLICT (key) DO NOTHING;

-- Commission change history (who changed what, when) + audit_logs row per change.
CREATE TABLE IF NOT EXISTS commission_history (
  id SERIAL PRIMARY KEY,
  old_pct NUMERIC(5, 2),
  new_pct NUMERIC(5, 2) NOT NULL,
  changed_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
