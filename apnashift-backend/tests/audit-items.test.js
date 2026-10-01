// DB integration tests for audit plan items 1-5 (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://apnashift:changeme@localhost:5433/apnashift_test npx vitest run
// Skips if not set. Covers the same cases suggested in the plan for each item.
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

let phoneSeq = 9890000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
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

// ~722 km (1 deg ~144.5 km x 5): beyond the 500 km limit.
function farPayload(over = {}) {
  return bookingPayload({
    drop: { address: 'Door Sheher', lat: 0, lng: 5 },
    ...over,
  });
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
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

describeDb('audit items 1-5 (DB)', () => {
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

  it('item 1 — schema migrations se match (fresh apply par sab kuch hai)', async () => {
    const cols = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_name IN ('bookings', 'drivers')`,
    );
    const has = (t, c) => cols.rows.some((r) => r.table_name === t && r.column_name === c);
    expect(has('bookings', 'pickup_lat')).toBe(true);
    expect(has('bookings', 'drop_lng')).toBe(true);
    expect(has('bookings', 'item_description')).toBe(true);
    expect(has('drivers', 'avg_rating')).toBe(true);
    expect(has('drivers', 'total_trips')).toBe(true);
    expect(has('drivers', 'needs_review')).toBe(true);
    expect(has('drivers', 'rejection_reason')).toBe(true);

    for (const t of ['audit_logs', 'pricing_history', 'idempotency_keys']) {
      const reg = await client.query('SELECT to_regclass($1) AS oid', [`public.${t}`]);
      expect(reg.rows[0].oid).not.toBeNull();
    }

    const statusDef = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'bookings_status_check'`,
    );
    expect(statusDef.rowCount).toBe(1);
    expect(statusDef.rows[0].def).toContain('pending');
    expect(statusDef.rows[0].def).not.toContain('requested');

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_bookings_available'`,
    );
    expect(idx.rowCount).toBe(1);
  });

  it('item 2 — 500 km se zyada par estimate + create 400 distance_too_far, row nahi', async () => {
    const { token } = await makeUser(nextPhone());

    const est = await request(app).post('/api/bookings/estimate-price').send({
      pickup: { lat: 0, lng: 0 },
      drop: { lat: 0, lng: 5 },
      vehicle_type: 'mini_truck',
    });
    expect(est.status).toBe(400);
    expect(est.body).toEqual({ ok: false, error: 'distance_too_far' });

    const create = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(farPayload());
    expect(create.status).toBe(400);
    expect(create.body.error).toBe('distance_too_far');

    const count = await client.query('SELECT COUNT(*) AS c FROM bookings');
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it('item 2 — boundary: 144 km wali booking abhi bhi 201', async () => {
    const { token } = await makeUser(nextPhone());
    const res = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(bookingPayload());
    expect(res.status).toBe(201);
  });

  it('item 3 — past scheduled_time 400, future 201', async () => {
    const { token } = await makeUser(nextPhone());
    const auth = { Authorization: `Bearer ${token}` };

    const past = await request(app)
      .post('/api/bookings')
      .set(auth)
      .send(bookingPayload({ scheduled_time: '2000-01-01T00:00:00.000Z' }));
    expect(past.status).toBe(400);
    expect(past.body.error).toBe('validation_failed');

    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const ok = await request(app)
      .post('/api/bookings')
      .set(auth)
      .send(bookingPayload({ scheduled_time: future }));
    expect(ok.status).toBe(201);
    expect(new Date(ok.body.booking.scheduled_time).getTime()).toBeGreaterThan(Date.now());
  });

  it('item 4 — same key dobara: 201 -> 200 same booking, ek hi row', async () => {
    const { token } = await makeUser(nextPhone());
    const auth = { Authorization: `Bearer ${token}` };
    const key = 'order-abc-123';

    const first = await request(app).post('/api/bookings').set(auth).set('Idempotency-Key', key).send(bookingPayload());
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/bookings').set(auth).set('Idempotency-Key', key).send(bookingPayload());
    expect(second.status).toBe(200);
    expect(second.body.booking.id).toBe(first.body.booking.id);

    const bookings = await client.query('SELECT COUNT(*) AS c FROM bookings');
    expect(Number(bookings.rows[0].c)).toBe(1);
    const keys = await client.query('SELECT COUNT(*) AS c FROM idempotency_keys');
    expect(Number(keys.rows[0].c)).toBe(1);
  });

  it('item 4 — same key + alag payload: 422, nayi booking nahi', async () => {
    const { token } = await makeUser(nextPhone());
    const auth = { Authorization: `Bearer ${token}` };
    const key = 'order-same-key';

    await request(app).post('/api/bookings').set(auth).set('Idempotency-Key', key).send(bookingPayload()).expect(201);
    const conflict = await request(app)
      .post('/api/bookings')
      .set(auth)
      .set('Idempotency-Key', key)
      .send(bookingPayload({ item_description: 'alag samaan' }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.error).toBe('idempotency_conflict');

    const bookings = await client.query('SELECT COUNT(*) AS c FROM bookings');
    expect(Number(bookings.rows[0].c)).toBe(1);
  });

  it('item 4 — alag keys / bina key: nayi bookings; galat format 400; user scope alag', async () => {
    const a = await makeUser(nextPhone());
    const b = await makeUser(nextPhone());
    const authA = { Authorization: `Bearer ${a.token}` };

    const r1 = await request(app).post('/api/bookings').set(authA).set('Idempotency-Key', 'k-1').send(bookingPayload());
    const r2 = await request(app).post('/api/bookings').set(authA).set('Idempotency-Key', 'k-2').send(bookingPayload());
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.booking.id).not.toBe(r2.body.booking.id);

    const n1 = await request(app).post('/api/bookings').set(authA).send(bookingPayload());
    const n2 = await request(app).post('/api/bookings').set(authA).send(bookingPayload());
    expect(n1.status).toBe(201);
    expect(n2.status).toBe(201);

    const bad = await request(app).post('/api/bookings').set(authA).set('Idempotency-Key', 'bad key!').send(bookingPayload());
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_idempotency_key');

    // Same key, different user: both get 201 (scope is per-user).
    const shared = 'shared-key-1';
    const ua = await request(app).post('/api/bookings').set(authA).set('Idempotency-Key', shared).send(bookingPayload());
    expect(ua.status).toBe(201);
    const ub = await request(app)
      .post('/api/bookings')
      .set({ Authorization: `Bearer ${b.token}` })
      .set('Idempotency-Key', shared)
      .send(bookingPayload());
    expect(ub.status).toBe(201);
    expect(ua.body.booking.id).not.toBe(ub.body.booking.id);
  });

  it('item 5 — pricing PUT: rate + history + audit ek transaction me', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

    const put = await admin(
      request(app).put('/api/admin/pricing-rules').send({ vehicle_type: 'pickup', base_rs: 400 }),
    );
    expect(put.status).toBe(200);

    const hist = await client.query(`SELECT * FROM pricing_history WHERE vehicle_type = 'Pickup' ORDER BY id DESC LIMIT 1`);
    expect(hist.rowCount).toBe(1);
    expect(Number(hist.rows[0].new_base_rs)).toBe(400);

    const audit = await client.query(
      `SELECT action, entity FROM audit_logs WHERE action = 'pricing.update'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].entity).toBe('pricing_rule');
  });

  it('item 5 — verify best-effort: success par audit row hai', async () => {
    const adminToken = await makeAdmin(nextPhone());
    const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
    const d = await request(app).post('/api/drivers/register').send({
      name: 'Test Driver',
      phone: nextPhone(),
      password: 'password123',
      vehicle_type: 'mini_truck',
      vehicle_number: 'MP09AB1234',
    });
    expect(d.status).toBe(201);

    const verify = await admin(request(app).patch(`/api/admin/drivers/${d.body.user.id}/verify`));
    expect(verify.status).toBe(200);

    const audit = await client.query(`SELECT action FROM audit_logs WHERE action = 'driver.verify'`);
    expect(audit.rowCount).toBe(1);
  });
});
