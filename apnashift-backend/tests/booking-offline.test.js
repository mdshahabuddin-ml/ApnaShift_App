// Offline/missed-order reliability (requires real Postgres).
// Pull model: available list is DB state (no socket needed); creation is
// audited once; non-pending never listed. Run:
// TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/booking-offline.test.js
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

let phoneSeq = 9970000000;
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

describeDb('offline + missed orders (DB)', () => {
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

  it('create writes exactly one booking.created audit (replay adds none)', async () => {
    const user = await makeUser(nextPhone());
    const key = 'offline-audit-1';
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
    const rows = await client.query(
      `SELECT action, entity, entity_id, details FROM audit_logs WHERE action = 'booking.created'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      action: 'booking.created',
      entity: 'booking',
      entity_id: first.body.booking.id,
    });
    expect(rows.rows[0].details.user_id).toBe(user.user.id);
  });

  it('only pending shows as available across the lifecycle', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());
    const mk = async () =>
      (
        await request(app)
          .post('/api/bookings')
          .set('Authorization', `Bearer ${user.token}`)
          .send(bookingPayload())
      ).body.booking;
    const bPending = await mk();
    const bAccept = await mk();
    const bCancel = await mk();
    const bDone = await mk();

    const list = async () =>
      request(app)
        .get('/api/driver/bookings/available?limit=20')
        .set('Authorization', `Bearer ${driver.token}`);
    expect((await list()).body.total).toBe(4);

    await request(app)
      .patch(`/api/driver/bookings/${bAccept.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    await request(app)
      .patch(`/api/bookings/${bCancel.id}/cancel`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ reason: 'changed_plan' })
      .expect(200);
    await request(app)
      .patch(`/api/driver/bookings/${bDone.id}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .expect(200);
    for (const st of ['arrived', 'in_transit', 'delivered']) {
      await request(app)
        .patch(`/api/driver/bookings/${bDone.id}/status`)
        .set('Authorization', `Bearer ${driver.token}`)
        .send({ status: st })
        .expect(200);
    }

    const after = await list();
    expect(after.body.total).toBe(1);
    expect(after.body.bookings.map((b) => b.id)).toEqual([bPending.id]);
  });
});
