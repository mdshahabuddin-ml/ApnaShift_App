// Separate limiter for notification endpoints (bell polling, token register).
// Extra layer above global /api limiter — a chatty poller must not eat the
// budget of booking/payment calls. Configurable via env for test friction.
import { rateLimit } from 'express-rate-limit';
import { config } from '../config.js';

export const notifyLimiter = rateLimit({
  windowMs: config.notifyRateLimitWindowMs,
  limit: config.notifyRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});
