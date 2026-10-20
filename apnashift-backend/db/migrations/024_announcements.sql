-- Migration 024: super-admin announcements + maintenance mode (additive).
-- Display windows, audiences, maintenance-mode flag, scheduled FCM push +
-- per-recipient delivery log (dedupe by UNIQUE). Time convention: all *_at
-- columns are UTC. Status model: draft | published | deactivated — "active
-- right now" is DERIVED (published AND within window) so expiry needs no job.
-- notify_before_minutes (from mssql 006): optional advance-notification lead
-- time; at WRITE time, if push_enabled and NO explicit push_scheduled_at,
-- schedule = start_at - N minutes. Idempotent guards so re-running is safe.

CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical', 'maintenance')),
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'users', 'drivers')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'deactivated')),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  show_banner BOOLEAN NOT NULL DEFAULT TRUE,
  maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
  block_message TEXT CHECK (block_message IS NULL OR char_length(block_message) <= 500),
  push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  push_title TEXT,
  push_body TEXT,
  push_scheduled_at TIMESTAMPTZ,
  push_status TEXT NOT NULL DEFAULT 'none'
    CHECK (push_status IN ('none', 'scheduled', 'sending', 'sent', 'partial', 'failed')),
  push_sent_at TIMESTAMPTZ,
  push_total INTEGER NOT NULL DEFAULT 0,
  push_delivered INTEGER NOT NULL DEFAULT 0,
  push_failed INTEGER NOT NULL DEFAULT 0,
  notify_before_minutes INTEGER CHECK (notify_before_minutes IS NULL OR (notify_before_minutes >= 0 AND notify_before_minutes <= 10080)),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_announcements_active
  ON announcements (status, start_at, end_at);
CREATE INDEX IF NOT EXISTS ix_announcements_push
  ON announcements (push_status, push_scheduled_at);

CREATE TABLE IF NOT EXISTS announcement_push_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  owner_role TEXT NOT NULL CHECK (owner_role IN ('user', 'driver', 'admin', 'super_admin')),
  owner_id UUID NOT NULL,
  token TEXT NOT NULL CHECK (char_length(token) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, owner_role, owner_id, token)
);
