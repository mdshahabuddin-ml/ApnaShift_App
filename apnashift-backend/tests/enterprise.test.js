// Enterprise inquiry (B2B lead) tests (requires real Postgres).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run
// Skips this suite if TEST_DATABASE_URL is not set.
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

let counter = 9850000000;
function nextPhone() {
  counter += 1;
  return String(counter).slice(0, 10);
}
let n = 0;
function uniq(prefix) {
  n += 1;
  return `${prefix}${n}`;
}

function inquiryPayload(over = {}) {
  const tag = uniq('ent');
  return {
    full_name: 'Priya Sharma',
    email: `${tag}@company.com`,
    phone: nextPhone(),
    company_name: `${tag} Retail Pvt Ltd`,
    website: 'https://example-company.com',
    designation: 'Operations Manager',
    business_type: 'retail',
    company_size: '11-50',
    cities: 'Indore, Bhopal',
    operating_state: 'Madhya Pradesh',
    locations_count: 3,
    services_required: ['local_delivery', 'goods_transport'],
    vehicle_types: ['mini_truck', 'pickup'],
    fleet_size: '6-20',
    monthly_trips: '101-500',
    start_date: '2030-05-01',
    service_frequency: 'daily',
    budget_range: '25k_50k',
    requirements: 'Daily store replenishment, 2 routes.',
    consent: true,
    ...over,
  };
}

async function makeAdmin() {
  const phone = nextPhone();
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

async function makeUser() {
  const phone = nextPhone();
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Test User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body.token;
}

describeDb('enterprise inquiries (DB)', () => {
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

  it('valid full submission — 201 + NEW + id', async () => {
    const res = await request(app).post('/api/enterprise/inquiries').send(inquiryPayload());

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.inquiry.status).toBe('NEW');
    expect(res.body.inquiry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('minimal required-only payload — 201', async () => {
    const res = await request(app).post('/api/enterprise/inquiries').send({
      full_name: 'Rahul Verma',
      email: 'rahul@shop.com',
      phone: nextPhone(),
      company_name: 'Verma Traders',
    });

    expect(res.status).toBe(201);
    expect(res.body.inquiry.status).toBe('NEW');
  });

  it('invalid fields — 400 (email, phone, company, requirements, enum, consent)', async () => {
    const base = inquiryPayload();
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'bad' })).status).toBe(400);
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'x2@a.com', phone: '12345' })).status).toBe(400);
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'x3@a.com', company_name: '' })).status).toBe(400);
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'x4@a.com', requirements: 'y'.repeat(1001) })).status).toBe(400);
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'x5@a.com', business_type: 'spaceship' })).status).toBe(400);
    expect((await request(app).post('/api/enterprise/inquiries').send({ ...base, email: 'x6@a.com', consent: false })).status).toBe(400);
  });

  it('duplicate (same email + company, 30 din) — 409; alag company — 201', async () => {
    const first = inquiryPayload();
    expect((await request(app).post('/api/enterprise/inquiries').send(first)).status).toBe(201);

    const dup = await request(app)
      .post('/api/enterprise/inquiries')
      .send({ ...inquiryPayload(), email: first.email, company_name: first.company_name });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ ok: false, error: 'duplicate_inquiry' });

    const otherCompany = await request(app)
      .post('/api/enterprise/inquiries')
      .send({ ...inquiryPayload(), email: first.email });
    expect(otherCompany.status).toBe(201);
  });

  it('admin list (filter/search) + status update', async () => {
    const token = await makeAdmin();
    const p1 = inquiryPayload({ business_type: 'retail' });
    const p2 = inquiryPayload({ business_type: 'manufacturing' });
    expect((await request(app).post('/api/enterprise/inquiries').send(p1)).status).toBe(201);
    expect((await request(app).post('/api/enterprise/inquiries').send(p2)).status).toBe(201);

    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    const all = await auth(request(app).get('/api/enterprise/inquiries'));
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);

    const search = await auth(request(app).get(`/api/enterprise/inquiries?search=${encodeURIComponent(p1.company_name)}`));
    expect(search.body.total).toBe(1);
    expect(search.body.inquiries[0].company_name).toBe(p1.company_name);

    const id = search.body.inquiries[0].id;
    const upd = await auth(
      request(app).patch(`/api/enterprise/inquiries/${id}/status`).send({ status: 'CONTACTED' }),
    );
    expect(upd.status).toBe(200);
    expect(upd.body.inquiry.status).toBe('CONTACTED');

    const filtered = await auth(request(app).get('/api/enterprise/inquiries?status=CONTACTED'));
    expect(filtered.body.total).toBe(1);

    const bad = await auth(
      request(app).patch(`/api/enterprise/inquiries/${id}/status`).send({ status: 'WRONG' }),
    );
    expect(bad.status).toBe(400);

    const missing = await auth(
      request(app).patch('/api/enterprise/inquiries/00000000-0000-0000-0000-000000000000/status').send({ status: 'CLOSED' }),
    );
    expect(missing.status).toBe(404);
  });

  it('admin access control — user 403, anon 401', async () => {
    const userToken = await makeUser();
    expect(
      (await request(app).get('/api/enterprise/inquiries').set('Authorization', `Bearer ${userToken}`)).status,
    ).toBe(403);
    expect((await request(app).get('/api/enterprise/inquiries')).status).toBe(401);
    expect(
      (await request(app)
        .patch('/api/enterprise/inquiries/00000000-0000-0000-0000-000000000000/status')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ status: 'CLOSED' })).status,
    ).toBe(403);
  });
});
