// NEW_BOOKING event tests (requires real Postgres).
// Customer create -> vehicle-channel SSE event with required fields only,
// no replay emit, auth gates. No new tables/APIs beyond the channel.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import {
  publishNewBooking,
  subscribeNewBookings,
} from '../src/services/tracking.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9940000000;
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

async function readEventData(port, path, token, want, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctrl.signal,
  });
  expect(res.status).toBe(200);
  const stop = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {
      // ignore — reader cleanup below handles it.
    }
  }, timeoutMs);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let data = null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const blocks = buf.split('\n\n');
      for (const b of blocks) {
        const lines = b.split('\n');
        if (lines[0] === `event: ${want}`) {
          const dl = lines.find((l) => l.startsWith('data: '));
          if (dl) {
            data = dl.slice('data: '.length);
            break;
          }
        }
      }
      if (data !== null) break;
    }
  } catch {
    // timeout abort — data stays null, asserted below.
  } finally {
    clearTimeout(stop);
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      // ignore — abort already tore it down.
    }
  }
  return data;
}

describeDb('NEW_BOOKING event (DB)', () => {
  let server;
  let port;

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
    process.env.TRACK_MIN_INTERVAL_MS = '0';
  });

  it('hub unit: vehicle isolation + leave() stops delivery', () => {
    const gotMini = [];
    const gotPickup = [];
    const fakeMini = { write: (d) => gotMini.push(d) };
    const fakePickup = { write: (d) => gotPickup.push(d) };
    const leaveMini = subscribeNewBookings('Mini Truck', fakeMini);
    subscribeNewBookings('Pickup', fakePickup);
    const n = publishNewBooking('Mini Truck', { booking_id: 'x' });
    expect(n).toBe(1);
    expect(gotMini).toHaveLength(1);
    expect(gotMini[0]).toContain('event: new_booking');
    expect(gotPickup).toHaveLength(0);
    leaveMini();
    publishNewBooking('Mini Truck', { booking_id: 'y' });
    expect(gotMini).toHaveLength(1);
    // Empty channel: no crash, zero delivered.
    expect(publishNewBooking('Mini Tractor', { booking_id: 'z' })).toBe(0);
  });

  it('create emits exact required fields, no secrets', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());

    const streamPromise = readEventData(
      port,
      '/api/driver/bookings/stream',
      driver.token,
      'new_booking',
    );
    // Let the subscriber attach before creating.
    await new Promise((r) => setTimeout(r, 300));
    const created = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send(bookingPayload({ payment_method: 'cash' }));
    expect(created.status).toBe(201);

    const buf = await streamPromise;
    expect(buf).not.toBeNull();
    const event = JSON.parse(buf);
    expect(Object.keys(event).sort()).toEqual(
      ['booking_id', 'drop', 'fare_rs', 'payment_method', 'pickup', 'status', 'vehicle_type'].sort(),
    );
    expect(event).toMatchObject({
      booking_id: created.body.booking.id,
      vehicle_type: 'mini_truck',
      payment_method: 'cash',
      status: 'pending',
    });
    expect(event.pickup).toMatchObject({ address: '12 MG Road, Indore', lat: 22.7196, lng: 75.8577 });
    expect(event.drop).toMatchObject({ address: '45 AB Road, Indore' });
    expect(event.fare_rs).toBe(created.body.booking.price_rs);
    // No secrets ever ride the event.
    const raw = JSON.stringify(event).toLowerCase();
    for (const banned of ['phone', 'password', 'token', 'hash', 'apikey', 'api_key', 'upi_id', 'name']) {
      expect(raw.includes(banned)).toBe(false);
    }
  });

  it('idempotency replay emits nothing', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const key = 'evt-replay-1';

    const streamPromise = (async () => {
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/driver/bookings/stream`, {
        headers: { Authorization: `Bearer ${driver.token}` },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let events = 0;
      // Abort ends the window — a bare reader.read() would hang past it.
      const stop = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {
          // ignore — cleanup below handles it.
        }
      }, 2500);
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += decoder.decode(chunk.value, { stream: true });
          events = buf.split('event: new_booking').length - 1;
          if (events >= 2) break;
        }
      } catch {
        // timeout abort — count what arrived.
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
    })();
    await new Promise((r) => setTimeout(r, 300));

    const first = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send(bookingPayload());
    expect(first.status).toBe(201);
    const replay = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send(bookingPayload());
    expect(replay.status).toBe(200);
    // Settle + count window.
    const events = await streamPromise;
    expect(events).toBe(1);
  });

  it('stream auth: anon 401, driver only (user 403), ready event shape', async () => {
    const anon = await request(app).get('/api/driver/bookings/stream');
    expect(anon.status).toBe(401);
    const user = await makeUser(nextPhone());
    const asUser = await request(app)
      .get('/api/driver/bookings/stream')
      .set('Authorization', `Bearer ${user.token}`);
    expect(asUser.status).toBe(403);

    const driver = await makeDriver(nextPhone());
    const buf = await readEventData(port, '/api/driver/bookings/stream', driver.token, 'ready');
    expect(buf).not.toBeNull();
    expect(JSON.parse(buf)).toEqual({ vehicle_type: 'Mini Truck' });
  });
});
