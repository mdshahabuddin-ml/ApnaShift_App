// Login/register par sakht rate limit: 10 req / 15 min / IP.
// (Global /api limiter alag hai — ye brute-force rokne ke liye hai.)
// Tests me tang na kare, isliye env se badal sakta hai (AUTH_RATE_LIMIT_MAX).
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const authLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  limit: config.authRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});
