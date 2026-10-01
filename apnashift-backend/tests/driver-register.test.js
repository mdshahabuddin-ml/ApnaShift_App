// Driver Partner Registration tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips this suite if TEST_DATABASE_URL is not set.
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

let phoneCounter = 9865000000;
function nextPhone() {
  phoneCounter += 1;
  return String(phoneCounter).slice(0, 10);
}
let n = 0;
function uniq(prefix) {
  n += 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function extPayload(over = {}) {
  return {
    name: 'Partner Driver',
    phone: nextPhone(),
    password: 'Driver@12345',
    email: `${uniq('drv')}@example.com`,
    dob: '1995-06-15',
    gender: 'male',
    city: 'Indore',
    state: 'Madhya Pradesh',
    address: '12 MG Road, Vijay Nagar',
    vehicle_type: 'mini_truck',
    vehicle_number: `MP09${uniq('Z')}`,
    vehicle_make: 'Tata',
    vehicle_model: 'Ace',
    vehicle_year: 2021,
    capacity_kg: 750,
    fuel_type: 'diesel',
    ownership: 'owned',
    license_number: `MP09 2021${uniq('00')}`,
    license_type: 'LMV',
    license_expiry: '2030-01-01',
    license_state: 'Madhya Pradesh',
    rc_number: uniq('RC'),
    insurance_expiry: '2027-01-01',
    pollution_expiry: '2027-06-01',
    service_city: 'Indore',
    service_state: 'Madhya Pradesh',
    service_areas: 'Vijay Nagar, Palasia',
    service_radius_km: 25,
    emergency_name: 'Sunita',
    emergency_relation: 'Wife',
    emergency_phone: nextPhone(),
    consent: true,
    ...over,
  };
}

describeDb('driver partner registration (DB)', () => {
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

  it('valid extended registration — 201 + PENDING_REVIEW + no secrets', async () => {
    const res = await request(app).post('/api/drivers/register').send(extPayload());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.role).toBe('driver');
    expect(res.body.user.is_verified).toBe(false);
    expect(res.body.application.status).toBe('PENDING_REVIEW');
    expect(res.body.application.id).toMatch(/^AS-\d{4}-[0-9A-F]{6}$/);
    expect(JSON.stringify(res.body)).not.toContain('password_hash');
    expect(JSON.stringify(res.body)).not.toContain('JWT');

    // Columns are stored in the DB.
    const db = await client.query('SELECT email, city, license_number, application_ref, consent_at FROM drivers WHERE phone = $1', [
      res.body.user.phone,
    ]);
    expect(db.rows[0].email).toBe(res.body.user.email);
    expect(db.rows[0].city).toBe('Indore');
    expect(db.rows[0].consent_at).not.toBeNull();
  });

  it('backward compat — purana minimal payload abhi bhi 201', async () => {
    const res = await request(app).post('/api/drivers/register').send({
      name: 'Old Client',
      phone: nextPhone(),
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: 'MP09CD9999',
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.application.status).toBe('PENDING_REVIEW');
  });

  it('duplicate phone — 409 phone_taken', async () => {
    const first = extPayload();
    expect((await request(app).post('/api/drivers/register').send(first)).status).toBe(201);

    const res = await request(app)
      .post('/api/drivers/register')
      .send({ ...extPayload(), phone: first.phone });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'phone_taken' });
  });

  it('duplicate license — 409 license_already_registered', async () => {
    const first = extPayload();
    expect((await request(app).post('/api/drivers/register').send(first)).status).toBe(201);

    const res = await request(app)
      .post('/api/drivers/register')
      .send({ ...extPayload(), license_number: first.license_number });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'license_already_registered' });
  });

  it('duplicate vehicle — 409 vehicle_already_registered', async () => {
    const first = extPayload();
    expect((await request(app).post('/api/drivers/register').send(first)).status).toBe(201);

    const res = await request(app)
      .post('/api/drivers/register')
      .send({ ...extPayload(), vehicle_number: first.vehicle_number });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ ok: false, error: 'vehicle_already_registered' });
  });

  it('invalid fields — 400 (email, underage, expired license, consent false)', async () => {
    const badEmail = await request(app)
      .post('/api/drivers/register')
      .send(extPayload({ email: 'not-an-email' }));
    expect(badEmail.status).toBe(400);

    const underage = await request(app)
      .post('/api/drivers/register')
      .send(extPayload({ dob: '2015-01-01' }));
    expect(underage.status).toBe(400);

    const expired = await request(app)
      .post('/api/drivers/register')
      .send(extPayload({ license_expiry: '2020-01-01' }));
    expect(expired.status).toBe(400);

    const noConsent = await request(app)
      .post('/api/drivers/register')
      .send(extPayload({ consent: false }));
    expect(noConsent.status).toBe(400);

    const missing = await request(app).post('/api/drivers/register').send({
      phone: nextPhone(),
      password: 'password123',
      vehicle_type: 'pickup',
      vehicle_number: 'MP09EF0001',
    });
    expect(missing.status).toBe(400);
  });

  it('new driver admin list me pending dikhta hai (review flow)', async () => {
    const payload = extPayload();
    const reg = await request(app).post('/api/drivers/register').send(payload);
    expect(reg.status).toBe(201);

    const hash = await import('bcrypt').then((m) => m.default.hash('admin-pass-123', 4));
    const adminPhone = nextPhone();
    await client.query('INSERT INTO admins (name, phone, password_hash) VALUES ($1, $2, $3)', [
      'Staff',
      adminPhone,
      hash,
    ]);
    const login = await request(app)
      .post('/api/admin/login')
      .send({ phone: adminPhone, password: 'admin-pass-123' });
    expect(login.status).toBe(200);

    const list = await request(app)
      .get('/api/admin/drivers?status=pending')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(list.status).toBe(200);
    const mine = list.body.drivers.find((d) => d.phone === reg.body.user.phone);
    expect(mine).toBeDefined();
    expect(mine.application_ref).toBe(reg.body.application.id);
    expect(mine.license_number).toBe(payload.license_number);
    expect(mine.city).toBe('Indore');
    expect(mine.password_hash).toBeUndefined();
  });
});
