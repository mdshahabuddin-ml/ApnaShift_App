// Param validation. Invalid UUID returns 404 (not 500 — pg errors stay hidden,
// and other users' data also uses the 404 convention).
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export function validateIdParam(req, res, next) {
  if (!uuidSchema.safeParse(req.params.id).success) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  next();
}
