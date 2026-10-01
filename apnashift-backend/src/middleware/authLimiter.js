// Strict rate limit for login/register: 10 req / 15 min / IP.
// (Separate from global /api limiter — this blocks brute force.)
// Configurable via env (AUTH_RATE_LIMIT_MAX) to avoid test friction.
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const authLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  limit: config.authRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});
