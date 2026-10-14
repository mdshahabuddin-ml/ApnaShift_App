-- Migration 021: persisted in-app notifications (customer/driver) + push device tokens.
-- Additive only (IF NOT EXISTS / DO guards). No DROP/TRUNCATE/DELETE.
--
-- notifications: one row per (booking, recipient, type). UNIQUE key doubles as
-- the dedupe guard — replays/retries can never create a duplicate row.
-- device_tokens: FCM/WebPush tokens for Phase-2 push (Phase 1 reads/writes
-- them via API, sending activates once FCM_* secrets are configured).
-- Retention: read notifications older than NOTIF_RETENTION_DAYS are pruned by
-- `npm run notifications:prune`. Unread rows are NEVER pruned.

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq SERIAL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('user', 'driver')),
  recipient_id UUID NOT NULL,
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'booking_created', 'booking_accepted', 'driver_arrived',
    'trip_started', 'trip_completed', 'booking_cancelled',
    'assignment_received'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, recipient_role, recipient_id, type)
);

CREATE INDEX IF NOT EXISTS idx_notif_recipient_time
  ON notifications (recipient_role, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread
  ON notifications (recipient_role, recipient_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_booking
  ON notifications (booking_id);

CREATE TABLE IF NOT EXISTS device_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_role TEXT NOT NULL CHECK (owner_role IN ('user', 'driver')),
  owner_id UUID NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  token TEXT NOT NULL CHECK (char_length(token) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_role, owner_id, token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_owner
  ON device_tokens (owner_role, owner_id);
