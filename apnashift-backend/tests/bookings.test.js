// Bookings flow tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/apnashift_test npx vitest run
// Skips if not set. Coords fixed (0,0)-(0,1) for deterministic distance.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9880000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

function bookingPayload(over = {}) {
  return {
    pickup: { address: '12 MG Road, Indore', lat: 0, lng: 0 },
    drop: { address: '45 AB Road, Indore', lat: 0, lng: 1 },
    vehicle_type: 'mini_truck',
    helper_needed: false,
    item_description: '2 bed + almari',
    ...over,
  };
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body; // { token, user }
}

async function makeDriver(phone, vehicle = 'mini_truck', verified = true) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: vehicle,
    // Each driver uses a distinct vehicle (register API blocks duplicate vehicles).
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

describeDb('bookings flow (DB)', () => {
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

  it('create — status pending, price server ginata hai (client price ignore)', async () => {
    const { token } = await makeUser(nextPhone());

    const est = await request(app).post('/api/bookings/estimate-price').send(bookingPayload());
    expect(est.status).toBe(200);

    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...bookingPayload(), price_rs: 1, total: 1 });
    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe('pending');
    expect(res.body.booking.price_rs).toBe(est.body.total);
    expect(res.body.booking.price_rs).not.toBe(1);
    expect(res.body.booking.vehicle_type).toBe('mini_truck');
  });

  it('list — apni bookings, paginated; doosre ki nahi', async () => {
    const a = await makeUser(nextPhone());
    const b = await makeUser(nextPhone());
    await makeBooking(a.token);
    await makeBooking(a.token);
    await makeBooking(a.token);
    await makeBooking(b.token);

    const p1 = await request(app)
      .get('/api/bookings?page=1&limit=2')
      .set('Authorization', `Bearer ${a.token}`);
    expect(p1.status).toBe(200);
    expect(p1.body.total).toBe(3);
    expect(p1.body.bookings).toHaveLength(2);

    const p2 = await request(app)
      .get('/api/bookings?page=2&limit=2')
      .set('Authorization', `Bearer ${a.token}`);
    expect(p2.body.bookings).toHaveLength(1);

    const onlyB = await request(app).get('/api/bookings').set('Authorization', `Bearer ${b.token}`);
    expect(onlyB.body.total).toBe(1);
  });

  it('get by id — apni 200, doosre ki 404 (403 nahi)', async () => {
    const a = await makeUser(nextPhone());
    const b = await makeUser(nextPhone());
    const booking = await makeBooking(a.token);

    const mine = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(mine.status).toBe(200);

    const others = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(others.status).toBe(404);
  });

  it('cancel — pending cancel hoti hai, dobara 409', async () => {
    const { token } = await makeUser(nextPhone());
    const booking = await makeBooking(token);

    const first = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.booking.status).toBe('cancelled');

    const second = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(409);
  });

  it('cancel — accepted wali cancel hoti hai, delivered wali 409', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);

    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${d.token}`);

    const cancelAccepted = await request(app)
      .patch(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelAccepted.status).toBe(200);

    const booking2 = await makeBooking(token);
    const dAuth = { Authorization: `Bearer ${d.token}` };
    await request(app).patch(`/api/driver/bookings/${booking2.id}/accept`).set(dAuth);
    await request(app).patch(`/api/driver/bookings/${booking2.id}/status`).set(dAuth).send({ status: 'arrived' });
    await request(app).patch(`/api/driver/bookings/${booking2.id}/status`).set(dAuth).send({ status: 'in_transit' });
    await request(app).patch(`/api/driver/bookings/${booking2.id}/status`).set(dAuth).send({ status: 'delivered' });

    const cancelDelivered = await request(app)
      .patch(`/api/bookings/${booking2.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelDelivered.status).toBe(409);
  });

  it('available — sirf pending + apni gaadi type', async () => {
    const { token } = await makeUser(nextPhone());
    const truck = await makeDriver(nextPhone(), 'mini_truck');
    const pickup = await makeDriver(nextPhone(), 'pickup');
    await makeBooking(token, { vehicle_type: 'mini_truck' });
    await makeBooking(token, { vehicle_type: 'pickup' });

    const forTruck = await request(app)
      .get('/api/driver/bookings/available')
      .set('Authorization', `Bearer ${truck.token}`);
    expect(forTruck.status).toBe(200);
    expect(forTruck.body.total).toBe(1);
    expect(forTruck.body.bookings[0].vehicle_type).toBe('mini_truck');

    const forPickup = await request(app)
      .get('/api/driver/bookings/available')
      .set('Authorization', `Bearer ${pickup.token}`);
    expect(forPickup.body.total).toBe(1);
    expect(forPickup.body.bookings[0].vehicle_type).toBe('pickup');
  });

  it('double-accept race — ek jeetega (200), doosra 409', async () => {
    const { token } = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone());
    const d2 = await makeDriver(nextPhone());
    const booking = await makeBooking(token);

    const [r1, r2] = await Promise.all([
      request(app)
        .patch(`/api/driver/bookings/${booking.id}/accept`)
        .set('Authorization', `Bearer ${d1.token}`),
      request(app)
        .patch(`/api/driver/bookings/${booking.id}/accept`)
        .set('Authorization', `Bearer ${d2.token}`),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error).toBe('already_accepted');
  });

  it('invalid transition — accepted se seedha delivered 409', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);
    const dAuth = { Authorization: `Bearer ${d.token}` };

    await request(app).patch(`/api/driver/bookings/${booking.id}/accept`).set(dAuth);
    const skip = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/status`)
      .set(dAuth)
      .send({ status: 'delivered' });
    expect(skip.status).toBe(409);
    expect(skip.body.error).toBe('invalid_transition');

    for (const s of ['arrived', 'in_transit', 'delivered']) {
      const r = await request(app)
        .patch(`/api/driver/bookings/${booking.id}/status`)
        .set(dAuth)
        .send({ status: s });
      expect(r.status).toBe(200);
    }
  });

  it('driver history + weekly earnings', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const dAuth = { Authorization: `Bearer ${d.token}` };
    const booking = await makeBooking(token);

    await request(app).patch(`/api/driver/bookings/${booking.id}/accept`).set(dAuth);
    for (const s of ['arrived', 'in_transit', 'delivered']) {
      await request(app).patch(`/api/driver/bookings/${booking.id}/status`).set(dAuth).send({ status: s });
    }

    const history = await request(app).get('/api/driver/bookings').set(dAuth);
    expect(history.status).toBe(200);
    expect(history.body.total).toBe(1);

    const earnings = await request(app).get('/api/driver/earnings/weekly').set(dAuth);
    expect(earnings.status).toBe(200);
    expect(earnings.body.completed_count).toBe(1);
    expect(earnings.body.earnings_rs).toBe(booking.price_rs);
  });

  it('access control — 401, 403, unverified driver, doosre driver ki booking', async () => {
    const { token } = await makeUser(nextPhone());
    const booking = await makeBooking(token);
    const d1 = await makeDriver(nextPhone());
    const d2 = await makeDriver(nextPhone());
    const unverified = await makeDriver(nextPhone(), 'mini_truck', false);

    // Without token.
    expect((await request(app).post('/api/bookings').send(bookingPayload())).status).toBe(401);

    // User token on driver route.
    expect(
      (await request(app).get('/api/driver/bookings/available').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(403);

    // Unverified driver.
    const unv = await request(app)
      .get('/api/driver/bookings/available')
      .set('Authorization', `Bearer ${unverified.token}`);
    expect(unv.status).toBe(403);
    expect(unv.body.error).toBe('driver_unverified');

    // Driver 1 accepted it, driver 2 cannot change its status (404).
    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${d1.token}`);
    const other = await request(app)
      .patch(`/api/driver/bookings/${booking.id}/status`)
      .set('Authorization', `Bearer ${d2.token}`)
      .send({ status: 'arrived' });
    expect(other.status).toBe(404);

    // That booking is absent from driver 2 history.
    const h2 = await request(app)
      .get('/api/driver/bookings')
      .set('Authorization', `Bearer ${d2.token}`);
    expect(h2.body.total).toBe(0);
  });
});
