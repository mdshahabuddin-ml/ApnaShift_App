-- 005_announcements.sql — Maintenance Message & Notification System (additive).
-- Super Admin announcements: display windows, audiences, maintenance-mode
-- flag, scheduled FCM push + per-recipient delivery log (dedupe by UNIQUE).
-- Time convention: all *_at columns are UTC (app/API converts from tz input).
-- Status model: draft | published | deactivated — "active right now" is
-- DERIVED (published AND within window) so expiry needs no background job.
-- Idempotent guards (IF ...) so re-running the runner is safe.

IF OBJECT_ID('announcements', 'U') IS NULL
CREATE TABLE announcements (
  id                uniqueidentifier NOT NULL DEFAULT NEWID() PRIMARY KEY,
  title             nvarchar(200)  NOT NULL,
  body              nvarchar(MAX)  NOT NULL,
  severity          nvarchar(20)   NOT NULL DEFAULT 'info',
  audience          nvarchar(20)   NOT NULL DEFAULT 'all',
  status            nvarchar(20)   NOT NULL DEFAULT 'draft',
  start_at          datetime2      NULL,
  end_at            datetime2      NULL,
  timezone          nvarchar(64)   NOT NULL DEFAULT 'Asia/Kolkata',
  show_banner       bit            NOT NULL DEFAULT 1,
  maintenance_mode  bit            NOT NULL DEFAULT 0,
  block_message     nvarchar(500)  NULL,
  push_enabled      bit            NOT NULL DEFAULT 0,
  push_title        nvarchar(200)  NULL,
  push_body         nvarchar(500)  NULL,
  push_scheduled_at datetime2      NULL,
  push_status       nvarchar(20)   NOT NULL DEFAULT 'none',
  push_sent_at      datetime2      NULL,
  push_total        int            NOT NULL DEFAULT 0,
  push_delivered    int            NOT NULL DEFAULT 0,
  push_failed       int            NOT NULL DEFAULT 0,
  created_by        uniqueidentifier NULL,
  created_at        datetime2      NOT NULL DEFAULT (sysutcdatetime()),
  updated_at        datetime2      NOT NULL DEFAULT (sysutcdatetime()),
  deactivated_at    datetime2      NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_announcements_active'
               AND object_id = OBJECT_ID('announcements'))
CREATE INDEX ix_announcements_active ON announcements (status, start_at, end_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_announcements_push'
               AND object_id = OBJECT_ID('announcements'))
CREATE INDEX ix_announcements_push ON announcements (push_status, push_scheduled_at);

IF OBJECT_ID('announcement_push_log', 'U') IS NULL
CREATE TABLE announcement_push_log (
  id              uniqueidentifier NOT NULL DEFAULT NEWID() PRIMARY KEY,
  announcement_id uniqueidentifier NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  owner_role      nvarchar(20) NOT NULL,
  owner_id        uniqueidentifier NOT NULL,
  token           nvarchar(512) NOT NULL,
  status          nvarchar(20) NOT NULL,
  error           nvarchar(200) NULL,
  sent_at         datetime2 NOT NULL DEFAULT (sysutcdatetime()),
  CONSTRAINT push_log_dedupe UNIQUE (announcement_id, owner_role, owner_id, token)
);
