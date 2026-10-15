// Strict rate limit for login/register: 10 failures / 15 min / IP.
// (Separate from global /api limiter — this blocks brute force.)
// Configurable via env (AUTH_RATE_LIMIT_MAX) to avoid test friction.
// skipSuccessfulRequests: successful logins/registers don't burn quota —
// otherwise normal use (login + register + OTP on same IP) locks out legit
// users. Only 4xx/5xx responses count toward the 10-attempt budget.
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const authLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  limit: config.authRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'too_many_attempts' },
});
