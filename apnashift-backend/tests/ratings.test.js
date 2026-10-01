// Ratings tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/apnashift_test npx vitest run
// Skips if not set.
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

let phoneSeq = 9890000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

function bookingPayload() {
  return {
    pickup: { address: '12 MG Road, Indore', lat: 0, lng: 0 },
    drop: { address: '45 AB Road, Indore', lat: 0, lng: 1 },
    vehicle_type: 'mini_truck',
    helper_needed: false,
    item_description: 'ghar ka samaan',
  };
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    // Each driver uses a distinct vehicle (register API blocks duplicate vehicles).
    vehicle_number: `MP${phone.slice(-8)}`,
  });
  expect(res.status).toBe(201);
  await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
  return res.body;
}

async function makeBooking(token) {
  const res = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send(bookingPayload());
  expect(res.status).toBe(201);
  return res.body.booking;
}

async function deliverBooking(driverToken, bookingId) {
  const h = { Authorization: `Bearer ${driverToken}` };
  await request(app).patch(`/api/driver/bookings/${bookingId}/accept`).set(h).expect(200);
  for (const s of ['arrived', 'in_transit', 'delivered']) {
    await request(app).patch(`/api/driver/bookings/${bookingId}/status`).set(h).send({ status: s }).expect(200);
  }
}

async function rate(token, bookingId, stars, comment = '') {
  return request(app)
    .post(`/api/bookings/${bookingId}/rating`)
    .set('Authorization', `Bearer ${token}`)
    .send({ stars, comment });
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

describeDb('ratings (DB)', () => {
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

  it('delivery se pehle rating 409 not_delivered (pending + accepted)', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);

    expect((await rate(token, booking.id, 5)).status).toBe(409);
    expect((await rate(token, booking.id, 5)).body.error).toBe('not_delivered');

    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${d.token}`)
      .expect(200);
    expect((await rate(token, booking.id, 5)).status).toBe(409);
  });

  it('duplicate rating 409 already_rated', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);
    await deliverBooking(d.token, booking.id);

    expect((await rate(token, booking.id, 5, 'badhaiya')).status).toBe(201);
    const dup = await rate(token, booking.id, 4);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_rated');
  });

  it('average sahi update hota hai (5 + 3 = 4.0, trips 2)', async () => {
    const u1 = await makeUser(nextPhone());
    const u2 = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const b1 = await makeBooking(u1.token);
    const b2 = await makeBooking(u2.token);
    await deliverBooking(d.token, b1.id);
    await deliverBooking(d.token, b2.id);
    await rate(u1.token, b1.id, 5, 'bahut badhiya');
    await rate(u2.token, b2.id, 3, 'theek thaak');

    const res = await request(app).get(`/api/drivers/${d.user.id}/ratings`);
    expect(res.status).toBe(200);
    expect(res.body.average).toBe(4);
    expect(res.body.count).toBe(2);
    expect(res.body.driver.avg_rating).toBe(4);
    expect(res.body.driver.total_trips).toBe(2);
    expect(res.body.comments).toHaveLength(2);

    const stored = await client.query('SELECT avg_rating, total_trips FROM drivers WHERE id = $1', [
      d.user.id,
    ]);
    expect(Number(stored.rows[0].avg_rating)).toBe(4);
    expect(Number(stored.rows[0].total_trips)).toBe(2);
  });

  it('5 ratings me avg < 3.0 par needs_review, recover par clear (no ban)', async () => {
    const d = await makeDriver(nextPhone());
    const adminToken = await makeAdmin(nextPhone());
    const flagged = () =>
      request(app).get('/api/admin/drivers/flagged').set('Authorization', `Bearer ${adminToken}`);

    // 5 x 2-star -> avg 2.0 -> flagged.
    for (let i = 0; i < 5; i++) {
      const u = await makeUser(nextPhone());
      const b = await makeBooking(u.token);
      await deliverBooking(d.token, b.id);
      expect((await rate(u.token, b.id, 2)).status).toBe(201);
    }
    let list = await flagged();
    expect(list.status).toBe(200);
    expect(list.body.drivers.map((x) => x.id)).toContain(d.user.id);

    // Driver can still log in — not banned.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ phone: d.user.phone, password: 'password123' });
    expect(login.status).toBe(200);

    // 5 x 5-star -> avg 3.5 -> flag clear.
    for (let i = 0; i < 5; i++) {
      const u = await makeUser(nextPhone());
      const b = await makeBooking(u.token);
      await deliverBooking(d.token, b.id);
      expect((await rate(u.token, b.id, 5)).status).toBe(201);
    }
    list = await flagged();
    expect(list.body.drivers.map((x) => x.id)).not.toContain(d.user.id);
  });

  it('public ratings me phone number nahi aata', async () => {
    const u = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const b = await makeBooking(u.token);
    await deliverBooking(d.token, b.id);
    await rate(u.token, b.id, 5, 'time par aaya');

    const res = await request(app).get(`/api/drivers/${d.user.id}/ratings`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(u.user.phone);
    expect(JSON.stringify(res.body)).not.toContain(d.user.phone);
    expect(res.body.comments[0]).toMatchObject({ stars: 5, comment: 'time par aaya' });
  });

  it('access control — 404 / 401 / 403', async () => {
    const a = await makeUser(nextPhone());
    const b = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(a.token);
    await deliverBooking(d.token, booking.id);

    // Another user's booking.
    expect((await rate(b.token, booking.id, 5)).status).toBe(404);

    // Without token.
    expect((await request(app).post(`/api/bookings/${booking.id}/rating`).send({ stars: 5 })).status).toBe(
      401,
    );

    // Driver role cannot access user route.
    expect(
      (
        await request(app)
          .post(`/api/bookings/${booking.id}/rating`)
          .set('Authorization', `Bearer ${d.token}`)
          .send({ stars: 5 })
      ).status,
    ).toBe(403);

    // Unknown driver.
    expect((await request(app).get('/api/drivers/00000000-0000-0000-0000-000000000000/ratings')).status).toBe(
      404,
    );
  });
});
