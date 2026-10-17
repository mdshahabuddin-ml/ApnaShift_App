// TEMP Step-D smoke: boots the real server against ApnaShiftDB_migrate,
// exercises read-only endpoints, then shuts the server down. One process tree.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { signToken } from '../src/utils/jwt.js';

const BASE = 'http://localhost:3999';
const CHILD_ENV = {
  ...process.env,
  DB_DRIVER: 'mssql',
  MSSQL_DATABASE: 'ApnaShiftDB_migrate',
  PORT: '3999',
};

const results = [];
let failures = 0;
const check = (label, ok, detail) => {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const child = spawn(process.execPath, ['src/server.js'], {
  env: CHILD_ENV,
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
  // 1) boot + health
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
  check('GET /api/health', health.ok === true, JSON.stringify(health));

  // 2) ready — exercises mssql translate + migrated DB
  const ready = await (await fetch(`${BASE}/api/ready`)).json();
  check('GET /api/ready (mssql ping)', ready.ok === true && ready.db === 'up', JSON.stringify(ready));

  // 3) login: correct migrated phone + wrong password -> 401 (read path works)
  const badLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '9092142438', password: 'definitely-wrong-pw' }),
  });
  const badBody = await badLogin.json();
  check('POST /auth/login wrong-pw -> 401 (migrated user found)', badLogin.status === 401 && badBody.ok === false, `status=${badLogin.status}`);

  // 4) public estimate — reads migrated pricing_rules
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
    'POST /bookings/estimate-price (migrated pricing)',
    est.status === 200 && estBody.ok === true && typeof estBody.total === 'number' && estBody.total > 0,
    `status=${est.status} total=${estBody.total} base_fare=${estBody.base_fare}`,
  );

  // 5) authenticated reads with app-minted token (migrated user)
  const token = signToken({ id: '399A8ABD-5BD5-494B-A3B2-2588F7F06E1C', role: 'user' });
  const auth = { authorization: `Bearer ${token}` };

  const me = await (await fetch(`${BASE}/api/auth/me`, { headers: auth })).json();
  check('GET /auth/me (migrated user row)', me.ok === true && me.user?.phone === '9092142438', JSON.stringify(me).slice(0, 200));

  const bookingsRes = await fetch(`${BASE}/api/bookings`, { headers: auth });
  const bookings = await bookingsRes.json();
  const rows = bookings.bookings ?? bookings.rows ?? [];
  check('GET /bookings (migrated booking row)', bookingsRes.status === 200 && rows.length === 1 && String(rows[0].id).toLowerCase() === '8213a81e-6b64-4709-bb73-e50a5d75ed44', `n=${rows.length}`);

  const notifRes = await fetch(`${BASE}/api/notifications`, { headers: auth });
  const notif = await notifRes.json();
  const nRows = notif.items ?? [];
  check(
    'GET /notifications (migrated jsonb rows)',
    notifRes.status === 200 && notif.ok === true && nRows.length === 5,
    `n=${nRows.length} status=${notifRes.status}`,
  );
} catch (e) {
  check('smoke runtime', false, e.message);
} finally {
  await stop();
}

for (const line of results) console.log(line);
console.log(failures ? `SMOKE FAILED (${failures})` : 'SMOKE OK — all read-only endpoints passed');
process.exit(failures ? 1 : 0);
