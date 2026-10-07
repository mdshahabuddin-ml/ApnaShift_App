-- Migration 019: WhatsApp booking foundation (additive only).
-- Run: npm run db:migrate
--
--   - bookings.booking_source: where the order came from. Existing rows
--     become 'WEB' via the default; CHECK locks the allowed set.
--   - wa_conversations: one row per WhatsApp phone holding the booking
--     dialog state machine (START..BOOKING_CREATED) + collected fields.
--     No booking/user/driver/payment row is ever duplicated by this table.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'WEB';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_source_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_source_ck CHECK (
      booking_source IN ('WEB', 'WHATSAPP', 'ADMIN', 'MOBILE')
    );
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS idx_bookings_source_created
  ON bookings (booking_source, created_at DESC);

CREATE TABLE IF NOT EXISTS wa_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  state TEXT NOT NULL DEFAULT 'START',
  data JSONB NOT NULL DEFAULT '{}',
  booking_id UUID REFERENCES bookings (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_updated
  ON wa_conversations (updated_at DESC);
