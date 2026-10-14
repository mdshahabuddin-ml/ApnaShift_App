// Admin new-booking notifications (requires real Postgres).
// Admin stream gets new_booking (+ required fields, no secrets) and
// booking_status transitions. Run:
// TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/admin-notify.test.js
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

let phoneSeq = 9960000000;
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

async function makeUser(phone, name = 'Test User') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name, phone, password: 'password123' });
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

// Collect SSE events of given names until timeout. Resolves { events: [{ev, data}] }.
async function collectAdminEvents(port, token, wantCount, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/bookings/stream`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  const stop = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      // ignore — cleanup below handles it.
    }
  }, timeoutMs);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const block of parts) {
        let ev = null;
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice('event: '.length).trim();
          else if (line.startsWith('data: ')) data += line.slice('data: '.length).trim();
        }
        if (ev && ev !== 'ready' && data) events.push({ ev, data: JSON.parse(data) });
      }
      if (events.length >= wantCount) break;
    }
  } catch {
    // timeout abort — return what arrived.
  } finally {
    clearTimeout(stop);
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      // ignore.
    }
  }
  return events;
}

describeDb('admin booking notifications (DB)', () => {
  let server;
  let port;
  let adminToken;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    adminToken = await makeAdmin(nextPhone());
  });

  const adminGet = (path, token = adminToken) =>
    request(app).get(path).set('Authorization', `Bearer ${token}`);

  it('create emits admin new_booking with required fields, no secrets', async () => {
    const user = await makeUser(nextPhone(), 'Asha Customer');
    const eventsPromise = collectAdminEvents(port, adminToken, 1);
    await new Promise((r) => setTimeout(r, 300));
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send(bookingPayload({ payment_method: 'cash' }));
    expect(created.status).toBe(201);

    const events = await eventsPromise;
    expect(events).toHaveLength(1);
    expect(events[0].ev).toBe('new_booking');
    const e = events[0].data;
    expect(Object.keys(e).sort()).toEqual(
      [
        'booking_id',
        'customer_name',
        'pickup',
        'drop',
        'vehicle_type',
        'fare_rs',
        'payment_method',
        'status',
        'created_at',
      ].sort(),
    );
    expect(e).toMatchObject({
      booking_id: created.body.booking.id,
      customer_name: 'Asha Customer',
      vehicle_type: 'mini_truck',
      payment_method: 'cash',
      status: 'pending',
    });
    expect(e.pickup).toMatchObject({ address: '12 MG Road, Indore' });
    expect(e.drop).toMatchObject({ address: '45 AB Road, Indore' });
    expect(e.fare_rs).toBe(created.body.booking.price_rs);
    const raw = JSON.stringify(e).toLowerCase();
    for (const banned of ['phone', 'password', 'token', 'hash', 'apikey', 'api_key', 'upi_id']) {
      expect(raw.includes(banned)).toBe(false);
    }
  });

  it('status pipeline reaches admin: accepted -> ... -> delivered + cancel', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = (
      await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${user.token}`)
        .send(bookingPayload())
    ).body.booking;

    const eventsPromise = collectAdminEvents(port, adminToken, 6);
    await new Promise((r) => setTimeout(r, 300));
    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      await request(app)
        .patch(`/api/driver/bookings/${booking.id}/status`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ status: st })
        .expect(200);
    }
    // Cancel path on a second booking.
    const booking2 = (
      await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${user.token}`)
        .send(bookingPayload())
    ).body.booking;
    await request(app)
      .patch(`/api/bookings/${booking2.id}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'changed_plan' })
      .expect(200);

    const events = (await eventsPromise).filter((e) => e.ev === 'booking_status');
    const byId = {};
    for (const { ev, data } of events) {
      expect(ev).toBe('booking_status');
      byId[data.booking_id] = byId[data.booking_id] || [];
      byId[data.booking_id].push(data);
    }
    // booking 1 went accepted -> arrived -> in_transit -> delivered.
    expect(byId[booking.id].map((d) => d.status)).toEqual([
      'accepted',
      'arrived',
      'in_transit',
      'delivered',
    ]);
    expect(byId[booking.id][0]).toMatchObject({ driver_id: driver.user.id });
    // booking 2 cancel arrived (its new_booking also flew by — filtered here).
    const cancels = (byId[booking2.id] || []).filter((d) => d.status === 'cancelled');
    expect(cancels).toHaveLength(1);
  });

  it('admin assign emits accepted with driver; stream auth gates hold', async () => {
    const anon = await request(app).get('/api/admin/bookings/stream');
    expect(anon.status).toBe(401);
    const user = await makeUser(nextPhone());
    const asUser = await adminGet('/api/admin/bookings/stream', user.token);
    expect(asUser.status).toBe(403);

    const driver = await makeDriver(nextPhone());
    const booking = (
      await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${user.token}`)
        .send(bookingPayload())
    ).body.booking;

    const eventsPromise = collectAdminEvents(port, adminToken, 1);
    await new Promise((r) => setTimeout(r, 300));
    const assign = await request(app)
      .patch(`/api/admin/bookings/${booking.id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ driver_id: driver.user.id });
    expect(assign.status).toBe(200);
    const events = await eventsPromise;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ev: 'booking_status',
      data: { booking_id: booking.id, status: 'accepted', driver_id: driver.user.id },
    });
  });
});
