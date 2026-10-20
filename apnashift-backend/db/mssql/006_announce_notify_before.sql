-- 006_announce_notify_before.sql — advance-notification lead time (additive).
-- notify_before_minutes: optional int (0..10080). Semantics: at WRITE time,
-- if push_enabled and NO explicit push_scheduled_at, schedule =
-- start_at - N minutes (resolved by src/routes/announcements.js helper
-- resolvePushScheduledAt). Dispatcher/ticker unchanged (still uses
-- push_scheduled_at <= now). Idempotent guard so re-running is safe.

IF COL_LENGTH('announcements', 'notify_before_minutes') IS NULL
  ALTER TABLE announcements ADD notify_before_minutes int NULL;
