// Admin login (admins table). Register endpoint nahi hai —
// admin staff manual insert se banta hai (password_hash bcrypt se).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { signToken } from '../utils/jwt.js';
import { adminLoginSchema, parseBody, VEHICLE_TO_DB } from '../validation/auth.js';
import { authLimiter } from '../middleware/authLimiter.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  adminDriversQuerySchema,
  driverRejectSchema,
  adminBookingsQuerySchema,
  bookingAssignSchema,
  pricingUpdateSchema,
  pricingHistoryQuerySchema,
  parseQuery,
} from '../validation/admin.js';
import { pool } from '../db.js';
import { logAuditSafe, logAuditTx } from '../services/audit.js';
import { validateIdParam } from '../utils/validate.js';
import { toPublicBooking } from './bookings.js';

export const adminRoutes = Router();

const GENERIC_LOGIN_ERROR = 'invalid_credentials';

// POST /api/admin/login
adminRoutes.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { phone, password } = parseBody(adminLoginSchema, req.body);

    const found = await query('SELECT id, name, phone, password_hash FROM admins WHERE phone = $1', [
      phone,
    ]);
    if (found.rowCount === 0) {
      // User login jaisa generic jawab (kaunsi table, ye bahar nahi batana).
      return res.status(401).json({ ok: false, error: GENERIC_LOGIN_ERROR });
    }
    const match = await bcrypt.compare(password, found.rows[0].password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: GENERIC_LOGIN_ERROR });
    }

    const row = found.rows[0];
    const user = { id: row.id, name: row.name, phone: row.phone, role: 'admin' };
    const token = signToken({ id: user.id, role: 'admin' });
    res.json({ ok: true, token, user });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/drivers/flagged (admin) — needs_review wale drivers.
// Auto-ban kahin nahi hota; admin yahan dekhkar manual action leta hai.
adminRoutes.get('/drivers/flagged', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT d.id, d.name, d.phone, d.vehicle_type, d.avg_rating, d.total_trips,
              COUNT(r.id) AS ratings_count
       FROM drivers d LEFT JOIN ratings r ON r.driver_id = d.id
       WHERE d.needs_review = TRUE
       GROUP BY d.id ORDER BY d.avg_rating ASC NULLS LAST`,
    );
    res.json({
      ok: true,
      drivers: rows.rows.map((d) => ({
        id: d.id,
        name: d.name,
        phone: d.phone,
        vehicle_type: d.vehicle_type,
        avg_rating: d.avg_rating === null ? 0 : Number(d.avg_rating),
        total_trips: Number(d.total_trips),
        ratings_count: Number(d.ratings_count),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Neeche ke sab routes admin-only (login public rehta hai).
adminRoutes.use(requireAuth, requireRole('admin'));

function adminDriver(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    vehicle_type: row.vehicle_type,
    vehicle_number: row.vehicle_number,
    is_verified: row.is_verified,
    is_active: row.is_active,
    rejection_reason: row.rejection_reason,
    avg_rating: row.avg_rating === null ? 0 : Number(row.avg_rating),
    total_trips: Number(row.total_trips),
    needs_review: row.needs_review,
  };
}

const ADMIN_DRIVER_COLS = `id, name, phone, vehicle_type, vehicle_number,
  is_verified, is_active, rejection_reason, avg_rating, total_trips, needs_review`;

// GET /api/admin/drivers?status=pending|verified|review (paginated)
adminRoutes.get('/drivers', async (req, res, next) => {
  try {
    const { status, page, limit } = parseQuery(adminDriversQuerySchema, req.query);
    const offset = (page - 1) * limit;

    let where = '';
    if (status === 'pending') where = 'WHERE is_verified = FALSE';
    else if (status === 'verified') where = 'WHERE is_verified = TRUE';
    else where = 'WHERE needs_review = TRUE';

    const [rows, count] = await Promise.all([
      query(
        `SELECT ${ADMIN_DRIVER_COLS} FROM drivers ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM drivers ${where}`),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      drivers: rows.rows.map(adminDriver),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/verify
adminRoutes.patch('/drivers/:id/verify', validateIdParam, async (req, res, next) => {
  try {
    const updated = await query(
      `UPDATE drivers SET is_verified = TRUE, rejection_reason = NULL
       WHERE id = $1 RETURNING ${ADMIN_DRIVER_COLS}`,
      [req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    // Best-effort: audit fail ho to bhi verify success rahe.
    await logAuditSafe(req.user.id, 'driver.verify', 'driver', req.params.id, {});
    res.json({ ok: true, driver: adminDriver(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/reject (wajah ke saath)
adminRoutes.patch('/drivers/:id/reject', validateIdParam, async (req, res, next) => {
  try {
    const { reason } = parseBody(driverRejectSchema, req.body);
    const updated = await query(
      `UPDATE drivers SET is_verified = FALSE, rejection_reason = $1
       WHERE id = $2 RETURNING ${ADMIN_DRIVER_COLS}`,
      [reason, req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    // Best-effort: audit fail ho to bhi reject success rahe.
    await logAuditSafe(req.user.id, 'driver.reject', 'driver', req.params.id, { reason });
    res.json({ ok: true, driver: adminDriver(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/deactivate (is_active FALSE — login rahega par bookings nahi)
adminRoutes.patch('/drivers/:id/deactivate', validateIdParam, async (req, res, next) => {
  try {
    const updated = await query(
      `UPDATE drivers SET is_active = FALSE
       WHERE id = $1 RETURNING ${ADMIN_DRIVER_COLS}`,
      [req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await logAuditSafe(req.user.id, 'driver.deactivate', 'driver', req.params.id, {});
    res.json({ ok: true, driver: adminDriver(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/reactivate (is_active TRUE wapas)
adminRoutes.patch('/drivers/:id/reactivate', validateIdParam, async (req, res, next) => {
  try {
    const updated = await query(
      `UPDATE drivers SET is_active = TRUE
       WHERE id = $1 RETURNING ${ADMIN_DRIVER_COLS}`,
      [req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await logAuditSafe(req.user.id, 'driver.reactivate', 'driver', req.params.id, {});
    res.json({ ok: true, driver: adminDriver(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/bookings (filters: status, date range, city) + totals
adminRoutes.get('/bookings', async (req, res, next) => {
  try {
    const { status, from, to, city, page, limit } = parseQuery(adminBookingsQuerySchema, req.query);
    const offset = (page - 1) * limit;

    // Values hamesha params me — string jodkar SQL nahi.
    const conds = [];
    const params = [];
    let i = 1;
    if (status) {
      conds.push(`b.status = $${i++}`);
      params.push(status);
    }
    if (from) {
      conds.push(`b.created_at >= $${i++}`);
      params.push(from);
    }
    if (to) {
      conds.push(`b.created_at <= $${i++}`);
      params.push(to);
    }
    if (city) {
      // City ke liye column nahi hai — address me ILIKE search.
      // % _ \ escape taaki user input wildcard na bane.
      const escaped = city.replace(/[%_\\]/g, (c) => `\\${c}`);
      conds.push(`(b.pickup_address ILIKE $${i} ESCAPE '\\' OR b.drop_address ILIKE $${i} ESCAPE '\\')`);
      params.push(`%${escaped}%`);
      i += 1;
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

    const [rows, totals] = await Promise.all([
      query(
        `SELECT b.*, u.name AS user_name, d.name AS driver_name
         FROM bookings b LEFT JOIN users u ON u.id = b.user_id
         LEFT JOIN drivers d ON d.id = b.driver_id
         ${where} ORDER BY b.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset],
      ),
      query(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN b.status <> 'cancelled' THEN b.price_rs ELSE 0 END), 0) AS revenue_rs
         FROM bookings b ${where}`,
        params,
      ),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(totals.rows[0].count),
      revenue_rs: Number(totals.rows[0].revenue_rs),
      bookings: rows.rows.map((r) => ({
        ...toPublicBooking(r),
        user_name: r.user_name,
        driver_name: r.driver_name,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/assign (manual dispatch: pending -> accepted)
adminRoutes.patch('/bookings/:id/assign', validateIdParam, async (req, res, next) => {
  try {
    const { driver_id } = parseBody(bookingAssignSchema, req.body);

    const booking = await query('SELECT id, status, vehicle_type FROM bookings WHERE id = $1', [
      req.params.id,
    ]);
    if (booking.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (booking.rows[0].status !== 'pending') {
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    const driver = await query(
      'SELECT id, vehicle_type, is_verified, is_active FROM drivers WHERE id = $1',
      [driver_id],
    );
    if (driver.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (!driver.rows[0].is_verified || !driver.rows[0].is_active) {
      return res.status(409).json({ ok: false, error: 'driver_unavailable' });
    }
    if (driver.rows[0].vehicle_type !== booking.rows[0].vehicle_type) {
      return res.status(400).json({ ok: false, error: 'vehicle_mismatch' });
    }

    const updated = await query(
      `UPDATE bookings SET driver_id = $1, status = 'accepted', updated_at = now()
       WHERE id = $2 AND status = 'pending'
       RETURNING ${['id', 'user_id', 'driver_id', 'pickup_address', 'pickup_lat', 'pickup_lng', 'drop_address', 'drop_lat', 'drop_lng', 'vehicle_type', 'helper', 'item_description', 'scheduled_at', 'delivered_at', 'distance_km', 'price_rs', 'status', 'created_at', 'updated_at'].join(', ')}`,
      [driver_id, req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    // Best-effort: audit fail ho to bhi assign success rahe.
    await logAuditSafe(req.user.id, 'booking.assign', 'booking', req.params.id, { driver_id });
    res.json({ ok: true, booking: toPublicBooking(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pricing-rules
adminRoutes.get('/pricing-rules', async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT vehicle_type, base_rs, per_km_rs, helper_rs, updated_at FROM pricing_rules ORDER BY id',
    );
    res.json({
      ok: true,
      rules: rows.rows.map((r) => ({
        vehicle_type: r.vehicle_type,
        base_rs: Number(r.base_rs),
        per_km_rs: Number(r.per_km_rs),
        helper_rs: Number(r.helper_rs),
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/pricing-rules (rate + history + audit, ek transaction me)
adminRoutes.put('/pricing-rules', async (req, res, next) => {
  try {
    const { vehicle_type, base_rs, per_km_rs, helper_rs } = parseBody(pricingUpdateSchema, req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT base_rs, per_km_rs, helper_rs FROM pricing_rules WHERE vehicle_type = $1 FOR UPDATE',
        [VEHICLE_TO_DB[vehicle_type]],
      );
      if (current.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'unknown_vehicle' });
      }
      const old = current.rows[0];
      const nextVals = {
        base_rs: base_rs ?? Number(old.base_rs),
        per_km_rs: per_km_rs ?? Number(old.per_km_rs),
        helper_rs: helper_rs ?? Number(old.helper_rs),
      };
      const updated = await client.query(
        `UPDATE pricing_rules SET base_rs = $1, per_km_rs = $2, helper_rs = $3, updated_at = now()
         WHERE vehicle_type = $4
         RETURNING vehicle_type, base_rs, per_km_rs, helper_rs, updated_at`,
        [nextVals.base_rs, nextVals.per_km_rs, nextVals.helper_rs, VEHICLE_TO_DB[vehicle_type]],
      );
      const hist = await client.query(
        `INSERT INTO pricing_history
           (vehicle_type, old_base_rs, old_per_km_rs, old_helper_rs,
            new_base_rs, new_per_km_rs, new_helper_rs, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          VEHICLE_TO_DB[vehicle_type],
          Number(old.base_rs),
          Number(old.per_km_rs),
          Number(old.helper_rs),
          nextVals.base_rs,
          nextVals.per_km_rs,
          nextVals.helper_rs,
          req.user.id,
        ],
      );
      // Audit isi transaction me: fail ho to rate+history bhi rollback.
      const r = updated.rows[0];
      await logAuditTx(client, req.user.id, 'pricing.update', 'pricing_rule', r.vehicle_type, {
        old: { base_rs: Number(old.base_rs), per_km_rs: Number(old.per_km_rs), helper_rs: Number(old.helper_rs) },
        new: nextVals,
      });
      await client.query('COMMIT');
      res.json({
        ok: true,
        rule: {
          vehicle_type: r.vehicle_type,
          base_rs: Number(r.base_rs),
          per_km_rs: Number(r.per_km_rs),
          helper_rs: Number(r.helper_rs),
          updated_at: r.updated_at,
        },
        history_id: hist.rows[0].id,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore — original error hi bahar jayegi.
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/pricing-rules/history
adminRoutes.get('/pricing-rules/history', async (req, res, next) => {
  try {
    const { vehicle_type, limit } = parseQuery(pricingHistoryQuerySchema, req.query);
    const conds = [];
    const params = [];
    if (vehicle_type) {
      conds.push('vehicle_type = $1');
      params.push(VEHICLE_TO_DB[vehicle_type]);
    }
    params.push(limit);
    const rows = await query(
      `SELECT id, vehicle_type, old_base_rs, old_per_km_rs, old_helper_rs,
              new_base_rs, new_per_km_rs, new_helper_rs, changed_by, created_at
       FROM pricing_history ${conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    res.json({
      ok: true,
      history: rows.rows.map((h) => ({
        id: h.id,
        vehicle_type: h.vehicle_type,
        old: {
          base_rs: h.old_base_rs === null ? null : Number(h.old_base_rs),
          per_km_rs: h.old_per_km_rs === null ? null : Number(h.old_per_km_rs),
          helper_rs: h.old_helper_rs === null ? null : Number(h.old_helper_rs),
        },
        new: {
          base_rs: Number(h.new_base_rs),
          per_km_rs: Number(h.new_per_km_rs),
          helper_rs: Number(h.new_helper_rs),
        },
        changed_by: h.changed_by,
        created_at: h.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats
// bookings/cancelled ginti created_at se (kab bani), completed/revenue delivered_at
// se (kab deliver hui) — updated_at har edit par badalta hai, isliye sahi nahi.
adminRoutes.get('/stats', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today_total,
         COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('day', now())) AS today_completed,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND created_at >= date_trunc('day', now())) AS today_cancelled,
         COALESCE(SUM(price_rs) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('day', now())), 0) AS today_revenue,
         COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '7 days') AS week_total,
         COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= now() - INTERVAL '7 days') AS week_completed,
         COUNT(*) FILTER (WHERE status = 'cancelled' AND created_at >= now() - INTERVAL '7 days') AS week_cancelled,
         COALESCE(SUM(price_rs) FILTER (WHERE status = 'delivered' AND delivered_at >= now() - INTERVAL '7 days'), 0) AS week_revenue,
         COUNT(*) AS all_total,
         COUNT(*) FILTER (WHERE status = 'delivered') AS all_completed,
         COUNT(*) FILTER (WHERE status = 'cancelled') AS all_cancelled,
         COALESCE(SUM(price_rs) FILTER (WHERE status = 'delivered'), 0) AS all_revenue
       FROM bookings`,
    );
    const drivers = await query(
      'SELECT COUNT(*) AS verified_active FROM drivers WHERE is_verified = TRUE AND is_active = TRUE',
    );
    const s = result.rows[0];
    const block = (p) => ({
      bookings: Number(s[`${p}_total`] ?? s.all_total),
      completed: Number(s[`${p}_completed`] ?? s.all_completed),
      cancelled: Number(s[`${p}_cancelled`] ?? s.all_cancelled),
      revenue_rs: Number(s[`${p}_revenue`] ?? s.all_revenue),
    });
    res.json({
      ok: true,
      today: block('today'),
      week: block('week'),
      total: {
        bookings: Number(s.all_total),
        completed: Number(s.all_completed),
        cancelled: Number(s.all_cancelled),
        revenue_rs: Number(s.all_revenue),
      },
      drivers: { verified_active: Number(drivers.rows[0].verified_active) },
    });
  } catch (err) {
    next(err);
  }
});
