// Health route tests (no DB needed — /api/health does not touch DB).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { hasTestDb } from './helpers/db.js';

describe('GET /api/health', () => {
  it('200 + ok:true deta hai', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('apnashift-backend');
  });
});

describe('unknown route', () => {
  it('404 + ok:false deta hai', async () => {
    const res = await request(app).get('/api/aisa-kuch-nahi');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

// Readiness + DB connectivity (CI deploy gate bhi yahi check karta hai).
// DB ke bina skip — baaki suites ki tarah TEST_DATABASE_URL aane par chalta hai.
const HAS_DB = hasTestDb;
const describeDb = HAS_DB ? describe : describe.skip;

describeDb('GET /api/ready', () => {
  it('200 + db:up deta hai jab database reachable ho', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toBe('up');
  });
});
