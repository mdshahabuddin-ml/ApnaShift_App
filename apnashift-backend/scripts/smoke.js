// Post-deployment smoke tests (no test framework needed — runs anywhere
// with node 20+: CI staging job, or manually against localhost).
//
//   SMOKE_BASE_URL=https://<staging> SMOKE_MODE=full \
//     SMOKE_ADMIN_PHONE=7xxxxxxxxx SMOKE_ADMIN_PASSWORD=... node scripts/smoke.js
//
// Modes:
//   full   — staging E2E: health, ready(DB), auth, booking, driver verify +
//            assignment, GPS posts, customer live tracking, enterprise inquiry.
//            Creates disposable rows (unique phones per run); run ONLY where
//            test data is acceptable (staging / localhost), NEVER production.
//   health — production-safe: only GET /api/health + /api/ready. No writes,
//            no test data. This is what the production job runs.
//
// Exit: 0 all pass, 1 any fail. Output is `SMOKE PASS/FAIL <name>` lines so
// CI logs show exactly which gate broke. Secrets (tokens/passwords) are
// NEVER printed — only statuses and public ids.
const BASE = (process.env.SMOKE_BASE_URL ?? '').replace(/\/$/, '');
const MODE = (process.env.SMOKE_MODE ?? 'health').toLowerCase();

if (!BASE) {
  console.error('SMOKE FAIL config: SMOKE_BASE_URL khaali hai (e.g. https://staging...)');
  process.exit(1);
}
if (!['full', 'health'].includes(MODE)) {
  console.error(`SMOKE FAIL config: SMOKE_MODE '${MODE}' galat hai (full|health)`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`SMOKE PASS ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`SMOKE FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function call(method, path, body, token) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(BASE + path, opts);
  } catch (err) {
    return { status: 0, body: null, netErr: err.message };
  }
  // Non-JSON body (proxies/HTML) -> null; status se faisla hoga.
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed, netErr: null };
}
// Unique 10-digit phones per run (suffix from timestamp; prefix keeps 6-9 start).
function uniqPhone(prefix9) {
  const suffix = String(Date.now() % 100000000).padStart(8, '0');
  return `${prefix9}${suffix}`.slice(0, 10);
}

async function healthChecks() {
  const h = await call('GET', '/api/health');
  check('api_health_200_ok', h.status === 200 && h.body?.ok === true, `status=${h.status}${h.netErr ? ` net=${h.netErr}` : ''}`);
  const r = await call('GET', '/api/ready');
  check('api_ready_200_db_up', r.status === 200 && r.body?.ok === true && r.body?.db === 'up', `status=${r.status}`);
  return fail === 0;
}

async function fullChecks() {
  const adminPhone = process.env.SMOKE_ADMIN_PHONE ?? '';
  const adminPass = process.env.SMOKE_ADMIN_PASSWORD ?? '';
  if (!/^[6-9]\d{9}$/.test(adminPhone) || adminPass.length < 8) {
    console.log('SMOKE FAIL config: SMOKE_ADMIN_PHONE (10-digit) + SMOKE_ADMIN_PASSWORD (8+ chars) chahiye full mode me');
    process.exit(1);
  }

  // 1. auth — customer + driver register (tokens prove auth works).
  const custPhone = uniqPhone('98');
  const cust = await call('POST', '/api/auth/register', { name: 'Smoke User', phone: custPhone, password: 'SmokePass123' });
  check('auth_customer_register_201', cust.status === 201 && !!cust.body?.token, `status=${cust.status}`);
  const drvPhone = uniqPhone('97');
  const drv = await call('POST', '/api/drivers/register', {
    name: 'Smoke Driver', phone: drvPhone, password: 'SmokePass123',
    vehicle_type: 'mini_truck', vehicle_number: `SM${custPhone.slice(-6)}`,
  });
  check('auth_driver_register_201', drv.status === 201 && !!drv.body?.token, `status=${drv.status}`);
  if (fail > 0) return false;
  const tokC = cust.body.token;
  const tokD = drv.body.token;

  // 2. admin login + driver verify (staging admin is created by CI before this).
  const adm = await call('POST', '/api/admin/login', { phone: adminPhone, password: adminPass });
  check('auth_admin_login_200', adm.status === 200 && !!adm.body?.token, `status=${adm.status}`);
  if (fail > 0) return false;
  const verify = await call('PATCH', `/api/admin/drivers/${drv.body?.user?.id ?? drv.body?.driver?.id ?? ''}/verify`, {}, adm.body.token);
  check('driver_verified_by_admin', verify.status === 200, `status=${verify.status}`);

  // 3. booking creation (customer).
  const created = await call('POST', '/api/bookings', {
    pickup: { address: 'Smoke Pickup, Indore', lat: 22.7196, lng: 75.8577 },
    drop: { address: 'Smoke Drop, Indore', lat: 22.7296, lng: 75.8677 },
    vehicle_type: 'mini_truck', helper_needed: false, item_description: 'smoke parcel',
  }, tokC);
  check('booking_create_201_pending', created.status === 201 && created.body?.booking?.status === 'pending', `status=${created.status}`);
  if (fail > 0) return false;
  const bid = created.body.booking.id;

  // 4. driver assignment (accept).
  const seen = await call('GET', '/api/driver/bookings/available?limit=20', null, tokD);
  check('driver_sees_pending_trip', seen.status === 200 && (seen.body?.bookings ?? []).some((b) => b.id === bid), `status=${seen.status}`);
  const acc = await call('PATCH', `/api/driver/bookings/${bid}/accept`, {}, tokD);
  check('driver_accept_200_accepted', acc.status === 200 && acc.body?.booking?.status === 'accepted', `status=${acc.status}`);
  if (fail > 0) return false;

  // 5. driver location updates (lat/lng/accuracy/speed/heading).
  // Server throttle: TRACK_MIN_INTERVAL_MS (default 3000) per driver+booking
  // — do posts ko us gap se door rakhna warna doosra 429.
  const fixes = [
    { lat: 22.721, lng: 75.859, accuracy_m: 12.5, speed_mps: 8.3, heading_deg: 90 },
    { lat: 22.724, lng: 75.862, accuracy_m: 9.4, speed_mps: 7.1, heading_deg: 100 },
  ];
  for (let i = 0; i < fixes.length; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, 3200));
    const f = fixes[i];
    const p = await call('POST', `/api/driver/bookings/${bid}/location`, f, tokD);
    check(`driver_gps_post_${f.lat}`, p.status === 201 && p.body?.point?.lat === f.lat, `status=${p.status}`);
  }

  // 6. customer live tracking (latest point + Online state + last update).
  const snap = await call('GET', `/api/bookings/${bid}/location?history=1`, tokC);
  check('tracking_snapshot_200', snap.status === 200 && snap.body?.ok === true, `status=${snap.status}`);
  check('tracking_state_live', snap.body?.tracking?.state === 'live', `state=${snap.body?.tracking?.state}`);
  check('tracking_latest_marker', snap.body?.points?.[0]?.lat === 22.724, JSON.stringify(snap.body?.points?.[0] ?? null).slice(0, 80));
  check('tracking_last_updated_set', !!snap.body?.tracking?.last_updated, 'last_updated missing');

  // 7. enterprise inquiry (public, no auth).
  const ent = await call('POST', '/api/enterprise/inquiries', {
    full_name: 'Smoke Prospect', email: `smoke-${Date.now()}@company.com`, phone: uniqPhone('96'),
    company_name: 'Smoke Retail Pvt Ltd', website: 'https://example-company.com',
    designation: 'Ops Manager', business_type: 'retail', company_size: '11-50',
    cities: 'Indore', operating_state: 'Madhya Pradesh', locations_count: 2,
    services_required: ['local_delivery'], message: 'CI smoke inquiry',
  });
  check('enterprise_inquiry_2xx', (ent.status === 200 || ent.status === 201) && ent.body?.ok !== false, `status=${ent.status}`);
  return fail === 0;
}

const ok = MODE === 'full' ? (await healthChecks()) && (await fullChecks()) : await healthChecks();
console.log(`\nSMOKE RESULT mode=${MODE}: ${pass} pass, ${fail} fail${failures.length ? ` [${failures.join(', ')}]` : ''}`);
process.exit(ok && fail === 0 ? 0 : 1);
