// Fixes 1-4 regression tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/apnashift_test npx vitest run
// Skips if not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9869000000;
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
    item_description: 'samaan',
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

describeDb('fixes 1-4 (DB)', () => {
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

  it('fix1: delivered par total_trips bina rating ke badhta hai', async () => {
    const { token } = await makeUser(nextPhone());
    const d = await makeDriver(nextPhone());
    const booking = await makeBooking(token);

    let stored = await client.query('SELECT total_trips FROM drivers WHERE id = $1', [d.user.id]);
    expect(Number(stored.rows[0].total_trips)).toBe(0);

    await deliverBooking(d.token, booking.id);

    // Count should be 1 without ratings (008 trigger).
    stored = await client.query('SELECT total_trips, avg_rating FROM drivers WHERE id = $1', [
      d.user.id,
    ]);
    expect(Number(stored.rows[0].total_trips)).toBe(1);

    const pub = await request(app).get(`/api/drivers/${d.user.id}/ratings`);
    expect(pub.status).toBe(200);
    expect(pub.body.driver.total_trips).toBe(1);

    // Second delivered without rating -> 2.
    const booking2 = await makeBooking(token);
    await deliverBooking(d.token, booking2.id);
    stored = await client.query('SELECT total_trips FROM drivers WHERE id = $1', [d.user.id]);
    expect(Number(stored.rows[0].total_trips)).toBe(2);
  });

  it('fix2: ek phone users/drivers/admins me dobara register nahi hota', async () => {
    const userPhone = nextPhone();
    await makeUser(userPhone);

    // User number registering as driver gets 409.
    const asDriver = await request(app).post('/api/drivers/register').send({
      name: 'Copy Driver',
      phone: userPhone,
      password: 'password123',
      vehicle_type: 'mini_truck',
      vehicle_number: 'MP09AB9999',
    });
    expect(asDriver.status).toBe(409);
    expect(asDriver.body).toEqual({ ok: false, error: 'phone_taken' });

    // Driver number registering as user gets 409.
    const driverPhone = nextPhone();
    await makeDriver(driverPhone);
    const asUser = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Copy User', phone: driverPhone, password: 'password123' });
    expect(asUser.status).toBe(409);
    expect(asUser.body).toEqual({ ok: false, error: 'phone_taken' });

    // Admin number gets 409 in both user + driver.
    const adminPhone = nextPhone();
    const hash = await bcrypt.hash('admin-pass-123', 4);
    await client.query('INSERT INTO admins (name, phone, password_hash) VALUES ($1, $2, $3)', [
      'Staff',
      adminPhone,
      hash,
    ]);
    const adminAsUser = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Copy Admin', phone: adminPhone, password: 'password123' });
    expect(adminAsUser.status).toBe(409);
    const adminAsDriver = await request(app).post('/api/drivers/register').send({
      name: 'Copy Admin',
      phone: adminPhone,
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: 'MP09CD1111',
    });
    expect(adminAsDriver.status).toBe(409);
  });

  it('fix3: dobara seed chalane par custom rates reset nahi hote', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

    const put = await admin(
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup', base_rs: 999 }),
    );
    expect(put.status).toBe(200);
    expect(put.body.rule.base_rs).toBe(999);

    // Re-run seed (as migrate does).
    const seed = await readFile(path.join(root, 'db', 'seed.sql'), 'utf8');
    await client.query(seed);

    const rules = await admin(request(app).get('/api/admin/pricing-rules'));
    const pickup = rules.body.rules.find((r) => r.vehicle_type === 'Pickup');
    expect(pickup.base_rs).toBe(999);
  });

  it('fix4: deactivate/reactivate is_active toggle + gate', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
    const d = await makeDriver(nextPhone());

    // Deactivate.
    const off = await admin(request(app).patch(`/api/admin/drivers/${d.user.id}/deactivate`));
    expect(off.status).toBe(200);
    expect(off.body.driver.is_active).toBe(false);

    // Deactivated driver gets 403 driver_inactive on driver API.
    const blocked = await request(app)
      .get('/api/driver/bookings/available')
      .set('Authorization', `Bearer ${d.token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('driver_inactive');

    // Assign also returns 409 driver_unavailable.
    const { token } = await makeUser(nextPhone());
    const booking = await makeBooking(token);
    const assignBlocked = await admin(
      request(app).patch(`/api/admin/bookings/${booking.id}/assign`).send({ driver_id: d.user.id }),
    );
    expect(assignBlocked.status).toBe(409);
    expect(assignBlocked.body.error).toBe('driver_unavailable');

    // Reactivate.
    const on = await admin(request(app).patch(`/api/admin/drivers/${d.user.id}/reactivate`));
    expect(on.status).toBe(200);
    expect(on.body.driver.is_active).toBe(true);

    const allowed = await request(app)
      .get('/api/driver/bookings/available')
      .set('Authorization', `Bearer ${d.token}`);
    expect(allowed.status).toBe(200);

    // Unknown id 404, user role 403, no token 401.
    expect(
      (await admin(request(app).patch('/api/admin/drivers/00000000-0000-0000-0000-000000000000/deactivate')))
        .status,
    ).toBe(404);
    const { token: userToken } = await makeUser(nextPhone());
    expect(
      (
        await request(app)
          .patch(`/api/admin/drivers/${d.user.id}/deactivate`)
          .set('Authorization', `Bearer ${userToken}`)
      ).status,
    ).toBe(403);
    expect((await request(app).patch(`/api/admin/drivers/${d.user.id}/deactivate`)).status).toBe(401);

    // Audit rows created.
    const audit = await client.query(
      "SELECT action FROM audit_logs WHERE entity = 'driver' AND entity_id = $1 ORDER BY action",
      [d.user.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['driver.deactivate', 'driver.reactivate']);
  });
});
