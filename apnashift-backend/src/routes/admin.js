// Admin login (admins table). No register endpoint —
// admin staff is created via manual insert (bcrypt password_hash).
import { Router } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';
import { signToken } from '../utils/jwt.js';
import { adminLoginSchema, parseBody, VEHICLE_TO_DB, VEHICLE_TO_API } from '../validation/auth.js';
import { trackingActivesQuerySchema, parseQuery as parseTrackingQuery } from '../validation/tracking.js';
import { trackingState } from '../services/tracking.js';
import {
  attachPayments,
  getCommissionPct,
  driverBalance,
  createSettlementTx,
} from '../services/payments.js';
import { toPaise, paiseToRs } from '../services/money.js';
import {
  commissionUpdateSchema,
  settlementCreateSchema,
  adjustmentCreateSchema,
  ledgerQuerySchema,
  settlementsQuerySchema,
  parseBody as parsePaymentBody,
  parseQuery as parsePaymentQuery,
} from '../validation/payments.js';
import { authLimiter } from '../middleware/authLimiter.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { config } from '../config.js';
import { passwordResetSchema } from '../validation/admin.js';
import { normalizePhone, PHONE_RE } from '../utils/phone.js';
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
      // Generic response like user login (never reveal which table).
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

// GET /api/admin/drivers/flagged (admin) — drivers needing review.
// No auto-ban anywhere; admin reviews here and acts manually.
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

// All routes below are admin-only (login stays public).
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
    // Driver Partner Registration (009) — safe profile fields for review.
    // Never password_hash; bank details are never collected.
    email: row.email ?? null,
    dob: row.dob ?? null,
    gender: row.gender ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    address: row.address ?? null,
    vehicle_make: row.vehicle_make ?? null,
    vehicle_model: row.vehicle_model ?? null,
    vehicle_year: row.vehicle_year === null ? null : Number(row.vehicle_year),
    capacity_kg: row.capacity_kg === null ? null : Number(row.capacity_kg),
    fuel_type: row.fuel_type ?? null,
    ownership: row.ownership ?? null,
    license_number: row.license_number ?? null,
    license_type: row.license_type ?? null,
    license_expiry: row.license_expiry ?? null,
    license_state: row.license_state ?? null,
    rc_number: row.rc_number ?? null,
    insurance_expiry: row.insurance_expiry ?? null,
    pollution_expiry: row.pollution_expiry ?? null,
    permit_number: row.permit_number ?? null,
    service_city: row.service_city ?? null,
    service_state: row.service_state ?? null,
    service_areas: row.service_areas ?? null,
    service_radius_km: row.service_radius_km === null ? null : Number(row.service_radius_km),
    emergency_name: row.emergency_name ?? null,
    emergency_relation: row.emergency_relation ?? null,
    emergency_phone: row.emergency_phone ?? null,
    application_ref: row.application_ref ?? null,
    consent_at: row.consent_at ?? null,
    upi_id: row.upi_id ?? null,
  };
}

const ADMIN_DRIVER_COLS = `id, name, phone, vehicle_type, vehicle_number,
  is_verified, is_active, rejection_reason, avg_rating, total_trips, needs_review,
  email, dob, gender, city, state, address,
  vehicle_make, vehicle_model, vehicle_year, capacity_kg, fuel_type, ownership,
  license_number, license_type, license_expiry, license_state,
  rc_number, insurance_expiry, pollution_expiry, permit_number,
  service_city, service_state, service_areas, service_radius_km,
  emergency_name, emergency_relation, emergency_phone,
  application_ref, consent_at, upi_id`;

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
    // Best-effort: verify succeeds even if audit fails.
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
    // Best-effort: reject succeeds even if audit fails.
    await logAuditSafe(req.user.id, 'driver.reject', 'driver', req.params.id, { reason });
    res.json({ ok: true, driver: adminDriver(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/deactivate (is_active FALSE — login stays, no bookings)
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

// PATCH /api/admin/drivers/:id/reactivate (restores is_active TRUE)
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

// Shared password-reset core (user/driver tables). Password kabhi response
// ya audit me nahi aata — sirf hash DB me jata hai.
async function resetAccountPassword(table, entity, id, newPassword, adminId) {
  const found = await query(`SELECT id, name, phone FROM ${table} WHERE id = $1`, [id]);
  if (found.rowCount === 0) {
    const err = new Error('not_found');
    err.status = 404;
    throw err;
  }
  const passwordHash = await bcrypt.hash(newPassword, config.bcryptRounds);
  await query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
  await logAuditSafe(adminId, `${entity}.password_reset`, entity, id, {});
  const row = found.rows[0];
  return { id: row.id, name: row.name, phone: row.phone };
}

// GET /api/admin/accounts/lookup?phone=X (admin only) — password reset
// form ke liye user/driver dhoondo. Safe fields only (kabhi hash nahi).
adminRoutes.get('/accounts/lookup', async (req, res, next) => {
  try {
    const phone = normalizePhone(req.query.phone);
    if (!PHONE_RE.test(phone)) {
      return res.status(400).json({ ok: false, error: 'validation_failed' });
    }
    const [users, drivers] = await Promise.all([
      query('SELECT id, name, phone FROM users WHERE phone = $1', [phone]),
      query('SELECT id, name, phone, vehicle_type FROM drivers WHERE phone = $1', [phone]),
    ]);
    const accounts = [
      ...users.rows.map((r) => ({ kind: 'user', id: r.id, name: r.name, phone: r.phone })),
      ...drivers.rows.map((r) => ({
        kind: 'driver',
        id: r.id,
        name: r.name,
        phone: r.phone,
        vehicle_type: r.vehicle_type,
      })),
    ];
    res.json({ ok: true, accounts });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:id/reset-password (admin only)
adminRoutes.patch('/users/:id/reset-password', validateIdParam, async (req, res, next) => {
  try {
    const { new_password } = parseBody(passwordResetSchema, req.body);
    const user = await resetAccountPassword('users', 'user', req.params.id, new_password, req.user.id);
    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/drivers/:id/reset-password (admin only)
adminRoutes.patch('/drivers/:id/reset-password', validateIdParam, async (req, res, next) => {
  try {
    const { new_password } = parseBody(passwordResetSchema, req.body);
    const user = await resetAccountPassword('drivers', 'driver', req.params.id, new_password, req.user.id);
    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/bookings (filters: status, date range, city, disputed) + totals
adminRoutes.get('/bookings', async (req, res, next) => {
  try {
    const { status, from, to, city, disputed, page, limit } = parseQuery(adminBookingsQuerySchema, req.query);
    const offset = (page - 1) * limit;

    // Values always via params — never string-concatenated SQL.
    const conds = [];
    const params = [];
    let i = 1;
    if (status) {
      conds.push(`b.status = $${i++}`);
      params.push(status);
    }
    if (disputed !== undefined) {
      conds.push(`b.disputed = $${i++}`);
      params.push(disputed);
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
      // No city column — ILIKE search on address.
      // Escape % _ \ so user input cannot act as wildcards.
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
    const bookings = await attachPayments(
      rows.rows.map((r) => ({
        ...toPublicBooking(r),
        user_name: r.user_name,
        driver_name: r.driver_name,
      })),
      'admin',
    );
    res.json({
      ok: true,
      page,
      limit,
      total: Number(totals.rows[0].count),
      revenue_rs: Number(totals.rows[0].revenue_rs),
      bookings,
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
        RETURNING ${['id', 'user_id', 'driver_id', 'pickup_address', 'pickup_lat', 'pickup_lng', 'drop_address', 'drop_lat', 'drop_lng', 'vehicle_type', 'helper', 'item_description', 'scheduled_at', 'delivered_at', 'distance_km', 'price_rs', 'status', 'created_at', 'updated_at', 'cancel_reason', 'cancelled_by', 'cancelled_at', 'payment_method', 'commission_percent'].join(', ')}`,
      [driver_id, req.params.id],
    );
    if (updated.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    // Best-effort: assign succeeds even if audit fails.
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
      'SELECT vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent, updated_at FROM pricing_rules ORDER BY id',
    );
    res.json({
      ok: true,
      rules: rows.rows.map((r) => ({
        vehicle_type: r.vehicle_type,
        base_rs: Number(r.base_rs),
        per_km_rs: Number(r.per_km_rs),
        helper_rs: Number(r.helper_rs),
        commission_pct: Number(r.commission_percent),
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/pricing-rules (rate + history + audit, ek transaction me)
// commission_pct bhi yahin badalta hai (per-vehicle; sirf NAYI bookings ka
// snapshot badalta hai). pricing_history me commission column nahi hai —
// commission change audit details me darj hota hai.
adminRoutes.put('/pricing-rules', async (req, res, next) => {
  try {
    const { vehicle_type, base_rs, per_km_rs, helper_rs, commission_pct } = parseBody(pricingUpdateSchema, req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT base_rs, per_km_rs, helper_rs, commission_percent FROM pricing_rules WHERE vehicle_type = $1 FOR UPDATE',
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
        commission_pct: commission_pct ?? Number(old.commission_percent),
      };
      const updated = await client.query(
        `UPDATE pricing_rules SET base_rs = $1, per_km_rs = $2, helper_rs = $3, commission_percent = $4, updated_at = now()
         WHERE vehicle_type = $5
         RETURNING vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent, updated_at`,
        [nextVals.base_rs, nextVals.per_km_rs, nextVals.helper_rs, nextVals.commission_pct, VEHICLE_TO_DB[vehicle_type]],
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
      // Audit in same transaction: failure rolls back rate+history too.
      const r = updated.rows[0];
      await logAuditTx(client, req.user.id, 'pricing.update', 'pricing_rule', r.vehicle_type, {
        old: {
          base_rs: Number(old.base_rs),
          per_km_rs: Number(old.per_km_rs),
          helper_rs: Number(old.helper_rs),
          commission_pct: Number(old.commission_percent),
        },
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
          commission_pct: Number(r.commission_percent),
          updated_at: r.updated_at,
        },
        history_id: hist.rows[0].id,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore — original error propagates.
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

// GET /api/admin/tracking/active (admin) — live overview: every
// accepted/arrived/in_transit booking with its newest GPS point (if any)
// and derived tracking state (live/stale/offline). No phones exposed.
adminRoutes.get('/tracking/active', async (req, res, next) => {
  try {
    const { limit } = parseTrackingQuery(trackingActivesQuerySchema, req.query);
    const rows = await query(
      `SELECT b.id, b.status, b.vehicle_type, b.pickup_address, b.drop_address,
              b.created_at, b.updated_at, b.user_id,
              d.id AS driver_id, d.name AS driver_name,
              d.vehicle_type AS driver_vehicle_type, d.vehicle_number AS driver_vehicle_number,
              u.name AS user_name,
              l.lat, l.lng, l.accuracy_m, l.speed_mps, l.heading_deg, l.recorded_at,
              (SELECT COUNT(*) FROM driver_locations dl WHERE dl.booking_id = b.id) AS points_count
        FROM bookings b
        LEFT JOIN drivers d ON d.id = b.driver_id
        LEFT JOIN users u ON u.id = b.user_id
        LEFT JOIN LATERAL (
          SELECT lat, lng, accuracy_m, speed_mps, heading_deg, recorded_at FROM driver_locations
          WHERE booking_id = b.id ORDER BY recorded_at DESC LIMIT 1
        ) l ON TRUE
        WHERE b.status IN ('accepted', 'arrived', 'in_transit')
        ORDER BY b.created_at DESC LIMIT $1`,
      [limit],
    );
    const now = Date.now();
    const actives = rows.rows.map((r) => {
      const hasPoint = r.recorded_at !== null && r.recorded_at !== undefined;
      return {
        booking_id: r.id,
        booking_status: r.status,
        vehicle_type: VEHICLE_TO_API[r.vehicle_type] ?? r.vehicle_type,
        pickup_address: r.pickup_address,
        drop_address: r.drop_address,
        user_name: r.user_name,
        driver: r.driver_id
          ? {
              id: r.driver_id,
              name: r.driver_name,
              vehicle_type: VEHICLE_TO_API[r.driver_vehicle_type] ?? r.driver_vehicle_type,
              vehicle_number: r.driver_vehicle_number,
            }
          : null,
        last_point: hasPoint
          ? {
              lat: Number(r.lat),
              lng: Number(r.lng),
              accuracy_m: r.accuracy_m === null ? null : Number(r.accuracy_m),
              speed_mps: r.speed_mps === null ? null : Number(r.speed_mps),
              heading_deg: r.heading_deg === null ? null : Number(r.heading_deg),
              recorded_at: r.recorded_at,
            }
          : null,
        tracking: {
          state: trackingState({ bookingStatus: r.status, recordedAt: r.recorded_at, now }),
          last_updated: r.recorded_at,
          age_s: hasPoint
            ? Math.max(0, Math.round((now - new Date(r.recorded_at).getTime()) / 1000))
            : null,
          points_count: Number(r.points_count),
        },
      };
    });
    const counts = { total: actives.length, live: 0, stale: 0, offline: 0 };
    for (const a of actives) {
      if (a.tracking.state === 'live') counts.live += 1;
      else if (a.tracking.state === 'stale') counts.stale += 1;
      else counts.offline += 1;
    }
    res.json({ ok: true, counts, actives });
  } catch (err) {
    next(err);
  }
});

// ---- Financial ledger: commission, payments, settlements, adjustments ----

// GET /api/admin/commission — current rate + recent change history.
adminRoutes.get('/commission', async (req, res, next) => {
  try {
    const pct = await getCommissionPct();
    const hist = await query(
      'SELECT old_pct, new_pct, changed_by, created_at FROM commission_history ORDER BY id DESC LIMIT 20',
    );
    res.json({
      ok: true,
      commission_pct: pct,
      history: hist.rows.map((h) => ({
        old_pct: h.old_pct === null ? null : Number(h.old_pct),
        new_pct: Number(h.new_pct),
        changed_by: h.changed_by,
        created_at: h.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/commission — global switch: sets ALL vehicle rates + the
// fallback setting (applies to FUTURE bookings only; past payments keep their
// snapshot). Per-vehicle fine-tuning stays in PUT /pricing-rules.
// History + audit in one transaction.
adminRoutes.put('/commission', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { pct } = parsePaymentBody(commissionUpdateSchema, req.body);
    await client.query('BEGIN');
    const cur = await client.query(`SELECT value FROM platform_settings WHERE key = 'commission' FOR UPDATE`);
    const oldPct = cur.rowCount > 0 && cur.rows[0].value?.pct !== undefined ? Number(cur.rows[0].value.pct) : null;
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ('commission', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify({ pct }), req.user.id],
    );
    await client.query('UPDATE pricing_rules SET commission_percent = $1, updated_at = now()', [pct]);
    await client.query(
      'INSERT INTO commission_history (old_pct, new_pct, changed_by) VALUES ($1, $2, $3)',
      [oldPct, pct, req.user.id],
    );
    await logAuditTx(client, req.user.id, 'commission.update', 'commission', 'commission', {
      old_pct: oldPct,
      new_pct: pct,
      scope: 'all_vehicles',
    });
    await client.query('COMMIT');
    res.json({ ok: true, commission_pct: pct, old_pct: oldPct });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/ledger — every payment + per-payment adjustments (paginated).
adminRoutes.get('/ledger', async (req, res, next) => {
  try {
    const { driver_id, status, page, limit } = parsePaymentQuery(ledgerQuerySchema, req.query);
    const offset = (page - 1) * limit;
    const conds = [];
    const params = [];
    let i = 1;
    if (driver_id) {
      conds.push(`p.driver_id = $${i++}`);
      params.push(driver_id);
    }
    if (status) {
      conds.push(`p.settlement_status = $${i++}`);
      params.push(status);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      query(
        `SELECT p.*, u.name AS user_name, d.name AS driver_name,
                COALESCE((SELECT SUM(a.commission_delta_paise) FROM payment_adjustments a WHERE a.payment_id = p.id), 0) AS adj_c,
                COALESCE((SELECT SUM(a.earning_delta_paise) FROM payment_adjustments a WHERE a.payment_id = p.id), 0) AS adj_e
          FROM payments p
          LEFT JOIN users u ON u.id = p.user_id
          LEFT JOIN drivers d ON d.id = p.driver_id
          ${where} ORDER BY p.collected_at DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM payments p ${where}`, params),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      payments: rows.rows.map((r) => ({
        id: r.id,
        booking_id: r.booking_id,
        user_name: r.user_name,
        driver_id: r.driver_id,
        driver_name: r.driver_name,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        gross_rs: Number(r.gross_amount),
        driver_earning_rs: Number(r.driver_earning),
        platform_commission_rs: Number(r.platform_commission),
        commission_pct: Number(r.commission_pct),
        adjustments_paise: { commission: Number(r.adj_c), earning: Number(r.adj_e) },
        settlement_status: r.settlement_status,
        settled_rs: Number(r.settled_amount),
        collected_at: r.collected_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/payments/:id — one transaction + its adjustment trail.
adminRoutes.get('/payments/:id', validateIdParam, async (req, res, next) => {
  try {
    const found = await query(
      `SELECT p.*, u.name AS user_name, d.name AS driver_name, b.status AS booking_status
        FROM payments p
        LEFT JOIN users u ON u.id = p.user_id
        LEFT JOIN drivers d ON d.id = p.driver_id
        LEFT JOIN bookings b ON b.id = p.booking_id
       WHERE p.id = $1`,
      [req.params.id],
    );
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const adj = await query(
      `SELECT id, commission_delta_paise, earning_delta_paise, reason, admin_id, created_at
        FROM payment_adjustments WHERE payment_id = $1 ORDER BY created_at ASC`,
      [req.params.id],
    );
    const r = found.rows[0];
    res.json({
      ok: true,
      payment: {
        id: r.id,
        booking_id: r.booking_id,
        booking_status: r.booking_status,
        user_name: r.user_name,
        driver_id: r.driver_id,
        driver_name: r.driver_name,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        gross_rs: Number(r.gross_amount),
        driver_earning_rs: Number(r.driver_earning),
        platform_commission_rs: Number(r.platform_commission),
        commission_pct: Number(r.commission_pct),
        settlement_status: r.settlement_status,
        settled_rs: Number(r.settled_amount),
        collected_at: r.collected_at,
      },
      adjustments: adj.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/driver-balances — settlement dashboard per driver.
adminRoutes.get('/driver-balances', async (req, res, next) => {
  try {
    const { page, limit } = parsePaymentQuery(settlementsQuerySchema, req.query);
    const offset = (page - 1) * limit;
    const rows = await query(
      `SELECT d.id, d.name, d.phone, d.vehicle_type,
              COUNT(p.id) AS n,
              COALESCE(SUM(p.gross_amount), 0) AS gross,
              COALESCE(SUM(p.driver_earning), 0) AS earning,
              COALESCE(SUM(p.platform_commission), 0) AS commission,
              COALESCE(SUM(p.settled_amount), 0) AS allocated,
              COALESCE((SELECT SUM(a.commission_delta_paise) FROM payment_adjustments a JOIN payments p2 ON p2.id = a.payment_id WHERE p2.driver_id = d.id), 0) AS adj_c,
              COALESCE((SELECT SUM(a.earning_delta_paise) FROM payment_adjustments a JOIN payments p2 ON p2.id = a.payment_id WHERE p2.driver_id = d.id), 0) AS adj_e,
              COALESCE((SELECT SUM(s.amount) FROM settlements s WHERE s.driver_id = d.id), 0) AS settled_tx
        FROM drivers d LEFT JOIN payments p ON p.driver_id = d.id
       GROUP BY d.id
       HAVING COUNT(p.id) > 0
       ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const drivers = await query(
      `SELECT COUNT(DISTINCT driver_id) AS total FROM payments`,
    );
    // Highest due first (settlement queue order). Computed here because
    // outstanding is derived (commission + adjustments - allocated).
    const balances = rows.rows
      .map((r) => {
        const outstandingPaise = Math.max(
          0,
          toPaise(r.commission) + Number(r.adj_c) - toPaise(r.allocated),
        );
        return {
          driver_id: r.id,
          driver_name: r.name,
          phone: r.phone,
          vehicle_type: r.vehicle_type,
          completed_cash_bookings: Number(r.n),
          cash_collected_rs: Number(r.gross),
          driver_earning_rs: paiseToRs(toPaise(r.earning) + Number(r.adj_e)),
          commission_rs: paiseToRs(toPaise(r.commission) + Number(r.adj_c)),
          settled_rs: Number(r.settled_tx),
          outstanding_rs: paiseToRs(outstandingPaise),
        };
      })
      .sort((a, b) => toPaise(b.outstanding_rs) - toPaise(a.outstanding_rs));
    res.json({
      ok: true,
      page,
      limit,
      total: Number(drivers.rows[0].total),
      balances,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/settlements — settlement history (optional driver filter).
adminRoutes.get('/settlements', async (req, res, next) => {
  try {
    const { driver_id, page, limit } = parsePaymentQuery(settlementsQuerySchema, req.query);
    const offset = (page - 1) * limit;
    const conds = [];
    const params = [];
    if (driver_id) {
      conds.push('s.driver_id = $1');
      params.push(driver_id);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      query(
        `SELECT s.*, d.name AS driver_name FROM settlements s
          LEFT JOIN drivers d ON d.id = s.driver_id
          ${where} ORDER BY s.settled_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      query(`SELECT COUNT(*) AS total FROM settlements s ${where}`, params),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      settlements: rows.rows.map((s) => ({
        id: s.id,
        driver_id: s.driver_id,
        driver_name: s.driver_name,
        amount_rs: Number(s.amount),
        method: s.method,
        reference_no: s.reference_no,
        admin_id: s.admin_id,
        notes: s.notes,
        settled_at: s.settled_at,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/settlements — record a settlement (admin only).
// Guards: driver must exist (404), amount>0 (400), amount<=outstanding (409).
// FIFO-allocates across oldest owed payments in one transaction + audit.
adminRoutes.post('/settlements', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { driver_id, amount_rs, method, reference_no, notes, settled_at } = parsePaymentBody(
      settlementCreateSchema,
      req.body,
    );
    const driver = await query('SELECT id FROM drivers WHERE id = $1', [driver_id]);
    if (driver.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    await client.query('BEGIN');
    const row = await createSettlementTx(client, {
      driverId: driver_id,
      amountPaise: toPaise(amount_rs),
      method,
      referenceNo: reference_no,
      notes,
      settledAt: settled_at,
      adminId: req.user.id,
    });
    await client.query('COMMIT');
    const balance = await driverBalance(query, driver_id);
    res.status(201).json({
      ok: true,
      settlement: {
        id: row.id,
        driver_id: row.driver_id,
        amount_rs: Number(row.amount),
        method: row.method,
        reference_no: row.reference_no,
        admin_id: row.admin_id,
        notes: row.notes,
        settled_at: row.settled_at,
        created_at: row.created_at,
      },
      outstanding_rs: balance.outstanding_rs,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

// POST /api/admin/adjustments — append-only correction (admin only).
// Never edits payments rows; outstanding math picks the deltas up.
adminRoutes.post('/adjustments', async (req, res, next) => {
  try {
    const { payment_id, commission_delta_paise, earning_delta_paise, reason } = parsePaymentBody(
      adjustmentCreateSchema,
      req.body,
    );
    const payment = await query('SELECT id FROM payments WHERE id = $1', [payment_id]);
    if (payment.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const inserted = await query(
      `INSERT INTO payment_adjustments
         (payment_id, commission_delta_paise, earning_delta_paise, reason, admin_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, payment_id, commission_delta_paise, earning_delta_paise, reason, admin_id, created_at`,
      [payment_id, commission_delta_paise, earning_delta_paise, reason, req.user.id],
    );
    await logAuditSafe(req.user.id, 'payment.adjust', 'payment', payment_id, {
      commission_delta_paise,
      earning_delta_paise,
      reason,
    });
    res.status(201).json({ ok: true, adjustment: inserted.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/stats
// bookings/cancelled count by created_at (when created), completed/revenue by
// delivered_at (when delivered) — updated_at changes on every edit, so unreliable.
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
