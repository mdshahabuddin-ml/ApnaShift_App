// Accept/decline dispatch safety (requires real Postgres).
// Accept path is untouched (atomic UPDATE race); decline is append-only and
// never assigns. Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/booking-dispatch.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll, makeTestClient, hasTestDb } from './helpers/db.js';

const HAS_DB = hasTestDb;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? makeTestClient() : null;

let phoneSeq = 9950000000;
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

async function makeDriver(phone, vehicle = 'mini_truck', verified = true) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: vehicle,
    vehicle_number: `MP${phone.slice(-8)}`,
  });
  expect(res.status).toBe(201);
  if (verified) {
    await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
  }
  return res.body;
}

async function makeBooking(token, over = {}) {
  const res = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send(bookingPayload(over));
  expect(res.status).toBe(201);
  return res.body.booking;
}

async function bookingRow(id) {
  const found = await client.query('SELECT id, status, driver_id FROM bookings WHERE id = $1', [id]);
  expect(found.rowCount).toBe(1);
  return found.rows[0];
}

describeDb('dispatch accept/decline safety (DB)', () => {
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

  it('A accepts first -> success; B simultaneous -> 409; still A assigned', async () => {
    const user = await makeUser(nextPhone());
    const a = await makeDriver(nextPhone());
    const b = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    const [ra, rb] = await Promise.all([
      request(app).patch(`/api/driver/bookings/${booking.id}/accept`).set('Authorization', `Bearer ${a.token}`),
      request(app).patch(`/api/driver/bookings/${booking.id}/accept`).set('Authorization', `Bearer ${b.token}`),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    expect([ra.body, rb.body].find((x) => x.booking)?.booking?.driver_id ?? winner.user.id).toBe(
      winner.user.id,
    );

    const row = await bookingRow(booking.id);
    expect(row.status).toBe('accepted');
    expect([a.user.id, b.user.id]).toContain(row.driver_id);

    // Loser retrying (or anyone else) still 409 — never reassigned.
    const retry = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${(await makeDriver(nextPhone())).token}`);
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe('already_accepted');
    expect((await bookingRow(booking.id)).driver_id).toBe(row.driver_id);
  });

  it('decline keeps booking pending+unassigned; hidden only for decliner', async () => {
    const user = await makeUser(nextPhone());
    const c = await makeDriver(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    const dec = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${c.token}`);
    expect(dec.status).toBe(200);
    expect(dec.body).toMatchObject({ ok: true, declined: true, booking_id: booking.id });

    // Booking untouched: still pending, no driver (history preserved, nothing deleted).
    const row = await bookingRow(booking.id);
    expect(row.status).toBe('pending');
    expect(row.driver_id).toBeNull();

    // Decliner no longer sees it; other driver still does (existing dispatch).
    const mineC = await request(app)
      .get('/api/driver/bookings/available?limit=20')
      .set('Authorization', `Bearer ${c.token}`);
    expect(mineC.body.bookings.map((x) => x.id)).not.toContain(booking.id);
    expect(mineC.body.total).toBe(0);
    const mineD = await request(app)
      .get('/api/driver/bookings/available?limit=20')
      .set('Authorization', `Bearer ${d.token}`);
    expect(mineD.body.bookings.map((x) => x.id)).toContain(booking.id);
    expect(mineD.body.total).toBe(1);
  });

  it('decline twice -> 409; decline accepted/cancelled -> 409; unknown -> 404', async () => {
    const user = await makeUser(nextPhone());
    const c = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    const first = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${c.token}`);
    expect(first.status).toBe(200);
    const dup = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${c.token}`);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_declined');

    // Accepted (by someone else) cannot be declined.
    const acc = await makeBooking(user.token);
    const other = await makeDriver(nextPhone());
    await request(app)
      .patch(`/api/driver/bookings/${acc.id}/accept`)
      .set('Authorization', `Bearer ${other.token}`)
      .expect(200);
    const late = await request(app)
      .post(`/api/driver/bookings/${acc.id}/decline`)
      .set('Authorization', `Bearer ${c.token}`);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('already_accepted');

    // Unknown id + wrong vehicle type -> 404 (same convention as accept).
    const nil = await request(app)
      .post('/api/driver/bookings/00000000-0000-0000-0000-000000000000/decline')
      .set('Authorization', `Bearer ${c.token}`);
    expect(nil.status).toBe(404);
    const pickupDriver = await makeDriver(nextPhone(), 'pickup');
    const wrongType = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${pickupDriver.token}`);
    expect(wrongType.status).toBe(404);
  });

  it('decline is not a ban: same driver can still accept afterwards', async () => {
    const user = await makeUser(nextPhone());
    const c = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${c.token}`)
      .expect(200);
    const acc = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${c.token}`);
    expect(acc.status).toBe(200);
    expect((await bookingRow(booking.id)).driver_id).toBe(c.user.id);
  });

  it('decline authz: anon 401, user 403, unverified driver 403', async () => {
    const user = await makeUser(nextPhone());
    const booking = await makeBooking(user.token);
    const anon = await request(app).post(`/api/driver/bookings/${booking.id}/decline`);
    expect(anon.status).toBe(401);
    const asUser = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);
    const unv = await makeDriver(nextPhone(), 'mini_truck', false);
    const asUnv = await request(app)
      .post(`/api/driver/bookings/${booking.id}/decline`)
      .set('Authorization', `Bearer ${unv.token}`);
    expect(asUnv.status).toBe(403);
  });
});
