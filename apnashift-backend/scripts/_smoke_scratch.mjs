// TEMP Step-D' smoke: boot the real server against a *migrate* scratch (or an
// exact MIGRATE_ALLOW_TARGET name via SMOKE_TARGET) holding production data
// and exercise read-only endpoints. Prints statuses/counts/ids only — never
// phones, names, addresses, hashes, or tokens.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import sql from 'mssql';
import { signToken } from '../src/utils/jwt.js';

const BASE = 'http://localhost:3999';
const results = [];
let failures = 0;
const check = (label, ok, detail) => {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// D2 target rule (same allowlist idea as migrate-data-mssql.js): default
// scratch, *migrate* name, or exact name in MIGRATE_ALLOW_TARGET.
// SMOKE_TARGET deliberately separate from MSSQL_DATABASE so .env defaults can
// never silently retarget the smoke.
const smokeTarget = process.env.SMOKE_TARGET ?? 'ApnaShiftDB_migrate';
const allowedTargets = (process.env.MIGRATE_ALLOW_TARGET ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (!/migrate/i.test(smokeTarget) && !allowedTargets.includes(smokeTarget.toLowerCase())) {
  console.error(`SMOKE ABORT: target '${smokeTarget}' allowed nahi hai (migrate scratch ya MIGRATE_ALLOW_TARGET exact name).`);
  process.exit(1);
}

// gather expectations from the target (read-only; values kept in memory)
const pool = await new sql.ConnectionPool({
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER ?? 'localhost',
  port: Number(process.env.MSSQL_PORT || 14330),
  database: smokeTarget,
  options: {
    encrypt: (process.env.MSSQL_ENCRYPT ?? 'false') === 'true',
    trustServerCertificate: (process.env.MSSQL_TRUST_CERT ?? 'true') === 'true',
  },
}).connect();
const bk = (
  await pool.request().query(`SELECT TOP 1 user_id FROM bookings ORDER BY created_at`)
).recordset[0];
if (!bk) {
  console.error('no booking row in scratch — unexpected');
  process.exit(1);
}
const uid = bk.user_id;
const userRow = (
  await pool
    .request()
    .query(`SELECT phone FROM users WHERE id = '${String(uid).replace(/'/g, "''")}'`)
).recordset[0];
const phone = userRow.phone;
const notifN = Number(
  (
    await pool
      .request()
      .query(
        `SELECT COUNT(*) AS n FROM notifications WHERE recipient_role = 'user' AND recipient_id = '${String(uid).replace(/'/g, "''")}'`,
      )
  ).recordset[0].n,
);
const bookingsN = Number(
  (
    await pool
      .request()
      .query(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = '${String(uid).replace(/'/g, "''")}'`)
  ).recordset[0].n,
);
await pool.close();

const child = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    DB_DRIVER: 'mssql',
    MSSQL_DATABASE: smokeTarget,
    PORT: '3999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));
const stop = async () => {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet — retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`server did not boot. log:\n${serverLog}`);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('GET /health', health.ok === true);

  const ready = await (await fetch(`${BASE}/api/ready`)).json();
  check('GET /ready (scratch mssql)', ready.ok === true && ready.db === 'up');

  const bad = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password: 'wrong-pw-never-matches' }),
  });
  check('POST /auth/login prod-user wrong-pw -> 401', bad.status === 401, `status=${bad.status}`);

  const est = await fetch(`${BASE}/api/bookings/estimate-price`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pickup: { lat: 19.076, lng: 72.8777 },
      drop: { lat: 19.1, lng: 72.9 },
      vehicle_type: 'mini_truck',
    }),
  });
  const estBody = await est.json();
  check(
    'POST /estimate-price (migrated pricing)',
    est.status === 200 && estBody.ok === true && Number(estBody.total) > 0,
    `total=${estBody.total}`,
  );

  const token = signToken({ id: uid, role: 'user' });
  const auth = { authorization: `Bearer ${token}` };

  const meRes = await fetch(`${BASE}/api/auth/me`, { headers: auth });
  const me = await meRes.json();
  check(
    'GET /auth/me (migrated prod user)',
    meRes.status === 200 && me.ok === true && me.user?.id?.toLowerCase() === String(uid).toLowerCase(),
    `status=${meRes.status}`,
  );

  const bkRes = await fetch(`${BASE}/api/bookings`, { headers: auth });
  const bkBody = await bkRes.json();
  const rows = bkBody.bookings ?? bkBody.rows ?? [];
  check(
    'GET /bookings (prod bookings for owner)',
    bkRes.status === 200 && rows.length === bookingsN,
    `n=${rows.length}/${bookingsN}`,
  );

  const ntRes = await fetch(`${BASE}/api/notifications`, { headers: auth });
  const ntBody = await ntRes.json();
  const nRows = ntBody.items ?? [];
  check(
    'GET /notifications (prod jsonb for owner)',
    ntRes.status === 200 && ntBody.ok === true && nRows.length === notifN,
    `n=${nRows.length}/${notifN}`,
  );
} catch (e) {
  check('smoke runtime', false, e.message);
} finally {
  await stop();
}

for (const line of results) console.log(line);
console.log(failures ? `SMOKE-SCRATCH FAILED (${failures})` : 'SMOKE-SCRATCH OK — app serves migrated production data read-only');
process.exit(failures ? 1 : 0);
