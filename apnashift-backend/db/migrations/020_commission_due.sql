-- Migration 020: drivers.commission_due stored due (denormalized fast path).
-- Derived outstanding (payments + adjustments - FIFO allocated) stays the
-- source of truth for the accept gate; this column is maintained in the SAME
-- transactions that mint payments (delivery) and record settlements, so the
-- two cannot drift apart mid-flight. New endpoints read this column.
-- Run: npm run db:migrate (runs migrations folder in order).

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS commission_due NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_commission_due_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_commission_due_ck CHECK (commission_due >= 0);
  END IF;
END
$$;

-- Backfill existing ledgers (same math as driverBalance outstanding).
UPDATE drivers d
SET commission_due = sub.due
FROM (
  SELECT d2.id AS driver_id,
         GREATEST(0,
           COALESCE((SELECT SUM(p.platform_commission) FROM payments p WHERE p.driver_id = d2.id), 0) +
           COALESCE((SELECT SUM(a.commission_delta_paise)
                       FROM payment_adjustments a
                       JOIN payments p2 ON p2.id = a.payment_id
                      WHERE p2.driver_id = d2.id), 0) / 100.0 -
           COALESCE((SELECT SUM(p.settled_amount) FROM payments p WHERE p.driver_id = d2.id), 0)
         ) AS due
    FROM drivers d2
) sub
WHERE d.id = sub.driver_id;
