// Driver endpoints (/api/driver/...). All require auth + driver role +
// verified driver gate. Other bookings return 404 (not 403).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { query, pool } from '../db.js';
import { config } from '../config.js';
import {
  resolveBookingCommissionPct,
  vehicleCommissionMap,
  insertPaymentTx,
  attachPayments,
  attachEstimates,
  driverBalance,
} from '../services/payments.js';
import { paiseToRs } from '../services/money.js';
import { logAuditSafe } from '../services/audit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireVerifiedDriver } from '../middleware/driver.js';
import { driverStatusSchema, disputeSchema, paginationSchema, parseBody, parseQuery } from '../validation/booking.js';
import { driverProfileSchema } from '../validation/auth.js';
import { locationReportSchema } from '../validation/tracking.js';
import { DRIVER_TRANSITIONS, assertTransition } from '../services/bookingStatus.js';
import {
  isTrackingActiveStatus,
  checkThrottle,
  publish,
  toPublicPoint,
} from '../services/tracking.js';
import { validateIdParam } from '../utils/validate.js';
import { toPublicBooking } from './bookings.js';

// Dedicated GPS limiter: a fix every few seconds must not trip the
// generic write limiter. Per-IP second layer (throttle below is per-driver).
const trackingLimiter = rateLimit({
  windowMs: config.trackRateLimitWindowMs,
  limit: config.trackRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});

export const driverRoutes = Router();

// PATCH /api/driver/profile — deliberately BEFORE the verified gate:
// PENDING_REVIEW driver bhi apna UPI ID jod sakta hai (sirf apni row,
// sirf upi_id — verification state se koi lena-dena nahi).
driverRoutes.patch('/profile', requireAuth, requireRole('driver'), async (req, res, next) => {
  try {
    const { upi_id } = parseBody(driverProfileSchema, req.body);
    let updated;
    try {
      updated = await query(
        `UPDATE drivers SET upi_id = $1 WHERE id = $2
         RETURNING id, name, phone, vehicle_type, vehicle_number, is_verified, upi_id`,
        [upi_id ?? null, req.user.id],
      );
    } catch (err) {
      if (err.code === '23514') {
        err.status = 400;
        err.message = 'validation_failed';
      }
      throw err;
    }
    if (updated.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const r = updated.rows[0];
    res.json({
      ok: true,
      driver: {
        id: r.id,
        name: r.name,
        phone: r.phone,
        vehicle_type: r.vehicle_type,
        vehicle_number: r.vehicle_number,
        is_verified: r.is_verified,
        upi_id: r.upi_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

driverRoutes.use(requireAuth, requireRole('driver'), requireVerifiedDriver);

const BOOKING_COLS = `id, user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
  drop_address, drop_lat, drop_lng, vehicle_type, helper, item_description,
  scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at,
  cancel_reason, cancelled_by, cancelled_at, payment_method,
  commission_percent, disputed, dispute_reason`;

// Estimates resolve the locked rate: booking snapshot -> vehicle -> global.
// Snapshot lives on the public booking (set at creation, never rewritten).
async function estimateResolver() {
  const { map, fallback } = await vehicleCommissionMap();
  return (item) => {
    if (item.commission_percent !== null && item.commission_percent !== undefined) {
      return Number(item.commission_percent);
    }
    // Public bookings carry API snake_case; rate map keys are DB display form.
    return map.get(vehicleToDb(item.vehicle_type)) ?? fallback;
  };
}

// API snake_case vehicle -> DB display form for the rate map lookup.
function vehicleToDb(api) {
  if (api === 'pickup') return 'Pickup';
  if (api === 'mini_truck') return 'Mini Truck';
  if (api === 'mini_tractor') return 'Mini Tractor';
  return api;
}

// COMMISSION_DUE_LIMIT (Rs): outstanding se zyada baaki ho to naya accept
// block. Env per-request padhte hain taaki tests tune kar saken.
function dueLimitPaise() {
  const raw = process.env.COMMISSION_DUE_LIMIT ?? config.commissionDueLimitRs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 150000;
}

// GET /api/driver/bookings/available (pending + own vehicle type, oldest first)
driverRoutes.get('/bookings/available', async (req, res, next) => {
  try {
    const { page, limit } = parseQuery(paginationSchema, req.query);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      query(
        `SELECT ${BOOKING_COLS} FROM bookings
         WHERE status = 'pending' AND vehicle_type = $1
         ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
        [req.driver.vehicle_type, limit, offset],
      ),
      query(
        `SELECT COUNT(*) AS total FROM bookings
         WHERE status = 'pending' AND vehicle_type = $1`,
        [req.driver.vehicle_type],
      ),
    ]);
    // Pending trips have no payment yet — server-computed estimate
    // (fare + method + commission + earning). Frontend never calculates.
    const bookings = await attachPayments(rows.rows.map(toPublicBooking), 'driver');
    await attachEstimates(bookings, await estimateResolver());
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/driver/bookings/:id/accept
// Concurrent accepts: only one wins via a single atomic UPDATE ...
// WHERE status='pending' locks the row, no transaction needed.
// Commission-due gate: outstanding > COMMISSION_DUE_LIMIT pehle hisab clear karo.
driverRoutes.patch('/bookings/:id/accept', validateIdParam, async (req, res, next) => {
  try {
    const balance = await driverBalance(query, req.user.id);
    if (balance.outstanding_paise > dueLimitPaise()) {
      return res.status(403).json({
        ok: false,
        error: 'commission_limit_exceeded',
        outstanding_rs: balance.outstanding_rs,
        limit_rs: paiseToRs(dueLimitPaise()),
      });
    }
    const accepted = await query(
      `UPDATE bookings SET driver_id = $1, status = 'accepted', updated_at = now()
       WHERE id = $2 AND status = 'pending' AND vehicle_type = $3
       RETURNING ${BOOKING_COLS}`,
      [req.user.id, req.params.id, req.driver.vehicle_type],
    );
    if (accepted.rowCount > 0) {
      return res.json({ ok: true, booking: toPublicBooking(accepted.rows[0]) });
    }

    const found = await query('SELECT id, status, vehicle_type FROM bookings WHERE id = $1', [
      req.params.id,
    ]);
    if (found.rowCount === 0 || found.rows[0].vehicle_type !== req.driver.vehicle_type) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    // Booking exists but is not pending — someone else won (or it was cancelled).
    return res.status(409).json({ ok: false, error: 'already_accepted' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/driver/bookings/:id/status (accepted -> arrived -> in_transit -> delivered)
// Delivered also mints the immutable cash payment (same transaction):
// gross = booking price (never client input), rate = booking creation-time
// snapshot (never live rate, never driver input).
// Conditional UPDATE still prevents double-advance on races.
driverRoutes.patch('/bookings/:id/status', validateIdParam, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { status: nextStatus } = parseBody(driverStatusSchema, req.body);

    await client.query('BEGIN');
    const found = await client.query(
      'SELECT id, status FROM bookings WHERE id = $1 AND driver_id = $2 FOR UPDATE',
      [req.params.id, req.user.id],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    assertTransition(found.rows[0].status, nextStatus, DRIVER_TRANSITIONS);

    // delivered sets delivered_at = now(), other steps leave it untouched (NULL).
    const updated = await client.query(
      `UPDATE bookings
        SET status = $1, updated_at = now(),
            delivered_at = CASE WHEN $1 = 'delivered' THEN now() ELSE delivered_at END
       WHERE id = $2 AND driver_id = $3 AND status = $4
       RETURNING ${BOOKING_COLS}`,
      [nextStatus, req.params.id, req.user.id, found.rows[0].status],
    );
    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }

    let payment = null;
    if (nextStatus === 'delivered') {
      const row = updated.rows[0];
      // CORE RULE: snapshot (creation) -> vehicle rule -> global. Live rate
      // ya driver input kabhi nahi. Pre-014 rows me snapshot NULL hota hai.
      const snapshotPct = await resolveBookingCommissionPct(
        { snapshot: row.commission_percent, vehicleDb: row.vehicle_type },
        client.query.bind(client),
      );
      payment = await insertPaymentTx(client, {
        bookingId: row.id,
        userId: row.user_id,
        driverId: row.driver_id,
        grossRs: row.price_rs,
        paymentMethod: row.payment_method ?? 'upi',
        commissionPct: snapshotPct,
      });
    }
    await client.query('COMMIT');

    if (payment) {
      // Best-effort: delivery succeeds even if audit fails. COD stays
      // 'pending' until the driver confirms — never logged as collected here.
      await logAuditSafe(null, payment.payment_status === 'collected' ? 'payment.collected' : 'payment.created', 'payment', payment.id, {
        booking_id: payment.booking_id,
        gross_rs: Number(payment.gross_amount),
      });
    }
    const [booking] = await attachPayments([toPublicBooking(updated.rows[0])], 'driver');
    res.json({ ok: true, booking });
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

// GET /api/driver/commission-due — apna baaki commission (ledger summary se).
driverRoutes.get('/commission-due', async (req, res, next) => {
  try {
    const balance = await driverBalance(query, req.user.id);
    res.json({
      ok: true,
      outstanding_rs: balance.outstanding_rs,
      outstanding_paise: balance.outstanding_paise,
      commission_rs: balance.commission_rs,
      settled_rs: balance.settled_rs,
      limit_rs: paiseToRs(dueLimitPaise()),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/bookings/:id/flag-dispute — apni assigned trip par flag.
// Sirf flag hai — commission/paisa auto-change nahi hota.
driverRoutes.post('/bookings/:id/flag-dispute', validateIdParam, async (req, res, next) => {
  try {
    const { reason } = parseBody(disputeSchema, req.body);
    const found = await query('SELECT id FROM bookings WHERE id = $1 AND driver_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const updated = await query(
      `UPDATE bookings SET disputed = TRUE, dispute_reason = $1, updated_at = now()
        WHERE id = $2 RETURNING ${BOOKING_COLS}`,
      [reason, req.params.id],
    );
    const [booking] = await attachPayments([toPublicBooking(updated.rows[0])], 'driver');
    res.json({ ok: true, booking });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/ledger — own money: summary + payments + settlements.
// Summary is derived live (no stored balance can drift or be rewritten).
driverRoutes.get('/ledger', async (req, res, next) => {
  try {
    const [summary, payments, settlements] = await Promise.all([
      driverBalance(query, req.user.id),
      query(
        `SELECT p.id, p.booking_id, p.payment_method, p.payment_status, p.gross_amount,
                p.driver_earning, p.platform_commission, p.commission_pct,
                p.settlement_status, p.settled_amount, p.collected_at,
                b.status AS booking_status
          FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE p.driver_id = $1 ORDER BY p.collected_at DESC LIMIT 50`,
        [req.user.id],
      ),
      query(
        `SELECT id, amount, method, reference_no, notes, settled_at, created_at
          FROM settlements WHERE driver_id = $1 ORDER BY settled_at DESC LIMIT 50`,
        [req.user.id],
      ),
    ]);
    res.json({
      ok: true,
      summary,
      payments: payments.rows.map((r) => ({
        id: r.id,
        booking_id: r.booking_id,
        booking_status: r.booking_status,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        gross_rs: Number(r.gross_amount),
        driver_earning_rs: Number(r.driver_earning),
        platform_commission_rs: Number(r.platform_commission),
        commission_pct: Number(r.commission_pct),
        settlement_status: r.settlement_status,
        settled_rs: Number(r.settled_amount),
        collected_at: r.collected_at,
      })),
      settlements: settlements.rows.map((s) => ({
        id: s.id,
        amount_rs: Number(s.amount),
        method: s.method,
        reference_no: s.reference_no,
        notes: s.notes,
        settled_at: s.settled_at,
        created_at: s.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/bookings (own history, newest first)
driverRoutes.get('/bookings', async (req, res, next) => {
  try {
    const { page, limit } = parseQuery(paginationSchema, req.query);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      query(
        `SELECT ${BOOKING_COLS} FROM bookings
         WHERE driver_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset],
      ),
      query('SELECT COUNT(*) AS total FROM bookings WHERE driver_id = $1', [req.user.id]),
    ]);
    // Actual payment where delivered; estimate where still active.
    const bookings = await attachPayments(rows.rows.map(toPublicBooking), 'driver');
    await attachEstimates(bookings, await estimateResolver());
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      bookings,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/driver/bookings/:id/location (live GPS during ACTIVE booking)
// Only the assigned driver, only while accepted/arrived/in_transit.
// pending (unassigned) -> 404, delivered/cancelled -> 409 tracking_not_active,
// too-frequent posts -> 429. Insert + fan-out to SSE subscribers.
driverRoutes.post(
  '/bookings/:id/location',
  validateIdParam,
  trackingLimiter,
  async (req, res, next) => {
    try {
      const { lat, lng, accuracy_m, speed_mps, heading_deg } = parseBody(locationReportSchema, req.body);

      const found = await query('SELECT id, status, driver_id FROM bookings WHERE id = $1 AND driver_id = $2', [
        req.params.id,
        req.user.id,
      ]);
      if (found.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const booking = found.rows[0];
      if (!isTrackingActiveStatus(booking.status)) {
        return res.status(409).json({ ok: false, error: 'tracking_not_active' });
      }

      const gate = checkThrottle(req.user.id, booking.id);
      if (!gate.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))));
        return res.status(429).json({ ok: false, error: 'too_many_attempts' });
      }

      const inserted = await query(
        `INSERT INTO driver_locations (booking_id, driver_id, lat, lng, accuracy_m, speed_mps, heading_deg)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING lat, lng, accuracy_m, speed_mps, heading_deg, recorded_at`,
        [booking.id, req.user.id, lat, lng, accuracy_m ?? null, speed_mps ?? null, heading_deg ?? null],
      );
      const point = toPublicPoint(inserted.rows[0]);
      publish(booking.id, {
        booking_id: booking.id,
        booking_status: booking.status,
        point,
      });
      res.status(201).json({ ok: true, tracking: 'active', point });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/driver/earnings/weekly (last 7 days delivered earnings, via delivered_at)
driverRoutes.get('/earnings/weekly', async (req, res, next) => {
  try {
    const result = await query(
      `SELECT COUNT(*) AS completed_count, COALESCE(SUM(price_rs), 0) AS total_rs
       FROM bookings
       WHERE driver_id = $1 AND status = 'delivered'
         AND delivered_at >= now() - INTERVAL '7 days'`,
      [req.user.id],
    );
    res.json({
      ok: true,
      period: '7d',
      completed_count: Number(result.rows[0].completed_count),
      earnings_rs: Number(result.rows[0].total_rs),
    });
  } catch (err) {
    next(err);
  }
});
