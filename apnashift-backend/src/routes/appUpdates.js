// App releases: public version check + Super Admin CRUD / push control.
//   GET  /api/app-updates/latest   — public (app startup + resume version check)
//   everything below               — super_admin only (requireRole gate)
// Audit: every write goes through logAuditSafe ('app_release.*' actions).
// Time convention: request bodies carry ISO-8601 with offset; stored as UTC.
import { Router } from 'express';
import { query } from '../db.js';
import { notifyLimiter } from '../middleware/notifyLimiter.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseBody } from '../validation/auth.js';
import {
  RELEASE_STATUSES,
  appReleaseCreateSchema,
  appReleaseUpdateSchema,
} from '../validation/appUpdates.js';
import {
  RELEASE_COLS,
  toPublicRelease,
  updateStateFor,
  dispatchDueReleasePushes,
  invalidateReleaseCache,
} from '../services/appUpdates.js';
import { fcmConfigured } from '../services/fcm.js';
import { logAuditSafe } from '../services/audit.js';
import { validateIdParam } from '../utils/validate.js';
import { cmpSemver } from '../utils/version.js';

export const appUpdatesRoutes = Router();

const truthy = (v) => v === true || v === 1;

// GET /api/app-updates/latest?version=1.0.0 — anonymous-safe, rate-limited,
// read-only. Returns action none|optional|required + release metadata
// (notes, priority, https update_url) — no secrets, ever.
appUpdatesRoutes.get('/latest', notifyLimiter, async (req, res, next) => {
  try {
    const raw = req.query.version;
    const installed =
      typeof raw === 'string' && raw.trim() !== '' && raw.length <= 20
        ? raw.trim()
        : null;
    const state = await updateStateFor(installed);
    res.json({ ok: true, ...state });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ super_admin
appUpdatesRoutes.use(requireAuth, requireRole('super_admin'));

function parseListParams(q) {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 20));
  const status = RELEASE_STATUSES.includes(q.status) ? q.status : null;
  return { page, limit, status };
}

async function getRowOr404(res, id) {
  const cur = await query(`SELECT ${RELEASE_COLS} FROM app_releases WHERE id = $1`, [id]);
  if (cur.rowCount === 0) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return null;
  }
  return cur.rows[0];
}

// GET /api/app-updates — paginated admin list (+ push credentials hint).
appUpdatesRoutes.get('/', async (req, res, next) => {
  try {
    const { page, limit, status } = parseListParams(req.query);
    const where = [];
    const params = [];
    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const countRes = await query(`SELECT COUNT(*) AS n FROM app_releases${whereSql}`, params);
    const rows = await query(
      `SELECT ${RELEASE_COLS} FROM app_releases${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, (page - 1) * limit],
    );
    res.json({
      ok: true,
      items: rows.rows.map(toPublicRelease),
      total: Number(countRes.rows[0].n),
      page,
      limit,
      fcm_configured: fcmConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/app-updates — create (draft by default; status='published' for
// immediate publish, which also stamps published_at + arms push).
appUpdatesRoutes.post('/', async (req, res, next) => {
  try {
    const v = parseBody(appReleaseCreateSchema, req.body);
    const status = v.status ?? 'draft';
    const pushEnabled = truthy(v.push_enabled);
    const publishedAt = status === 'published' ? new Date() : null;
    const armPush = status === 'published' && pushEnabled;
    const pushScheduledAt = armPush ? (v.push_scheduled_at ?? new Date()) : null;
    const r = await query(
      `INSERT INTO app_releases
        (version, build, min_supported_version, mandatory, audience, priority,
         release_notes, update_url, status, push_enabled, push_title, push_body,
         push_scheduled_at, push_status, created_by, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${RELEASE_COLS}`,
      [
        v.version,
        v.build ?? null,
        v.min_supported_version ?? null,
        v.mandatory ?? false,
        v.audience,
        v.priority,
        v.release_notes,
        v.update_url ?? null,
        status,
        pushEnabled,
        v.push_title ?? null,
        v.push_body ?? null,
        pushScheduledAt,
        armPush ? 'scheduled' : 'none',
        req.user.id,
        publishedAt,
      ],
    );
    const row = r.rows[0];
    invalidateReleaseCache();
    logAuditSafe(req.user.id, 'app_release.create', 'app_release', row.id, {
      status,
      version: v.version,
      mandatory: truthy(v.mandatory),
      audience: v.audience,
      push_enabled: pushEnabled,
    });
    res.status(201).json({ ok: true, release: toPublicRelease(row) });
  } catch (err) {
    // UNIQUE(version) — duplicate version is an admin mistake, not a 500.
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'version_taken' });
    }
    next(err);
  }
});

// GET /api/app-updates/:id — single release.
appUpdatesRoutes.get('/:id', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    res.json({ ok: true, release: toPublicRelease(row) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/app-updates/:id — edit fields, status flips, push retry.
// Status side effects (implicit, admin-visible via audit):
//   ->archived : pending scheduled push cancelled (push_status none)
//   ->published: published_at stamped, pending push re-armed (if push_enabled)
//   ->draft    : pending scheduled push cancelled
//   push_enabled=false while scheduled : push cancelled
//   retry_push : failed push_log rows deleted (sent rows kept = no dupes),
//                push_status='scheduled' + immediate push_scheduled_at
appUpdatesRoutes.patch('/:id', validateIdParam, async (req, res, next) => {
  try {
    const v = parseBody(appReleaseUpdateSchema, req.body);
    const cur = await getRowOr404(res, req.params.id);
    if (!cur) return;

    // Cross-field check against MERGED state (field may come from DB only).
    const mergedMin = 'min_supported_version' in v ? v.min_supported_version : cur.min_supported_version;
    const mergedVer = 'version' in v ? v.version : cur.version;
    if (mergedMin && mergedVer) {
      const c = cmpSemver(mergedMin, mergedVer);
      if (!Number.isNaN(c) && c > 0) {
        const err = new Error('validation_failed');
        err.status = 400;
        err.details = [
          { field: 'min_supported_version', message: 'min_supported_version version se chhota ya barabar hona chahiye' },
        ];
        throw err;
      }
    }

    const set = [];
    const params = [req.params.id]; // $1
    const put = (col, val) => {
      params.push(val);
      set.push(`${col} = $${params.length}`);
    };

    for (const key of [
      'version', 'build', 'min_supported_version', 'mandatory', 'audience',
      'priority', 'release_notes', 'update_url', 'push_enabled', 'push_title',
      'push_body', 'push_scheduled_at', 'status',
    ]) {
      if (key in v) put(key, v[key]);
    }

    const newStatus = 'status' in v ? v.status : cur.status;
    const pushEnabled = 'push_enabled' in v ? truthy(v.push_enabled) : truthy(cur.push_enabled);
    const curPushStatus = cur.push_status;

    if ('status' in v && v.status !== cur.status) {
      if (v.status === 'archived') {
        if (curPushStatus === 'scheduled') put('push_status', 'none');
      } else if (v.status === 'published') {
        put('published_at', new Date());
        if (pushEnabled && curPushStatus === 'none') {
          put('push_status', 'scheduled');
          if (!('push_scheduled_at' in v) && !cur.push_scheduled_at) {
            put('push_scheduled_at', new Date());
          }
        }
      } else if (v.status === 'draft' && curPushStatus === 'scheduled') {
        put('push_status', 'none');
      }
    }
    if ('push_enabled' in v && !truthy(v.push_enabled) && curPushStatus === 'scheduled') {
      put('push_status', 'none');
    }

    let deletedFailed = false;
    if (v.retry_push === true) {
      if (!pushEnabled) {
        const err = new Error('validation_failed');
        err.status = 400;
        err.details = [{ field: 'retry_push', message: 'retry ke liye push_enabled on chahiye' }];
        throw err;
      }
      if (newStatus !== 'published') {
        const err = new Error('validation_failed');
        err.status = 400;
        err.details = [{ field: 'retry_push', message: 'retry sirf published release par' }];
        throw err;
      }
      // Failed rows only — already-sent rows keep their UNIQUE dedupe row.
      await query(
        `DELETE FROM app_release_push_log WHERE release_id = $1 AND status = 'failed'`,
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
      `UPDATE app_releases SET ${set.join(', ')} WHERE id = $1 RETURNING ${RELEASE_COLS}`,
      params,
    );
    invalidateReleaseCache();
    const changed = Object.keys(v).filter((k) => k !== 'retry_push');
    logAuditSafe(req.user.id, 'app_release.update', 'app_release', req.params.id, {
      changed,
      status: newStatus,
      ...(deletedFailed ? { retry_push: true } : {}),
      ...('status' in v && v.status === 'archived' ? { archived: true } : {}),
    });
    res.json({ ok: true, release: toPublicRelease(r.rows[0]) });
  } catch (err) {
    // UNIQUE(version) — duplicate version is an admin mistake, not a 500.
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'version_taken' });
    }
    next(err);
  }
});

// GET /api/app-updates/:id/push — delivery report (counts + recent rows).
appUpdatesRoutes.get('/:id/push', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    const countsRes = await query(
      `SELECT status, COUNT(*) AS n FROM app_release_push_log
        WHERE release_id = $1 GROUP BY status`,
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
         FROM app_release_push_log WHERE release_id = $1
        ORDER BY sent_at DESC LIMIT 50`,
      [req.params.id],
    );
    res.json({
      ok: true,
      release_id: req.params.id,
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

// POST /api/app-updates/:id/push/run — run the dispatcher NOW (no 30s wait).
// With FCM creds missing returns dispatch.skipped='awaiting_credentials'.
appUpdatesRoutes.post('/:id/push/run', validateIdParam, async (req, res, next) => {
  try {
    const row = await getRowOr404(res, req.params.id);
    if (!row) return;
    const dispatch = await dispatchDueReleasePushes();
    const freshRes = await query(`SELECT ${RELEASE_COLS} FROM app_releases WHERE id = $1`, [
      req.params.id,
    ]);
    const fresh = freshRes.rowCount > 0 ? freshRes.rows[0] : row;
    res.json({
      ok: true,
      release: toPublicRelease(fresh),
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
