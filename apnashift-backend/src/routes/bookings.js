// User bookings: estimate (public) + create/list/get/cancel (role: user).
// Server always computes price — price in body is ignored
// (create schema has no price field). Other users' bookings return 404.
// POST / par optional Idempotency-Key (Option A: idempotency_keys table, per-user scope).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { query, pool } from '../db.js';
import { config } from '../config.js';
import { VEHICLE_TO_API } from '../validation/auth.js';
import {
  estimateSchema,
  bookingCreateSchema,
  ratingSchema,
  cancelSchema,
  disputeSchema,
  paginationSchema,
  parseBody,
  parseQuery,
} from '../validation/booking.js';
import { locationQuerySchema } from '../validation/tracking.js';
import {
  isTrackingActiveStatus,
  trackingState,
  staleAfterMs,
  offlineAfterMs,
  subscribe,
  publishNewBooking,
  publishAdminBooking,
  toPublicPoint,
} from '../services/tracking.js';
import { attachPayments } from '../services/payments.js';
import { ratesFor, createBookingRow } from '../services/bookings.js';
import { buildEstimate } from '../services/pricing.js';
import { parseIdempotencyKey, hashBookingRequest } from '../services/idempotency.js';
import { logAuditSafe } from '../services/audit.js';
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
  scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at,
  cancel_reason, cancelled_by, cancelled_at, payment_method,
  commission_percent, disputed, dispute_reason`;

// DB row -> API shape (vehicle snake_case, price as number).
// cancellation is null unless the booking was cancelled (012 columns;
// queries that do not select them simply yield null — never an error).
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
    cancellation:
      row.status === 'cancelled'
        ? {
            reason: row.cancel_reason ?? null,
            cancelled_by: row.cancelled_by ?? null,
            cancelled_at: row.cancelled_at ?? null,
          }
        : null,
    payment_method: row.payment_method ?? 'upi',
    booking_source: row.booking_source ?? 'WEB',
    // Creation-time commission snapshot (rate lock; null = pre-014 row).
    commission_percent: row.commission_percent === null || row.commission_percent === undefined
      ? null
      : Number(row.commission_percent),
    disputed: row.disputed ?? false,
    dispute_reason: row.dispute_reason ?? null,
    // Filled by attachPayments/attachEstimates where the endpoint supports it.
    payment: row.payment ?? null,
    estimate: row.estimate ?? null,
  };
}

// (ratesFor lives in services/bookings.js — shared with the WhatsApp flow.)

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

// NEW_BOOKING event payload — required fields only, built from the public
// booking shape. No phones/names/tokens/hashes ever enter the event.
export function newBookingEvent(row) {
  const b = toPublicBooking(row);
  return {
    booking_id: b.id,
    vehicle_type: b.vehicle_type,
    pickup: b.pickup,
    drop: b.drop,
    fare_rs: b.price_rs,
    payment_method: b.payment_method,
    status: b.status,
  };
}

// Admin event payload — admin-safe fields only (name/addresses/fare,
// never phone/hash). Same content as the admin bookings list shows.
export async function adminBookingEvent(row) {
  const u = await query('SELECT name FROM users WHERE id = $1', [row.user_id]);
  const b = toPublicBooking(row);
  return {
    booking_id: b.id,
    customer_name: u.rowCount > 0 ? u.rows[0].name : null,
    pickup: b.pickup,
    drop: b.drop,
    vehicle_type: b.vehicle_type,
    fare_rs: b.price_rs,
    payment_method: b.payment_method,
    status: b.status,
    created_at: b.created_at,
  };
}

// POST /api/bookings (user) — server computes price, not the client.
// Optional Idempotency-Key: first success replays (201 -> 200, same booking).
// Same key + different payload returns 422 idempotency_conflict. Per-user scope.
bookingsRoutes.post('/', requireAuth, requireRole('user'), writeLimiter, async (req, res, next) => {
  try {
    const { pickup, drop, vehicle_type, helper_needed, item_description, scheduled_time, payment_method } =
      parseBody(bookingCreateSchema, req.body);
    // Online gateway exists nahi — architecture ready hai (column + CHECK),
    // par creation abhi cash/upi-only hai (customer driver ko direct deta hai).
    if (payment_method !== 'cash' && payment_method !== 'upi') {
      return res.status(400).json({ ok: false, error: 'unsupported_payment_method' });
    }
    const idempotencyKey = parseIdempotencyKey(req);

    // Creation itself lives in services/bookings.js (shared with the
    // WhatsApp flow). Estimate + snapshot + INSERT move together.
    const coreArgs = {
      userId: req.user.id,
      vehicleType: vehicle_type,
      pickup,
      drop,
      helperNeeded: helper_needed,
      itemDescription: item_description,
      scheduledAt: scheduled_time,
      paymentMethod: payment_method,
      source: 'WEB',
    };

    // Without key: direct insert (legacy flow).
    if (!idempotencyKey) {
      const inserted = { rows: [await createBookingRow(query, coreArgs)] };
      // Genuinely new booking -> notify subscribed drivers (replays never emit).
      publishNewBooking(inserted.rows[0].vehicle_type, newBookingEvent(inserted.rows[0]));
      publishAdminBooking('new_booking', await adminBookingEvent(inserted.rows[0]));
      // Auditable dispatch trail (one row per real booking, never on replay).
      // admin_id stays NULL (creator is a customer, not staff) — user goes in details.
      await logAuditSafe(null, 'booking.created', 'booking', inserted.rows[0].id, {
        user_id: req.user.id,
        vehicle_type,
        price_rs: inserted.rows[0].price_rs,
      });
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

    // Fast path: known key returns the same booking (payload must match).
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

    // New key: booking + key in one transaction (one winner on race).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = { rows: [await createBookingRow(client.query.bind(client), coreArgs)] };
      try {
        await client.query(
          'INSERT INTO idempotency_keys (user_id, key, booking_id, request_hash) VALUES ($1, $2, $3, $4)',
          [req.user.id, idempotencyKey, inserted.rows[0].id, requestHash],
        );
      } catch (keyErr) {
        // Race: concurrent requests, second key committed first.
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
      // Genuinely new booking -> notify subscribed drivers (replays never emit).
      publishNewBooking(inserted.rows[0].vehicle_type, newBookingEvent(inserted.rows[0]));
      publishAdminBooking('new_booking', await adminBookingEvent(inserted.rows[0]));
      // Auditable dispatch trail (one row per real booking, never on replay).
      // admin_id stays NULL (creator is a customer, not staff) — user goes in details.
      await logAuditSafe(null, 'booking.created', 'booking', inserted.rows[0].id, {
        user_id: req.user.id,
        vehicle_type,
        price_rs: inserted.rows[0].price_rs,
      });
      return res.status(201).json({ ok: true, booking: toPublicBooking(inserted.rows[0]) });
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

// GET /api/bookings (user, own — paginated)
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
      bookings: await attachPayments(rows.rows.map(toPublicBooking), 'user'),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id (user, own — others return 404, not 403)
bookingsRoutes.get('/:id', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const found = await query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1 AND user_id = $2`, [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const [booking] = await attachPayments([toPublicBooking(found.rows[0])], 'user');
    // Accepted ya aage: assigned driver ka UPI ID (upi payment par frontend dikhayega).
    if (booking.driver_id && ['accepted', 'arrived', 'in_transit', 'delivered'].includes(booking.status)) {
      const d = await query(
        'SELECT id, name, vehicle_type, vehicle_number, upi_id FROM drivers WHERE id = $1',
        [booking.driver_id],
      );
      if (d.rowCount > 0) {
        booking.driver = {
          id: d.rows[0].id,
          name: d.rows[0].name,
          vehicle_type: VEHICLE_TO_API[d.rows[0].vehicle_type] ?? d.rows[0].vehicle_type,
          vehicle_number: d.rows[0].vehicle_number,
          upi_id: d.rows[0].upi_id,
        };
      }
    }
    res.json({ ok: true, booking });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/flag-dispute (role: user, apni booking)
// Sirf flag hai — commission/paisa auto-change nahi hota, admin review karta hai.
bookingsRoutes.post('/:id/flag-dispute', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const { reason } = parseBody(disputeSchema, req.body);
    const found = await query('SELECT id FROM bookings WHERE id = $1 AND user_id = $2', [
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
    const [booking] = await attachPayments([toPublicBooking(updated.rows[0])], 'user');
    res.json({ ok: true, booking });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/cancel (pending/accepted only, reason required)
// Atomic: one conditional UPDATE flips status + records reason/by/at together,
// so a concurrent driver advance (accepted->arrived) can only win or lose —
// never half-cancel. Booking row + history preserved (never deleted).
// arrived/in_transit/delivered/cancelled -> 409 (non-cancellable stage).
bookingsRoutes.patch('/:id/cancel', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const { reason } = parseBody(cancelSchema, req.body);
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
      `UPDATE bookings
         SET status = 'cancelled', cancel_reason = $1, cancelled_by = 'user',
             cancelled_at = now(), updated_at = now()
       WHERE id = $2 AND user_id = $3 AND status IN ('pending', 'accepted')
       RETURNING ${BOOKING_COLS}`,
      [reason, req.params.id, req.user.id],
    );
    if (updated.rowCount === 0) {
      // Race: driver advanced accepted->arrived in between.
      return res.status(409).json({ ok: false, error: 'invalid_transition' });
    }
    publishAdminBooking('booking_status', {
      booking_id: updated.rows[0].id,
      status: 'cancelled',
      driver_id: updated.rows[0].driver_id,
    });
    res.json({ ok: true, booking: toPublicBooking(updated.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/rating (user, own delivered booking, once only)
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
      // Race on concurrent requests: unique violation -> same 409.
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

// GET /api/bookings/:id/rating (user, own booking — apni rating dekho)
// Rated hai to 200 + rating, nahi di to 404 not_rated. Doosre ki booking 404.
bookingsRoutes.get('/:id/rating', requireAuth, requireRole('user'), validateIdParam, async (req, res, next) => {
  try {
    const found = await query('SELECT id FROM bookings WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const existing = await query(
      'SELECT id, booking_id, stars, comment, created_at FROM ratings WHERE booking_id = $1',
      [req.params.id],
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_rated' });
    }
    const r = existing.rows[0];
    res.json({
      ok: true,
      rating: {
        id: r.id,
        booking_id: r.booking_id,
        stars: r.stars,
        comment: r.comment,
        created_at: r.created_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Shared helper: own booking + assigned driver (public fields only —
// never phone/hash) + recent GPS points. Others' bookings -> 404.
async function trackingSnapshot(bookingId, userId, history) {
  const found = await query(
    `SELECT id, user_id, driver_id, status FROM bookings WHERE id = $1 AND user_id = $2`,
    [bookingId, userId],
  );
  if (found.rowCount === 0) return null;
  const booking = found.rows[0];

  let driver = null;
  if (booking.driver_id) {
    const d = await query(
      'SELECT id, name, vehicle_type, vehicle_number, upi_id FROM drivers WHERE id = $1',
      [booking.driver_id],
    );
    if (d.rowCount > 0) {
      driver = {
        id: d.rows[0].id,
        name: d.rows[0].name,
        vehicle_type: VEHICLE_TO_API[d.rows[0].vehicle_type] ?? d.rows[0].vehicle_type,
        vehicle_number: d.rows[0].vehicle_number,
        // UPI ID sirf accepted ya aage (cancelled/pending me nahi).
        upi_id: ['accepted', 'arrived', 'in_transit', 'delivered'].includes(booking.status)
          ? d.rows[0].upi_id
          : null,
      };
    }
  }

  const points = await query(
    `SELECT lat, lng, accuracy_m, speed_mps, heading_deg, recorded_at FROM driver_locations
      WHERE booking_id = $1 ORDER BY recorded_at DESC LIMIT $2`,
    [bookingId, history],
  );
  const latest = points.rows[0] ?? null;
  const now = Date.now();
  const state = trackingState({ bookingStatus: booking.status, recordedAt: latest?.recorded_at, now });
  return {
    booking_id: booking.id,
    booking_status: booking.status,
    tracking_active: isTrackingActiveStatus(booking.status),
    tracking: {
      state,
      last_updated: latest?.recorded_at ?? null,
      age_s: latest ? Math.max(0, Math.round((now - new Date(latest.recorded_at).getTime()) / 1000)) : null,
      points_count: Number(points.rowCount),
      // Server thresholds so the frontend badge never drifts from backend
      // when TRACK_STALE/OFFLINE_AFTER_MS are tuned via env.
      stale_after_ms: staleAfterMs(),
      offline_after_ms: offlineAfterMs(),
    },
    driver,
    points: points.rows.map(toPublicPoint),
  };
}

// GET /api/bookings/:id/location?history=N (user, own booking)
bookingsRoutes.get(
  '/:id/location',
  requireAuth,
  requireRole('user'),
  validateIdParam,
  async (req, res, next) => {
    try {
      const { history } = parseQuery(locationQuerySchema, req.query);
      const snap = await trackingSnapshot(req.params.id, req.user.id, history);
      if (!snap) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.json({ ok: true, ...snap });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/bookings/:id/location/stream (user, own booking — SSE live feed)
// Auth via Authorization header (frontend uses fetch, not EventSource).
// Emits `event: snapshot` once, then `event: location` per driver post.
// Frontend also polls GET .../location as fallback; stale badge is derived
// from last_updated on both ends — never synthesized server-side.
bookingsRoutes.get(
  '/:id/location/stream',
  requireAuth,
  requireRole('user'),
  validateIdParam,
  async (req, res, next) => {
    try {
      const snap = await trackingSnapshot(req.params.id, req.user.id, 1);
      if (!snap) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);

      const leave = subscribe(req.params.id, res);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          // closed below.
        }
      }, 25000);
      heartbeat.unref?.();

      req.on('close', () => {
        clearInterval(heartbeat);
        leave();
      });
    } catch (err) {
      next(err);
    }
  },
);
