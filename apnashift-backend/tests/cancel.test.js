// Customer booking-cancellation tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips if not set. Covers: ownership, reason required + fixed set,
// non-cancellable stages, atomic meta, preservation, view updates, tracking end.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9895000000;
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

const cancel = (token, id, body) =>
  request(app)
    .patch(`/api/bookings/${id}/cancel`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describeDb('customer cancellation (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
  });

  it('pending cancel with reason -> meta recorded, row preserved', async () => {
    const user = await makeUser(nextPhone());
    const booking = await makeBooking(user.token);
    const res = await cancel(user.token, booking.id, { reason: 'changed_plan' });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');
    expect(res.body.booking.cancellation.reason).toBe('changed_plan');
    expect(res.body.booking.cancellation.cancelled_by).toBe('user');
    expect(res.body.booking.cancellation.cancelled_at).toBeTruthy();

    // Preserved: still readable, with history intact.
    const got = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(got.status).toBe(200);
    expect(got.body.booking.status).toBe('cancelled');
    expect(got.body.booking.cancellation.reason).toBe('changed_plan');

    const row = await client.query(
      'SELECT status, cancel_reason, cancelled_by, cancelled_at, driver_id FROM bookings WHERE id = $1',
      [booking.id],
    );
    expect(row.rows[0].status).toBe('cancelled');
    expect(row.rows[0].cancelled_by).toBe('user');

    // Cancelled trip cannot be rated.
    const rate = await request(app)
      .post(`/api/bookings/${booking.id}/rating`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ stars: 5 });
    expect(rate.status).toBe(409);
  });

  it('accepted (driver assigned) cancel keeps driver + reason; driver view shows it', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    const acc = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(acc.status).toBe(200);

    const res = await cancel(user.token, booking.id, { reason: 'driver_issue' });
    expect(res.status).toBe(200);
    expect(res.body.booking.driver_id).toBe(driver.user.id);
    expect(res.body.booking.cancellation.reason).toBe('driver_issue');

    // Driver's own history reflects the cancellation + reason.
    const mine = await request(app)
      .get('/api/driver/bookings?limit=20')
      .set('Authorization', `Bearer ${driver.token}`);
    expect(mine.status).toBe(200);
    const row = mine.body.bookings.find((b) => b.id === booking.id);
    expect(row.status).toBe('cancelled');
    expect(row.cancellation.reason).toBe('driver_issue');

    // Driver can no longer advance a cancelled trip.
    const adv = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/status`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ status: 'arrived' });
    expect(adv.status).toBe(409);

    // Admin can no longer assign a cancelled trip.
    const adminToken = await makeAdmin(nextPhone());
    const driver2 = await makeDriver(nextPhone());
    const assign = await request(app)
      .patch(`/api/admin/bookings/${booking.id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ driver_id: driver2.user.id });
    expect(assign.status).toBe(409);
  });

  it('reason required + fixed set; all 7 reasons accepted', async () => {
    const user = await makeUser(nextPhone());
    for (const bad of [{}, { reason: '' }, { reason: 'no_mood' }, { reason: 5 }]) {
      const b = await makeBooking(user.token);
      const r = await cancel(user.token, b.id, bad);
      expect(r.status).toBe(400);
    }
    const reasons = [
      'wrong_pickup',
      'wrong_drop',
      'wrong_vehicle',
      'changed_plan',
      'duplicate',
      'driver_issue',
      'other',
    ];
    for (const reason of reasons) {
      const b = await makeBooking(user.token);
      const r = await cancel(user.token, b.id, { reason });
      expect(r.status).toBe(200);
      expect(r.body.booking.cancellation.reason).toBe(reason);
    }
  });

  it('authz — stranger 404, driver role 403, anon 401', async () => {
    const user = await makeUser(nextPhone());
    const stranger = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    const s = await cancel(stranger.token, booking.id, { reason: 'other' });
    expect(s.status).toBe(404);

    const d = await cancel(driver.token, booking.id, { reason: 'other' });
    expect(d.status).toBe(403);

    const anon = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .send({ reason: 'other' });
    expect(anon.status).toBe(401);

    // Failed attempts changed nothing.
    const got = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(got.body.booking.status).toBe('pending');
    expect(got.body.booking.cancellation).toBeNull();
  });

  it('non-cancellable stages + double cancel -> 409, state untouched', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());

    // Double cancel.
    const b1 = await makeBooking(user.token);
    expect((await cancel(user.token, b1.id, { reason: 'duplicate' })).status).toBe(200);
    const again = await cancel(user.token, b1.id, { reason: 'duplicate' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('invalid_transition');

    // arrived / in_transit / delivered all refuse.
    for (const target of ['arrived', 'in_transit', 'delivered']) {
      const b = await makeBooking(user.token);
      await request(app)
        .patch(`/api/driver/bookings/${b.id}/accept`)
        .set('Authorization', `Bearer ${driver.token}`)
        .expect(200);
      const path = ['arrived', 'in_transit', 'delivered'].slice(
        0,
        ['arrived', 'in_transit', 'delivered'].indexOf(target) + 1,
      );
      for (const st of path) {
        await request(app)
          .patch(`/api/driver/bookings/${b.id}/status`)
          .set('Authorization', `Bearer ${driver.token}`)
          .send({ status: st })
          .expect(200);
      }
      const r = await cancel(user.token, b.id, { reason: 'changed_plan' });
      expect(r.status).toBe(409);
      const got = await request(app)
        .get(`/api/bookings/${b.id}`)
        .set('Authorization', `Bearer ${user.token}`);
      expect(got.body.booking.status).toBe(target);
      expect(got.body.booking.cancellation).toBeNull();
    }
  });

  it('admin bookings list + tracking both reflect cancellation (tracking ended)', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const adminToken = await makeAdmin(nextPhone());
    const booking = await makeBooking(user.token);
    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    await cancel(user.token, booking.id, { reason: 'wrong_drop' }).then((r) => {
      expect(r.status).toBe(200);
    });

    const list = await request(app)
      .get('/api/admin/bookings?status=cancelled')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    const row = list.body.bookings.find((b) => b.id === booking.id);
    expect(row).toBeTruthy();
    expect(row.cancellation.reason).toBe('wrong_drop');

    // Tracking auto-stops: cancelled is an ended state.
    const loc = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(loc.status).toBe(200);
    expect(loc.body.tracking.state).toBe('ended');
    expect(loc.body.tracking_active).toBe(false);

    const actives = await request(app)
      .get('/api/admin/tracking/active')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(actives.body.actives.some((a) => a.booking_id === booking.id)).toBe(false);
  });
});
