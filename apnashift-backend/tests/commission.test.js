// UPI ID, per-vehicle commission snapshot, due-limit gate, dispute flag.
// Requires real Postgres. Skips if TEST_DATABASE_URL not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import { toPaise, splitFare } from '../src/services/money.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9910000000;
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

async function makeDriver(phone, over = {}) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    vehicle_number: `MP${phone.slice(-8)}`,
    ...over,
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

describeDb('upi + snapshot commission + due limit + dispute (DB)', () => {
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

  it('upi_id — register + profile update/clear + validation', async () => {
    const phone = nextPhone();
    const res = await request(app).post('/api/drivers/register').send({
      name: 'UPI Driver',
      phone,
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: `MP${phone.slice(-8)}`,
      upi_id: 'driver.name-1@okhdfc',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.upi_id).toBe('driver.name-1@okhdfc');

    const bad = await request(app).post('/api/drivers/register').send({
      name: 'Bad UPI',
      phone: nextPhone(),
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: `MP${nextPhone().slice(-8)}`,
      upi_id: 'not-a-upi',
    });
    expect(bad.status).toBe(400);

    const token = res.body.token;
    const upd = await request(app)
      .patch('/api/driver/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ upi_id: 'new.id@okaxis' });
    expect(upd.status).toBe(200);
    expect(upd.body.driver.upi_id).toBe('new.id@okaxis');

    const badUpd = await request(app)
      .patch('/api/driver/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ upi_id: 'x' });
    expect(badUpd.status).toBe(400);

    const clear = await request(app)
      .patch('/api/driver/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ upi_id: null });
    expect(clear.status).toBe(200);
    expect(clear.body.driver.upi_id).toBeNull();

    // Non-driver cannot use the endpoint.
    const user = await makeUser(nextPhone());
    const asUser = await request(app)
      .patch('/api/driver/profile')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ upi_id: 'a@okhdfc' });
    expect(asUser.status).toBe(403);
  });

  it('payment_method — default upi, cash accepted, online still reserved', async () => {
    const user = await makeUser(nextPhone());
    const def = await makeBooking(user.token);
    expect(def.payment_method).toBe('upi');
    const cash = await makeBooking(user.token, { payment_method: 'cash' });
    expect(cash.payment_method).toBe('cash');
    const online = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send(bookingPayload({ payment_method: 'online' }));
    expect(online.status).toBe(400);
    expect(online.body.error).toBe('unsupported_payment_method');
  });

  it('commission comes from system price + pricing_rules snapshot (driver input ignored)', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    // Driver/client tries to smuggle amounts — schema has no such fields.
    const sneaky = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ ...bookingPayload(), price_rs: 1, total_price: 1, commission_percent: 0 });
    expect(sneaky.status).toBe(201);
    expect(sneaky.body.booking.price_rs).toBeGreaterThan(100);
    expect(sneaky.body.booking.commission_percent).toBe(15);

    // Status advance with price in body is ignored too.
    await request(app)
      .patch(`/api/driver/bookings/${sneaky.body.booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    const adv = await request(app)
      .patch(`/api/driver/bookings/${sneaky.body.booking.id}/status`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ status: 'arrived', price_rs: 1 });
    expect(adv.status).toBe(200);
    const row = await client.query('SELECT price_rs FROM bookings WHERE id = $1', [
      sneaky.body.booking.id,
    ]);
    expect(Number(row.rows[0].price_rs)).toBe(sneaky.body.booking.price_rs);
  });

  it('snapshot locks per-vehicle rate across later rate changes', async () => {
    const user = await makeUser(nextPhone());
    // Per-vehicle divergence: pickup 20, mini_truck 25.
    await admin(request(app).put('/api/admin/pricing-rules')).send({ vehicle_type: 'pickup', commission_pct: 20 }).expect(200);
    await admin(request(app).put('/api/admin/pricing-rules')).send({ vehicle_type: 'mini_truck', commission_pct: 25 }).expect(200);

    const bTruck = await makeBooking(user.token, { vehicle_type: 'mini_truck' });
    const bPickup = await makeBooking(user.token, { vehicle_type: 'pickup' });
    expect(bTruck.commission_percent).toBe(25);
    expect(bPickup.commission_percent).toBe(20);

    // Rates change AFTER creation — snapshots must not move.
    await admin(request(app).put('/api/admin/pricing-rules')).send({ vehicle_type: 'mini_truck', commission_pct: 5 }).expect(200);
    await admin(request(app).put('/api/admin/commission')).send({ pct: 30 }).expect(200);

    const d2 = await makeDriver(nextPhone(), { vehicle_type: 'pickup' });
    await request(app)
      .patch(`/api/driver/bookings/${bPickup.id}/accept`)
      .set('Authorization', `Bearer ${d2.token}`)
      .expect(200);
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      await request(app)
        .patch(`/api/driver/bookings/${bPickup.id}/status`)
        .set('Authorization', `Bearer ${d2.token}`)
        .send({ status: st })
        .expect(200);
    }
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const pay = ledger.body.payments.find((p) => p.booking_id === bPickup.id);
    expect(pay.commission_pct).toBe(20);
    const exp = splitFare(toPaise(bPickup.price_rs), 2000);
    expect(toPaise(pay.platform_commission_rs)).toBe(exp.commissionPaise);

    // New booking after the change picks the NEW rate.
    const bNew = await makeBooking(user.token, { vehicle_type: 'mini_truck' });
    expect(bNew.commission_percent).toBe(30);
  });

  it('settlement reduces due, never negative; commission-due visible to driver', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b.id);
    const exp = splitFare(toPaise(b.price_rs), 1500);

    const due = await request(app)
      .get('/api/driver/commission-due')
      .set('Authorization', `Bearer ${driver.token}`);
    expect(due.status).toBe(200);
    expect(due.body.outstanding_paise).toBe(exp.commissionPaise);

    const part = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: 1,
      method: 'cash',
      note: 'oops-wrong-key',
    });
    // 'note' is not a field — unknown keys are stripped, valid body -> 201.
    expect(part.status).toBe(201);

    const dueAfterPart = await request(app)
      .get('/api/driver/commission-due')
      .set('Authorization', `Bearer ${driver.token}`);
    const full = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: dueAfterPart.body.outstanding_rs,
      method: 'cash',
      notes: 'weekly hisab',
    });
    expect(full.status).toBe(201);
    const due2 = await request(app)
      .get('/api/driver/commission-due')
      .set('Authorization', `Bearer ${driver.token}`);
    // Partial (if accepted) + full may over-cover; outstanding floors at 0.
    expect(due2.body.outstanding_paise).toBe(0);

    const over = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: 1,
      method: 'cash',
    });
    expect(over.status).toBe(409);
  });

  it('due limit blocks accept with 403 + current due', async () => {
    process.env.COMMISSION_DUE_LIMIT = '50';
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);
    const exp = splitFare(toPaise(b1.price_rs), 1500);
    expect(exp.commissionPaise).toBeGreaterThan(5000); // over Rs 50

    const b2 = await makeBooking(user.token);
    const blocked = await request(app)
      .patch(`/api/driver/bookings/${b2.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('commission_limit_exceeded');
    expect(blocked.body.outstanding_rs).toBe(exp.commissionPaise / 100);

    // After settling, accept works again.
    await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: exp.commissionPaise / 100,
      method: 'cash',
    }).expect(201);
    const ok = await request(app)
      .patch(`/api/driver/bookings/${b2.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(ok.status).toBe(200);
  });

  it('dispute flag — driver/user can flag, admin filter sees it, money untouched', async () => {
    const user = await makeUser(nextPhone());
    const stranger = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token);
    await request(app)
      .patch(`/api/driver/bookings/${b.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    const bad = await request(app)
      .post(`/api/bookings/${b.id}/flag-dispute`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({});
    expect(bad.status).toBe(400);

    const uflag = await request(app)
      .post(`/api/bookings/${b.id}/flag-dispute`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'kiraya zyada laga' });
    expect(uflag.status).toBe(200);
    expect(uflag.body.booking.disputed).toBe(true);
    expect(uflag.body.booking.dispute_reason).toBe('kiraya zyada laga');

    const dflag = await request(app)
      .post(`/api/driver/bookings/${b.id}/flag-dispute`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ reason: 'customer ne samaan badha diya' });
    expect(dflag.status).toBe(200);
    expect(dflag.body.booking.dispute_reason).toBe('customer ne samaan badha diya');

    const snooping = await request(app)
      .post(`/api/bookings/${b.id}/flag-dispute`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .send({ reason: 'main kaun' });
    expect(snooping.status).toBe(404);

    const anon = await request(app)
      .post(`/api/bookings/${b.id}/flag-dispute`)
      .send({ reason: 'bina login' });
    expect(anon.status).toBe(401);

    // Admin filter.
    const flagged = await admin(request(app).get('/api/admin/bookings?disputed=true'));
    expect(flagged.body.bookings.some((x) => x.id === b.id)).toBe(true);
    const clean = await admin(request(app).get('/api/admin/bookings?disputed=false'));
    expect(clean.body.bookings.some((x) => x.id === b.id)).toBe(false);

    // Money untouched by the flag: advance (already accepted) then check split.
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      await request(app)
        .patch(`/api/driver/bookings/${b.id}/status`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ status: st })
        .expect(200);
    }
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const pay = ledger.body.payments.find((p) => p.booking_id === b.id);
    const exp = splitFare(toPaise(b.price_rs), 1500);
    expect(toPaise(pay.platform_commission_rs)).toBe(exp.commissionPaise);
  });

  it('upi_id surfaces on accepted booking detail (user) but not before', async () => {
    const user = await makeUser(nextPhone());
    const phone = nextPhone();
    const d = await request(app).post('/api/drivers/register').send({
      name: 'UPI Driver',
      phone,
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: `MP${phone.slice(-8)}`,
      upi_id: 'trip@okhdfc',
    });
    expect(d.status).toBe(201);
    const verified = await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
    expect(verified.rowCount).toBe(1);

    const b = await makeBooking(user.token, { vehicle_type: 'pickup' });
    const before = await request(app)
      .get(`/api/bookings/${b.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(before.body.booking.driver).toBeUndefined();

    await request(app)
      .patch(`/api/driver/bookings/${b.id}/accept`)
      .set('Authorization', `Bearer ${d.body.token}`)
      .expect(200);
    const after = await request(app)
      .get(`/api/bookings/${b.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(after.body.booking.driver.upi_id).toBe('trip@okhdfc');
    expect(after.body.booking.driver.phone).toBeUndefined();
  });
});
