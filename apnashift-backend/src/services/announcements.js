// Announcements: display windows, maintenance-mode gate, scheduled FCM push.
// "Active right now" and expiry are DERIVED per query (published + window vs
// server UTC clock) — no activation job can desync and block lift is automatic.
// The only background work is push dispatch (startAnnouncementTicker).
// Push dispatch is crash-safe: DB-level dedupe (announcement_push_log UNIQUE)
// + status-CAS claim; a re-run skips already-sent rows, never double-sends.
import { query } from '../db.js';
import { fcmConfigured, sendToDeviceToken } from './fcm.js';

export const ANNOUNCE_COLS = `id, title, body, severity, audience, status,
  start_at, end_at, timezone, show_banner, maintenance_mode, block_message,
  push_enabled, push_title, push_body, push_scheduled_at, push_status,
  push_sent_at, push_total, push_delivered, push_failed, notify_before_minutes,
  created_by, created_at, updated_at, deactivated_at`;

// Shared WHERE fragment — every active/maintenance query uses this window.
const ACTIVE_WINDOW = `status = 'published'
  AND (start_at IS NULL OR start_at <= now())
  AND (end_at IS NULL OR end_at > now())`;

const iso = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function toPublicAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    audience: row.audience,
    status: row.status,
    start_at: iso(row.start_at),
    end_at: iso(row.end_at),
    timezone: row.timezone ?? 'Asia/Kolkata',
    show_banner: row.show_banner === true || row.show_banner === 1,
    maintenance_mode: row.maintenance_mode === true || row.maintenance_mode === 1,
    block_message: row.block_message ?? null,
    push: {
      enabled: row.push_enabled === true || row.push_enabled === 1,
      scheduled_at: iso(row.push_scheduled_at),
      status: row.push_status,
      sent_at: iso(row.push_sent_at),
      total: Number(row.push_total ?? 0),
      delivered: Number(row.push_delivered ?? 0),
      failed: Number(row.push_failed ?? 0),
    },
    notify_before_minutes:
      row.notify_before_minutes === null || row.notify_before_minutes === undefined
        ? null
        : Number(row.notify_before_minutes),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    deactivated_at: iso(row.deactivated_at),
  };
}

// Active announcements for the public banner feed.
// audience: 'user' | 'driver' (role) -> matches announcement audience values
// ('all' + plural 'users'/'drivers'); null/invalid -> only universal rows.
export async function activeAnnouncements(audience = null) {
  const params = [];
  let sql = `SELECT ${ANNOUNCE_COLS} FROM announcements WHERE ${ACTIVE_WINDOW}`;
  if (audience === 'user' || audience === 'driver') {
    params.push(audience === 'user' ? 'users' : 'drivers');
    sql += ` AND (audience = 'all' OR audience = $${params.length})`;
  } else {
    sql += ` AND audience = 'all'`;
  }
  sql += ` ORDER BY CASE severity WHEN 'maintenance' THEN 0 WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, created_at DESC`;
  const r = await query(sql, params);
  return r.rows.map(toPublicAnnouncement);
}

// Booking/driver-action block state — any ACTIVE maintenance_mode row blocks.
// until: latest end_at across blocking rows; null = at least one indefinite.
export async function maintenanceState() {
  const r = await query(
    `SELECT block_message, end_at FROM announcements
      WHERE ${ACTIVE_WINDOW} AND maintenance_mode = TRUE`,
    [],
  );
  if (r.rowCount === 0) return { blocked: false, message: null, until: null };
  const withMsg = r.rows.find((x) => x.block_message);
  const message =
    withMsg?.block_message ??
    'Maintenance in progress — bookings and driver actions will resume shortly.';
  let anyIndefinite = false;
  let maxEnd = null;
  for (const x of r.rows) {
    if (!x.end_at) anyIndefinite = true;
    else {
      const d = new Date(x.end_at);
      if (!maxEnd || d > maxEnd) maxEnd = d;
    }
  }
  return { blocked: true, message, until: anyIndefinite ? null : maxEnd.toISOString() };
}

// Advance notification: explicit push_scheduled_at wins; warna (n + start_at)
// se derived = start_at - N minutes; warna null (caller immediate/none decide).
// WRITE-TIME resolution — dispatcher/ticker unchanged.
export function resolvePushScheduledAt({
  push_scheduled_at = null,
  notify_before_minutes = null,
  start_at = null,
} = {}) {
  if (push_scheduled_at) {
    const d = push_scheduled_at instanceof Date ? push_scheduled_at : new Date(push_scheduled_at);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (notify_before_minutes !== null && notify_before_minutes !== undefined && start_at) {
    const s = start_at instanceof Date ? start_at : new Date(start_at);
    if (!Number.isNaN(s.getTime())) {
      return new Date(s.getTime() - Number(notify_before_minutes) * 60_000);
    }
  }
  return null;
}

// Express middleware for gated routes (POST /api/bookings, estimate,
// driver accept/decline/status). 423 with the announcement's own words.
export async function maintenanceGate(req, res, next) {
  try {
    const m = await maintenanceState();
    if (m.blocked) {
      return res
        .status(423)
        .json({ ok: false, error: 'maintenance_active', message: m.message, until: m.until });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Service-level guard inside createBookingRow — covers the WhatsApp flow
// (and any future writer) even if its route forgot the middleware.
export async function assertBookingsAllowed() {
  const m = await maintenanceState();
  if (m.blocked) {
    const err = new Error('maintenance_active');
    err.status = 423;
    err.code = 'maintenance_active';
    err.maintenance = m;
    throw err;
  }
}

// ---------------------------------------------------------------- dispatch
function audienceRoles(audience) {
  if (audience === 'users') return ['user'];
  if (audience === 'drivers') return ['driver'];
  return ['user', 'driver'];
}

async function dispatchAnnouncement(a) {
  const roles = audienceRoles(a.audience);
  const ph = roles.map((_, i) => `$${i + 1}`).join(', ');
  const tokens = await query(
    `SELECT DISTINCT owner_role, owner_id, token FROM device_tokens WHERE owner_role IN (${ph})`,
    roles,
  );
  const title = a.push_title || a.title;
  const body = a.push_body || a.body;
  let sent = 0;
  let failed = 0;
  let oauthDead = false;
  for (const t of tokens.rows) {
    if (!t.token) continue;
    // Dedupe: UNIQUE (announcement, role, owner, token) — duplicate key on a
    // crash-restart means this row was already handled, skip without sending.
    try {
      await query(
        `INSERT INTO announcement_push_log (announcement_id, owner_role, owner_id, token, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [a.id, t.owner_role, t.owner_id, t.token],
      );
    } catch (err) {
      if (err.code === '23505' || err.code === '2627' || err.number === 2627) continue;
      throw err;
    }
    const r = await sendToDeviceToken(t.token, {
      title,
      body,
      data: { announcement_id: String(a.id), severity: String(a.severity) },
    });
    if (r.ok) {
      sent += 1;
      await query(
        `UPDATE announcement_push_log SET status = 'sent'
          WHERE announcement_id = $1 AND owner_role = $2 AND owner_id = $3 AND token = $4`,
        [a.id, t.owner_role, t.owner_id, t.token],
      ).catch(() => {});
    } else {
      failed += 1;
      const shortErr = String(r.error ?? 'send_failed').slice(0, 190);
      await query(
        `UPDATE announcement_push_log SET status = 'failed', error = $5
          WHERE announcement_id = $1 AND owner_role = $2 AND owner_id = $3 AND token = $4`,
        [a.id, t.owner_role, t.owner_id, t.token, shortErr],
      ).catch(() => {});
      // FCM says token is gone -> auto-prune so future fan-outs stay clean.
      if (r.dead) {
        await query(
          'DELETE FROM device_tokens WHERE owner_role = $1 AND owner_id = $2 AND token = $3',
          [t.owner_role, t.owner_id, t.token],
        ).catch(() => {});
      }
      if (r.oauth) oauthDead = true;
    }
    if (oauthDead) break; // credentials broken — every remaining send would fail
  }
  const status = failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
  await query(
    `UPDATE announcements
        SET push_status = $2, push_sent_at = now(), push_total = $3,
            push_delivered = $4, push_failed = $5, updated_at = now()
      WHERE id = $1`,
    [a.id, status, sent + failed, sent, failed],
  );
  return { id: a.id, status, sent, failed };
}

// Fire all due, published, scheduled pushes. Returns a report object, never
// throws (ticker wraps anyway). Without FCM_* creds: {skipped:'awaiting_credentials'}.
export async function dispatchDuePushes() {
  if (!fcmConfigured()) return { skipped: 'awaiting_credentials', due: 0, results: [] };
  const due = await query(
    `SELECT id, title, body, push_title, push_body, audience, severity
       FROM announcements
      WHERE push_enabled = TRUE AND push_status = 'scheduled' AND status = 'published'
        AND push_scheduled_at IS NOT NULL AND push_scheduled_at <= now()
      ORDER BY push_scheduled_at ASC`,
    [],
  );
  const results = [];
  for (const a of due.rows) {
    // CAS claim — only one dispatcher process wins this row.
    const claimed = await query(
      `UPDATE announcements SET push_status = 'sending', updated_at = now()
        WHERE id = $1 AND push_status = 'scheduled'`,
      [a.id],
    );
    if (claimed.rowCount !== 1) continue;
    try {
      results.push(await dispatchAnnouncement(a));
    } catch (err) {
      console.error('[announce] dispatch fail:', err.message);
      // Send broke mid-way — mark failed so super admin sees it + can retry
      // (retry_push deletes failed log rows first, so sent ones never repeat).
      await query(
        `UPDATE announcements SET push_status = 'failed', updated_at = now()
          WHERE id = $1 AND push_status = 'sending'`,
        [a.id],
      ).catch(() => {});
    }
  }
  return { skipped: null, due: due.rowCount, results };
}

// ------------------------------------------------------------------ ticker
// In-process scheduler (no new dependency): same setInterval pattern as the
// SSE heartbeats. Started ONLY from server.js so supertest never spawns it.
let tickerTimer = null;

export function startAnnouncementTicker(intervalMs = 30000) {
  if (tickerTimer) return tickerTimer;
  const tick = () => {
    dispatchDuePushes().catch((err) => console.error('[announce] tick fail:', err.message));
  };
  const boot = setTimeout(tick, 5000); // DB/creds settle after boot
  if (typeof boot.unref === 'function') boot.unref();
  tickerTimer = setInterval(tick, intervalMs);
  if (typeof tickerTimer.unref === 'function') tickerTimer.unref();
  return tickerTimer;
}

export function stopAnnouncementTicker() {
  if (tickerTimer) {
    clearInterval(tickerTimer);
    tickerTimer = null;
  }
}
