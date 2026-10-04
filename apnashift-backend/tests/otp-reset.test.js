// Self-service OTP password reset (zero-cost flow).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/apnashift_test npx vitest run tests/otp-reset.test.js
// Skips if TEST_DATABASE_URL is not set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

let phoneCounter = 9881000000;
function nextPhone() {
  phoneCounter += 1;
  return String(phoneCounter).slice(0, 10);
}

describeDb('otp password reset (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    await client.query(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE users, drivers, admins, bookings, ratings, password_reset_otps RESTART IDENTITY CASCADE',
    );
  });

  it('full flow: forgot -> reset -> login with new password', async () => {
    const phone = nextPhone();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ name: 'OTP User', phone, password: 'password123' });
    expect(reg.status).toBe(201);

    const forgot = await request(app).post('/api/auth/forgot-password').send({ phone });
    expect(forgot.status).toBe(200);
    expect(forgot.body.ok).toBe(true);
    // test env me debug OTP milta hai (zero-cost, SMS nahi laga)
    expect(forgot.body.debug_otp).toMatch(/^\d{6}$/);
    const otp = forgot.body.debug_otp;

    const wrong = await request(app)
      .post('/api/auth/reset-password')
      .send({ phone, otp: '000000', new_password: 'newpass123' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_otp');

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ phone, otp, new_password: 'newpass123' });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    // OTP single-use — dobara same OTP fail
    const reuse = await request(app)
      .post('/api/auth/reset-password')
      .send({ phone, otp, new_password: 'another123' });
    expect(reuse.status).toBe(400);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ phone, password: 'newpass123' });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
  });

  it('unknown phone par bhi ok:true (enumeration nahi)', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ phone: nextPhone() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.debug_otp).toBeUndefined();
  });

  it('validation: galat phone/otp/password par 400', async () => {
    const badPhone = await request(app)
      .post('/api/auth/forgot-password')
      .send({ phone: '123' });
    expect(badPhone.status).toBe(400);

    const badReset = await request(app)
      .post('/api/auth/reset-password')
      .send({ phone: nextPhone(), otp: '12', new_password: 'short' });
    expect(badReset.status).toBe(400);
  });
});
