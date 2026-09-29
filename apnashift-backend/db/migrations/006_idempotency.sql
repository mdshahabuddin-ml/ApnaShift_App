-- Migration 006: idempotency keys for POST /api/bookings (Option A: DB-backed separate table).
-- Chalao: npm run db:migrate
--
-- Design (Option A):
--   - Header `Idempotency-Key` optional hai. Bhejo to (user_id, key) unique scope me
--     pehli success response dobara milti hai (replay 200, pehli baar 201).
--   - Same key + alag payload par 422 `idempotency_conflict` (nayi booking nahi).
--   - Alag user same key use kar sakta hai (scope per-user hai).
--   - booking insert + key insert ek transaction me hote hain (route dekho);
--     race me unique violation (23505) par loser existing row wapas karta hai.
--   - Expiry nahi hai (MVP) — keys hamesha rehti hain.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (char_length(key) >= 1 AND char_length(key) <= 64),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_booking ON idempotency_keys (booking_id);
