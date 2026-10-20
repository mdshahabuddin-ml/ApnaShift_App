-- 007_app_releases.sql — Automated app update notification system (additive).
-- Super Admin app releases: version config (latest / min-supported / mandatory),
-- release notes, update URL, priority, scheduled FCM push + per-recipient
-- delivery log (dedupe by UNIQUE — never double-sends a release notice).
-- "Latest published release" is DERIVED per query (status='published',
-- newest published_at first) — no activation job, archive to retire.
-- Time convention: *_at columns are UTC. Idempotent guards so re-running
-- the runner is safe. MSSQL-only (AGENTS.md) — no PostgreSQL twin.

IF OBJECT_ID('app_releases', 'U') IS NULL
CREATE TABLE app_releases (
  id                      uniqueidentifier NOT NULL DEFAULT NEWID() PRIMARY KEY,
  version                 nvarchar(20)   NOT NULL,             -- versionName (semver x.y.z)
  build                   int            NULL,                 -- versionCode (informational)
  min_supported_version   nvarchar(20)   NULL,                 -- isse chhoti version -> forced
  mandatory               bit            NOT NULL DEFAULT 0,   -- is release par sab purani -> forced
  audience                nvarchar(20)   NOT NULL DEFAULT 'users',
  priority                nvarchar(10)   NOT NULL DEFAULT 'normal',
  release_notes           nvarchar(MAX)  NOT NULL DEFAULT '',
  update_url              nvarchar(500)  NULL,                 -- https-only Play Store / official APK page
  status                  nvarchar(20)   NOT NULL DEFAULT 'draft',
  push_enabled            bit            NOT NULL DEFAULT 0,
  push_title              nvarchar(200)  NULL,
  push_body               nvarchar(500)  NULL,
  push_scheduled_at       datetime2      NULL,
  push_status             nvarchar(20)   NOT NULL DEFAULT 'none',
  push_sent_at            datetime2      NULL,
  push_total              int            NOT NULL DEFAULT 0,
  push_delivered          int            NOT NULL DEFAULT 0,
  push_failed             int            NOT NULL DEFAULT 0,
  created_by              uniqueidentifier NULL,
  created_at              datetime2      NOT NULL DEFAULT (sysutcdatetime()),
  updated_at              datetime2      NOT NULL DEFAULT (sysutcdatetime()),
  published_at            datetime2      NULL,
  CONSTRAINT uq_app_releases_version UNIQUE (version),
  CONSTRAINT ck_app_releases_status CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT ck_app_releases_priority CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT ck_app_releases_audience CHECK (audience IN ('all', 'users', 'drivers')),
  CONSTRAINT ck_app_releases_push_status CHECK (push_status IN ('none', 'scheduled', 'sending', 'sent', 'partial', 'failed'))
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_app_releases_published'
               AND object_id = OBJECT_ID('app_releases'))
CREATE INDEX ix_app_releases_published ON app_releases (status, published_at DESC);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_app_releases_push'
               AND object_id = OBJECT_ID('app_releases'))
CREATE INDEX ix_app_releases_push ON app_releases (push_status, push_scheduled_at);

IF OBJECT_ID('app_release_push_log', 'U') IS NULL
CREATE TABLE app_release_push_log (
  id           uniqueidentifier NOT NULL DEFAULT NEWID() PRIMARY KEY,
  release_id   uniqueidentifier NOT NULL REFERENCES app_releases(id) ON DELETE CASCADE,
  owner_role   nvarchar(20) NOT NULL,
  owner_id     uniqueidentifier NOT NULL,
  token        nvarchar(512) NOT NULL,
  status       nvarchar(20) NOT NULL,
  error        nvarchar(200) NULL,
  sent_at      datetime2 NOT NULL DEFAULT (sysutcdatetime()),
  CONSTRAINT release_push_log_dedupe UNIQUE (release_id, owner_role, owner_id, token)
);
