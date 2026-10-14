// GET /api/admin/reports/summary tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://apnashift:changeme@localhost:5433/apnashift_test npx vitest run tests/admin-reports.test.js
// Skips if not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9860000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeDriver(phone, vehicle = 'mini_truck') {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: vehicle,
    vehicle_number: `MP${phone.slice(-8)}`,
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

async function makeBooking(token, over = {}) {
  const res = await request(app)
    .post('/api/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send(bookingPayload(over));
  expect(res.status).toBe(201);
  return res.body.booking;
}

async function acceptAndDeliver(driverToken, bookingId) {
  await request(app)
    .patch(`/api/driver/bookings/${bookingId}/accept`)
    .set('Authorization', `Bearer ${driverToken}`)
    .expect(200);
  for (const st of ['arrived', 'in_transit', 'delivered']) {
    await request(app)
      .patch(`/api/driver/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ status: st })
      .expect(200);
  }
}

// Full flow se deliver karo, phir dates fix karo taaki range deterministic ho.
async function deliverOn({ userToken, driverToken, vehicle, deliveredAt }) {
  const b = await makeBooking(userToken, { vehicle_type: vehicle });
  await acceptAndDeliver(driverToken, b.id);
  await client.query('UPDATE bookings SET delivered_at = $1 WHERE id = $2', [deliveredAt, b.id]);
  await client.query('UPDATE payments SET collected_at = $1 WHERE booking_id = $2', [
    deliveredAt,
    b.id,
  ]);
  const pay = await client.query(
    'SELECT id, platform_commission, settled_amount FROM payments WHERE booking_id = $1',
    [b.id],
  );
  return { bookingId: b.id, payment: pay.rows[0] };
}

describeDb('admin reports summary (DB)', () => {
  let adminToken;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    adminToken = await makeAdmin(nextPhone());
  });

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  it('auth — bina token 401, user role 403', async () => {
    expect((await request(app).get('/api/admin/reports/summary')).status).toBe(401);
    const { token } = await makeUser(nextPhone());
    expect(
      (await request(app).get('/api/admin/reports/summary').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(403);
  });

  it('validation — galat group_by / date / ulta range 400', async () => {
    expect((await admin(request(app).get('/api/admin/reports/summary?group_by=year'))).status).toBe(
      400,
    );
    expect((await admin(request(app).get('/api/admin/reports/summary?from=not-a-date'))).status).toBe(
      400,
    );
    expect(
      (await admin(request(app).get('/api/admin/reports/summary?from=2026-02-01&to=2026-01-01')))
        .status,
    ).toBe(400);
  });

  it('khaali range — zero totals + bhare hue day buckets', async () => {
    const res = await admin(
      request(app).get('/api/admin/reports/summary?from=2026-01-01&to=2026-01-07&group_by=day'),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.totals).toMatchObject({
      delivered_trips: 0,
      commission_rs: 0,
      settled_rs: 0,
      pending_rs: 0,
    });
    expect(res.body.by_vehicle).toEqual([]);
    expect(res.body.series).toHaveLength(7);
    for (const p of res.body.series) {
      expect(p.trips).toBe(0);
      expect(p.commission_rs).toBe(0);
    }
    expect(res.body.series[0].period).toBe('2026-01-01');
    expect(res.body.series[6].period).toBe('2026-01-07');
  });

  it('seeded data — totals, vehicle split, settled vs pending, day series', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const d2 = await makeDriver(nextPhone(), 'pickup');

    const first = await deliverOn({
      userToken: user.token,
      driverToken: d1.token,
      vehicle: 'mini_truck',
      deliveredAt: '2026-03-10T10:00:00.000Z',
    });
    const second = await deliverOn({
      userToken: user.token,
      driverToken: d2.token,
      vehicle: 'pickup',
      deliveredAt: '2026-03-11T10:00:00.000Z',
    });
    // Ek pending booking — range me hote hue bhi count nahi honi chahiye.
    await makeBooking(user.token, { vehicle_type: 'mini_truck' });

    // Pehli payment poori settled.
    await client.query(
      `UPDATE payments SET settled_amount = platform_commission, settlement_status = 'settled'
        WHERE booking_id = $1`,
      [first.bookingId],
    );

    const res = await admin(
      request(app).get('/api/admin/reports/summary?from=2026-03-01&to=2026-03-31&group_by=month'),
    );
    expect(res.status).toBe(200);
    const c1 = Number(first.payment.platform_commission);
    const c2 = Number(second.payment.platform_commission);
    expect(res.body.totals.delivered_trips).toBe(2);
    expect(res.body.totals.commission_rs).toBeCloseTo(c1 + c2, 2);
    expect(res.body.totals.settled_rs).toBeCloseTo(c1, 2);
    expect(res.body.totals.pending_rs).toBeCloseTo(c2, 2);

    const byV = new Map(res.body.by_vehicle.map((r) => [r.vehicle_type, r]));
    expect(byV.get('mini_truck').trips).toBe(1);
    expect(byV.get('pickup').trips).toBe(1);
    expect(byV.get('mini_truck').commission_rs).toBeCloseTo(c1, 2);

    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0]).toMatchObject({ period: '2026-03-01', trips: 2 });

    const days = await admin(
      request(app).get('/api/admin/reports/summary?from=2026-03-10&to=2026-03-11&group_by=day'),
    );
    expect(days.status).toBe(200);
    expect(days.body.series).toHaveLength(2);
    expect(days.body.series[0]).toMatchObject({ period: '2026-03-10', trips: 1 });
    expect(days.body.series[1]).toMatchObject({ period: '2026-03-11', trips: 1 });
    expect(days.body.series[0].commission_rs).toBeCloseTo(c1, 2);
  });

  it('adjustment — commission me delta judta hai', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const { payment } = await deliverOn({
      userToken: user.token,
      driverToken: d1.token,
      vehicle: 'mini_truck',
      deliveredAt: '2026-04-05T10:00:00.000Z',
    });
    await client.query(
      `INSERT INTO payment_adjustments (payment_id, commission_delta_paise, earning_delta_paise, reason)
       VALUES ($1, 100, 0, 'test correction')`,
      [payment.id],
    );
    const res = await admin(
      request(app).get('/api/admin/reports/summary?from=2026-04-01&to=2026-04-30&group_by=month'),
    );
    expect(res.status).toBe(200);
    expect(res.body.totals.commission_rs).toBeCloseTo(Number(payment.platform_commission) + 1, 2);
  });

  it('week group_by — Monday se aligned buckets', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    await deliverOn({
      userToken: user.token,
      driverToken: d1.token,
      vehicle: 'mini_truck',
      deliveredAt: '2026-03-11T10:00:00.000Z', // Wednesday
    });
    const res = await admin(
      request(app).get('/api/admin/reports/summary?from=2026-03-09&to=2026-03-15&group_by=week'),
    );
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0]).toMatchObject({ period: '2026-03-09', trips: 1 });
  });
});
