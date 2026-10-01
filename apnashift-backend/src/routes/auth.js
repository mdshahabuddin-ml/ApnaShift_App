// User auth: register, login (user/driver/admin), me.
// TODO(otp): No OTP yet — password-only login. When adding OTP:
//   1. Add phone_verified BOOLEAN column to users/drivers (default FALSE).
//   2. Send OTP on register + verify via POST /api/auth/verify-otp.
//   3. Deny tokens to unverified phones on login:
//      return 403 { ok:false, error:'phone_unverified' }.
//   4. Hook this TODO where passwords are checked (login below).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { VEHICLE_TO_API, registerSchema, loginSchema, parseBody } from '../validation/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter } from '../middleware/authLimiter.js';

export const authRoutes = Router();

// Wrong phone or wrong password — same response (prevents enumeration).
const GENERIC_LOGIN_ERROR = 'invalid_credentials';

// Dummy compare to avoid timing leaks for unknown phones.
// (Hash is created once and reused — not per request.)
let dummyHashPromise = null;
function dummyCompare(password) {
  dummyHashPromise ??= bcrypt.hash('never-matches-this', 4);
  return dummyHashPromise.then((hash) => bcrypt.compare(password, hash));
}

// password_hash never appears in responses.
function publicUser(row, role) {
  const user = { id: row.id, name: row.name, phone: row.phone, role };
  if (role === 'driver') {
    user.vehicle_type = VEHICLE_TO_API[row.vehicle_type] ?? row.vehicle_type;
    user.vehicle_number = row.vehicle_number;
    user.is_verified = row.is_verified;
    // Own profile — safe fields only (bank details are never collected).
    user.email = row.email ?? null;
    user.city = row.city ?? null;
    user.state = row.state ?? null;
    user.application_ref = row.application_ref ?? null;
  }
  return user;
}

// POST /api/auth/register (user)
authRoutes.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, phone, password } = parseBody(registerSchema, req.body);

    // Cross-table uniqueness: one number only once across users/drivers/admins.
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
      // Race on concurrent requests: unique violation -> same 409.
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

// POST /api/auth/login (user | driver | admin — by whichever table holds the phone)
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

    // TODO(otp): phone_verified check goes here (see TODO above).
    const user = publicUser(found.row, found.role);
    const token = signToken({ id: user.id, role: found.role });
    res.json({ ok: true, token, user });
  } catch (err) {
    next(err);
  }
});

// users -> drivers -> admins (parameterized, one at a time).
async function findByPhone(phone) {
  const inUsers = await query('SELECT id, name, phone, password_hash FROM users WHERE phone = $1', [
    phone,
  ]);
  if (inUsers.rowCount > 0) return { role: 'user', row: inUsers.rows[0] };

  const inDrivers = await query(
    'SELECT id, name, phone, password_hash, vehicle_type, vehicle_number, is_verified, email, city, state, application_ref FROM drivers WHERE phone = $1',
    [phone],
  );
  if (inDrivers.rowCount > 0) return { role: 'driver', row: inDrivers.rows[0] };

  const inAdmins = await query('SELECT id, name, phone, password_hash FROM admins WHERE phone = $1', [
    phone,
  ]);
  if (inAdmins.rowCount > 0) return { role: 'admin', row: inAdmins.rows[0] };

  return null;
}

// GET /api/auth/me (own profile for the token holder)
authRoutes.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { id, role } = req.user;
    let result;
    if (role === 'user') {
      result = await query('SELECT id, name, phone FROM users WHERE id = $1', [id]);
    } else if (role === 'driver') {
      result = await query(
        'SELECT id, name, phone, vehicle_type, vehicle_number, is_verified, email, city, state, application_ref FROM drivers WHERE id = $1',
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
