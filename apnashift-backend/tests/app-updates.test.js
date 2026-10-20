// App updates: public version check + super_admin CRUD/push + 426 gate.
// Skips when no test DB (hasTestDb); DB-dependent bodies also skip when the
// app_releases tables don't exist — CI's PG never runs db/mssql/007, and the
// PG migration was deliberately skipped (AGENTS.md: MSSQL-only rule).
// Pure decideAction/cmpSemver tests run EVERYWHERE (no DB needed).
// Run: npx vitest run tests/app-updates.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/app.js';
import {
  applyTestSchema,
  truncateAll,
  makeTestClient,
  hasTestDb,
  tableExists,
} from './helpers/db.js';
import {
  dispatchDueReleasePushes,
  decideAction,
  invalidateReleaseCache,
} from '../src/services/appUpdates.js';
import { cmpSemver } from '../src/utils/version.js';
import { fcmConfigured } from '../src/services/fcm.js';

const describeDb = hasTestDb ? describe : describe.skip;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = hasTestDb ? makeTestClient() : null;

let relReady = false;

let phoneSeq = 9871000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Upd User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Upd Driver',
    phone,
    password: 'password123',
    vehicle_type: 'mini_truck',
    vehicle_number: `MP${phone.slice(-8)}`,
  });
  expect(res.status).toBe(201);
  await client.query('UPDATE drivers SET is_verified = TRUE WHERE phone = $1', [phone]);
  const idRow = await client.query('SELECT id FROM drivers WHERE phone = $1', [phone]);
  return { ...res.body, driver: { ...(res.body.driver ?? {}), id: idRow.rows[0].id } };
}

async function makeAdmin(phone, role = 'super_admin') {
  const hash = await bcrypt.hash('admin-pass-123', 4);
  await client.query('INSERT INTO admins (name, phone, password_hash, role) VALUES ($1, $2, $3, $4)', [
    role === 'super_admin' ? 'Super' : 'Staff',
    phone,
    hash,
    role,
  ]);
  const res = await request(app).post('/api/admin/login').send({ phone, password: 'admin-pass-123' });
  expect(res.status).toBe(200);
  return res.body.token;
}

function relPayload(over = {}) {
  return {
    version: '1.1.0',
    release_notes: 'Bug fixes + naye features (test)',
    audience: 'users',
    priority: 'normal',
    ...over,
  };
}

async function createRel(token, payload) {
  return request(app)
    .post('/api/app-updates')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);
}

function bookingPayload(over = {}) {
  return {
    pickup: { address: '12 MG Road, Indore', lat: 22.7196, lng: 75.8577 },
    drop: { address: '45 AB Road, Indore', lat: 22.7296, lng: 75.8677 },
    vehicle_type: 'mini_truck',
    helper_needed: false,
    item_description: 'samaan',
    ...over,
  };
}

const latest = (version) =>
  version === undefined
    ? request(app).get('/api/app-updates/latest')
    : request(app).get(`/api/app-updates/latest?version=${version}`);

// ---------------------------------------------------------------- pure tests
describe('cmpSemver + decideAction (pure, no DB)', () => {
  it('cmpSemver: numeric order, equality, junk = NaN', () => {
    expect(cmpSemver('1.9.0', '1.10.0')).toBe(-1); // lexical would say 1.10 < 1.9
    expect(cmpSemver('2.0.0', '1.9.9')).toBe(1);
    expect(cmpSemver('1.2.3', '1.2.3')).toBe(0);
    expect(cmpSemver('1.0', '1.0.0')).toBeNaN();
    expect(cmpSemver('banana', '1.0.0')).toBeNaN();
    expect(cmpSemver(null, '1.0.0')).toBeNaN();
  });

  const rel = (over = {}) => ({
    version: '1.1.0',
    build: null,
    mandatory: 0,
    min_supported_version: null,
    update_url: 'https://example.com/app',
    priority: 'normal',
    release_notes: 'notes for 1.1.0',
    ...over,
  });

  it('no published rows -> none with null metadata', () => {
    const d = decideAction('1.0.0', []);
    expect(d).toMatchObject({ action: 'none', latest_version: null, update_url: null });
  });

  it('up-to-date / newer / unknown installed -> none', () => {
    const rows = [rel()];
    expect(decideAction('1.1.0', rows).action).toBe('none');
    expect(decideAction('2.0.0', rows).action).toBe('none');
    expect(decideAction('1.0', rows).action).toBe('none'); // garbage -> never punish
    expect(decideAction(null, rows).action).toBe('none');
  });

  it('older installed, optional release -> optional + latest metadata', () => {
    const d = decideAction('1.0.0', [rel({ priority: 'high' })]);
    expect(d).toMatchObject({
      action: 'optional',
      latest_version: '1.1.0',
      priority: 'high',
      mandatory: false,
      release_notes: 'notes for 1.1.0',
    });
  });

  it('latest mandatory -> required for every older version', () => {
    const d = decideAction('1.0.9', [rel({ mandatory: 1 })]);
    expect(d).toMatchObject({ action: 'required', mandatory: true, latest_version: '1.1.0' });
  });

  it('installed < min_supported_version -> required (even if optional flag off)', () => {
    const d = decideAction('1.0.2', [rel({ min_supported_version: '1.0.5' })]);
    expect(d.action).toBe('required');
    expect(d.mandatory).toBe(false);
    expect(d.min_supported_version).toBe('1.0.5');
    // Same min but installed >= it -> optional again.
    expect(decideAction('1.0.5', [rel({ min_supported_version: '1.0.5' })]).action).toBe(
      'optional',
    );
  });

  it('mandatory on an OLDER release still forces (multi-release)', () => {
    const rows = [rel({ version: '1.2.0', mandatory: 0 }), rel({ version: '1.1.0', mandatory: 1 })];
    expect(decideAction('1.0.0', rows)).toMatchObject({ action: 'required', mandatory: true });
    // Metadata still comes from the LATEST row (where clients are sent).
    expect(decideAction('1.0.0', rows).latest_version).toBe('1.2.0');
    // Between the two: not below 1.1.0 anymore -> optional.
    expect(decideAction('1.1.5', rows).action).toBe('optional');
  });
});

// ------------------------------------------------------------------ DB tests
describeDb('app updates (DB)', () => {
  let superTok;
  let adminTok;
  let userTok;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
    relReady = await tableExists(client, 'app_releases');
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    if (!relReady) return;
    await truncateAll(client);
    invalidateReleaseCache();
    superTok = await makeAdmin(nextPhone(), 'super_admin');
    adminTok = await makeAdmin(nextPhone(), 'admin');
    userTok = (await makeUser(nextPhone())).token;
  });

  it('RBAC — /latest public, list 401/403, super_admin 200', async () => {
    const pub = await latest('1.0.0');
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ ok: true, action: 'none', latest_version: null });
    expect(pub.body.served_at).toBeTruthy();

    expect((await request(app).get('/api/app-updates')).status).toBe(401);
    expect(
      (await request(app).get('/api/app-updates').set('Authorization', `Bearer ${userTok}`)).status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/app-updates').set('Authorization', `Bearer ${adminTok}`)).status,
    ).toBe(403);
    const ok = await request(app)
      .get('/api/app-updates')
      .set('Authorization', `Bearer ${superTok}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, total: 0, page: 1, fcm_configured: false });
  });

  it('create + validation + duplicate 409 + audit log', async () => {
    const draft = await createRel(superTok, relPayload());
    expect(draft.status).toBe(201);
    expect(draft.body.release).toMatchObject({ version: '1.1.0', status: 'draft', mandatory: false });
    expect(draft.body.release.push.status).toBe('none');
    expect(draft.body.release.published_at).toBeNull();
    const id = draft.body.release.id;

    // Draft never shows in the public version check.
    expect((await latest('1.0.0')).body.action).toBe('none');

    // Strict semver.
    const badVer = await createRel(superTok, relPayload({ version: '1.0' }));
    expect(badVer.status).toBe(400);
    expect(badVer.body.details[0].field).toBe('version');

    // https-only update_url (Play Store / verified APK page — kabhi http nahi).
    expect((await createRel(superTok, relPayload({ update_url: 'http://x.com/a.apk' }))).status).toBe(400);
    expect(
      (await createRel(superTok, relPayload({ update_url: 'javascript:alert(1)' }))).status,
    ).toBe(400);
    const withUrl = await createRel(
      superTok,
      relPayload({
        version: '1.2.0',
        update_url: 'https://play.google.com/store/apps/details?id=com.apnashift.apnashift_app',
      }),
    );
    expect(withUrl.status).toBe(201);
    expect(withUrl.body.release.update_url).toContain('https://play.google.com/');

    // min_supported_version > version rejected.
    const badMin = await createRel(
      superTok,
      relPayload({ version: '1.3.0', min_supported_version: '1.4.0' }),
    );
    expect(badMin.status).toBe(400);
    expect(badMin.body.details[0].field).toBe('min_supported_version');

    // Missing notes + bad enum + plain admin (RBAC before validation).
    expect((await createRel(superTok, relPayload({ release_notes: '' }))).status).toBe(400);
    expect((await createRel(superTok, relPayload({ priority: 'urgent' }))).status).toBe(400);
    expect((await createRel(adminTok, relPayload({ version: '1.9.0' }))).status).toBe(403);

    // Duplicate version -> 409 (UNIQUE), not 500.
    const dup = await createRel(superTok, relPayload({ version: '1.1.0' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('version_taken');

    // Audit row.
    const audit = await client.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'app_release.create' AND entity_id = $1`,
      [id],
    );
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  it('latest endpoint: none/optional/required + archive retires', async () => {
    const c = await createRel(
      superTok,
      relPayload({
        status: 'published',
        mandatory: true,
        min_supported_version: '1.0.5',
        priority: 'high',
        update_url: 'https://play.google.com/store/apps/details?id=com.apnashift.apnashift_app',
      }),
    );
    expect(c.status).toBe(201);
    expect(c.body.release.published_at).toBeTruthy();

    // Optional vs required boundaries.
    const old = await latest('1.0.0');
    expect(old.body).toMatchObject({
      action: 'required',
      mandatory: true,
      latest_version: '1.1.0',
      min_supported_version: '1.0.5',
      priority: 'high',
    });
    expect(old.body.update_url).toContain('https://');
    expect(old.body.release_notes).toContain('Bug fixes');
    expect((await latest('1.1.0')).body.action).toBe('none');
    expect((await latest('9.9.9')).body.action).toBe('none');
    expect((await latest('nonsense')).body.action).toBe('none');
    expect((await latest()).body.action).toBe('none'); // no version param

    // Same release, mandatory OFF + min met -> optional.
    const opt = await request(app)
      .patch(`/api/app-updates/${c.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ mandatory: false, min_supported_version: '1.0.0' });
    expect(opt.status).toBe(200);
    expect((await latest('1.0.0')).body.action).toBe('optional');

    // Archive -> nothing published -> none.
    const off = await request(app)
      .patch(`/api/app-updates/${c.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'archived' });
    expect(off.status).toBe(200);
    expect((await latest('1.0.0')).body).toMatchObject({ action: 'none', latest_version: null });
  });

  it('426 gate on bookings/estimate/driver — header-less flows unaffected', async () => {
    const driver = await makeDriver(nextPhone());
    // Setup BEFORE the forced release: header-less booking works (website/app se pehle).
    const pre = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${userTok}`)
      .send(bookingPayload());
    expect(pre.status).toBe(201);
    const bookingId = pre.body.booking.id;

    const pub = await createRel(
      superTok,
      relPayload({
        status: 'published',
        mandatory: true,
        update_url: 'https://play.google.com/store/apps/details?id=com.apnashift.apnashift_app',
      }),
    );
    expect(pub.status).toBe(201);

    // Outdated app (X-App-Version 1.0.0 < 1.1.0) -> 426 everywhere protected.
    const est = await request(app)
      .post('/api/bookings/estimate-price')
      .set('X-App-Version', '1.0.0')
      .send(bookingPayload());
    expect(est.status).toBe(426);
    expect(est.body).toMatchObject({
      ok: false,
      error: 'update_required',
      latest_version: '1.1.0',
    });
    expect(est.body.update_url).toContain('https://');
    expect(est.body.message).toContain('1.1.0');

    const bk = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${userTok}`)
      .set('X-App-Version', '1.0.0')
      .send(bookingPayload());
    expect(bk.status).toBe(426);
    expect(bk.body.error).toBe('update_required');

    const acc = await request(app)
      .patch(`/api/driver/bookings/${bookingId}/accept`)
      .set('Authorization', `Bearer ${driver.token}`)
      .set('X-App-Version', '1.0.0');
    expect(acc.status).toBe(426);
    expect(acc.body.error).toBe('update_required');

    // Up-to-date version passes.
    const okEst = await request(app)
      .post('/api/bookings/estimate-price')
      .set('X-App-Version', '1.1.0')
      .send(bookingPayload());
    expect(okEst.status).toBe(200);

    // No header / garbage header -> allowed (website, WhatsApp, old binaries).
    const noHdr = await request(app)
      .post('/api/bookings/estimate-price')
      .send(bookingPayload());
    expect(noHdr.status).toBe(200);
    const junkHdr = await request(app)
      .post('/api/bookings/estimate-price')
      .set('X-App-Version', 'banana')
      .send(bookingPayload());
    expect(junkHdr.status).toBe(200);

    // Archive -> gate lifts (cache invalidated on write).
    await request(app)
      .patch(`/api/app-updates/${pub.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'archived' });
    const after = await request(app)
      .post('/api/bookings/estimate-price')
      .set('X-App-Version', '1.0.0')
      .send(bookingPayload());
    expect(after.status).toBe(200);
  });

  it('push: armed at publish, gated by missing FCM creds, report + run', async () => {
    expect(fcmConfigured()).toBe(false);
    const c = await createRel(
      superTok,
      relPayload({ status: 'published', push_enabled: true, push_title: 'Naya update', push_body: 'v1.1.0 aa gaya' }),
    );
    expect(c.status).toBe(201);
    const rel = c.body.release;
    expect(rel.push.status).toBe('scheduled');
    expect(rel.push.scheduled_at).toBeTruthy();

    // Dispatcher creds ke bina kuch bhejta nahi — row untouched.
    const disp = await dispatchDueReleasePushes();
    expect(disp).toMatchObject({ skipped: 'awaiting_credentials' });
    const run = await request(app)
      .post(`/api/app-updates/${rel.id}/push/run`)
      .set('Authorization', `Bearer ${superTok}`);
    expect(run.status).toBe(200);
    expect(run.body.dispatch.skipped).toBe('awaiting_credentials');
    expect(run.body.release.push.status).toBe('scheduled');

    // Delivery report (abhi khali) + list me fcm_configured flag.
    const rep = await request(app)
      .get(`/api/app-updates/${rel.id}/push`)
      .set('Authorization', `Bearer ${superTok}`);
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({
      fcm_configured: false,
      push_status: 'scheduled',
      counts: { sent: 0, failed: 0, pending: 0 },
      recent: [],
    });
    const list = await request(app)
      .get('/api/app-updates')
      .set('Authorization', `Bearer ${superTok}`);
    expect(list.body.fcm_configured).toBe(false);
  });

  it('PATCH transitions: archive cancels push, republish re-arms, retry purges failed only', async () => {
    const c = await createRel(superTok, relPayload({ status: 'published', push_enabled: true }));
    const id = c.body.release.id;
    expect(c.body.release.push.status).toBe('scheduled');

    // -> archived: push cancelled + feed se gayab.
    const off = await request(app)
      .patch(`/api/app-updates/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'archived' });
    expect(off.status).toBe(200);
    expect(off.body.release.status).toBe('archived');
    expect(off.body.release.push.status).toBe('none');
    expect((await latest('1.0.0')).body.action).toBe('none');

    // -> published: re-armed + published_at stamped.
    const on = await request(app)
      .patch(`/api/app-updates/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'published' });
    expect(on.status).toBe(200);
    expect(on.body.release.push.status).toBe('scheduled');
    expect(on.body.release.published_at).toBeTruthy();

    // Simulated dispatch history: ek failed + ek sent row.
    const userRow = await client.query('SELECT id FROM users ORDER BY created_at DESC', []);
    const uid = userRow.rows[0].id;
    await client.query(
      `INSERT INTO app_release_push_log (release_id, owner_role, owner_id, token, status, error)
       VALUES ($1, 'user', $2, 'dead-token-1', 'failed', 'UNREGISTERED')`,
      [id, uid],
    );
    await client.query(
      `INSERT INTO app_release_push_log (release_id, owner_role, owner_id, token, status)
       VALUES ($1, 'user', $2, 'good-token-1', 'sent')`,
      [id, uid],
    );
    await client.query(
      `UPDATE app_releases SET push_status = 'failed', push_total = 2, push_delivered = 1, push_failed = 1
        WHERE id = $1`,
      [id],
    );

    // retry_push: failed row delete, sent row protected, arming + counters reset.
    const retry = await request(app)
      .patch(`/api/app-updates/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ retry_push: true });
    expect(retry.status).toBe(200);
    expect(retry.body.release.push).toMatchObject({
      status: 'scheduled',
      total: 0,
      delivered: 0,
      failed: 0,
    });
    const counts = await client.query(
      `SELECT status, COUNT(*) AS n FROM app_release_push_log WHERE release_id = $1 GROUP BY status`,
      [id],
    );
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus.failed ?? 0).toBe(0);
    expect(byStatus.sent ?? 0).toBe(1);

    // retry validations: push off -> 400, draft -> 400.
    const c2 = await createRel(superTok, relPayload({ version: '1.2.0', status: 'published', push_enabled: false }));
    const badRetry = await request(app)
      .patch(`/api/app-updates/${c2.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ retry_push: true });
    expect(badRetry.status).toBe(400);
    expect(badRetry.body.details[0].field).toBe('retry_push');

    const draftC = await createRel(superTok, relPayload({ version: '1.3.0' }));
    const draftRetry = await request(app)
      .patch(`/api/app-updates/${draftC.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ retry_push: true });
    expect(draftRetry.status).toBe(400);

    // push_enabled=false while scheduled -> cancel.
    const c3 = await createRel(superTok, relPayload({ version: '1.4.0', status: 'published', push_enabled: true }));
    const cancel = await request(app)
      .patch(`/api/app-updates/${c3.body.release.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ push_enabled: false });
    expect(cancel.status).toBe(200);
    expect(cancel.body.release.push.status).toBe('none');
  });
});
