// User auth: register, login (user/driver/admin), me.
// TODO(otp): OTP abhi nahi hai — password-only login hai. Jab OTP aayega:
//   1. users/drivers me phone_verified BOOLEAN column jodo (default FALSE).
//   2. Register par OTP bhejo + POST /api/auth/verify-otp se verify karo.
//   3. Login par unverified phone ko token mat do:
//      return 403 { ok:false, error:'phone_unverified' }.
//   4. Ye TODO jahan password check hota hai (neeche login me), wahan hook lagega.
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { VEHICLE_TO_API, registerSchema, loginSchema, parseBody } from '../validation/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/authLimiter.js';

export const authRoutes = Router();

// Galat phone ho ya galat password — jawab ek jaisa (enumeration rokne ke liye).
const GENERIC_LOGIN_ERROR = 'invalid_credentials';

// Unknown phone par timing se pata na chale, isliye dummy compare.
// (Ek baar bana hash reuse hota hai — har request par naya nahi.)
let dummyHashPromise = null;
function dummyCompare(password) {
  dummyHashPromise ??= bcrypt.hash('never-matches-this', 4);
  return dummyHashPromise.then((hash) => bcrypt.compare(password, hash));
}

// password_hash kabhi response me nahi jata.
function publicUser(row, role) {
  const user = { id: row.id, name: row.name, phone: row.phone, role };
  if (role === 'driver') {
    user.vehicle_type = VEHICLE_TO_API[row.vehicle_type] ?? row.vehicle_type;
    user.vehicle_number = row.vehicle_number;
    user.is_verified = row.is_verified;
  }
  return user;
}

// POST /api/auth/register (user)
authRoutes.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, phone, password } = parseBody(registerSchema, req.body);

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
        'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone',
        [name, phone, passwordHash],
      );
    } catch (err) {
      // Race me do request saath aayein to unique violation -> same 409.
      if (err.code === '23505') {
        return res.status(409).json({ ok: false, error: 'phone_taken' });
      }
      throw err;
    }

    const user = publicUser(inserted.rows[0], 'user');
    const token = signToken({ id: user.id, role: 'user' });
    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login (user | driver | admin — phone jis table me mile)
authRoutes.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { phone, password } = parseBody(loginSchema, req.body);

    const found = await findByPhone(phone);
    if (!found) {
      await dummyCompare(password);
      return res.status(401).json({ ok: false, error: GENERIC_LOGIN_ERROR });
    }
    const match = await bcrypt.compare(password, found.row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: GENERIC_LOGIN_ERROR });
    }

    // TODO(otp): yahan phone_verified check lagega (upar TODO dekho).
    const user = publicUser(found.row, found.role);
    const token = signToken({ id: user.id, role: found.role });
    res.json({ ok: true, token, user });
  } catch (err) {
    next(err);
  }
});

// users -> drivers -> admins (parameterized, ek-ek karke).
async function findByPhone(phone) {
  const inUsers = await query('SELECT id, name, phone, password_hash FROM users WHERE phone = $1', [
    phone,
  ]);
  if (inUsers.rowCount > 0) return { role: 'user', row: inUsers.rows[0] };

  const inDrivers = await query(
    'SELECT id, name, phone, password_hash, vehicle_type, vehicle_number, is_verified FROM drivers WHERE phone = $1',
    [phone],
  );
  if (inDrivers.rowCount > 0) return { role: 'driver', row: inDrivers.rows[0] };

  const inAdmins = await query('SELECT id, name, phone, password_hash FROM admins WHERE phone = $1', [
    phone,
  ]);
  if (inAdmins.rowCount > 0) return { role: 'admin', row: inAdmins.rows[0] };

  return null;
}

// GET /api/auth/me (token wala apna profile)
authRoutes.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { id, role } = req.user;
    let result;
    if (role === 'user') {
      result = await query('SELECT id, name, phone FROM users WHERE id = $1', [id]);
    } else if (role === 'driver') {
      result = await query(
        'SELECT id, name, phone, vehicle_type, vehicle_number, is_verified FROM drivers WHERE id = $1',
        [id],
      );
    } else if (role === 'admin') {
      result = await query('SELECT id, name, phone FROM admins WHERE id = $1', [id]);
    } else {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    if (result.rowCount === 0) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    res.json({ ok: true, user: publicUser(result.rows[0], role) });
  } catch (err) {
    next(err);
  }
});
