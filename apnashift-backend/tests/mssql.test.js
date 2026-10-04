// MS SQL Server verification tests. Live-connection tests run only when
// MSSQL_* env is set (local SSMS instance); config unit tests always run.
// NOTE: local Express instances ship with TCP/Named Pipes OFF (shared memory
// only), so Node (tedious/TCP) cannot connect until TCP is enabled + the
// service is restarted with admin rights. Until then the live tests fail
// honestly with mssql_unreachable — PostgreSQL remains the live database.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { isMssqlConfigured, mssqlConfig, mssqlTarget } from '../src/mssql/config.js';

const HAS_MSSQL_ENV = !!(process.env.MSSQL_USER && process.env.MSSQL_PASSWORD);
const describeLive = HAS_MSSQL_ENV ? describe : describe.skip;

describe('mssql config (no connection needed)', () => {
  it('target summary exposes names only, never secrets', () => {
    const t = mssqlTarget();
    expect(t.database).toBeTruthy();
    expect(JSON.stringify(t)).not.toContain(process.env.MSSQL_PASSWORD ?? 'no-such-secret');
  });

  it('mssqlConfig refuses without credentials', () => {
    const savedU = process.env.MSSQL_USER;
    const savedP = process.env.MSSQL_PASSWORD;
    delete process.env.MSSQL_USER;
    delete process.env.MSSQL_PASSWORD;
    expect(isMssqlConfigured()).toBe(false);
    expect(() => mssqlConfig()).toThrow();
    if (savedU) process.env.MSSQL_USER = savedU;
    if (savedP) process.env.MSSQL_PASSWORD = savedP;
  });
});

describeLive('mssql live connection', () => {
  it('GET /api/mssql/health — read-only server + table check', async () => {
    const res = await request(app).get('/api/mssql/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.database).toBe(process.env.MSSQL_DATABASE ?? 'ApnaShift');
    expect(typeof res.body.user_tables).toBe('number');
  }, 30000);
});
