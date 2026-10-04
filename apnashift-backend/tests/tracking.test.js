// Live driver tracking tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips if not set. Covers: driver->DB->customer/admin flow, strict authz,
// lifecycle gating, GPS validation, throttle, stale/offline, SSE fan-out.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import {
  subscribe,
  unsubscribe,
  trackingState,
  clearThrottle,
} from '../src/services/tracking.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9890000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

function bookingPayload(over = {}) {
  return {
    pickup: { address: '12 MG Road, Indore', lat: 22.7196, lng: 75.8577 },
    drop: { address: '45 AB Road, Indore', lat: 22.7296, lng: 75.8677 },
    vehicle_type: 'mini_truck',
    helper_needed: false,
    item_description: 'samaan',
    ...over,
  };
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeDriver(phone, verified = true) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    vehicle_number: `MP${phone.slice(-8)}`,
  });
  expect(res.status).toBe(201);
  if (verified) {
    await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
  }
  return res.body;
}

async function makeAdmin(phone) {
  const hash = await bcrypt.hash('admin-pass-123', 4);
  await client.query('INSERT INTO admins (name, phone, password_hash) VALUES ($1, $2, $3)', [
    'Staff',
    phone,
    hash,
  ]);
  const res = await request(app).post('/api/admin/login').send({ phone, password: 'admin-pass-123' });
  expect(res.status).toBe(200);
  return res.body.token;
}

async function makeBooking(token, over = {}) {
  const res = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send(bookingPayload(over));
  expect(res.status).toBe(201);
  return res.body.booking;
}

async function driverAccept(driverToken, bookingId) {
  const res = await request(app)
    .patch(`/api/driver/bookings/${bookingId}/accept`)
    .set('Authorization', `Bearer ${driverToken}`);
  expect(res.status).toBe(200);
  return res.body.booking;
}

describeDb('live tracking (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    clearThrottle();
    process.env.TRACK_MIN_INTERVAL_MS = '0';
  });

  it('driver post -> DB row -> customer latest shows live + driver/vehicle (no phone)', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);

    const post = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect([200, 409]).toContain(post.status); // already accepted -> 409, fine

    const loc = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.72, lng: 75.86, accuracy_m: 12.5, speed_mps: 8.3 });
    expect(loc.status).toBe(201);
    expect(loc.body.ok).toBe(true);
    expect(loc.body.point.lat).toBe(22.72);

    const rows = await client.query('SELECT * FROM driver_locations WHERE booking_id = $1', [
      booking.id,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(Number(rows.rows[0].lat)).toBe(22.72);
    expect(rows.rows[0].recorded_at).toBeTruthy();

    const read = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(read.status).toBe(200);
    expect(read.body.tracking.state).toBe('live');
    expect(read.body.booking_status).toBe('accepted');
    expect(read.body.driver.name).toBe('Test Driver');
    expect(read.body.driver.vehicle_number).toMatch(/^MP/);
    expect(read.body.driver.phone).toBeUndefined();
    expect(read.body.points).toHaveLength(1);
  });

  it('authz — other customer 404, other driver 404, unverified driver 403, no token 401', async () => {
    const user = await makeUser(nextPhone());
    const stranger = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const otherDriver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);

    const s = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(s.status).toBe(404);

    const od = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${otherDriver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(od.status).toBe(404);

    const unv = await makeDriver(nextPhone(), false);
    const uv = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${unv.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(uv.status).toBe(403);
    expect(uv.body.error).toBe('driver_unverified');

    const anon = await request(app).get(`/api/bookings/${booking.id}/location`);
    expect(anon.status).toBe(401);

    const streamAnon = await request(app).get(`/api/bookings/${booking.id}/location/stream`);
    expect(streamAnon.status).toBe(401);
    const streamStranger = await request(app)
      .get(`/api/bookings/${booking.id}/location/stream`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(streamStranger.status).toBe(404);
  });

  it('lifecycle — pending booking 404, delivered/cancelled 409 + ended flag', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    // Not assigned yet (pending, driver_id NULL) -> 404, never 403 leak.
    const pend = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(pend.status).toBe(404);

    await driverAccept(driver.token, booking.id);
    const okPost = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(okPost.status).toBe(201);

    // Walk lifecycle to delivered via driver status API.
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      const r = await request(app)
        .patch(`/api/driver/bookings/${booking.id}/status`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ status: st });
      expect(r.status).toBe(200);
      if (st !== 'delivered') {
        const p = await request(app)
          .post(`/api/driver/bookings/${booking.id}/location`)
          .set('Authorization', `Bearer ${driver.token}`)
          .send({ lat: 22.71, lng: 75.81 });
        expect(p.status).toBe(201);
      }
    }

    const after = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.71, lng: 75.81 });
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('tracking_not_active');

    const read = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(read.body.tracking.state).toBe('ended');
    expect(read.body.tracking_active).toBe(false);

    // Cancelled booking also ends tracking.
    const booking2 = await makeBooking(user.token);
    await driverAccept(driver.token, booking2.id);
    const cancel = await request(app)
      .patch(`/api/bookings/${booking2.id}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'changed_plan' });
    expect(cancel.status).toBe(200);
    const afterCancel = await request(app)
      .post(`/api/driver/bookings/${booking2.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(afterCancel.status).toBe(409);
  });

  it('validation — bad coords rejected, history bounds enforced', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);

    for (const bad of [
      { lat: 200, lng: 75.8 },
      { lat: 22.7, lng: 300 },
      { lat: 'x', lng: 75.8 },
      { lat: 22.7, lng: 75.8, accuracy_m: -5 },
      { lat: 22.7, lng: 75.8, speed_mps: 500 },
      {},
    ]) {
      const r = await request(app)
        .post(`/api/driver/bookings/${booking.id}/location`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send(bad);
      expect(r.status).toBe(400);
    }

    const badHist = await request(app)
      .get(`/api/bookings/${booking.id}/location?history=200`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(badHist.status).toBe(400);

    // history=N returns newest-first trail.
    await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.71, lng: 75.81 });
    const h = await request(app)
      .get(`/api/bookings/${booking.id}/location?history=2`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(h.body.points).toHaveLength(2);
  });

  it('throttle — rapid posts get 429 with Retry-After', async () => {
    process.env.TRACK_MIN_INTERVAL_MS = '60000';
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);

    const first = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.7, lng: 75.8 });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.71, lng: 75.81 });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('too_many_attempts');
    expect(second.headers['retry-after']).toBeTruthy();
  });

  it('stale/offline — old points and empty trail computed, never faked', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);
    const driverRow = await client.query('SELECT id FROM drivers WHERE phone = $1', [
      driver.user.phone,
    ]);
    const driverId = driverRow.rows[0].id;

    // No points yet -> offline, last_updated null.
    const empty = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(empty.body.tracking.state).toBe('offline');
    expect(empty.body.tracking.last_updated).toBeNull();

    // 2-minute-old point -> stale.
    await client.query(
      `INSERT INTO driver_locations (booking_id, driver_id, lat, lng, recorded_at)
       VALUES ($1, $2, 22.7, 75.8, now() - INTERVAL '120 seconds')`,
      [booking.id, driverId],
    );
    const stale = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(stale.body.tracking.state).toBe('stale');
    expect(stale.body.tracking.age_s).toBeGreaterThanOrEqual(110);

    // 10-minute-old point -> offline.
    await client.query('DELETE FROM driver_locations WHERE booking_id = $1', [booking.id]);
    await client.query(
      `INSERT INTO driver_locations (booking_id, driver_id, lat, lng, recorded_at)
       VALUES ($1, $2, 22.7, 75.8, now() - INTERVAL '600 seconds')`,
      [booking.id, driverId],
    );
    const off = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(off.body.tracking.state).toBe('offline');
    // Real stored coords still returned — position never invented.
    expect(off.body.points[0].lat).toBe(22.7);
  });

  it('trackingState() unit — ended/live/stale/offline boundaries', () => {
    const now = Date.now();
    expect(trackingState({ bookingStatus: 'delivered', recordedAt: new Date(now), now })).toBe('ended');
    expect(trackingState({ bookingStatus: 'cancelled', recordedAt: new Date(now), now })).toBe('ended');
    expect(trackingState({ bookingStatus: 'accepted', recordedAt: null, now })).toBe('offline');
    expect(trackingState({ bookingStatus: 'accepted', recordedAt: new Date(now - 10 * 1000), now })).toBe(
      'live',
    );
    expect(trackingState({ bookingStatus: 'in_transit', recordedAt: new Date(now - 120 * 1000), now })).toBe(
      'stale',
    );
    expect(trackingState({ bookingStatus: 'arrived', recordedAt: new Date(now - 600 * 1000), now })).toBe(
      'offline',
    );
  });

  it('SSE fan-out — HTTP POST reaches an in-process stream subscriber', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);

    const chunks = [];
    const fakeRes = { write: (c) => chunks.push(String(c)), end: () => {} };
    const leave = subscribe(booking.id, fakeRes);
    try {
      const loc = await request(app)
        .post(`/api/driver/bookings/${booking.id}/location`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ lat: 22.72, lng: 75.86 });
      expect(loc.status).toBe(201);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('event: location');
      expect(chunks[0]).toContain('"lat":22.72');
      expect(chunks[0]).not.toContain('password');
      expect(chunks[0]).not.toContain('phone');
    } finally {
      leave();
      unsubscribe(booking.id, fakeRes);
    }
  });

  it('admin actives — sees live booking+point, counts; user 403, anon 401', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await driverAccept(driver.token, booking.id);
    await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ lat: 22.72, lng: 75.86 });

    const res = await request(app)
      .get('/api/admin/tracking/active')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.counts.total).toBe(1);
    expect(res.body.counts.live).toBe(1);
    expect(res.body.actives[0].booking_id).toBe(booking.id);
    expect(res.body.actives[0].last_point.lat).toBe(22.72);
    expect(res.body.actives[0].driver.name).toBe('Test Driver');
    expect(JSON.stringify(res.body)).not.toContain('password');

    const asUser = await request(app)
      .get('/api/admin/tracking/active')
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);

    const anon = await request(app).get('/api/admin/tracking/active');
    expect(anon.status).toBe(401);

    // Delivered booking drops out of actives.
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      await request(app)
        .patch(`/api/driver/bookings/${booking.id}/status`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ status: st });
    }
    const res2 = await request(app)
      .get('/api/admin/tracking/active')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res2.body.counts.total).toBe(0);
  });
});
