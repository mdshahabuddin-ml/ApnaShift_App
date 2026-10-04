// Admin password-reset tests (requires real Postgres).
// Skips if TEST_DATABASE_URL not set.
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

let phoneSeq = 9930000000;
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

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Test Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    vehicle_number: `MP${phone.slice(-8)}`,
  });
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

describeDb('admin password reset (DB)', () => {
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

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  async function loginAs(phone, password, path) {
    return request(app).post(path).send({ phone, password });
  }

  it('user reset — new password works, old fails, no hash leaked, audited', async () => {
    const phone = nextPhone();
    const user = await makeUser(phone);
    const res = await admin(
      request(app).patch(`/api/admin/users/${user.user.id}/reset-password`),
    ).send({ new_password: 'naya-pass-456' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.user.id, phone });
    expect(JSON.stringify(res.body)).not.toContain('hash');

    expect((await loginAs(phone, 'naya-pass-456', '/api/auth/login')).status).toBe(200);
    expect((await loginAs(phone, 'password123', '/api/auth/login')).status).toBe(401);

    const audit = await client.query(
      `SELECT action, entity FROM audit_logs WHERE action = 'user.password_reset'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].entity).toBe('user');
  });

  it('driver reset — new password works, audited', async () => {
    const phone = nextPhone();
    const driver = await makeDriver(phone);
    const res = await admin(
      request(app).patch(`/api/admin/drivers/${driver.user.id}/reset-password`),
    ).send({ new_password: 'driver-naya-789' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: driver.user.id, phone });

    expect((await loginAs(phone, 'driver-naya-789', '/api/auth/login')).status).toBe(200);
    expect((await loginAs(phone, 'password123', '/api/auth/login')).status).toBe(401);

    const audit = await client.query(
      `SELECT action FROM audit_logs WHERE action = 'driver.password_reset'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('accounts lookup — phone se user/driver, validation + auth', async () => {
    const uPhone = nextPhone();
    const dPhone = nextPhone();
    await makeUser(uPhone);
    await makeDriver(dPhone);

    const both = await admin(
      request(app).get('/api/admin/accounts/lookup').query({ phone: uPhone }),
    );
    expect(both.status).toBe(200);
    expect(both.body.accounts).toHaveLength(1);
    expect(both.body.accounts[0]).toMatchObject({ kind: 'user', phone: uPhone });
    expect(JSON.stringify(both.body)).not.toContain('hash');

    const drv = await admin(
      request(app).get('/api/admin/accounts/lookup').query({ phone: '+91 ' + dPhone }),
    );
    expect(drv.body.accounts).toHaveLength(1);
    expect(drv.body.accounts[0].kind).toBe('driver');

    const none = await admin(
      request(app).get('/api/admin/accounts/lookup').query({ phone: nextPhone() }),
    );
    expect(none.body.accounts).toHaveLength(0);

    expect(
      (await admin(request(app).get('/api/admin/accounts/lookup').query({ phone: '123' }))).status,
    ).toBe(400);
    expect((await admin(request(app).get('/api/admin/accounts/lookup'))).status).toBe(400);

    const user = await makeUser(nextPhone());
    expect(
      (
        await request(app)
          .get('/api/admin/accounts/lookup')
          .set('Authorization', `Bearer ${user.token}`)
          .query({ phone: uPhone })
      ).status,
    ).toBe(403);
  });

  it('validation + access control', async () => {
    const user = await makeUser(nextPhone());
    const driver = await makeDriver(nextPhone());

    // Short / missing password.
    for (const bad of [{ new_password: 'short' }, {}, { new_password: 12345 }]) {
      expect(
        (await admin(request(app).patch(`/api/admin/users/${user.user.id}/reset-password`)).send(bad))
          .status,
      ).toBe(400);
      expect(
        (
          await admin(
            request(app).patch(`/api/admin/drivers/${driver.user.id}/reset-password`),
          ).send(bad)
        ).status,
      ).toBe(400);
    }

    // Unknown ids.
    const nil = '00000000-0000-0000-0000-000000000000';
    expect(
      (await admin(request(app).patch(`/api/admin/users/${nil}/reset-password`)).send({ new_password: 'password123' }))
        .status,
    ).toBe(404);
    expect(
      (
        await admin(
          request(app).patch(`/api/admin/drivers/${nil}/reset-password`),
        ).send({ new_password: 'password123' })
      ).status,
    ).toBe(404);

    // Non-admin roles + anon.
    expect(
      (
        await request(app)
          .patch(`/api/admin/users/${user.user.id}/reset-password`)
          .set('Authorization', `Bearer ${user.token}`)
          .send({ new_password: 'password123' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/admin/drivers/${driver.user.id}/reset-password`)
          .set('Authorization', `Bearer ${driver.token}`)
          .send({ new_password: 'password123' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`/api/admin/users/${user.user.id}/reset-password`)
          .send({ new_password: 'password123' })
      ).status,
    ).toBe(401);
  });
});
