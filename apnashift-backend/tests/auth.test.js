// Auth integration tests (real Postgres chahiye).
// Chalao: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/apnashift_test npx vitest run
// TEST_DATABASE_URL set nahi hai to ye suite skip hogi (health tests phir bhi chalenge).
// Har test me alag phone + har test ke baad TRUNCATE, taaki tests aapas me na takrayein.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { requireAuth, requireRole } from '../src/middleware/auth.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }) : null;

// Har test ka phone alag (parallel-safe nahi, par sequence me unique).
let phoneCounter = 9876000000;
function nextPhone() {
  phoneCounter += 1;
  // 98760xxxxx hamesha 6-9 se shuru, 10 digit.
  return String(phoneCounter).slice(0, 10);
}

describeDb('auth (DB)', () => {
  beforeAll(async () => {
    await client.connect();
    const schema = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
    await client.query(schema);
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query(
      'TRUNCATE users, drivers, admins, bookings, ratings RESTART IDENTITY CASCADE',
    );
  });

  it('POST /api/auth/register — naya user + token', async () => {
    const phone = nextPhone();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Rahul Sharma', phone, password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toMatchObject({ name: 'Rahul Sharma', phone, role: 'user' });
    expect(res.body.user.password_hash).toBeUndefined();

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(payload.role).toBe('user');
    expect(payload.id).toBe(res.body.user.id);
  });

  it('register — +91 wala phone normalize hokar save hota hai', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Priya', phone: '+91 98765 43210', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBe('9876543210');
  });

  it('register — duplicate phone par 409 phone_taken', async () => {
    const phone = nextPhone();
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Pehla', phone, password: 'password123' });

    const dup = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Doosra', phone, password: 'password123' });

    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ ok: false, error: 'phone_taken' });
  });

  it('register — chhota password par 400 validation_failed', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Chhota', phone: nextPhone(), password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
  });

  it('login — success par JWT (7 din nahi check karte, bas role+id)', async () => {
    const phone = nextPhone();
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Login Wala', phone, password: 'password123' });

    const res = await request(app).post('/api/auth/login').send({ phone, password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(payload).toMatchObject({ role: 'user' });
  });

  it('login — galat password aur anjaan phone par EK JAISA error', async () => {
    const phone = nextPhone();
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Asli', phone, password: 'password123' });

    const wrongPass = await request(app)
      .post('/api/auth/login')
      .send({ phone, password: 'galat-pass' });
    const unknownPhone = await request(app)
      .post('/api/auth/login')
      .send({ phone: '9000000001', password: 'kuch-bhi-123' });

    expect(wrongPass.status).toBe(401);
    expect(unknownPhone.status).toBe(401);
    expect(wrongPass.body).toEqual(unknownPhone.body);
    expect(wrongPass.body).toEqual({ ok: false, error: 'invalid_credentials' });
  });

  it('GET /api/auth/me — bina token 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/auth/me — token par profile (hash nahi)', async () => {
    const phone = nextPhone();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Me Wala', phone, password: 'password123' });

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ name: 'Me Wala', phone, role: 'user' });
    expect(res.body.user.password_hash).toBeUndefined();
  });

  it('driver register — is_verified=false, login me role=driver', async () => {
    const phone = nextPhone();
    const reg = await request(app).post('/api/drivers/register').send({
      name: 'Driver Dev',
      phone,
      password: 'password123',
      vehicle_type: 'mini_truck',
      vehicle_number: 'mp09 ab 1234',
    });

    expect(reg.status).toBe(201);
    expect(reg.body.user.role).toBe('driver');
    expect(reg.body.user.is_verified).toBe(false);
    expect(reg.body.user.vehicle_type).toBe('mini_truck');

    const login = await request(app).post('/api/auth/login').send({ phone, password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('driver');
  });

  it('admin login — success aur failure (generic error)', async () => {
    const hash = await bcrypt.hash('admin-pass-123', 4);
    await client.query('INSERT INTO admins (name, phone, password_hash) VALUES ($1, $2, $3)', [
      'Staff',
      '9111111111',
      hash,
    ]);

    const okRes = await request(app)
      .post('/api/admin/login')
      .send({ phone: '9111111111', password: 'admin-pass-123' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.user.role).toBe('admin');

    const badRes = await request(app)
      .post('/api/admin/login')
      .send({ phone: '9111111111', password: 'galat-pass-123' });
    expect(badRes.status).toBe(401);
    expect(badRes.body).toEqual({ ok: false, error: 'invalid_credentials' });
  });

  it('wrong role — user token se driver-only route par 403', async () => {
    // Driver-only route abhi app me nahi (booking API me aayegi) —
    // isliye middleware ko alag mini-app par test karte hain.
    const mini = express();
    mini.use(express.json());
    mini.get('/driver-only', requireAuth, requireRole('driver'), (req, res) => {
      res.json({ ok: true });
    });

    const phone = nextPhone();
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Aam User', phone, password: 'password123' });

    const forbidden = await request(mini)
      .get('/driver-only')
      .set('Authorization', `Bearer ${reg.body.token}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ ok: false, error: 'forbidden' });

    const dPhone = nextPhone();
    const dReg = await request(app).post('/api/drivers/register').send({
      name: 'Sahi Driver',
      phone: dPhone,
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: 'MP09CD9999',
    });
    const allowed = await request(mini)
      .get('/driver-only')
      .set('Authorization', `Bearer ${dReg.body.token}`);
    expect(allowed.status).toBe(200);
  });
});
