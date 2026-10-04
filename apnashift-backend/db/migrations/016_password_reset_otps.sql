-- Migration 016: self-service password-reset OTPs (zero-cost dev mode).
-- Run: npm run db:migrate
--
-- Design (zero-cost):
--   - OTP generate karna FREE hai (crypto.randomInt, 6-digit).
--   - OTP bhejna (SMS/WhatsApp) PAID hai (~Rs 0.13-0.25/SMS) — isliye
--     dev/test me OTP console me log hota hai + OTP_DEV_RETURN=1 par
--     response me debug_otp milta hai. Production me SMS provider lagne
--     tak WhatsApp fallback chalta rahega.
--   - phone users/drivers dono me ho sakta hai — isliye FK nahi, phone key hai.
--   - otp_hash = HMAC-SHA256(otp, pepper) — plain OTP kabhi DB me nahi.
--   - expires_at 10 min, attempts cap 5, success par single-use delete.
--   - Per-phone throttle (3 / 15 min) route layer me COUNT(*) se hota hai.

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_phone_created
  ON password_reset_otps (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_expires
  ON password_reset_otps (expires_at);
