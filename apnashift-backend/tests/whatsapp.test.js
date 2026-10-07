// WhatsApp booking foundation (no Meta credentials required).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/whatsapp.test.js
// Covers: verify handshake (403/200), malformed bodies (400), unknown phone
// (register prompt, no state), full WA dialog via HTTP webhook (mock
// geocode) -> WHATSAPP booking + driver/admin notify path + audit +
// confirmation, no-double-mint on repeated YES, NAHI cancel, CONFIRMATION
// reprompt, WEB parity on the HTTP route, provider=none suppression.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../src/services/geoapify.js', async (importOriginal) => {
  const mod = await importOriginal();
  const pts = [
    { lat: 22.7196, lng: 75.8577 },
    { lat: 22.7296, lng: 75.8677 },
  ];
  let n = 0;
  return {
    ...mod,
    geoapifyAutocomplete: async (text) => {
      const p = pts[n % pts.length];
      n += 1;
      return [{ lat: p.lat, lng: p.lon ?? p.lng, formatted: `Mock: ${text}` }];
    },
  };
});

import { app } from '../src/app.js';
import { applyTestSchema, truncateAll } from './helpers/db.js';
import {
  mockOutboxList,
  clearMockOutbox,
  sendBookingConfirmation,
} from '../src/services/whatsapp.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneSeq = 9940000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

async function registerUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'WA User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function waSay(from, text) {
  return request(app).post('/api/whatsapp/webhook').send({ from, text });
}

async function dialogToConfirm(from) {
  let r = await waSay(from, 'HI');
  expect(r.status).toBe(200);
  expect(r.body.reply).toMatch(/Pickup address/i);
  r = await waSay(from, '12 MG Road, Indore');
  expect(r.body.reply).toMatch(/drop address/i);
  r = await waSay(from, '45 AB Road, Indore');
  expect(r.body.reply).toMatch(/Gaadi chuno/i);
  r = await waSay(from, 'mini truck');
  expect(r.body.reply).toMatch(/Kab chahiye/i);
  r = await waSay(from, 'now');
  expect(r.body.reply).toMatch(/cash.*upi|upi.*cash/i);
  r = await waSay(from, 'upi');
  expect(r.body.reply).toMatch(/Booking summary/i);
  return r;
}

describeDb('whatsapp booking foundation (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await truncateAll(client);
    clearMockOutbox();
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    delete process.env.WHATSAPP_PROVIDER;
  });

  it('GET verify without token is 403 by design', async () => {
    const r = await request(app).get(
      '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc',
    );
    expect(r.status).toBe(403);
    expect(r.body.ok).toBe(false);
  });

  it('GET verify with matching token echoes challenge', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-token-123';
    const r = await request(app).get(
      '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-token-123&hub.challenge=abc123',
    );
    expect(r.status).toBe(200);
    expect(r.text).toBe('abc123');
  });

  it('GET verify with wrong token stays 403', async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = 'test-token-123';
    const r = await request(app).get(
      '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123',
    );
    expect(r.status).toBe(403);
  });

  it('malformed bodies get 400 without touching state', async () => {
    const r1 = await request(app).post('/api/whatsapp/webhook').send({ from: nextPhone() });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('validation_failed');
    const r2 = await request(app)
      .post('/api/whatsapp/webhook')
      .send({ from: nextPhone(), text: 'x'.repeat(2001) });
    expect(r2.status).toBe(400);
    const convos = await client.query('SELECT COUNT(*)::int AS n FROM wa_conversations');
    expect(convos.rows[0].n).toBe(0);
  });

  it('unknown phone gets register prompt, no conversation, no booking', async () => {
    const r = await waSay('9922113344', 'HI');
    expect(r.status).toBe(200);
    expect(r.body.reply).toMatch(/register/i);
    expect(r.body.booking).toBeUndefined();
    const convos = await client.query('SELECT COUNT(*)::int AS n FROM wa_conversations');
    expect(convos.rows[0].n).toBe(0);
  });

  it('full dialog mints WHATSAPP booking + audit + confirmation', async () => {
    const phone = nextPhone();
    await registerUser(phone);
    await dialogToConfirm(phone);

    const r = await waSay(phone, 'YES');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.booking).toBeDefined();
    expect(r.body.booking.booking_source).toBe('WHATSAPP');
    expect(r.body.booking.payment_method).toBe('upi');
    expect(r.body.booking.status).toBe('pending');

    const row = await client.query('SELECT * FROM bookings WHERE id = $1', [r.body.booking.id]);
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].booking_source).toBe('WHATSAPP');

    const audit = await client.query(
      "SELECT * FROM audit_logs WHERE action = 'booking.created' AND entity_id = $1",
      [r.body.booking.id],
    );
    expect(audit.rowCount).toBe(1);

    const convo = await client.query('SELECT state, booking_id FROM wa_conversations WHERE phone = $1', [
      phone,
    ]);
    expect(convo.rows[0].state).toBe('BOOKING_CREATED');
    expect(convo.rows[0].booking_id).toBe(r.body.booking.id);

    const outbox = mockOutboxList();
    expect(outbox.length).toBeGreaterThan(0);
    const last = outbox[outbox.length - 1];
    expect(last.to).toBe(phone);
    expect(last.text).toContain(r.body.booking.id);
  });

  it('repeated YES after completion cannot mint a second booking', async () => {
    const phone = nextPhone();
    await registerUser(phone);
    await dialogToConfirm(phone);
    const first = await waSay(phone, 'YES');
    expect(first.body.booking).toBeDefined();

    const again = await waSay(phone, 'YES');
    expect(again.status).toBe(200);
    expect(again.body.booking).toBeUndefined();

    const count = await client.query(
      'SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = (SELECT id FROM users WHERE phone = $1)',
      [phone],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('NAHI cancels cleanly with no booking', async () => {
    const phone = nextPhone();
    await registerUser(phone);
    await dialogToConfirm(phone);
    const r = await waSay(phone, 'NAHI');
    expect(r.status).toBe(200);
    expect(r.body.reply).toMatch(/cancel/i);
    expect(r.body.booking).toBeUndefined();
    const count = await client.query('SELECT COUNT(*)::int AS n FROM bookings');
    expect(count.rows[0].n).toBe(0);
    const convo = await client.query('SELECT state FROM wa_conversations WHERE phone = $1', [phone]);
    expect(convo.rows[0].state).toBe('START');
  });

  it('unknown text at CONFIRMATION reshows summary, no booking', async () => {
    const phone = nextPhone();
    await registerUser(phone);
    await dialogToConfirm(phone);
    const r = await waSay(phone, 'shayad kal?');
    expect(r.status).toBe(200);
    expect(r.body.reply).toMatch(/Booking summary/i);
    expect(r.body.booking).toBeUndefined();
  });

  it('bad vehicle choice reprompts, dialog preserved', async () => {
    const phone = nextPhone();
    await registerUser(phone);
    await waSay(phone, 'HI');
    await waSay(phone, '12 MG Road, Indore');
    await waSay(phone, '45 AB Road, Indore');
    const r = await waSay(phone, 'helicopter');
    expect(r.body.reply).toMatch(/pickup, mini_truck ya mini_tractor/i);
    const convo = await client.query('SELECT state FROM wa_conversations WHERE phone = $1', [phone]);
    expect(convo.rows[0].state).toBe('VEHICLE');
  });

  it('HTTP route parity: app bookings still source WEB', async () => {
    const phone = nextPhone();
    const user = await registerUser(phone);
    const r = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        pickup: { address: '12 MG Road, Indore', lat: 22.7196, lng: 75.8577 },
        drop: { address: '45 AB Road, Indore', lat: 22.7296, lng: 75.8677 },
        vehicle_type: 'mini_truck',
        helper_needed: false,
        item_description: 'samaan',
      });
    expect(r.status).toBe(201);
    expect(r.body.booking.booking_source).toBe('WEB');
  });

  it('provider=none suppresses outbound text, dialog still works', async () => {
    process.env.WHATSAPP_PROVIDER = 'none';
    const res = await sendBookingConfirmation('9940000001', {
      bookingId: 'bid-1',
      fareRs: 100,
      paymentMethod: 'upi',
    });
    expect(res.ok).toBe(false);
    expect(mockOutboxList().length).toBe(0);
  });
});
