// Driver endpoints (/api/driver/...). Sab par requireAuth + driver role +
// verified driver gate. Doosre ki booking par 404 (403 nahi).
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireVerifiedDriver } from '../middleware/driver.js';
import { driverStatusSchema, paginationSchema, parseBody, parseQuery } from '../validation/booking.js';
import { DRIVER_TRANSITIONS, assertTransition } from '../services/bookingStatus.js';
import { validateIdParam } from '../utils/validate.js';
import { toPublicBooking } from './bookings.js';

export const driverRoutes = Router();

driverRoutes.use(requireAuth, requireRole('driver'), requireVerifiedDriver);

const BOOKING_COLS = `id, user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
  drop_address, drop_lat, drop_lng, vehicle_type, helper, item_description,
  scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at`;

// GET /api/driver/bookings/available (pending + apni gaadi type, purani pehle)
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
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      bookings: rows.rows.map(toPublicBooking),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/driver/bookings/:id/accept
// Do driver saath accept karein to sirf ek jeetega: ek atomic UPDATE ...
// WHERE status='pending' hi row lock karta hai, transaction ki zaroorat nahi.
driverRoutes.patch('/bookings/:id/accept', validateIdParam, async (req, res, next) => {
  try {
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
    // Booking hai par pending nahi — koi aur jeet gaya (ya cancel ho gayi).
    return res.status(409).json({ ok: false, error: 'already_accepted' });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/driver/bookings/:id/status (accepted -> arrived -> in_transit -> delivered)
driverRoutes.patch('/bookings/:id/status', validateIdParam, async (req, res, next) => {
  try {
    const { status: nextStatus } = parseBody(driverStatusSchema, req.body);

    const found = await query('SELECT id, status FROM bookings WHERE id = $1 AND driver_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    assertTransition(found.rows[0].status, nextStatus, DRIVER_TRANSITIONS);

    // delivered par delivered_at = now(), baaki steps par untouched (NULL rehta hai).
    // Conditional UPDATE (status check saath) race me double-advance rokta hai.
    const updated = await query(
      `UPDATE bookings
        SET status = $1, updated_at = now(),
            delivered_at = CASE WHEN $1 = 'delivered' THEN now() ELSE delivered_at END
       WHERE id = $2 AND driver_id = $3 AND status = $4
       RETURNING ${BOOKING_COLS}`,
      [nextStatus, req.params.id, req.user.id, found.rows[0].status],
    );
    if (updated.rowCount === 0) {
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    res.json({ ok: true, booking: toPublicBooking(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/bookings (apni history, nayi pehle)
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
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      bookings: rows.rows.map(toPublicBooking),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/earnings/weekly (pichle 7 din ki delivered kamai, delivered_at se)
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
