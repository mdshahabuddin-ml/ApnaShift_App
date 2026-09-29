// Param validation. Galat UUID par 404 (500 nahi — pg error bahar nahi jana chahiye,
// aur doosre ke data wali convention bhi 404 hai).
import { z } from 'zod';

const uuidSchema = z.string().uuid();

export function validateIdParam(req, res, next) {
  if (!uuidSchema.safeParse(req.params.id).success) {
    return res.status(404).json({ ok: false, error: 'not_found' });
  }
  next();
}
