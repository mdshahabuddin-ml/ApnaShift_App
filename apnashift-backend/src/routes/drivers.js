// Driver register. Naye driver is_verified=false ke saath bante hain —
// booking tabhi milegi jab admin verify kare (wo logic booking API me aayega).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { VEHICLE_TO_DB, VEHICLE_TO_API, driverRegisterSchema, parseBody } from '../validation/auth.js';
import { authLimiter } from '../middleware/authLimiter.js';

export const driverRoutes = Router();

// POST /api/drivers/register
driverRoutes.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, phone, password, vehicle_type, vehicle_number } = parseBody(
      driverRegisterSchema,
      req.body,
    );

    // Cross-table uniqueness: ek number users/drivers/admins me sirf ek baar.
    const existing = await query(
      `SELECT 1 FROM users WHERE phone = $1
       UNION ALL SELECT 1 FROM drivers WHERE phone = $1
       UNION ALL SELECT 1 FROM admins WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'phone_taken' });
    }

    const passwordHash = await bcrypt.hash(password, config.bcryptRounds);
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO drivers (name, phone, password_hash, vehicle_type, vehicle_number, is_verified)
         VALUES ($1, $2, $3, $4, $5, FALSE)
         RETURNING id, name, phone, vehicle_type, vehicle_number, is_verified`,
        [name, phone, passwordHash, VEHICLE_TO_DB[vehicle_type], vehicle_number],
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ ok: false, error: 'phone_taken' });
      }
      throw err;
    }

    const row = inserted.rows[0];
    const user = {
      id: row.id,
      name: row.name,
      phone: row.phone,
      role: 'driver',
      vehicle_type: VEHICLE_TO_API[row.vehicle_type] ?? vehicle_type,
      vehicle_number: row.vehicle_number,
      is_verified: row.is_verified,
    };
    const token = signToken({ id: user.id, role: 'driver' });
    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    next(err);
  }
});
