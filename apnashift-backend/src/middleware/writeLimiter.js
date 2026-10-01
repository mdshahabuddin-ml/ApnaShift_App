// Separate limiter for write endpoints (booking create, rating).
// Extra layer above global /api limiter — prevents DB spam via bookings.
// Configurable via env (WRITE_RATE_LIMIT_MAX) to avoid test friction.
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const writeLimiter = rateLimit({
  windowMs: config.writeRateLimitWindowMs,
  limit: config.writeRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});
