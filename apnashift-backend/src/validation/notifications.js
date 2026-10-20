// Zod schemas for in-app notifications + push device tokens.
// Server-rendered titles stay English-only for v1 (client shows stored text
// escaped); booking refs travel in `data` so no PII is ever needed client-side.
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';
import { parseQuery } from './booking.js';

export { parseAuthBody as parseBody, parseQuery };

// Bell dropdown / history list: newest first, cursor = ISO timestamp.
export const notificationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.string().datetime({ offset: true }).optional(),
});

// SSE replay cursor: only rows newer than this timestamp are re-sent.
export const notificationStreamQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

// FCM/WebPush token registration. Token is opaque to us — stored as-is,
// never logged (suffix only in mince-level logs, never in responses).
export const deviceTokenSchema = z.object({
  platform: z.enum(['android', 'ios', 'web'], {
    errorMap: () => ({ message: 'platform must be android, ios, or web.' }),
  }),
  token: z
    .string()
    .min(1, 'token must not be empty.')
    .max(512, 'token must be no more than 512 characters.'),
});
