// Booking -> tracking end-to-end (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/booking-tracking.test.js
// Covers the customer flow the UI drives: create (id back) -> detail ->
// accept -> GPS posts -> live snapshot + SSE -> deliver -> posts stop ->
// state ended. Authz on every tracking API.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9930000000;
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

const GPS = { lat: 22.721, lng: 75.859, accuracy_m: 12.5 };

describeDb('booking -> live tracking E2E (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    process.env.TRACK_MIN_INTERVAL_MS = '0';
  });

  it('full flow: create -> detail -> accept -> GPS -> live -> deliver -> ended', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());

    // 1-2. Customer creates booking, backend returns the id.
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send(bookingPayload({ payment_method: 'cash' }));
    expect(created.status).toBe(201);
    const bookingId = created.body.booking.id;
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.body.booking.payment).toBeNull();

    // 3. Confirmation page data (what booking-detail.html renders).
    const detail = await request(app)
      .get(`/api/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking).toMatchObject({
      id: bookingId,
      status: 'pending',
      payment_method: 'cash',
    });
    expect(detail.body.booking.price_rs).toBeGreaterThan(0);

    // Pending (unassigned): driver GPS rejected, customer sees offline/empty.
    const prePost = await request(app)
      .post(`/api/driver/bookings/${bookingId}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send(GPS);
    expect(prePost.status).toBe(404);
    const preLoc = await request(app)
      .get(`/api/bookings/${bookingId}/location?history=1`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(preLoc.status).toBe(200);
    expect(preLoc.body.points).toHaveLength(0);
    expect(preLoc.body.tracking_active).toBe(false);
    expect(preLoc.body.tracking.state).toBe('offline');

    // 4. Driver accepts + arrives, then sends GPS.
    await request(app)
      .patch(`/api/driver/bookings/${bookingId}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    await request(app)
      .patch(`/api/driver/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ status: 'arrived' })
      .expect(200);
    const post1 = await request(app)
      .post(`/api/driver/bookings/${bookingId}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send(GPS);
    expect(post1.status).toBe(201);
    expect(post1.body.tracking).toBe('active');

    // 5. Customer sees the live driver (marker data + status + thresholds).
    const live = await request(app)
      .get(`/api/bookings/${bookingId}/location?history=5`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(live.status).toBe(200);
    expect(live.body.booking_status).toBe('arrived');
    expect(live.body.tracking_active).toBe(true);
    expect(live.body.tracking.state).toBe('live');
    expect(live.body.tracking.points_count).toBe(1);
    expect(live.body.tracking.stale_after_ms).toBeGreaterThan(0);
    expect(live.body.points[0]).toMatchObject({ lat: GPS.lat, lng: GPS.lng });
    // Driver identity without secrets.
    expect(live.body.driver.name).toBe('Test Driver');
    expect(live.body.driver.phone).toBeUndefined();
    // Last-updated time present for the UI clock.
    expect(typeof live.body.tracking.last_updated).toBe('string');

    // 6. SSE stream opens with a snapshot event (real HTTP on an ephemeral
    // port, then abort — the server only ends it on client disconnect).
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const ctrl = new AbortController();
    const streamRes = await fetch(
      `http://127.0.0.1:${port}/api/bookings/${bookingId}/location/stream`,
      { headers: { Authorization: `Bearer ${user.token}` }, signal: ctrl.signal },
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (!buf.includes('event: snapshot') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
    }
    expect(buf).toContain('event: snapshot');
    expect(buf).toContain(bookingId);
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      // ignore — abort already tore it down.
    }
    await new Promise((resolve) => server.close(resolve));

    // 7-8. Delivered: GPS stops (409), state ended, COD still unconfirmed.
    await request(app)
      .patch(`/api/driver/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ status: 'in_transit' })
      .expect(200);
    await request(app)
      .patch(`/api/driver/bookings/${bookingId}/status`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send({ status: 'delivered' })
      .expect(200);
    const postAfter = await request(app)
      .post(`/api/driver/bookings/${bookingId}/location`)
      .set('Authorization', `Bearer ${driver.token}`)
      .send(GPS);
    expect(postAfter.status).toBe(409);
    expect(postAfter.body.error).toBe('tracking_not_active');
    const ended = await request(app)
      .get(`/api/bookings/${bookingId}/location?history=1`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(ended.body.tracking.state).toBe('ended');
    expect(ended.body.tracking_active).toBe(false);
  });

  it('tracking authz on every API: stranger 404, driver 403, anon 401', async () => {
    const user = await makeUser(nextPhone());
    const stranger = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const booking = await makeBooking(user.token);
    await request(app)
      .patch(`/api/driver/bookings/${booking.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);

    // Stranger's booking -> 404 (not 403, no enumeration).
    for (const path of [
      `/api/bookings/${booking.id}/location`,
      `/api/bookings/${booking.id}/location/stream`,
    ]) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${stranger.token}`);
      expect(res.status).toBe(404);
    }
    // Driver role on customer-only routes -> 403.
    const asDriver = await request(app)
      .get(`/api/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(asDriver.status).toBe(403);
    // No token -> 401.
    const anon = await request(app).get(`/api/bookings/${booking.id}/location`);
    expect(anon.status).toBe(401);

    // Stranger driver cannot post GPS to someone else's trip.
    const other = await makeDriver(nextPhone());
    const post = await request(app)
      .post(`/api/driver/bookings/${booking.id}/location`)
      .set('Authorization', `Bearer ${other.token}`)
      .send(GPS);
    expect(post.status).toBe(404);

    async function makeBooking(token) {
      const res = await request(app)
        .post('/api/bookings')
        .set('Authorization', `Bearer ${token}`)
        .send(bookingPayload());
      expect(res.status).toBe(201);
      return res.body.booking;
    }
  });
});
