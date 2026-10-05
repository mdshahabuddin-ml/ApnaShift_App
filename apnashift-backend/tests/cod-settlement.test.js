// COD + weekly settlement tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/cod-settlement.test.js
// Skips if not set. Money math is integer-paise (services/money.js).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import { toPaise, paiseToRs, pctToBps, splitFare } from '../src/services/money.js';
import { weekStartIST, isMondayDate, weekRangeUTC, effectiveStatus } from '../src/services/settlements.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function paymentByBooking(bookingId) {
  const found = await client.query('SELECT * FROM payments WHERE booking_id = $1', [bookingId]);
  expect(found.rowCount).toBe(1);
  return found.rows[0];
}

describeDb('COD + weekly settlement (DB)', () => {
  let adminToken;
  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

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

  it('week helpers — Mon–Sun IST, invalid weeks rejected', () => {
    // 2026-10-05 is a Monday.
    expect(weekStartIST(new Date('2026-10-05T12:00:00+05:30'))).toBe('2026-10-05');
    expect(weekStartIST(new Date('2026-10-11T23:59:59+05:30'))).toBe('2026-10-05');
    expect(weekStartIST(new Date('2026-10-12T00:00:01+05:30'))).toBe('2026-10-12');
    expect(isMondayDate('2026-10-05')).toBe(true);
    expect(isMondayDate('2026-10-11')).toBe(false);
    expect(isMondayDate('not-a-date')).toBe(false);
    const { start, end } = weekRangeUTC('2026-10-05');
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(() => weekRangeUTC('2026-10-11')).toThrowError(
      expect.objectContaining({ message: 'invalid_week' }),
    );
    // OVERDUE derived: past DUE week, still owed.
    expect(
      effectiveStatus(
        { status: 'DUE', week_end: '2020-01-05', commission_paise: 15000, settled_paise: 0 },
        new Date('2026-10-05T12:00:00+05:30'),
      ),
    ).toBe('OVERDUE');
    expect(
      effectiveStatus(
        { status: 'PAID', week_end: '2020-01-05', commission_paise: 15000, settled_paise: 15000 },
        new Date('2026-10-05T12:00:00+05:30'),
      ),
    ).toBe('PAID');
  });

  it('spec example — Rs 1000 @15% = 150 commission + 850 earning (paise)', () => {
    expect(splitFare(100000, 1500)).toEqual({ commissionPaise: 15000, earningPaise: 85000 });
    expect(paiseToRs(15000)).toBe(150);
    expect(paiseToRs(85000)).toBe(850);
  });

  it('COD delivery stays pending (never auto-collected); UPI unchanged', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const cash = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, cash.id);
    const row = await paymentByBooking(cash.id);
    expect(row.payment_method).toBe('cash');
    expect(row.payment_status).toBe('pending');
    expect(row.cash_confirmed_at).toBeNull();

    const upi = await makeBooking(user.token); // default upi
    await acceptAndDeliver(driver.token, upi.id);
    const urow = await paymentByBooking(upi.id);
    expect(urow.payment_status).toBe('collected');
  });

  it('driver confirm — success, duplicate 409, authz gates', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const other = await makeDriver(nextPhone());
    const cash = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, cash.id);
    const row = await paymentByBooking(cash.id);

    // Foreign driver -> 404 (own rows only).
    const foreign = await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(foreign.status).toBe(404);
    // User role -> 403.
    const asUser = await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);

    const ok = await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.payment.payment_status).toBe('collected');
    const after = await paymentByBooking(cash.id);
    expect(after.cash_confirmed_at).not.toBeNull();

    // Duplicate confirm never double-counts.
    const dup = await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_confirmed');

    // Non-cash payment -> 409.
    const upi = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, upi.id);
    const urow = await paymentByBooking(upi.id);
    const notCash = await request(app)
      .post(`/api/driver/payments/${urow.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(notCash.status).toBe(409);

    // Unverified driver blocked even with a valid pending row.
    const cash2 = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, cash2.id);
    await client.query('UPDATE drivers SET is_verified = FALSE WHERE id = $1', [driver.user.id]);
    const row2 = await paymentByBooking(cash2.id);
    const unv = await request(app)
      .post(`/api/driver/payments/${row2.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(unv.status).toBe(403);
  });

  it('weekly generate — one row per driver/week, collected only, idempotent', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token, { payment_method: 'cash' });
    const b2 = await makeBooking(user.token); // upi
    await acceptAndDeliver(driver.token, b1.id);
    await acceptAndDeliver(driver.token, b2.id);
    // Confirm only b1 — b2 (upi) is collected at delivery already.
    const r1 = await paymentByBooking(b1.id);
    await request(app)
      .post(`/api/driver/payments/${r1.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    const exp1 = splitFare(toPaise(b1.price_rs), pctToBps(15));
    const exp2 = splitFare(toPaise(b2.price_rs), pctToBps(15));

    const gen = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({});
    expect(gen.status).toBe(200);
    expect(gen.body.created).toHaveLength(1);
    const period = gen.body.created[0];
    expect(period.driver_id).toBe(driver.user.id);
    expect(period.status).toBe('DUE');
    // NOTE: splitFare returns { commissionPaise, earningPaise } only —
    // gross comes from the booking price itself.
    expect(toPaise(period.gross_rs)).toBe(toPaise(b1.price_rs) + toPaise(b2.price_rs));
    expect(toPaise(period.commission_rs)).toBe(exp1.commissionPaise + exp2.commissionPaise);
    expect(toPaise(period.earning_rs)).toBe(exp1.earningPaise + exp2.earningPaise);

    // Re-run: same week skipped, never doubled.
    const again = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({});
    expect(again.body.created).toHaveLength(0);
    const n = await client.query('SELECT COUNT(*) c FROM settlement_periods WHERE driver_id = $1', [
      driver.user.id,
    ]);
    expect(Number(n.rows[0].c)).toBe(1);
    // Explicit same driver+week reports already_generated (not a second row).
    const explicit = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
    });
    expect(explicit.body.created).toHaveLength(0);
    expect(explicit.body.skipped).toContainEqual(
      expect.objectContaining({ driver_id: driver.user.id, reason: 'already_generated' }),
    );

    // Driver sees own week; other driver sees nothing + detail 404.
    const mine = await request(app)
      .get('/api/driver/settlement-periods')
      .set('Authorization', `Bearer ${driver.token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.total).toBe(1);
    const detail = await request(app)
      .get(`/api/driver/settlement-periods/${period.id}`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.items).toHaveLength(2);
    const foreign = await request(app)
      .get(`/api/driver/settlement-periods/${period.id}`)
      .set('Authorization', `Bearer ${(await makeDriver(nextPhone())).token}`);
    expect(foreign.status).toBe(404);
    const asUser = await request(app)
      .get('/api/driver/settlement-periods')
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);
  });

  it('unconfirmed COD excluded until driver confirms', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, b.id);

    const gen1 = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
    });
    // Pending cash is not collected yet — nothing to settle.
    expect(gen1.body.created).toHaveLength(0);

    const row = await paymentByBooking(b.id);
    await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    const gen2 = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
    });
    expect(gen2.body.created).toHaveLength(1);
  });

  it('period pay — partial, full, finalized frozen, overpay blocked', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b1 = await makeBooking(user.token, { payment_method: 'cash' });
    const b2 = await makeBooking(user.token);
    await acceptAndDeliver(driver.token, b1.id);
    await acceptAndDeliver(driver.token, b2.id);
    const r1 = await paymentByBooking(b1.id);
    await request(app)
      .post(`/api/driver/payments/${r1.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    const exp1 = splitFare(toPaise(b1.price_rs), pctToBps(15));
    const exp2 = splitFare(toPaise(b2.price_rs), pctToBps(15));
    const total = exp1.commissionPaise + exp2.commissionPaise;

    const gen = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
    });
    const pid = gen.body.created[0].id;

    const half = Math.ceil(total / 2);
    const part = await admin(
      request(app).post(`/api/admin/settlement-periods/${pid}/payments`),
    ).send({ amount_rs: paiseToRs(half), method: 'cash' });
    expect(part.status).toBe(201);
    expect(part.body.period.status).toBe('PARTIALLY_PAID');
    expect(toPaise(part.body.outstanding_rs)).toBe(total - half);

    const rest = await admin(
      request(app).post(`/api/admin/settlement-periods/${pid}/payments`),
    ).send({ amount_rs: paiseToRs(total - half), method: 'upi', reference_no: 'UPI-WK-1' });
    expect(rest.status).toBe(201);
    expect(rest.body.period.status).toBe('PAID');
    expect(rest.body.outstanding_rs).toBe(0);

    // Finalized: further pay + dispute + adjustment all blocked.
    const more = await admin(
      request(app).post(`/api/admin/settlement-periods/${pid}/payments`),
    ).send({ amount_rs: 1, method: 'cash' });
    expect(more.status).toBe(409);
    expect(more.body.error).toBe('settlement_finalized');
    const disp = await admin(request(app).patch(`/api/admin/settlement-periods/${pid}/dispute`)).send({
      reason: 'too late',
    });
    expect(disp.status).toBe(409);
    const ledger = await admin(request(app).get('/api/admin/ledger'));
    const anyPid = ledger.body.payments.find((p) => p.booking_id === b1.id).id;
    const adj = await admin(request(app).post('/api/admin/adjustments')).send({
      payment_id: anyPid,
      commission_delta_paise: 100,
      reason: 'final week edit try',
    });
    expect(adj.status).toBe(409);
    expect(adj.body.error).toBe('settlement_finalized');

    // Global settlement also finds nothing left (no silent drift).
    const over = await admin(request(app).post('/api/admin/settlements')).send({
      driver_id: driver.user.id,
      amount_rs: 1,
      method: 'cash',
    });
    expect(over.status).toBe(409);
  });

  it('dispute freezes pay until resolve; OVERDUE derived for past weeks', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, b.id);
    const row = await paymentByBooking(b.id);
    await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    // Move the confirmed payment 3 weeks back, generate that week.
    const old = new Date(Date.now() - 21 * 24 * 3600 * 1000);
    const monday = weekStartIST(old);
    await client.query('UPDATE payments SET collected_at = $1 WHERE id = $2', [
      new Date(`${monday}T12:00:00+05:30`).toISOString(),
      row.id,
    ]);
    const gen = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
      week_start: monday,
    });
    expect(gen.body.created).toHaveLength(1);
    const pid = gen.body.created[0].id;

    // Past unpaid week reads as OVERDUE (derived, never stored).
    const over = await admin(request(app).get('/api/admin/settlement-periods?status=OVERDUE'));
    expect(over.status).toBe(200);
    const found = over.body.periods.find((p) => p.id === pid);
    expect(found.effective_status).toBe('OVERDUE');
    expect(found.status).toBe('DUE');

    // Dispute freezes; pay blocked until resolve.
    const dis = await admin(request(app).patch(`/api/admin/settlement-periods/${pid}/dispute`)).send({
      reason: 'grahak ne kam paid kiya',
    });
    expect(dis.status).toBe(200);
    expect(dis.body.period.status).toBe('DISPUTED');
    const blocked = await admin(
      request(app).post(`/api/admin/settlement-periods/${pid}/payments`),
    ).send({ amount_rs: 10, method: 'cash' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('settlement_disputed');
    const res = await admin(request(app).patch(`/api/admin/settlement-periods/${pid}/resolve`)).send({});
    expect(res.status).toBe(200);
    expect(['DUE', 'PARTIALLY_PAID']).toContain(res.body.period.status);
  });

  it('audit trail covers COD + weekly flow', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const b = await makeBooking(user.token, { payment_method: 'cash' });
    await acceptAndDeliver(driver.token, b.id);
    const row = await paymentByBooking(b.id);
    await request(app)
      .post(`/api/driver/payments/${row.id}/confirm-cash`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    const gen = await admin(request(app).post('/api/admin/settlement-periods/generate')).send({
      driver_id: driver.user.id,
    });
    const pid = gen.body.created[0].id;
    const exp = splitFare(toPaise(b.price_rs), pctToBps(15));
    await admin(request(app).post(`/api/admin/settlement-periods/${pid}/payments`)).send({
      amount_rs: paiseToRs(exp.commissionPaise),
      method: 'cash',
    });
    const audit = await client.query(`SELECT action FROM audit_logs`);
    const actions = audit.rows.map((r) => r.action);
    for (const a of [
      'payment.created',
      'payment.cash_confirmed',
      'settlement.period_generate',
      'settlement.period_pay',
    ]) {
      expect(actions).toContain(a);
    }
  });
});
