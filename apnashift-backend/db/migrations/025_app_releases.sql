-- Migration 025: automated app update notification system (additive).
-- Super-admin app releases: version config (latest / min-supported / mandatory),
-- release notes, update URL, priority, scheduled FCM push + per-recipient
-- delivery log (dedupe by UNIQUE — never double-sends a release notice).
-- "Latest published release" is DERIVED per query (status='published',
-- newest published_at first) — no activation job, archive to retire.
-- Time convention: *_at columns are UTC. Idempotent guards so re-running
-- the runner is safe.

CREATE TABLE IF NOT EXISTS app_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL CHECK (char_length(version) BETWEEN 1 AND 20),
  build INTEGER,
  min_supported_version TEXT,
  mandatory BOOLEAN NOT NULL DEFAULT FALSE,
  audience TEXT NOT NULL DEFAULT 'users' CHECK (audience IN ('all', 'users', 'drivers')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  release_notes TEXT NOT NULL DEFAULT '',
  update_url TEXT CHECK (update_url IS NULL OR char_length(update_url) <= 500),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
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
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (version)
);

CREATE INDEX IF NOT EXISTS ix_app_releases_published
  ON app_releases (status, published_at DESC);
CREATE INDEX IF NOT EXISTS ix_app_releases_push
  ON app_releases (push_status, push_scheduled_at);

CREATE TABLE IF NOT EXISTS app_release_push_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id UUID NOT NULL REFERENCES app_releases (id) ON DELETE CASCADE,
  owner_role TEXT NOT NULL CHECK (owner_role IN ('user', 'driver', 'admin', 'super_admin')),
  owner_id UUID NOT NULL,
  token TEXT NOT NULL CHECK (char_length(token) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (release_id, owner_role, owner_id, token)
);
