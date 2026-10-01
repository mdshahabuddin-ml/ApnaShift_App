// Admin endpoints tests (requires real Postgres).
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

let phoneSeq = 9885000000;
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
    // Each driver uses a distinct vehicle (register API blocks duplicate vehicles).
    vehicle_number: `MP${phone.slice(-8)}`,
  });
  expect(res.status).toBe(201);
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
    pickup: { address: '12 MG Road, Indore', lat: 0, lng: 0 },
    drop: { address: '45 AB Road, Indore', lat: 0, lng: 1 },
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

describeDb('admin (DB)', () => {
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

  it('access control — user ko 403, bina token 401', async () => {
    const { token } = await makeUser(nextPhone());
    const userAuth = { Authorization: `Bearer ${token}` };

    for (const r of [
      request(app).get('/api/admin/drivers'),
      request(app).patch('/api/admin/drivers/00000000-0000-0000-0000-000000000000/verify'),
      request(app).get('/api/admin/bookings'),
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup', base_rs: 1 }),
      request(app).get('/api/admin/stats'),
      request(app).get('/api/admin/drivers/flagged'),
    ]) {
      expect((await r.set(userAuth)).status).toBe(403);
    }
    expect((await request(app).get('/api/admin/drivers')).status).toBe(401);
    expect((await request(app).get('/api/admin/stats')).status).toBe(401);
  });

  it('drivers list + verify + reject (+ audit)', async () => {
    const d1 = await makeDriver(nextPhone());
    const d2 = await makeDriver(nextPhone());

    const pending = await admin(request(app).get('/api/admin/drivers?status=pending'));
    expect(pending.status).toBe(200);
    expect(pending.body.total).toBe(2);

    const verify = await admin(
      request(app).patch(`/api/admin/drivers/${d1.user.id}/verify`),
    );
    expect(verify.status).toBe(200);
    expect(verify.body.driver.is_verified).toBe(true);

    const verified = await admin(request(app).get('/api/admin/drivers?status=verified'));
    expect(verified.body.total).toBe(1);

    const reject = await admin(
      request(app).patch(`/api/admin/drivers/${d2.user.id}/reject`).send({ reason: 'Number galat hai' }),
    );
    expect(reject.status).toBe(200);
    expect(reject.body.driver.is_verified).toBe(false);
    expect(reject.body.driver.rejection_reason).toBe('Number galat hai');

    const noReason = await admin(
      request(app).patch(`/api/admin/drivers/${d2.user.id}/reject`).send({}),
    );
    expect(noReason.status).toBe(400);

    const unknown = await admin(
      request(app).patch('/api/admin/drivers/00000000-0000-0000-0000-000000000000/verify'),
    );
    expect(unknown.status).toBe(404);

    const audit = await client.query("SELECT action FROM audit_logs WHERE entity = 'driver'");
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['driver.reject', 'driver.verify']);
  });

  it('bookings list — status/city filter + totals', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    await client.query('UPDATE drivers SET is_verified = TRUE WHERE id = $1', [d.user.id]);

    const b1 = await makeBooking(token);
    await makeBooking(token, { drop: { address: 'Connaught Place, Delhi', lat: 1, lng: 1 } });
    const dAuth = { Authorization: `Bearer ${d.token}` };
    await request(app).patch(`/api/driver/bookings/${b1.id}/accept`).set(dAuth).expect(200);
    for (const s of ['arrived', 'in_transit', 'delivered']) {
      await request(app).patch(`/api/driver/bookings/${b1.id}/status`).set(dAuth).send({ status: s }).expect(200);
    }

    const delivered = await admin(request(app).get('/api/admin/bookings?status=delivered'));
    expect(delivered.status).toBe(200);
    expect(delivered.body.total).toBe(1);
    expect(delivered.body.revenue_rs).toBe(b1.price_rs);

    const indore = await admin(request(app).get('/api/admin/bookings?city=Indore'));
    expect(indore.body.total).toBe(2);

    const delhi = await admin(request(app).get('/api/admin/bookings?city=Delhi'));
    expect(delhi.body.total).toBe(1);

    const all = await admin(request(app).get('/api/admin/bookings'));
    expect(all.body.total).toBe(2);
    expect(all.body.bookings[0].user_name).toBe('Test User');
  });

  it('assign — pending par ok, dobara 409, unverified/galat gaadi reject', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);

    const unv = await admin(
      request(app).patch(`/api/admin/bookings/${booking.id}/assign`).send({ driver_id: d.user.id }),
    );
    expect(unv.status).toBe(409);

    await admin(request(app).patch(`/api/admin/drivers/${d.user.id}/verify`)).expect(200);
    const okRes = await admin(
      request(app).patch(`/api/admin/bookings/${booking.id}/assign`).send({ driver_id: d.user.id }),
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body.booking.status).toBe('accepted');
    expect(okRes.body.booking.driver_id).toBe(d.user.id);

    const again = await admin(
      request(app).patch(`/api/admin/bookings/${booking.id}/assign`).send({ driver_id: d.user.id }),
    );
    expect(again.status).toBe(409);

    const pickupDriver = await makeDriver(nextPhone(), 'pickup');
    await admin(request(app).patch(`/api/admin/drivers/${pickupDriver.user.id}/verify`));
    const booking2 = await makeBooking(token);
    const mismatch = await admin(
      request(app).patch(`/api/admin/bookings/${booking2.id}/assign`).send({ driver_id: pickupDriver.user.id }),
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('vehicle_mismatch');
  });

  it('pricing — GET, PUT, history, validation', async () => {
    const rules = await admin(request(app).get('/api/admin/pricing-rules'));
    expect(rules.status).toBe(200);
    expect(rules.body.rules).toHaveLength(3);

    const put = await admin(
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup', base_rs: 400 }),
    );
    expect(put.status).toBe(200);
    expect(put.body.rule.base_rs).toBe(400);
    expect(put.body.rule.per_km_rs).toBe(17.5); // rest unchanged
    expect(typeof put.body.history_id).toBe('number');

    const hist = await admin(request(app).get('/api/admin/pricing-rules/history?vehicle_type=pickup'));
    expect(hist.body.history[0]).toMatchObject({
      vehicle_type: 'Pickup',
      new: { base_rs: 400, per_km_rs: 17.5, helper_rs: 200 },
    });
    expect(hist.body.history[0].old.base_rs).toBe(350);

    const bad = await admin(
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup', base_rs: -5 }),
    );
    expect(bad.status).toBe(400);

    const empty = await admin(
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup' }),
    );
    expect(empty.status).toBe(400);
  });

  it('stats — shape + ginti', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    await client.query('UPDATE drivers SET is_verified = TRUE WHERE id = $1', [d.user.id]);
    const b = await makeBooking(token);
    await makeBooking(token);
    const dAuth = { Authorization: `Bearer ${d.token}` };
    await request(app).patch(`/api/driver/bookings/${b.id}/accept`).set(dAuth);
    for (const s of ['arrived', 'in_transit', 'delivered']) {
      await request(app).patch(`/api/driver/bookings/${b.id}/status`).set(dAuth).send({ status: s });
    }

    const res = await admin(request(app).get('/api/admin/stats'));
    expect(res.status).toBe(200);
    expect(res.body.today.bookings).toBe(2);
    expect(res.body.today.completed).toBe(1);
    expect(res.body.today.revenue_rs).toBe(b.price_rs);
    expect(res.body.week.bookings).toBe(2);
    expect(res.body.total.bookings).toBe(2);
    expect(res.body.drivers.verified_active).toBe(1);
  });
});
