// Point 7 (delivered_at) ke DB integration tests (real Postgres chahiye).
// Chalao: TEST_DATABASE_URL=postgres://apnashift:changeme@localhost:5433/apnashift_test npx vitest run
// Set nahi hai to skip. Cases: lifecycle me timestamp kab set hota hai,
// baaki transitions par NULL, earnings/stats delivered_at se bucketing.
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
    pickup: { address: '12 MG Road, Indore', lat: 0, lng: 0 },
    drop: { address: '45 AB Road, Indore', lat: 0, lng: 1 },
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

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    vehicle_number: 'MP09AB1234',
  });
  expect(res.status).toBe(201);
  await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
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

// Poora lifecycle chalakar delivered tak pahunchata hai, har step ka booking deta hai.
async function deliverBooking(userToken, driverToken) {
  const steps = {};
  const created = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${userToken}`)
    .send(bookingPayload());
  expect(created.status).toBe(201);
  steps.pending = created.body.booking;

  const dAuth = { Authorization: `Bearer ${driverToken}` };
  const accepted = await request(app)
    .patch(`/api/driver/bookings/${steps.pending.id}/accept`)
    .set(dAuth);
  expect(accepted.status).toBe(200);
  steps.accepted = accepted.body.booking;

  for (const s of ['arrived', 'in_transit', 'delivered']) {
    const r = await request(app)
      .patch(`/api/driver/bookings/${steps.pending.id}/status`)
      .set(dAuth)
      .send({ status: s });
    expect(r.status).toBe(200);
    steps[s] = r.body.booking;
  }
  return steps;
}

describeDb('delivered_at (DB)', () => {
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

  it('migration — column + CHECK + indexes maujood', async () => {
    const col = await client.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'delivered_at'`,
    );
    expect(col.rowCount).toBe(1);
    expect(col.rows[0].data_type).toContain('timestamp');

    const check = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'bookings_delivered_at_check'`,
    );
    expect(check.rowCount).toBe(1);
    expect(check.rows[0].def).toContain('delivered_at');

    for (const idx of ['idx_bookings_driver_delivered', 'idx_bookings_delivered_at']) {
      const found = await client.query(
        `SELECT indexname FROM pg_indexes WHERE indexname = $1`,
        [idx],
      );
      expect(found.rowCount).toBe(1);
    }
  });

  it('lifecycle — delivered se pehle NULL, delivered par now() set', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const steps = await deliverBooking(token, d.token);

    for (const s of ['pending', 'accepted', 'arrived', 'in_transit']) {
      expect(steps[s].delivered_at).toBeNull();
    }

    const before = Date.now();
    expect(steps.delivered.delivered_at).not.toBeNull();
    const deliveredMs = new Date(steps.delivered.delivered_at).getTime();
    expect(deliveredMs).toBeLessThanOrEqual(before + 60 * 1000);
    expect(deliveredMs).toBeGreaterThanOrEqual(
      new Date(steps.in_transit.updated_at).getTime() - 60 * 1000,
    );

    // GET par bhi dikhta hai.
    const got = await request(app)
      .get(`/api/bookings/${steps.pending.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(got.status).toBe(200);
    expect(got.body.booking.delivered_at).toBe(steps.delivered.delivered_at);
  });

  it('cancel — delivered_at NULL rehta hai', async () => {
    const { token } = await makeUser(nextPhone());
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload());
    expect(created.body.booking.delivered_at).toBeNull();

    const cancelled = await request(app)
      .patch(`/api/bookings/${created.body.booking.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.status).toBe('cancelled');
    expect(cancelled.body.booking.delivered_at).toBeNull();
  });

  it('invariant — delivered <=> delivered_at NOT NULL (DB level)', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    await deliverBooking(token, d.token);
    // Ek pending bhi banao taaki dono sides cover hon.
    await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload())
      .expect(201);

    const bad = await client.query(
      `SELECT COUNT(*) AS c FROM bookings
       WHERE (status = 'delivered' AND delivered_at IS NULL)
          OR (status <> 'delivered' AND delivered_at IS NOT NULL)`,
    );
    expect(Number(bad.rows[0].c)).toBe(0);
  });

  it('earnings — delivered_at se ginti (purani delivery week me nahi)', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const dAuth = { Authorization: `Bearer ${d.token}` };
    const steps = await deliverBooking(token, d.token);

    const now = await request(app).get('/api/driver/earnings/weekly').set(dAuth);
    expect(now.status).toBe(200);
    expect(now.body.completed_count).toBe(1);
    expect(now.body.earnings_rs).toBe(steps.delivered.price_rs);

    // Delivery ko 8 din peeche karo. (Ye UPDATE updated_at ko now() par bump
    // karta hai — purani updated_at wali query ise abhi bhi ginti, nayi nahi.)
    await client.query(`UPDATE bookings SET delivered_at = now() - INTERVAL '8 days' WHERE id = $1`, [
      steps.pending.id,
    ]);
    const week = await request(app).get('/api/driver/earnings/weekly').set(dAuth);
    expect(week.status).toBe(200);
    expect(week.body.completed_count).toBe(0);
    expect(week.body.earnings_rs).toBe(0);
  });

  it('admin stats — completed/revenue delivered_at bucket me, bookings created_at se', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const steps = await deliverBooking(token, d.token);
    const price = steps.delivered.price_rs;

    const fresh = await admin(request(app).get('/api/admin/stats'));
    expect(fresh.status).toBe(200);
    expect(fresh.body.today.completed).toBe(1);
    expect(fresh.body.today.revenue_rs).toBe(price);
    expect(fresh.body.week.completed).toBe(1);
    expect(fresh.body.total.completed).toBe(1);
    expect(fresh.body.total.revenue_rs).toBe(price);

    // Delivery 10 din purani: aaj/week se bahar, total me rahe.
    await client.query(
      `UPDATE bookings SET delivered_at = now() - INTERVAL '10 days' WHERE id = $1`,
      [steps.pending.id],
    );
    const aged = await admin(request(app).get('/api/admin/stats'));
    expect(aged.status).toBe(200);
    // Booking aaj bani thi — ye ginti nahi badalti.
    expect(aged.body.today.bookings).toBe(1);
    expect(aged.body.week.bookings).toBe(1);
    // Completed/revenue aaj/week se bahar, total me andar.
    expect(aged.body.today.completed).toBe(0);
    expect(aged.body.today.revenue_rs).toBe(0);
    expect(aged.body.week.completed).toBe(0);
    expect(aged.body.week.revenue_rs).toBe(0);
    expect(aged.body.total.completed).toBe(1);
    expect(aged.body.total.revenue_rs).toBe(price);
  });
});
