// Announcements: public feed + super_admin CRUD/push + maintenance gates.
// Skips when no test DB (hasTestDb); DB-dependent bodies also skip when the
// announcements tables don't exist — CI's PG never runs db/mssql/005, and the
// PG migration was deliberately skipped (AGENTS.md: MSSQL-only rule).
// Run: npx vitest run tests/announcements.test.js
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
import { dispatchDuePushes, maintenanceState } from '../src/services/announcements.js';
import { fcmConfigured } from '../src/services/fcm.js';

const describeDb = hasTestDb ? describe : describe.skip;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = hasTestDb ? makeTestClient() : null;

let annReady = false;

let phoneSeq = 9881000000;
function nextPhone() {
  phoneSeq += 1;
  return String(phoneSeq);
}

async function makeUser(phone) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name: 'Ann User', phone, password: 'password123' });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeDriver(phone) {
  const res = await request(app).post('/api/drivers/register').send({
    name: 'Ann Driver',
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

function annPayload(over = {}) {
  return {
    title: 'Server maintenance',
    body: 'Hum upgrade kar rahe hain — thodi der me wapas.',
    severity: 'warning',
    audience: 'all',
    ...over,
  };
}

async function createAnn(token, payload) {
  const res = await request(app)
    .post('/api/announcements')
    .set('Authorization', `Bearer ${token}`)
    .send(payload);
  return res;
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

// Every DB-dependent body passes through this guard (skip works from the
// test context in vitest 2).
const itAnn = (name, fn) =>
  it(name, async (ctx) => {
    if (!annReady) return ctx.skip();
    return fn(ctx);
  });

describeDb('announcements (DB)', () => {
  let superTok;
  let adminTok;
  let userTok;

  beforeAll(async () => {
    await client.connect();
    await applyTestSchema(client, root);
    annReady = await tableExists(client, 'announcements');
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    if (!annReady) return;
    await truncateAll(client);
    superTok = await makeAdmin(nextPhone(), 'super_admin');
    adminTok = await makeAdmin(nextPhone(), 'admin');
    userTok = (await makeUser(nextPhone())).token;
  });

  itAnn('RBAC — /active public, list 401/403, super_admin 200', async () => {
    const pub = await request(app).get('/api/announcements/active');
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ ok: true, maintenance: { blocked: false } });
    expect(pub.body.served_at).toBeTruthy();
    expect(pub.body.items).toEqual([]);

    expect((await request(app).get('/api/announcements')).status).toBe(401);
    expect(
      (await request(app).get('/api/announcements').set('Authorization', `Bearer ${userTok}`)).status,
    ).toBe(403);
    expect(
      (await request(app).get('/api/announcements').set('Authorization', `Bearer ${adminTok}`)).status,
    ).toBe(403);
    const ok = await request(app)
      .get('/api/announcements')
      .set('Authorization', `Bearer ${superTok}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, total: 0, page: 1, fcm_configured: false });
  });

  itAnn('create draft + validation + audit log', async () => {
    const draft = await createAnn(superTok, annPayload());
    expect(draft.status).toBe(201);
    expect(draft.body.announcement.status).toBe('draft');
    expect(draft.body.announcement.push.status).toBe('none');
    const id = draft.body.announcement.id;

    // Draft never shows in the public feed.
    const feed = await request(app).get('/api/announcements/active');
    expect(feed.body.items).toEqual([]);

    // Maintenance mode ke liye block_message mandatory.
    const noBlock = await createAnn(
      superTok,
      annPayload({ severity: 'maintenance', maintenance_mode: true, status: 'published' }),
    );
    expect(noBlock.status).toBe(400);
    expect(noBlock.body.error).toBe('validation_failed');
    expect(noBlock.body.details[0].field).toBe('block_message');

    // end_at <= start_at rejected.
    const badWindow = await createAnn(
      superTok,
      annPayload({
        start_at: '2026-10-19T12:00:00+05:30',
        end_at: '2026-10-19T11:00:00+05:30',
      }),
    );
    expect(badWindow.status).toBe(400);
    expect(badWindow.body.details[0].field).toBe('end_at');

    // Bad enum rejected.
    expect((await createAnn(superTok, annPayload({ severity: 'loud' }))).status).toBe(400);

    // Plain admin create nahi kar sakta (RBAC 403, validation se pehle).
    expect((await createAnn(adminTok, annPayload())).status).toBe(403);

    // Audit row.
    const audit = await client.query(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'announcement.create' AND entity_id = $1`,
      [id],
    );
    expect(Number(audit.rows[0].n)).toBe(1);
  });

  itAnn('published window + audience filter on /active', async () => {
    const all = await createAnn(superTok, annPayload({ status: 'published' }));
    expect(all.status).toBe(201);
    const usersOnly = await createAnn(
      superTok,
      annPayload({ status: 'published', audience: 'users', title: 'Users only' }),
    );
    expect(usersOnly.status).toBe(201);
    // Future window — active nahi.
    await createAnn(
      superTok,
      annPayload({
        status: 'published',
        title: 'Kal se',
        start_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    );
    // Expiry — end chuka.
    await createAnn(
      superTok,
      annPayload({
        status: 'published',
        title: 'Purana',
        end_at: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const def = await request(app).get('/api/announcements/active');
    expect(def.status).toBe(200);
    expect(def.body.items.map((i) => i.title)).toEqual(['Server maintenance']);

    const forUsers = await request(app).get('/api/announcements/active?audience=user');
    expect(forUsers.body.items.map((i) => i.title).sort()).toEqual([
      'Server maintenance',
      'Users only',
    ]);

    // super_admin list me charo rows (total=4), naye pehle.
    const list = await request(app)
      .get('/api/announcements')
      .set('Authorization', `Bearer ${superTok}`);
    expect(list.body.total).toBe(4);
  });

  itAnn('scheduled push: armed at publish, gated by missing FCM creds', async () => {
    expect(fcmConfigured()).toBe(false);
    const c = await createAnn(
      superTok,
      annPayload({ status: 'published', push_enabled: true, push_title: 'Naya update', push_body: 'App update aaya' }),
    );
    expect(c.status).toBe(201);
    const ann = c.body.announcement;
    expect(ann.push.status).toBe('scheduled');
    expect(ann.push.scheduled_at).toBeTruthy();

    // Dispatcher creds ke bina kuch bhejta nahi — row untouched.
    const disp = await dispatchDuePushes();
    expect(disp).toMatchObject({ skipped: 'awaiting_credentials' });
    const run = await request(app)
      .post(`/api/announcements/${ann.id}/push/run`)
      .set('Authorization', `Bearer ${superTok}`);
    expect(run.status).toBe(200);
    expect(run.body.dispatch.skipped).toBe('awaiting_credentials');
    expect(run.body.announcement.push.status).toBe('scheduled');

    // Delivery report (abhi khali) + list me fcm_configured flag.
    const rep = await request(app)
      .get(`/api/announcements/${ann.id}/push`)
      .set('Authorization', `Bearer ${superTok}`);
    expect(rep.status).toBe(200);
    expect(rep.body).toMatchObject({
      fcm_configured: false,
      push_status: 'scheduled',
      counts: { sent: 0, failed: 0, pending: 0 },
      recent: [],
    });
  });

  itAnn('advance notification: derived schedule, explicit wins, patch recalcs', async () => {
    const start = new Date(Date.now() + 3600_000);
    const c = await createAnn(
      superTok,
      annPayload({
        status: 'published',
        push_enabled: true,
        start_at: start.toISOString(),
        notify_before_minutes: 30,
      }),
    );
    expect(c.status).toBe(201);
    const ann = c.body.announcement;
    expect(ann.notify_before_minutes).toBe(30);
    expect(ann.push.status).toBe('scheduled');
    // Derived: push_scheduled_at = start_at - 30 min.
    const expected = start.getTime() - 30 * 60_000;
    expect(Math.abs(Date.parse(ann.push.scheduled_at) - expected)).toBeLessThan(5000);

    // Explicit push_scheduled_at WINS over notify_before_minutes.
    const explicit = new Date(Date.now() + 7200_000);
    const c2 = await createAnn(
      superTok,
      annPayload({
        status: 'published',
        push_enabled: true,
        start_at: start.toISOString(),
        notify_before_minutes: 30,
        push_scheduled_at: explicit.toISOString(),
      }),
    );
    expect(c2.status).toBe(201);
    expect(Math.abs(Date.parse(c2.body.announcement.push.scheduled_at) - explicit.getTime()))
      .toBeLessThan(5000);

    // start_at PATCH (pending push, no explicit schedule in payload) → recalc.
    const newStart = new Date(Date.now() + 7200_000);
    const p = await request(app)
      .patch(`/api/announcements/${ann.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ start_at: newStart.toISOString() });
    expect(p.status).toBe(200);
    const exp2 = newStart.getTime() - 30 * 60_000;
    expect(Math.abs(Date.parse(p.body.announcement.push.scheduled_at) - exp2)).toBeLessThan(5000);

    // Range validation: -1 aur10081 dono400.
    expect((await createAnn(superTok, annPayload({ notify_before_minutes: -1 }))).status).toBe(400);
    expect((await createAnn(superTok, annPayload({ notify_before_minutes: 10081 }))).status).toBe(400);
  });

  itAnn('maintenance mode blocks bookings/estimate/driver — deactivate lifts', async () => {
    const driver = await makeDriver(nextPhone());
    // Maintenance se PEHLE booking + driver ready.
    const pre = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${userTok}`)
      .send(bookingPayload());
    expect(pre.status).toBe(201);
    const bookingId = pre.body.booking.id;

    const msg = 'Upgrades chal raha hai — bookings 30 min me wapas chalu hongi.';
    const maint = await createAnn(
      superTok,
      annPayload({
        severity: 'maintenance',
        maintenance_mode: true,
        block_message: msg,
        status: 'published',
      }),
    );
    expect(maint.status).toBe(201);

    // Feed ab maintenance state batata hai.
    const feed = await request(app).get('/api/announcements/active');
    expect(feed.body.maintenance).toMatchObject({ blocked: true, message: msg });
    expect((await maintenanceState()).blocked).toBe(true);

    // Booking create -> 423 (maintenanceGate) with admin ke words.
    const blocked = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${userTok}`)
      .send(bookingPayload());
    expect(blocked.status).toBe(423);
    expect(blocked.body).toMatchObject({ ok: false, error: 'maintenance_active', message: msg });

    // Estimate bhi blocked.
    const est = await request(app)
      .post('/api/bookings/estimate-price')
      .set('Authorization', `Bearer ${userTok}`)
      .send(bookingPayload());
    expect(est.status).toBe(423);
    expect(est.body.error).toBe('maintenance_active');

    // Driver accept bhi blocked.
    const acc = await request(app)
      .patch(`/api/driver/bookings/${bookingId}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(acc.status).toBe(423);
    expect(acc.body.error).toBe('maintenance_active');

    // Deactivate -> gate lifts automatically (derived window, no job).
    const off = await request(app)
      .patch(`/api/announcements/${maint.body.announcement.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'deactivated' });
    expect(off.status).toBe(200);
    expect((await maintenanceState()).blocked).toBe(false);
    expect(
      (await request(app).get('/api/announcements/active')).body.maintenance.blocked,
    ).toBe(false);

    const ok = await request(app)
      .post('/api/bookings')
      .set('Authorization', `Bearer ${userTok}`)
      .send(bookingPayload());
    expect(ok.status).toBe(201);

    const acc2 = await request(app)
      .patch(`/api/driver/bookings/${bookingId}/accept`)
      .set('Authorization', `Bearer ${driver.token}`);
    expect(acc2.status).toBe(200);
  });

  itAnn('PATCH transitions: deactivate cancels push, republish re-arms, retry purges failed', async () => {
    const c = await createAnn(
      superTok,
      annPayload({ status: 'published', push_enabled: true }),
    );
    const id = c.body.announcement.id;
    expect(c.body.announcement.push.status).toBe('scheduled');

    // -> deactivated: push cancelled + deactivated_at stamped + feed se gayab.
    const off = await request(app)
      .patch(`/api/announcements/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'deactivated' });
    expect(off.status).toBe(200);
    expect(off.body.announcement.status).toBe('deactivated');
    expect(off.body.announcement.push.status).toBe('none');
    expect(off.body.announcement.deactivated_at).toBeTruthy();
    expect(
      (await request(app).get('/api/announcements/active')).body.items,
    ).toEqual([]);

    // -> published: re-armed (deactivated_at cleared).
    const on = await request(app)
      .patch(`/api/announcements/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ status: 'published' });
    expect(on.status).toBe(200);
    expect(on.body.announcement.push.status).toBe('scheduled');
    expect(on.body.announcement.deactivated_at).toBeNull();

    // Simulated dispatch history: ek failed + ek sent row.
    const userRow = await client.query(
      'SELECT id FROM users ORDER BY created_at DESC',
      [],
    );
    const uid = userRow.rows[0].id;
    await client.query(
      `INSERT INTO announcement_push_log (announcement_id, owner_role, owner_id, token, status, error)
       VALUES ($1, 'user', $2, 'dead-token-1', 'failed', 'UNREGISTERED')`,
      [id, uid],
    );
    await client.query(
      `INSERT INTO announcement_push_log (announcement_id, owner_role, owner_id, token, status)
       VALUES ($1, 'user', $2, 'good-token-1', 'sent')`,
      [id, uid],
    );
    await client.query(
      `UPDATE announcements SET push_status = 'failed', push_total = 2, push_delivered = 1, push_failed = 1
        WHERE id = $1`,
      [id],
    );

    // retry_push: failed row delete, sent row protected, arming + counters reset.
    const retry = await request(app)
      .patch(`/api/announcements/${id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ retry_push: true });
    expect(retry.status).toBe(200);
    expect(retry.body.announcement.push).toMatchObject({
      status: 'scheduled',
      total: 0,
      delivered: 0,
      failed: 0,
    });
    const counts = await client.query(
      `SELECT status, COUNT(*) AS n FROM announcement_push_log WHERE announcement_id = $1 GROUP BY status`,
      [id],
    );
    const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
    expect(byStatus.failed ?? 0).toBe(0);
    expect(byStatus.sent ?? 0).toBe(1);

    // retry without push_enabled -> 400.
    const c2 = await createAnn(superTok, annPayload({ status: 'published', push_enabled: false }));
    const badRetry = await request(app)
      .patch(`/api/announcements/${c2.body.announcement.id}`)
      .set('Authorization', `Bearer ${superTok}`)
      .send({ retry_push: true });
    expect(badRetry.status).toBe(400);
    expect(badRetry.body.details[0].field).toBe('retry_push');
  });
});
