// drivers.commission_due stored due + settle-commission + commission-summary.
// Requires real Postgres:
//   TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips if not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import { toPaise, paiseToRs, pctToBps, splitFare } from '../src/services/money.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9800000000;
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

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
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

async function driverRowByPhone(phone) {
  const r = await client.query('SELECT id, commission_due, total_trips FROM drivers WHERE phone = $1', [
    phone,
  ]);
  return r.rows[0];
}

function expectedCommission(grossRs, pct = 15) {
  return splitFare(toPaise(grossRs), pctToBps(pct)).commissionPaise;
}

describeDb('commission_due ledger (DB)', () => {
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

  afterEach(() => {
    delete process.env.COMMISSION_DUE_LIMIT;
  });

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  it('delivered booking adds commission_amount to commission_due (same tx)', async () => {
    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const booking = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, booking.id);

    const row = await driverRowByPhone(driverPhone);
    const pay = await client.query('SELECT platform_commission FROM payments WHERE booking_id = $1', [
      booking.id,
    ]);
    expect(pay.rowCount).toBe(1);
    // Stored due equals the minted payment commission, paise-exact.
    expect(toPaise(row.commission_due)).toBe(toPaise(pay.rows[0].platform_commission));
    expect(toPaise(row.commission_due)).toBe(expectedCommission(booking.price_rs));
    expect(Number(row.total_trips)).toBe(1);
  });

  it('commission-summary lists due + total_trips, highest due first, paginated', async () => {
    const user = await makeUser(nextPhone());
    const d1Phone = nextPhone();
    const d2Phone = nextPhone();
    const d1 = await makeDriver(d1Phone);
    const d2 = await makeDriver(d2Phone);
    // d1: two deliveries (bigger due), d2: one delivery.
    await acceptAndDeliver(d1.token, (await makeBooking(user.token)).id);
    await acceptAndDeliver(d1.token, (await makeBooking(user.token)).id);
    await acceptAndDeliver(d2.token, (await makeBooking(user.token)).id);

    const res = await admin(request(app).get('/api/admin/drivers/commission-summary'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const [first, second] = res.body.drivers;
    expect(first.commission_due_rs).toBeGreaterThan(second.commission_due_rs);
    expect(first.total_trips).toBe(2);
    expect(second.total_trips).toBe(1);
    expect(first).toHaveProperty('driver_id');
    expect(first).toHaveProperty('phone');

    const page2 = await admin(request(app).get('/api/admin/drivers/commission-summary?page=2&limit=1'));
    expect(page2.status).toBe(200);
    expect(page2.body.drivers).toHaveLength(1);
    expect(page2.body.drivers[0].driver_id).toBe(second.driver_id);
  });

  it('settle-commission reduces due, logs settlement, blocks over-settle', async () => {
    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const booking = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, booking.id);
    const before = await driverRowByPhone(driverPhone);
    const duePaise = toPaise(before.commission_due);
    expect(duePaise).toBeGreaterThan(0);
    const driverId = (await client.query('SELECT id FROM drivers WHERE phone = $1', [driverPhone]))
      .rows[0].id;

    // Partial settle (Rs 10).
    const part = await admin(
      request(app).post(`/api/admin/drivers/${driverId}/settle-commission`).send({
        amount_rs: 10,
        note: 'counter cash',
      }),
    );
    expect(part.status).toBe(201);
    expect(part.body.settlement.amount_rs).toBe(10);
    expect(toPaise(part.body.commission_due_rs)).toBe(duePaise - 1000);
    // Settlement history row exists.
    const hist = await admin(
      request(app).get(`/api/admin/settlements?driver_id=${driverId}`),
    );
    expect(hist.status).toBe(200);
    expect(hist.body.settlements.some((s) => s.notes === 'counter cash')).toBe(true);
    // Derived outstanding agrees with stored due (no adjustments yet).
    expect(toPaise(part.body.outstanding_rs)).toBe(duePaise - 1000);

    // Over-settle -> 409, due untouched.
    const over = await admin(
      request(app).post(`/api/admin/drivers/${driverId}/settle-commission`).send({
        amount_rs: 1000000,
      }),
    );
    expect(over.status).toBe(409);
    const still = await driverRowByPhone(driverPhone);
    expect(toPaise(still.commission_due)).toBe(duePaise - 1000);

    // Settle the rest exactly -> due 0, never negative.
    const rest = paiseToRs(duePaise - 1000);
    const full = await admin(
      request(app).post(`/api/admin/drivers/${driverId}/settle-commission`).send({ amount_rs: rest }),
    );
    expect(full.status).toBe(201);
    expect(Number(full.body.commission_due_rs)).toBe(0);
    const zero = await driverRowByPhone(driverPhone);
    expect(Number(zero.commission_due)).toBe(0);
  });

  it('settle-commission validates input + driver', async () => {
    const badUuid = await admin(
      request(app).post('/api/admin/drivers/not-a-uuid/settle-commission').send({ amount_rs: 10 }),
    );
    expect(badUuid.status).toBe(404);

    const missing = await admin(
      request(app)
        .post('/api/admin/drivers/11111111-1111-4111-8111-111111111111/settle-commission')
        .send({ amount_rs: 10 }),
    );
    expect(missing.status).toBe(404);

    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const driverId = (await client.query('SELECT id FROM drivers WHERE phone = $1', [driverPhone]))
      .rows[0].id;
    await acceptAndDeliver(driver.token, (await makeBooking(user.token)).id);

    for (const bad of [{ amount_rs: 0 }, { amount_rs: -5 }, {}]) {
      const r = await admin(
        request(app).post(`/api/admin/drivers/${driverId}/settle-commission`).send(bad),
      );
      expect([400, 422]).toContain(r.status);
    }
  });

  it('driver commission-due agrees with stored due', async () => {
    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const booking = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, booking.id);

    const res = await request(app)
      .get('/api/driver/commission-due')
      .set('Authorization', `Bearer ${driver.token}`);
    expect(res.status).toBe(200);
    const row = await driverRowByPhone(driverPhone);
    expect(toPaise(res.body.outstanding_rs)).toBe(toPaise(row.commission_due));
  });

  it('COMMISSION_DUE_LIMIT blocks accept at 403', async () => {
    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const b1 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);

    process.env.COMMISSION_DUE_LIMIT = '0';
    const b2 = await makeBooking(user.token);
    const blocked = await request(app)
      .patch(`/api/driver/bookings/${b2.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('commission_limit_exceeded');

    delete process.env.COMMISSION_DUE_LIMIT;
    const ok = await request(app)
      .patch(`/api/driver/bookings/${b2.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(ok.status).toBe(200);
  });

  it('commission adjustment moves stored due in step (no drift)', async () => {
    const user = await makeUser(nextPhone());
    const driverPhone = nextPhone();
    const driver = await makeDriver(driverPhone);
    const booking = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, booking.id);
    const before = await driverRowByPhone(driverPhone);
    const paymentId = (
      await client.query('SELECT id FROM payments WHERE booking_id = $1', [booking.id])
    ).rows[0].id;

    const adj = await admin(
      request(app).post('/api/admin/adjustments').send({
        payment_id: paymentId,
        commission_delta_paise: 500,
        reason: 'toll correction',
      }),
    );
    expect(adj.status).toBe(201);
    const after = await driverRowByPhone(driverPhone);
    expect(toPaise(after.commission_due)).toBe(toPaise(before.commission_due) + 500);
  });
});
