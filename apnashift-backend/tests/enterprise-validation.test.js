// Enterprise validation-consistency tests (requires real Postgres).
// Proves frontend/backend rules agree: genuinely valid submits pass,
// invalid input fails with safe field details (never a bare code).
// Run: TEST_DATABASE_URL=postgres://USER:PASS@localhost:5433/apnashift_test npx vitest run tests/enterprise-validation.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import { applyTestSchema, truncateAll, makeTestClient, hasTestDb } from './helpers/db.js';

const HAS_DB = hasTestDb;
const describeDb = HAS_DB ? describe : describe.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = HAS_DB ? makeTestClient() : null;

let n = 0;
function uniq(prefix) {
  n += 1;
  return `${prefix}${n}_${Date.now() % 100000}`;
}
let phoneSeq = 9861000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

function validPayload(over = {}) {
  const tag = uniq('eval');
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
    services_required: ['local_delivery'],
    vehicle_types: ['mini_truck'],
    fleet_size: '6-20',
    monthly_trips: '101-500',
    start_date: '2030-05-01',
    service_frequency: 'weekly',
    budget_range: '25k_50k',
    requirements: 'Daily store replenishment.',
    consent: true,
    ...over,
  };
}

describeDb('enterprise validation consistency (DB)', () => {
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

  it('1. fully valid form -> 201', async () => {
    const res = await request(app).post('/api/enterprise/inquiries').send(validPayload());
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.inquiry.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('2. invalid email -> 400 with field details (not a bare code)', async () => {
    const res = await request(app)
      .post('/api/enterprise/inquiries')
      .send(validPayload({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details[0].field).toBe('email');
    expect(typeof res.body.details[0].message).toBe('string');
  });

  it('3. invalid phone -> 400 with field details', async () => {
    const res = await request(app)
      .post('/api/enterprise/inquiries')
      .send(validPayload({ phone: '12345' }));
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('phone');
  });

  it('4. missing required company_name -> 400 with field details', async () => {
    const body = validPayload();
    delete body.company_name;
    const res = await request(app).post('/api/enterprise/inquiries').send(body);
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('company_name');
  });

  it('root cause: dot-less website -> 400 website details (frontend now pre-checks)', async () => {
    for (const bad of ['example', 'my company']) {
      const res = await request(app)
        .post('/api/enterprise/inquiries')
        .send(validPayload({ website: bad }));
      expect(res.status).toBe(400);
      expect(res.body.details[0].field).toBe('website');
    }
    const ok = await request(app)
      .post('/api/enterprise/inquiries')
      .send(validPayload({ website: 'example.com' }));
    expect(ok.status).toBe(201);
  });

  it('optional single-char text + oversize state -> 400 (frontend mirrors these)', async () => {
    const short = await request(app)
      .post('/api/enterprise/inquiries')
      .send(validPayload({ designation: 'X' }));
    expect(short.status).toBe(400);
    expect(short.body.details[0].field).toBe('designation');
    const longState = await request(app)
      .post('/api/enterprise/inquiries')
      .send(validPayload({ operating_state: 'S'.repeat(81) }));
    expect(longState.status).toBe(400);
    expect(longState.body.details[0].field).toBe('operating_state');
  });
});
