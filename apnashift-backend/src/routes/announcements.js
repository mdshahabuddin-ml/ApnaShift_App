// Announcements: public active feed + Super Admin CRUD / push control.
//   GET  /api/announcements/active      — public (website + app banner source)
//   everything below                    — super_admin only (requireRole gate)
// Audit: every write goes through logAuditSafe ('announcement.*' actions).
// Time convention: request bodies carry ISO-8601 with offset; stored as UTC.
import { Router } from 'express';
import { query } from '../db.js';
import { notifyLimiter } from '../middleware/notifyLimiter.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseBody } from '../validation/auth.js';
import {
  ANNOUNCE_STATUSES,
  announcementCreateSchema,
  announcementUpdateSchema,
} from '../validation/announcements.js';
import {
  ANNOUNCE_COLS,
  toPublicAnnouncement,
  activeAnnouncements,
  maintenanceState,
  dispatchDuePushes,
  resolvePushScheduledAt,
} from '../services/announcements.js';
import { fcmConfigured } from '../services/fcm.js';
import { logAuditSafe } from '../services/audit.js';
import { validateIdParam } from '../utils/validate.js';

export const announcementsRoutes = Router();

const truthy = (v) => v === true || v === 1;

// GET /api/announcements/active — anonymous-safe, rate-limited, read-only.
// audience=user|driver widens the filter past universal rows; default = only
// audience='all'. served_at lets clients expire banners against SERVER time.
announcementsRoutes.get('/active', notifyLimiter, async (req, res, next) => {
  try {
    const aud = req.query.audience;
    const items = await activeAnnouncements(
      aud === 'user' || aud === 'driver' ? aud : null,
    );
    const maintenance = await maintenanceState();
    res.json({
      ok: true,
      served_at: new Date().toISOString(),
      maintenance,
      items,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ super_admin
announcementsRoutes.use(requireAuth, requireRole('super_admin'));

function parseListParams(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 20));
  const status = ANNOUNCE_STATUSES.includes(q.status) ? q.status : null;
  const audience = ['all', 'users', 'drivers'].includes(q.audience) ? q.audience : null;
  return { page, limit, status, audience };
}

async function getRowOr404(res, id) {
  const cur = await query(`SELECT ${ANNOUNCE_COLS} FROM announcements WHERE id = $1`, [id]);
  if (cur.rowCount === 0) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return null;
  }
  return cur.rows[0];
}

// GET /api/announcements — paginated admin list (+ push credentials hint).
announcementsRoutes.get('/', async (req, res, next) => {
  try {
    const { page, limit, status, audience } = parseListParams(req.query);
    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    if (audience) {
      params.push(audience);
      where.push(`audience = $${params.length}`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) AS n FROM announcements${whereSql}`, params);
    const rows = await query(
      `SELECT ${ANNOUNCE_COLS} FROM announcements${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    res.json({
      ok: true,
      items: rows.rows.map(toPublicAnnouncement),
      total: Number(countRes.rows[0].n),
      page,
      limit,
      fcm_configured: fcmConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/announcements — create (draft by default; status='published'
// allowed for immediate publish). Push arms at publish time.
announcementsRoutes.post('/', async (req, res, next) => {
  try {
    const v = parseBody(announcementCreateSchema, req.body);
    const status = v.status ?? 'draft';
    const pushEnabled = truthy(v.push_enabled);
    // Explicit push_scheduled_at > derived (start_at - notify_before_minutes).
    let pushScheduledAt =
      resolvePushScheduledAt({
        push_scheduled_at: v.push_scheduled_at ?? null,
        notify_before_minutes: v.notify_before_minutes ?? null,
        start_at: v.start_at ?? null,
      }) ?? null;
    const armPush = status === 'published' && pushEnabled;
    if (armPush && !pushScheduledAt) pushScheduledAt = new Date();
    const r = await query(
      `INSERT INTO announcements
        (title, body, severity, audience, status, start_at, end_at, timezone,
         show_banner, maintenance_mode, block_message, push_enabled, push_title,
         push_body, push_scheduled_at, push_status, notify_before_minutes,
         created_by, deactivated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING ${ANNOUNCE_COLS}`,
      [
        v.title,
        v.body,
        v.severity,
        v.audience,
        status,
        v.start_at ?? null,
        v.end_at ?? null,
        v.timezone ?? 'Asia/Kolkata',
        v.show_banner ?? true,
        v.maintenance_mode ?? false,
        v.block_message ?? null,
        pushEnabled,
        v.push_title ?? null,
        v.push_body ?? null,
        pushScheduledAt,
        armPush ? 'scheduled' : 'none',
        v.notify_before_minutes ?? null,
        req.user.id,
        status === 'deactivated' ? new Date() : null,
      ],
    );
    const row = r.rows[0];
    logAuditSafe(req.user.id, 'announcement.create', 'announcement', row.id, {
      status,
      severity: v.severity,
      audience: v.audience,
      maintenance_mode: truthy(v.maintenance_mode),
      push_enabled: pushEnabled,
    });
    res.status(201).json({ ok: true, announcement: toPublicAnnouncement(row) });
  } catch (err) {
    next(err);
  }
});

// GET /api/announcements/:id — single announcement.
announcementsRoutes.get('/:id', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    res.json({ ok: true, announcement: toPublicAnnouncement(row) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/announcements/:id — edit fields, status flips, push retry.
// Status side effects (all implicit, admin-visible via audit):
//   ->deactivated : pending scheduled push cancelled (push_status none)
//   ->published   : pending push re-armed (if push_enabled), deactivated_at cleared
//   ->draft       : pending scheduled push cancelled
//   push_enabled=false while scheduled : push cancelled
//   retry_push    : failed push_log rows deleted (sent rows kept = no dupes),
//                   push_status='scheduled' + immediate push_scheduled_at
announcementsRoutes.patch('/:id', validateIdParam, async (req, res, next) => {
  try {
    const v = parseBody(announcementUpdateSchema, req.body);
    const cur = await getRowOr404(res, req.params.id);
    if (!cur) return;

    // Cross-field checks against MERGED state (field may come from DB only).
    const mergedMaint = 'maintenance_mode' in v ? truthy(v.maintenance_mode) : truthy(cur.maintenance_mode);
    const mergedBlock = 'block_message' in v ? v.block_message : cur.block_message;
    if (mergedMaint && !mergedBlock) {
      const err = new Error('validation_failed');
      err.status = 400;
      err.details = [{ field: 'block_message', message: 'block_message is required for maintenance_mode' }];
      throw err;
    }
    const mergedStart = 'start_at' in v ? v.start_at : cur.start_at;
    const mergedEnd = 'end_at' in v ? v.end_at : cur.end_at;
    if (mergedStart && mergedEnd && new Date(mergedEnd) <= new Date(mergedStart)) {
      const err = new Error('validation_failed');
      err.status = 400;
      err.details = [{ field: 'end_at', message: 'end_at must be after start_at' }];
      throw err;
    }

    const set = [];
    const params = [req.params.id]; // $1
    const put = (col, val) => {
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };

    // Plain field updates (only keys present in the payload).
    for (const key of [
      'title', 'body', 'severity', 'audience', 'start_at', 'end_at', 'timezone',
      'show_banner', 'maintenance_mode', 'block_message', 'push_enabled',
      'push_title', 'push_body', 'push_scheduled_at', 'notify_before_minutes',
      'status',
    ]) {
      if (key in v) put(key, v[key]);
    }

    const newStatus = 'status' in v ? v.status : cur.status;
    const pushEnabled = 'push_enabled' in v ? truthy(v.push_enabled) : truthy(cur.push_enabled);
    const curPushStatus = cur.push_status;
    // Push_status ke baad wali state — recompute decision isi par.
    let effPushStatus = curPushStatus;
    const mergedNbm = 'notify_before_minutes' in v ? v.notify_before_minutes : cur.notify_before_minutes;

    if ('status' in v && v.status !== cur.status) {
      if (v.status === 'deactivated') {
        put('deactivated_at', new Date());
        if (curPushStatus === 'scheduled') {
          put('push_status', 'none');
          effPushStatus = 'none';
        }
      } else if (v.status === 'published') {
        put('deactivated_at', null);
        if (pushEnabled && curPushStatus === 'none') {
          put('push_status', 'scheduled');
          effPushStatus = 'scheduled';
          if (!('push_scheduled_at' in v) && !cur.push_scheduled_at) {
            // Advance notification derived schedule (start_at - N) > immediate.
            const derived = resolvePushScheduledAt({
              notify_before_minutes: mergedNbm,
              start_at: mergedStart,
            });
            put('push_scheduled_at', derived ?? new Date());
          }
        }
      } else if (v.status === 'draft' && curPushStatus === 'scheduled') {
        put('push_status', 'none');
        effPushStatus = 'none';
      }
    }
    if ('push_enabled' in v && !truthy(v.push_enabled) && curPushStatus === 'scheduled') {
      put('push_status', 'none');
      effPushStatus = 'none';
    }
    // Advance notification: schedule inputs badle (start_at / nbm) aur
    // explicit push_scheduled_at client se nahi aaya → derived time recalc
    // (sirf abhi bhi pending push par — sent/failed ko kabhi restart nahi).
    if (
      effPushStatus === 'scheduled' &&
      !('push_scheduled_at' in v) &&
      ('start_at' in v || 'notify_before_minutes' in v)
    ) {
      const derived = resolvePushScheduledAt({
        notify_before_minutes: mergedNbm,
        start_at: mergedStart,
      });
      if (derived) put('push_scheduled_at', derived);
    }

    let deletedFailed = false;
    if (v.retry_push === true) {
      if (!pushEnabled) {
        const err = new Error('validation_failed');
        err.status = 400;
        err.details = [{ field: 'retry_push', message: 'push_enabled must be on to retry' }];
        throw err;
      }
      if (newStatus !== 'published') {
        const err = new Error('validation_failed');
        err.status = 400;
        err.details = [{ field: 'retry_push', message: 'retry only works on published announcements' }];
        throw err;
      }
      // Failed rows only — already-sent rows keep their UNIQUE dedupe row.
      await query(
        `DELETE FROM announcement_push_log WHERE announcement_id = $1 AND status = 'failed'`,
        [req.params.id],
      );
      deletedFailed = true;
      put('push_status', 'scheduled');
      put('push_scheduled_at', new Date());
      put('push_sent_at', null);
      put('push_total', 0);
      put('push_delivered', 0);
      put('push_failed', 0);
    }

    set.push('updated_at = now()');
    const r = await query(
      `UPDATE announcements SET ${set.join(', ')} WHERE id = $1 RETURNING ${ANNOUNCE_COLS}`,
      params,
    );
    const changed = Object.keys(v).filter((k) => k !== 'retry_push');
    logAuditSafe(req.user.id, 'announcement.update', 'announcement', req.params.id, {
      changed,
      status: newStatus,
      ...(deletedFailed ? { retry_push: true } : {}),
      ...('status' in v && v.status === 'deactivated' ? { deactivated: true } : {}),
    });
    res.json({ ok: true, announcement: toPublicAnnouncement(r.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// GET /api/announcements/:id/push — delivery report (counts + recent rows).
announcementsRoutes.get('/:id/push', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    const countsRes = await query(
      `SELECT status, COUNT(*) AS n FROM announcement_push_log
        WHERE announcement_id = $1 GROUP BY status`,
      [req.params.id],
    );
    const counts = { sent: 0, failed: 0, pending: 0 };
    for (const c of countsRes.rows) {
      const n = Number(c.n);
      if (c.status === 'sent') counts.sent = n;
      else if (c.status === 'failed') counts.failed = n;
      else counts.pending += n;
    }
    const rows = await query(
      `SELECT owner_role, owner_id, status, error, sent_at
         FROM announcement_push_log WHERE announcement_id = $1
        ORDER BY sent_at DESC LIMIT 50`,
      [req.params.id],
    );
    res.json({
      ok: true,
      announcement_id: req.params.id,
      push_status: row.push_status,
      counters: {
        total: Number(row.push_total ?? 0),
        delivered: Number(row.push_delivered ?? 0),
        failed: Number(row.push_failed ?? 0),
      },
      counts,
      fcm_configured: fcmConfigured(),
      recent: rows.rows.map((r2) => ({
        owner_role: r2.owner_role,
        owner_id: r2.owner_id,
        status: r2.status,
        error: r2.error ?? null,
        sent_at: isoDate(r2.sent_at),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/announcements/:id/push/run — run the dispatcher NOW (no 30s wait).
// With FCM creds missing returns dispatch.skipped='awaiting_credentials'.
announcementsRoutes.post('/:id/push/run', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    const dispatch = await dispatchDuePushes();
    const freshRes = await query(`SELECT ${ANNOUNCE_COLS} FROM announcements WHERE id = $1`, [
      req.params.id,
    ]);
    const fresh = freshRes.rowCount > 0 ? freshRes.rows[0] : row;
    res.json({
      ok: true,
      announcement: toPublicAnnouncement(fresh),
      dispatch,
    });
  } catch (err) {
    next(err);
  }
});

function isoDate(v) {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
