// User bookings: estimate (public) + create/list/get/cancel (role: user).
// Price hamesha server ginata hai — body me price bhejo to ignore hoga
// (create schema me price field hai hi nahi). Doosre user ki booking par 404.
// POST / par optional Idempotency-Key (Option A: idempotency_keys table, per-user scope).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { query, pool } from '../db.js';
import { config } from '../config.js';
import { VEHICLE_TO_DB, VEHICLE_TO_API } from '../validation/auth.js';
import {
  estimateSchema,
  bookingCreateSchema,
  ratingSchema,
  paginationSchema,
  parseBody,
  parseQuery,
} from '../validation/booking.js';
import { buildEstimate } from '../services/pricing.js';
import { parseIdempotencyKey, hashBookingRequest } from '../services/idempotency.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateIdParam } from '../utils/validate.js';
import { writeLimiter } from '../middleware/writeLimiter.js';

export const bookingsRoutes = Router();

const estimateLimiter = rateLimit({
  windowMs: config.estimateRateLimitWindowMs,
  limit: config.estimateRateLimitMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});

const BOOKING_COLS = `id, user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
  drop_address, drop_lat, drop_lng, vehicle_type, helper, item_description,
  scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at`;

// DB row -> API shape (vehicle snake_case, price number me).
export function toPublicBooking(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    driver_id: row.driver_id,
    pickup: { address: row.pickup_address, lat: row.pickup_lat, lng: row.pickup_lng },
    drop: { address: row.drop_address, lat: row.drop_lat, lng: row.drop_lng },
    vehicle_type: VEHICLE_TO_API[row.vehicle_type] ?? row.vehicle_type,
    helper_needed: row.helper,
    item_description: row.item_description,
    scheduled_time: row.scheduled_at,
    delivered_at: row.delivered_at,
    distance_km: Number(row.distance_km),
    price_rs: Number(row.price_rs),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function ratesFor(vehicleType) {
  const found = await query(
    'SELECT base_rs, per_km_rs, helper_rs FROM pricing_rules WHERE vehicle_type = $1',
    [VEHICLE_TO_DB[vehicleType]],
  );
  if (found.rowCount === 0) {
    const err = new Error('unknown_vehicle');
    err.status = 400;
    throw err;
  }
  const rule = found.rows[0];
  return {
    [vehicleType]: {
      baseRs: Number(rule.base_rs),
      perKmRs: Number(rule.per_km_rs),
      helperRs: Number(rule.helper_rs),
    },
  };
}

// POST /api/bookings/estimate-price (public)
bookingsRoutes.post('/estimate-price', estimateLimiter, async (req, res, next) => {
  try {
    const { pickup, drop, vehicle_type, helper_needed } = parseBody(estimateSchema, req.body);

    const estimate = await buildEstimate({
      pickup,
      drop,
      vehicleType: vehicle_type,
      helperNeeded: helper_needed,
      rates: await ratesFor(vehicle_type),
    });
    res.json({ ok: true, ...estimate });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings (user) — price server ginata hai, client ka nahi.
// Optional Idempotency-Key: pehli success replay hoti hai (201 -> 200, same booking).
// Same key + alag payload par 422 idempotency_conflict. Scope per-user hai.
bookingsRoutes.post('/', requireAuth, requireRole('user'), writeLimiter, async (req, res, next) => {
  try {
    const { pickup, drop, vehicle_type, helper_needed, item_description, scheduled_time } =
      parseBody(bookingCreateSchema, req.body);
    const idempotencyKey = parseIdempotencyKey(req);

    const estimate = await buildEstimate({
      pickup: { lat: pickup.lat, lng: pickup.lng },
      drop: { lat: drop.lat, lng: drop.lng },
      vehicleType: vehicle_type,
      helperNeeded: helper_needed,
      rates: await ratesFor(vehicle_type),
    });

    const bookingParams = [
      req.user.id,
      VEHICLE_TO_DB[vehicle_type],
      pickup.address,
      pickup.lat,
      pickup.lng,
      drop.address,
      drop.lat,
      drop.lng,
      estimate.distance_km,
      helper_needed,
      item_description,
      scheduled_time ? new Date(scheduled_time) : null,
      estimate.total,
    ];
    const insertSql = `INSERT INTO bookings
        (user_id, vehicle_type, pickup_address, pickup_lat, pickup_lng,
         drop_address, drop_lat, drop_lng, distance_km, helper,
         item_description, scheduled_at, price_rs, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
       RETURNING ${BOOKING_COLS}`;

    // Bina key: seedha insert (purana flow).
    if (!idempotencyKey) {
      const inserted = await query(insertSql, bookingParams);
      return res.status(201).json({ ok: true, booking: toPublicBooking(inserted.rows[0]) });
    }

    const requestHash = hashBookingRequest({
      pickup,
      drop,
      vehicle_type,
      helper_needed,
      item_description,
      scheduled_time,
    });

    // Fast path: key pehle dekhi hai to wahi booking wapas (payload same hona chahiye).
    const seen = await query(
      'SELECT booking_id, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [req.user.id, idempotencyKey],
    );
    if (seen.rowCount > 0) {
      if (seen.rows[0].request_hash !== requestHash) {
        return res.status(422).json({ ok: false, error: 'idempotency_conflict' });
      }
      const found = await query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [
        seen.rows[0].booking_id,
      ]);
      if (found.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      return res.status(200).json({ ok: true, booking: toPublicBooking(found.rows[0]) });
    }

    // Nayi key: booking + key ek transaction me (race me ek jeetega).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(insertSql, bookingParams);
      try {
        await client.query(
          'INSERT INTO idempotency_keys (user_id, key, booking_id, request_hash) VALUES ($1, $2, $3, $4)',
          [req.user.id, idempotencyKey, inserted.rows[0].id, requestHash],
        );
      } catch (keyErr) {
        // Race: do request saath aayi, doosri key pehle commit ho gayi.
        if (keyErr.code === '23505') {
          await client.query('ROLLBACK');
          const winner = await query(
            'SELECT booking_id, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2',
            [req.user.id, idempotencyKey],
          );
          if (winner.rowCount === 0) throw keyErr;
          if (winner.rows[0].request_hash !== requestHash) {
            return res.status(422).json({ ok: false, error: 'idempotency_conflict' });
          }
          const wBooking = await query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [
            winner.rows[0].booking_id,
          ]);
          return res.status(200).json({ ok: true, booking: toPublicBooking(wBooking.rows[0]) });
        }
        throw keyErr;
      }
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, booking: toPublicBooking(inserted.rows[0]) });
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

// GET /api/bookings (user, apni — paginated)
bookingsRoutes.get('/', requireAuth, requireRole('user'), async (req, res, next) => {
  try {
    const { page, limit } = parseQuery(paginationSchema, req.query);
    const offset = (page - 1) * limit;

    const [rows, count] = await Promise.all([
      query(
        `SELECT ${BOOKING_COLS} FROM bookings
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset],
      ),
      query('SELECT COUNT(*) AS total FROM bookings WHERE user_id = $1', [req.user.id]),
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

// GET /api/bookings/:id (user, apni — doosre ki ho to 404, 403 nahi)
bookingsRoutes.get('/:id', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const found = await query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.json({ ok: true, booking: toPublicBooking(found.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/cancel (sirf pending/accepted me)
bookingsRoutes.patch('/:id/cancel', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const found = await query('SELECT id, status FROM bookings WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (!['pending', 'accepted'].includes(found.rows[0].status)) {
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    const updated = await query(
      `UPDATE bookings SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'accepted')
       RETURNING ${BOOKING_COLS}`,
      [req.params.id, req.user.id],
    );
    if (updated.rowCount === 0) {
      // Race: beech me driver ne utha liya.
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    res.json({ ok: true, booking: toPublicBooking(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/rating (user, apni delivered booking, sirf ek baar)
bookingsRoutes.post('/:id/rating', requireAuth, requireRole('user'), validateIdParam, writeLimiter, async (req, res, next) => {
  try {
    const { stars, comment } = parseBody(ratingSchema, req.body);

    const found = await query(
      'SELECT id, user_id, driver_id, status FROM bookings WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id],
    );
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const booking = found.rows[0];
    if (booking.status !== 'delivered') {
      return res.status(409).json({ ok: false, error: 'not_delivered' });
    }
    if (!booking.driver_id) {
      return res.status(400).json({ ok: false, error: 'no_driver' });
    }

    const existing = await query('SELECT id FROM ratings WHERE booking_id = $1', [booking.id]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'already_rated' });
    }

    let inserted;
    try {
      inserted = await query(
        `INSERT INTO ratings (booking_id, user_id, driver_id, stars, comment)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, booking_id, stars, comment, created_at`,
        [booking.id, req.user.id, booking.driver_id, stars, comment ? comment : null],
      );
    } catch (err) {
      // Race me do request saath aayein to unique violation -> same 409.
      if (err.code === '23505') {
        return res.status(409).json({ ok: false, error: 'already_rated' });
      }
      throw err;
    }
    const row = inserted.rows[0];
    res.status(201).json({
      ok: true,
      rating: {
        id: row.id,
        booking_id: row.booking_id,
        stars: row.stars,
        comment: row.comment,
        created_at: row.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});
