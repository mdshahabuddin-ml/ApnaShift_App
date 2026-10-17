// In-app notifications tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://apnashift:changeme@localhost:5433/apnashift_test npx vitest run tests/notifications.test.js
// Skips if not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll, makeTestClient, hasTestDb } from './helpers/db.js';
import {
  queueNotification,
  unreadCount,
  notificationsSince,
  clearRecipientSubscribers,
} from '../src/services/notifyCenter.js';
import { fcmConfigured, pushToOwner } from '../src/services/fcm.js';

const HAS_DB = hasTestDb;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? makeTestClient() : null;

let phoneSeq = 9880000000;
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
  const idRow = await client.query('SELECT id FROM drivers WHERE phone = $1', [phone]);
  return { ...res.body, driver: { ...(res.body.driver ?? {}), id: idRow.rows[0].id } };
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

async function acceptBooking(driverToken, bookingId) {
  const res = await request(app)
    .patch(`/api/driver/bookings/${bookingId}/accept`)
    .set('Authorization', `Bearer ${driverToken}`);
  expect(res.status).toBe(200);
  return res.body.booking;
}

async function advanceStatus(driverToken, bookingId, status) {
  const res = await request(app)
    .patch(`/api/driver/bookings/${bookingId}/status`)
    .set('Authorization', `Bearer ${driverToken}`)
    .send({ status });
  expect(res.status).toBe(200);
  return res.body.booking;
}

async function notifList(token) {
  const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.items;
}

async function unread(token) {
  const res = await request(app)
    .get('/api/notifications/unread-count')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.unread;
}

describeDb('notifications (DB)', () => {
  let adminToken;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    clearRecipientSubscribers();
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    adminToken = await makeAdmin(nextPhone());
  });

  it('auth — bina token 401, admin role 403', async () => {
    expect((await request(app).get('/api/notifications')).status).toBe(401);
    expect((await request(app).get('/api/notifications/unread-count')).status).toBe(401);
    expect(
      (await request(app).get('/api/notifications').set('Authorization', `Bearer ${adminToken}`))
        .status,
    ).toBe(403);
    // Stream bhi auth mangta hai (hang nahi — turant 401).
    expect(
      (await request(app).get('/api/notifications/stream').timeout(5000)).status,
    ).toBe(401);
  });

  it('booking create -> customer ko booking_created + unread 1', async () => {
    const user = await makeUser(nextPhone());
    await makeBooking(user.token);
    const items = await notifList(user.token);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'booking_created', title: 'Booking placed' });
    expect(items[0].booking_id).toBeTruthy();
    expect(items[0].read_at).toBeNull();
    expect(await unread(user.token)).toBe(1);
  });

  it('accept/arrive/transit/deliver -> customer timeline + dedupe', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const b = await makeBooking(user.token);
    await acceptBooking(d1.token, b.id);
    // Dobara accept 409 — koi duplicate notification nahi.
    const again = await request(app)
      .patch(`/api/driver/bookings/${b.id}/accept`)
      .set('Authorization', `Bearer ${d1.token}`);
    expect(again.status).toBe(409);
    await advanceStatus(d1.token, b.id, 'arrived');
    await advanceStatus(d1.token, b.id, 'in_transit');
    await advanceStatus(d1.token, b.id, 'delivered');
    const types = (await notifList(user.token)).map((n) => n.type);
    expect(types).toEqual([
      'trip_completed',
      'trip_started',
      'driver_arrived',
      'booking_accepted',
      'booking_created',
    ]);
    expect(await unread(user.token)).toBe(5);
  });

  it('user cancel -> assigned driver ko booking_cancelled (customer ko nahi)', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const b = await makeBooking(user.token);
    await acceptBooking(d1.token, b.id);
    const res = await request(app)
      .patch(`/api/bookings/${b.id}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'changed_plan' });
    expect(res.status).toBe(200);
    const driverTypes = (await notifList(d1.token)).map((n) => n.type);
    expect(driverTypes).toEqual(['booking_cancelled']);
    const userTypes = (await notifList(user.token)).map((n) => n.type);
    expect(userTypes).toEqual(['booking_accepted', 'booking_created']);
  });

  it('admin assign -> customer booking_accepted + driver assignment_received', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const b = await makeBooking(user.token);
    const res = await request(app)
      .patch(`/api/admin/bookings/${b.id}/assign`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ driver_id: d1.driver.id });
    expect(res.status).toBe(200);
    expect((await notifList(user.token)).map((n) => n.type)).toEqual([
      'booking_accepted',
      'booking_created',
    ]);
    expect((await notifList(d1.token)).map((n) => n.type)).toEqual(['assignment_received']);
  });

  it('cross-user isolation — dusre ka notification 404', async () => {
    const u1 = await makeUser(nextPhone());
    const u2 = await makeUser(nextPhone());
    await makeBooking(u1.token);
    const items = await notifList(u1.token);
    expect(items).toHaveLength(1);
    // u2 apni list me kuch nahi dekhta.
    expect(await notifList(u2.token)).toHaveLength(0);
    // u2 u1 ka row read nahi kar sakta.
    const res = await request(app)
      .patch(`/api/notifications/${items[0].id}/read`)
      .set('Authorization', `Bearer ${u2.token}`);
    expect(res.status).toBe(404);
    expect(await unread(u1.token)).toBe(1);
  });

  it('read + read-all + pagination + validation', async () => {
    const user = await makeUser(nextPhone());
    const d1 = await makeDriver(nextPhone(), 'mini_truck');
    const b = await makeBooking(user.token);
    await acceptBooking(d1.token, b.id);
    await advanceStatus(d1.token, b.id, 'arrived');
    const items = await notifList(user.token);
    expect(items).toHaveLength(3);
    // Pagination: limit=2 -> newest 2.
    const page = await request(app)
      .get('/api/notifications?limit=2')
      .set('Authorization', `Bearer ${user.token}`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.items[0].type).toBe('driver_arrived');
    // Cursor: before=oldest -> khaali.
    const oldest = items[items.length - 1].created_at;
    const cursor = await request(app)
      .get(`/api/notifications?before=${encodeURIComponent(oldest)}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(cursor.status).toBe(200);
    expect(cursor.body.items).toHaveLength(0);
    // Single read.
    const one = await request(app)
      .patch(`/api/notifications/${items[0].id}/read`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(one.status).toBe(200);
    expect(await unread(user.token)).toBe(2);
    // Read-all.
    const all = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${user.token}`);
    expect(all.status).toBe(200);
    expect(all.body.updated).toBe(2);
    expect(await unread(user.token)).toBe(0);
    // Validation: limit range + bad cursor 400.
    expect(
      (await request(app).get('/api/notifications?limit=999').set('Authorization', `Bearer ${user.token}`))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/notifications?before=not-a-date')
          .set('Authorization', `Bearer ${user.token}`)
      ).status,
    ).toBe(400);
  });

  it('device tokens — register upsert + unregister + validation', async () => {
    const user = await makeUser(nextPhone());
    const auth = (req) => req.set('Authorization', `Bearer ${user.token}`);
    const tok = `fcm-token-${Date.now()}`;
    expect((await auth(request(app).post('/api/notifications/device-tokens').send({ platform: 'web', token: tok }))).status).toBe(201);
    // Dobara register -> upsert (201, single row).
    expect((await auth(request(app).post('/api/notifications/device-tokens').send({ platform: 'android', token: tok }))).status).toBe(201);
    const count = await client.query('SELECT COUNT(*) AS n FROM device_tokens');
    expect(Number(count.rows[0].n)).toBe(1);
    // Galat platform 400.
    expect(
      (await auth(request(app).post('/api/notifications/device-tokens').send({ platform: 'sms', token: tok }))).status,
    ).toBe(400);
    // Unregister.
    expect(
      (await auth(request(app).delete('/api/notifications/device-tokens').send({ token: tok }))).status,
    ).toBe(200);
    const after = await client.query('SELECT COUNT(*) AS n FROM device_tokens');
    expect(Number(after.rows[0].n)).toBe(0);
  });

  it('service dedupe + since-cursor + FCM no-op bina secrets', async () => {
    const userPhone = nextPhone();
    const user = await makeUser(userPhone);
    const b = await makeBooking(user.token);
    const me = await client.query('SELECT id FROM users WHERE phone = $1', [userPhone]);
    expect(me.rowCount).toBe(1);
    const uid = me.rows[0].id;
    const first = await queueNotification({
      role: 'user',
      recipientId: uid,
      bookingId: b.id,
      type: 'booking_accepted',
    });
    expect(first).not.toBeNull();
    // Same event dobara -> null (koi duplicate row nahi).
    const dup = await queueNotification({
      role: 'user',
      recipientId: uid,
      bookingId: b.id,
      type: 'booking_accepted',
    });
    expect(dup).toBeNull();
    const rows = await client.query('SELECT COUNT(*) AS n FROM notifications');
    // booking_created (flow) + booking_accepted (direct) = 2.
    expect(Number(rows.rows[0].n)).toBe(2);
    // since-cursor: purana timestamp -> dono, naya -> khaali.
    expect((await notificationsSince('user', uid, '2000-01-01T00:00:00.000Z')).length).toBe(2);
    expect((await notificationsSince('user', uid, new Date().toISOString())).length).toBe(0);
    expect(await unreadCount('user', uid)).toBe(2);
    // FCM secrets nahi — sender turant no-op, kabhi throw nahi.
    expect(fcmConfigured()).toBe(false);
    expect(await pushToOwner('user', uid, { title: 't', body: 'b' })).toMatchObject({
      skipped: true,
    });
  });
});
