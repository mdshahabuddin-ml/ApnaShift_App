-- Migration 006: idempotency keys for POST /api/bookings (Option A: DB-backed separate table).
-- Run: npm run db:migrate
--
-- Design (Option A):
--   - Header `Idempotency-Key` is optional. When sent, (user_id, key) uniquely scopes
--     the first success response replay (replay 200, first time 201).
--   - Same key + different payload returns 422 `idempotency_conflict` (no new booking).
--   - Different users may reuse the same key (scope is per-user).
--   - booking + key inserts run in one transaction (see route);
--     on unique violation (23505) in a race, the loser returns the existing row.
--   - No expiry (MVP) — keys persist indefinitely.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (char_length(key) >= 1 AND char_length(key) <= 64),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_booking ON idempotency_keys (booking_id);
