-- Migration 017: Cash on Delivery (COD) confirm + mandatory weekly settlement.
-- Run: npm run db:migrate
--
-- Design (existing structures reused, nothing duplicated):
--   - payments rows stay the single money record (immutable split).
--   - COD (payment_method='cash') is now 'pending' at delivery and flips to
--     'collected' ONLY via driver confirm (cash_confirmed_at). UPI/online
--     behavior unchanged. Legacy auto-collected cash rows keep
--     cash_confirmed_at NULL (pre-confirm era) — confirm endpoint only
--     accepts pending rows, so no backfill needed.
--   - settlement_periods = one row per driver per Mon–Sun week (IST).
--     UNIQUE(driver_id, week_start) makes generation idempotent.
--   - settlement_period_items links collected payments into a period;
--     UNIQUE(payment_id) stops double-counting across weeks.
--   - settlements rows (existing admin receipts) gain an optional period
--     link so weekly money stays traceable. PAID/DISPUTED periods are
--     frozen: enforced in code + audit-logged (no silent edits).
--   - Money in paise (BIGINT); statuses DUE/PARTIALLY_PAID/PAID/DISPUTED
--     stored, OVERDUE derived on read (past week + still owed).

-- 1. COD confirm timestamp (NULL = not driver-confirmed / legacy row).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cash_confirmed_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_cash_confirm_ck') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_cash_confirm_ck CHECK (
      cash_confirmed_at IS NULL OR payment_method = 'cash'
    );
  END IF;
END
$$;

-- 2. Weekly settlement periods (Mon–Sun, IST calendar).
CREATE TABLE IF NOT EXISTS settlement_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  gross_paise BIGINT NOT NULL CHECK (gross_paise >= 0),
  commission_paise BIGINT NOT NULL CHECK (commission_paise >= 0),
  earning_paise BIGINT NOT NULL CHECK (earning_paise >= 0),
  settled_paise BIGINT NOT NULL DEFAULT 0 CHECK (settled_paise >= 0),
  status TEXT NOT NULL DEFAULT 'DUE'
    CHECK (status IN ('DUE', 'PARTIALLY_PAID', 'PAID', 'DISPUTED')),
  dispute_reason TEXT CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 3 AND 500),
  created_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlement_periods_week_ck CHECK (
    week_end = week_start + 6
    AND EXTRACT(ISODOW FROM week_start) = 1
  ),
  CONSTRAINT settlement_periods_settled_ck CHECK (settled_paise <= gross_paise),
  CONSTRAINT settlement_periods_unique_ck UNIQUE (driver_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_driver_week
  ON settlement_periods (driver_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_status
  ON settlement_periods (status, week_end DESC);

-- 3. Period <-> payment links (one payment in at most one period).
CREATE TABLE IF NOT EXISTS settlement_period_items (
  period_id UUID NOT NULL REFERENCES settlement_periods (id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  PRIMARY KEY (period_id, payment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_period_items_payment
  ON settlement_period_items (payment_id);
CREATE INDEX IF NOT EXISTS idx_settlement_period_items_period
  ON settlement_period_items (period_id);

-- 4. Link admin settlement receipts to a weekly period (nullable so the
-- legacy global flow keeps working untouched).
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settlement_period_id UUID
  REFERENCES settlement_periods (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_settlements_period
  ON settlements (settlement_period_id);
