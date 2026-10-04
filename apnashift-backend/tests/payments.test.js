// Cash payment / commission / settlement tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips if not set. Money math is integer-paise (services/money.js).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

let phoneSeq = 9900000000;
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

// Spec example, exact paise: 100000 @15% -> 15000 commission, 85000 earning.
function expectedSplit(grossRs, pct = 15) {
  const grossPaise = toPaise(grossRs);
  const { commissionPaise, earningPaise } = splitFare(grossPaise, pctToBps(pct));
  return { grossPaise, commissionPaise, earningPaise };
}

describeDb('cash payments + commission + settlements (DB)', () => {
  let adminToken;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client); // also reseeds default 15% commission
    adminToken = await makeAdmin(nextPhone());
  });

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  it('money math — spec example exact, half-up rounding, guards', () => {
    expect(splitFare(100000, 1500)).toEqual({ commissionPaise: 15000, earningPaise: 85000 });
    expect(paiseToRs(15000)).toBe(150);
    expect(paiseToRs(85000)).toBe(850);
    // Half-up: 1001 paise @15% = 150.15 -> 150.
    expect(splitFare(1001, 1500)).toEqual({ commissionPaise: 150, earningPaise: 851 });
    // Dust: 1 paise @15% = 0.15 -> 0 commission, driver keeps 1.
    expect(splitFare(1, 1500)).toEqual({ commissionPaise: 0, earningPaise: 1 });
    expect(toPaise(640.55)).toBe(64055);
    expect(pctToBps(15)).toBe(1500);
    expect(() => toPaise(-5)).toThrowError(
      expect.objectContaining({ status: 400, message: 'invalid_amount' }),
    );
    expect(() => pctToBps(101)).toThrowError(
      expect.objectContaining({ status: 400, message: 'invalid_commission' }),
    );
  });

  it('delivery mints immutable cash payment with snapshot rate', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    expect(booking.payment_method).toBe('upi');
    expect(booking.payment).toBeNull();
    await acceptAndDeliver(driver.token, booking.id);

    const got = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(got.status).toBe(200);
    const pay = got.body.booking.payment;
    expect(pay.payment_method).toBe('upi');
    expect(pay.payment_status).toBe('collected');
    const exp = expectedSplit(booking.price_rs, 15);
    expect(toPaise(pay.gross_rs)).toBe(exp.grossPaise);
    // Customer viewer: fare + method + status only (no commission internals).
    expect(pay.driver_earning_rs).toBeUndefined();
    expect(pay.platform_commission_rs).toBeUndefined();
    expect(pay.commission_pct).toBeUndefined();
    expect(pay.settlement_status).toBeUndefined();

    // Backend-computed split verified through the admin ledger (full view).
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const full = ledger.body.payments.find((p) => p.booking_id === booking.id);
    expect(toPaise(full.platform_commission_rs)).toBe(exp.commissionPaise);
    expect(toPaise(full.driver_earning_rs)).toBe(exp.earningPaise);
    expect(full.commission_pct).toBe(15);
    expect(full.settlement_status).toBe('owed');

    // Immutable: exactly one row, UNIQUE(booking_id) enforced at DB level.
    const rows = await client.query('SELECT COUNT(*) c FROM payments WHERE booking_id = $1', [
      booking.id,
    ]);
    expect(Number(rows.rows[0].c)).toBe(1);
  });

  it('driver available shows server estimate; mine shows actual after delivery', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);

    const avail = await request(app)
      .get('/api/driver/bookings/available?limit=20')
      .set('Authorization', `Bearer ${driver.token}`);
    const pending = avail.body.bookings.find((b) => b.id === booking.id);
    expect(pending.payment).toBeNull();
    expect(pending.estimate.estimated).toBe(true);
    expect(pending.estimate.payment_method).toBe('upi');
    expect(pending.estimate.commission_pct).toBe(15);
    const exp = expectedSplit(pending.price_rs, 15);
    expect(toPaise(pending.estimate.commission_rs)).toBe(exp.commissionPaise);
    expect(toPaise(pending.estimate.earning_rs)).toBe(exp.earningPaise);

    await acceptAndDeliver(driver.token, booking.id);
    const mine = await request(app)
      .get('/api/driver/bookings?limit=20')
      .set('Authorization', `Bearer ${driver.token}`);
    const done = mine.body.bookings.find((b) => b.id === booking.id);
    expect(done.payment.payment_status).toBe('collected');
    expect(toPaise(done.payment.platform_commission_rs)).toBe(exp.commissionPaise);
    expect(done.estimate).toBeNull();
  });

  it('commission change applies to future deliveries only (snapshot)', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);

    const put = await admin(request(app).put('/api/admin/commission')).send({ pct: 20 });
    expect(put.status).toBe(200);
    expect(put.body.commission_pct).toBe(20);

    const b2 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b2.id);
    const [p1, p2] = await Promise.all(
      [b1, b2].map((b) =>
        request(app).get(`/api/bookings/${b.id}`).set('Authorization', `Bearer ${user.token}`),
      ),
    );
    // User viewer hides pct; check via admin ledger.
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const row1 = ledger.body.payments.find((p) => p.booking_id === b1.id);
    const row2 = ledger.body.payments.find((p) => p.booking_id === b2.id);
    expect(row1.commission_pct).toBe(15);
    expect(row2.commission_pct).toBe(20);
    expect(p1.body.booking.payment).toBeTruthy();
    expect(p2.body.booking.payment).toBeTruthy();

    const hist = await admin(request(app).get('/api/admin/commission'));
    expect(hist.body.commission_pct).toBe(20);
    expect(hist.body.history[0]).toMatchObject({ old_pct: 15, new_pct: 20 });

    for (const bad of [{ pct: -1 }, { pct: 101 }, { pct: 15.123 }, {}]) {
      expect((await admin(request(app).put('/api/admin/commission')).send(bad)).status).toBe(400);
    }
    const asUser = await request(app)
      .put('/api/admin/commission')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ pct: 10 });
    expect(asUser.status).toBe(403);
  });

  it('driver ledger — summary + payments + settlements, own data only', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const other = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token);
    const b2 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);
    await acceptAndDeliver(driver.token, b2.id);

    const ledger = await request(app)
      .get('/api/driver/ledger')
      .set('Authorization', `Bearer ${driver.token}`);
    expect(ledger.status).toBe(200);
    const exp1 = expectedSplit(b1.price_rs);
    const exp2 = expectedSplit(b2.price_rs);
    expect(ledger.body.summary.completed_cash_bookings).toBe(2);
    expect(ledger.body.summary.commission_paise).toBe(exp1.commissionPaise + exp2.commissionPaise);
    expect(ledger.body.summary.outstanding_paise).toBe(exp1.commissionPaise + exp2.commissionPaise);
    expect(ledger.body.payments).toHaveLength(2);
    expect(ledger.body.settlements).toHaveLength(0);

    const Space = await request(app)
      .get('/api/driver/ledger')
      .set('Authorization', `Bearer ${other.token}`);
    expect(Space.body.summary.completed_cash_bookings).toBe(0);
    expect(Space.body.summary.outstanding_paise).toBe(0);

    const asUser = await request(app)
      .get('/api/driver/ledger')
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);
  });

  it('settlement — full pay, duplicate + over-settle blocked, FIFO partials', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token);
    const b2 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);
    await acceptAndDeliver(driver.token, b2.id);
    const exp1 = expectedSplit(b1.price_rs);
    const exp2 = expectedSplit(b2.price_rs);
    const total = exp1.commissionPaise + exp2.commissionPaise;

    // Partial: half of first payment's commission (rounded up to be safe).
    const half = Math.ceil(exp1.commissionPaise / 2);
    const part = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(half),
      method: 'cash',
      notes: 'part 1',
    });
    expect(part.status).toBe(201);
    expect(part.body.outstanding_rs).toBe(paiseToRs(total - half));

    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const first = ledger.body.payments.find((p) => p.booking_id === b1.id);
    const second = ledger.body.payments.find((p) => p.booking_id === b2.id);
    expect(first.settlement_status).toBe('partial');
    expect(second.settlement_status).toBe('owed');

    // Settle the rest exactly.
    const rest = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(total - half),
      method: 'upi',
      reference_no: 'UPI-REF-001',
    });
    expect(rest.status).toBe(201);
    expect(rest.body.outstanding_rs).toBe(0);

    const ledger2 = await admin(request(app).get('/api/admin/ledger'));
    expect(ledger2.body.payments.every((p) => p.settlement_status === 'settled')).toBe(true);

    // Duplicate full replay + over-settle both blocked by outstanding check.
    const dup = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(total),
      method: 'cash',
    });
    expect(dup.status).toBe(409);
    const over = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: 1,
      method: 'cash',
    });
    expect(over.status).toBe(409);

    // Same reference twice -> 409 duplicate even with fresh outstanding.
    const b3 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b3.id);
    const exp3 = expectedSplit(b3.price_rs);
    const s1 = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(Math.max(1, Math.floor(exp3.commissionPaise / 2))),
      method: 'bank_transfer',
      reference_no: 'NEFT-DUP-1',
    });
    expect(s1.status).toBe(201);
    const s2 = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(1),
      method: 'bank_transfer',
      reference_no: 'NEFT-DUP-1',
    });
    expect(s2.status).toBe(409);

    // Guards: bad driver, bad amount/method, reference rules.
    expect(
      (
        await admin(request(app).post('/api/admin/settlements')).send({
          driver_id: '00000000-0000-0000-0000-000000000000',
          amount_rs: 10,
          method: 'cash',
        })
      ).status,
    ).toBe(404);
    for (const bad of [
      { driver_id: driver.user.id, amount_rs: -5, method: 'cash' },
      { driver_id: driver.user.id, amount_rs: 0, method: 'cash' },
      { driver_id: driver.user.id, amount_rs: 10, method: 'cheque' },
      { driver_id: driver.user.id, amount_rs: 10, method: 'upi' },
      { driver_id: driver.user.id, method: 'cash' },
    ]) {
      expect((await admin(request(app).post('/api/admin/settlements')).send(bad)).status).toBe(400);
    }
    const asDriver = await request(app)
      .post('/api/admin/settlements')
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ driver_id: driver.user.id, amount_rs: 10, method: 'cash' });
    expect(asDriver.status).toBe(403);
  });

  it('balances dashboard + adjustments move outstanding, audited', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);
    const exp = expectedSplit(b1.price_rs);

    const balances = await admin(request(app).get('/api/admin/driver-balances'));
    const row = balances.body.balances.find((x) => x.driver_id === driver.user.id);
    expect(row.completed_cash_bookings).toBe(1);
    expect(toPaise(row.cash_collected_rs)).toBe(exp.grossPaise);
    expect(toPaise(row.outstanding_rs)).toBe(exp.commissionPaise);

    // Positive commission correction raises what the driver owes.
    const pay = await admin(request(app).get('/api/admin/ledger'));
    const pid = pay.body.payments.find((p) => p.booking_id === b1.id).id;
    const adj = await admin(request(app).post('/api/admin/adjustments')).send({
      payment_id: pid,
      commission_delta_paise: 500,
      earning_delta_paise: 0,
      reason: 'toll miss tha — joda',
    });
    expect(adj.status).toBe(201);

    const balances2 = await admin(request(app).get('/api/admin/driver-balances'));
    const row2 = balances2.body.balances.find((x) => x.driver_id === driver.user.id);
    expect(toPaise(row2.outstanding_rs)).toBe(exp.commissionPaise + 500);

    const detail = await admin(request(app).get(`/api/admin/payments/${pid}`));
    expect(detail.body.adjustments).toHaveLength(1);
    expect(detail.body.adjustments[0].reason).toBe('toll miss tha — joda');

    // Zero-delta and missing payment rejected.
    expect(
      (
        await admin(request(app).post('/api/admin/adjustments')).send({
          payment_id: pid,
          reason: 'kuch nahi',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin(request(app).post('/api/admin/adjustments')).send({
          payment_id: '00000000-0000-0000-0000-000000000000',
          commission_delta_paise: 100,
          reason: 'test wajah',
        })
      ).status,
    ).toBe(404);
  });

  it('cancelled booking creates no payment; online booking rejected for now', async () => {
    const user = await makeUser(nextPhone());
    const b = await makeBooking(user.token);
    const c = await request(app)
      .patch(`/api/bookings/${b.id}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'changed_plan' });
    expect(c.status).toBe(200);
    expect(c.body.booking.payment).toBeNull();
    const n = await client.query('SELECT COUNT(*) c FROM payments WHERE booking_id = $1', [b.id]);
    expect(Number(n.rows[0].c)).toBe(0);

    const online = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send(bookingPayload({ payment_method: 'online' }));
    expect(online.status).toBe(400);
    expect(online.body.error).toBe('unsupported_payment_method');
  });

  it('audit trail — payment, settlement, commission, adjustment logged', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b.id);
    await admin(request(app).put('/api/admin/commission')).send({ pct: 16 });
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const pid = ledger.body.payments.find((p) => p.booking_id === b.id).id;
    await admin(request(app).post('/api/admin/adjustments')).send({
      payment_id: pid,
      earning_delta_paise: 100,
      reason: 'audit trail check',
    });
    const exp = expectedSplit(b.price_rs, 15);
    await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: paiseToRs(exp.commissionPaise),
      method: 'cash',
    });
    const audit = await client.query(`SELECT action FROM audit_logs WHERE action LIKE 'payment.%' OR action LIKE 'settlement.%' OR action LIKE 'commission.%'`);
    const actions = audit.rows.map((r) => r.action);
    for (const a of ['payment.collected', 'commission.update', 'payment.adjust', 'settlement.create']) {
      expect(actions).toContain(a);
    }
    // Financial tables are append-only in API surface: no DELETE route exists
    // (verified by code review); rows still present here.
    expect(Number((await client.query('SELECT COUNT(*) c FROM payments')).rows[0].c)).toBeGreaterThan(0);
  });
});
