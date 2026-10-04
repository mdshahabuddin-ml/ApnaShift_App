// User auth: register, login (user/driver/admin), me + self-service
// password reset via zero-cost OTP (generate FREE, SMS paid — dev me console).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { config } from '../config.js';
import { signToken } from '../utils/jwt.js';
import {
  VEHICLE_TO_API,
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  parseBody,
} from '../validation/auth.js';
import {
  generateOtp,
  hashOtp,
  timingSafeEqualHex,
  sendOtp,
  shouldReturnDebugOtp,
  OTP_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_WINDOW,
} from '../services/otp.js';
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
    user.upi_id = row.upi_id ?? null;
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
    'SELECT id, name, phone, password_hash, vehicle_type, vehicle_number, is_verified, email, city, state, application_ref, upi_id FROM drivers WHERE phone = $1',
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
        'SELECT id, name, phone, vehicle_type, vehicle_number, is_verified, email, city, state, application_ref, upi_id FROM drivers WHERE id = $1',
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

// POST /api/auth/forgot-password { phone } — zero-cost OTP.
// Hamesha ok:true (phone hai ya nahi — enumeration nahi). OTP generate FREE,
// bhejna dev me console (Rs 0), SMS provider lagne par SMS.
// Per-phone throttle 3/15min (future SMS kharch bachane ke liye) + IP throttle authLimiter.
authRoutes.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { phone } = parseBody(forgotPasswordSchema, req.body);

    // Per-phone throttle — table na ho (purana DB, migrate baaki) to skip karke aage badho.
    try {
      const recent = await query(
        `SELECT COUNT(*)::int AS c FROM password_reset_otps
         WHERE phone = $1 AND created_at > now() - make_interval(secs => $2)`,
        [phone, OTP_MAX_PER_WINDOW === 0 ? 0 : 900],
      );
      if ((recent.rows[0]?.c ?? 0) >= OTP_MAX_PER_WINDOW) {
        return res.status(429).json({ ok: false, error: 'too_many_attempts' });
      }
    } catch {
      // password_reset_otps table missing (migrate pending) — throttle skip.
    }

    // Sirf users/drivers self-reset (admins owner-flow se — par response same ok:true).
    const inUsers = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    let accountTable = inUsers.rowCount > 0 ? 'users' : null;
    if (!accountTable) {
      const inDrivers = await query('SELECT id FROM drivers WHERE phone = $1', [phone]);
      if (inDrivers.rowCount > 0) accountTable = 'drivers';
    }
    if (!accountTable) {
      // Phone nahi mila — phir bhi ok:true (enumeration rokna). Thoda delay taaki timing se pata na chale.
      await new Promise((r) => setTimeout(r, 150));
      return res.json({ ok: true });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    try {
      await query(
        'INSERT INTO password_reset_otps (phone, otp_hash, expires_at) VALUES ($1, $2, $3)',
        [phone, hashOtp(otp), expiresAt.toISOString()],
      );
    } catch (err) {
      // Table missing (migrate pending) — seedha error mat do, ok:true taaki purana flow na toote.
      if (err?.code === '42P01') return res.json({ ok: true });
      throw err;
    }
    // Best-effort send — fail ho to bhi OTP DB me hai, user retry kar sakta hai.
    try {
      await sendOtp(phone, otp);
    } catch {
      // ignore — console fallback already logged inside sendOtp
    }
    // Dev/test me frontend bina SMS ke test kar sake. Production me kabhi OTP wapas nahi.
    if (shouldReturnDebugOtp()) {
      return res.json({ ok: true, debug_otp: otp });
    }
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password { phone, otp, new_password } — OTP verify + password badlo.
// Galat/expire/missing sab par 400 invalid_otp (enumeration nahi). 5 galat try -> code dead.
authRoutes.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { phone, otp, new_password } = parseBody(resetPasswordSchema, req.body);

    let row = null;
    try {
      const found = await query(
        `SELECT id, otp_hash, expires_at, attempts FROM password_reset_otps
         WHERE phone = $1 AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [phone],
      );
      row = found.rows[0] ?? null;
    } catch (err) {
      if (err?.code === '42P01') {
        return res.status(503).json({ ok: false, error: 'otp_unavailable' });
      }
      throw err;
    }
    if (!row) {
      return res.status(400).json({ ok: false, error: 'invalid_otp' });
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await query('DELETE FROM password_reset_otps WHERE phone = $1', [phone]);
      return res.status(400).json({ ok: false, error: 'invalid_otp' });
    }
    if (!timingSafeEqualHex(hashOtp(otp), row.otp_hash)) {
      await query('UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return res.status(400).json({ ok: false, error: 'invalid_otp' });
    }

    // OTP sahi — kaunsi table me hai?
    const inUsers = await query('SELECT id FROM users WHERE phone = $1', [phone]);
    let accountTable = inUsers.rowCount > 0 ? 'users' : null;
    if (!accountTable) {
      const inDrivers = await query('SELECT id FROM drivers WHERE phone = $1', [phone]);
      if (inDrivers.rowCount > 0) accountTable = 'drivers';
    }
    if (!accountTable) {
      await query('DELETE FROM password_reset_otps WHERE phone = $1', [phone]);
      return res.status(400).json({ ok: false, error: 'invalid_otp' });
    }
    const passwordHash = await bcrypt.hash(new_password, config.bcryptRounds);
    // Table name allowlist se aata hai (users/drivers) — SQL injection nahi.
    await query(`UPDATE ${accountTable} SET password_hash = $1 WHERE phone = $2`, [
      passwordHash,
      phone,
    ]);
    // Single-use: saare OTP khatm.
    await query('DELETE FROM password_reset_otps WHERE phone = $1', [phone]);
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
