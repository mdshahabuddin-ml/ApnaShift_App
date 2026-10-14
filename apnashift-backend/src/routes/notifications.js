// In-app notifications (bell + history + live stream) for customers/drivers.
// All routes are owner-scoped: callers only ever see their own rows
// (role + id come from the verified JWT, never from query/body).
// Admins keep their existing booking SSE channel — this router is 403 for
// the admin role by design (separate key space, separate audience).
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { notifyLimiter } from '../middleware/notifyLimiter.js';
import { query } from '../db.js';
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  notificationsSince,
  subscribeRecipient,
  RECIPIENT_ROLES,
} from '../services/notifyCenter.js';
import {
  notificationListQuerySchema,
  notificationStreamQuerySchema,
  deviceTokenSchema,
  parseQuery,
  parseBody,
} from '../validation/notifications.js';
import { validateIdParam } from '../utils/validate.js';

export const notificationsRoutes = Router();

function ownerOf(req, res) {
  if (!RECIPIENT_ROLES.includes(req.user.role)) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return null;
  }
  return { role: req.user.role, id: req.user.id };
}

// GET /api/notifications?limit=20&before=ISO (own, newest first)
notificationsRoutes.get('/', requireAuth, notifyLimiter, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const { limit, before } = parseQuery(notificationListQuerySchema, req.query);
    const items = await listNotifications(owner.role, owner.id, { limit, before: before ?? null });
    res.json({ ok: true, items });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count (bell badge — cheap count query)
notificationsRoutes.get('/unread-count', requireAuth, notifyLimiter, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    res.json({ ok: true, unread: await unreadCount(owner.role, owner.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/stream?since=ISO (SSE live feed, own channel)
// Auth via Authorization header (frontend uses fetch, not EventSource).
// Replays rows newer than `since`, then pushes live `notification` events.
// 25s heartbeat + frontend poll fallback (same pattern as tracking stream).
notificationsRoutes.get('/stream', requireAuth, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const { since } = parseQuery(notificationStreamQuerySchema, req.query);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (since) {
      const missed = await notificationsSince(owner.role, owner.id, since);
      for (const item of missed) {
        res.write(`event: notification\ndata: ${JSON.stringify(item)}\n\n`);
      }
    }
    const leave = subscribeRecipient(owner.role, owner.id, res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        // closed below.
      }
    }, 25000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      leave();
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read (own row only — cross-user -> 404)
notificationsRoutes.patch(
  '/:id/read',
  requireAuth,
  notifyLimiter,
  validateIdParam,
  async (req, res, next) => {
    try {
      const owner = ownerOf(req, res);
      if (!owner) return;
      const updated = await markRead(owner.role, owner.id, req.params.id);
      if (updated === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/notifications/read-all (own unread -> read)
notificationsRoutes.post('/read-all', requireAuth, notifyLimiter, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const updated = await markAllRead(owner.role, owner.id);
    res.json({ ok: true, updated });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/device-tokens (Phase-2 push registration)
notificationsRoutes.post('/device-tokens', requireAuth, notifyLimiter, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const { platform, token } = parseBody(deviceTokenSchema, req.body);
    await query(
      `INSERT INTO device_tokens (owner_role, owner_id, platform, token, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (owner_role, owner_id, token)
       DO UPDATE SET platform = EXCLUDED.platform, updated_at = now()`,
      [owner.role, owner.id, platform, token],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/notifications/device-tokens (unregister — body carries token)
notificationsRoutes.delete('/device-tokens', requireAuth, notifyLimiter, async (req, res, next) => {
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const { token } = parseBody(deviceTokenSchema.pick({ token: true }), req.body);
    await query('DELETE FROM device_tokens WHERE owner_role = $1 AND owner_id = $2 AND token = $3', [
      owner.role,
      owner.id,
      token,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
