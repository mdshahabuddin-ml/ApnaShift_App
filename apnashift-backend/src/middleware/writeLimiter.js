// Write endpoints (booking create, rating) par alag limiter.
// Global /api limiter ke upar extra layer — spam bookings se DB bharne se rokta hai.
// Tests me tang na kare, isliye env se badal sakta hai (WRITE_RATE_LIMIT_MAX).
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const writeLimiter = rateLimit({
  windowMs: config.writeRateLimitWindowMs,
  limit: config.writeRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});
