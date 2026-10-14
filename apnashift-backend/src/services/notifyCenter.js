// Central notification hub: persisted rows + per-recipient SSE fan-out.
// Best-effort by contract: queueNotification() NEVER rejects — booking,
// driver and admin flows must succeed even if the notification store is
// down (failures become one console line, like logAuditSafe).
// Dedupe: UNIQUE(booking_id, recipient_role, recipient_id, type) means a
// retry/replay can never create a second row for the same event.
import { query } from '../db.js';
import { pushToOwner } from './fcm.js';

export const NOTIF_TYPES = [
  'booking_created',
  'booking_accepted',
  'driver_arrived',
  'trip_started',
  'trip_completed',
  'booking_cancelled',
  'assignment_received',
];

export const RECIPIENT_ROLES = ['user', 'driver'];

function shortRef(bookingId) {
  return String(bookingId).slice(0, 8);
}

function templateFor(type, bookingId) {
  const ref = shortRef(bookingId);
  switch (type) {
    case 'booking_created':
      return { title: 'Booking placed', body: `Booking #${ref} is placed. We will assign a driver shortly.` };
    case 'booking_accepted':
      return { title: 'Driver assigned', body: `Booking #${ref} is confirmed — your driver is assigned.` };
    case 'driver_arrived':
      return { title: 'Driver reached pickup', body: `Your driver reached the pickup point for booking #${ref}.` };
    case 'trip_started':
      return { title: 'Trip started', body: `Trip started for booking #${ref}. Track your vehicle live.` };
    case 'trip_completed':
      return { title: 'Trip completed', body: `Booking #${ref} is delivered. Thank you for using ApnaShift.` };
    case 'booking_cancelled':
      return { title: 'Booking cancelled', body: `Booking #${ref} was cancelled.` };
    case 'assignment_received':
      return { title: 'New trip assigned', body: `Trip #${ref} is assigned to you. Open your dashboard.` };
    default:
      return { title: 'Update', body: `Update for booking #${ref}.` };
  }
}

// ---- Recipient SSE hub (one channel per role:id; separate key space from
// the tracking.js GPS/booking/admin hubs so streams never interfere) ----
const recipientSubscribers = new Map(); // `${role}:${id}` -> Set<res>

function channelOf(role, id) {
  return `${role}:${id}`;
}

export function subscribeRecipient(role, id, res) {
  const key = channelOf(role, id);
  let set = recipientSubscribers.get(key);
  if (!set) {
    set = new Set();
    recipientSubscribers.set(key, set);
  }
  set.add(res);
  return () => unsubscribeRecipient(role, id, res);
}

export function unsubscribeRecipient(role, id, res) {
  const key = channelOf(role, id);
  const set = recipientSubscribers.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) recipientSubscribers.delete(key);
}

export function publishRecipient(role, id, eventName, event) {
  const set = recipientSubscribers.get(channelOf(role, id));
  if (!set || set.size === 0) return 0;
  const data = `event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`;
  let delivered = 0;
  for (const res of [...set]) {
    try {
      res.write(data);
      delivered += 1;
    } catch {
      unsubscribeRecipient(role, id, res);
    }
  }
  return delivered;
}

export function clearRecipientSubscribers() {
  for (const [, set] of recipientSubscribers) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        // ignore — test/closed sockets.
      }
    }
  }
  recipientSubscribers.clear();
}

// Public row shape (no tokens, no PII beyond booking ref + timestamps).
export function toPublicNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    booking_id: row.booking_id,
    read_at: row.read_at ?? null,
    created_at: row.created_at,
  };
}

export async function queueNotification({ role, recipientId, bookingId, type }) {
  try {
    if (!RECIPIENT_ROLES.includes(role) || !NOTIF_TYPES.includes(type)) return null;
    if (!recipientId || !bookingId) return null;
    const { title, body } = templateFor(type, bookingId);
    const res = await query(
      `INSERT INTO notifications (recipient_role, recipient_id, booking_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (booking_id, recipient_role, recipient_id, type) DO NOTHING
       RETURNING id, type, title, body, booking_id, read_at, created_at`,
      [role, recipientId, bookingId, type, title, body, JSON.stringify({ booking_id: bookingId })],
    );
    if (res.rowCount === 0) return null; // duplicate (retry/replay) — no second row.
    const event = toPublicNotification(res.rows[0]);
    publishRecipient(role, recipientId, 'notification', event);
    // Phase-2 push: best-effort, never blocks, no-ops without FCM_* secrets.
    pushToOwner(role, recipientId, { title, body, data: { booking_id: bookingId } }).catch(() => {});
    return event;
  } catch (err) {
    console.error('[notify] queue fail:', err.message);
    return null;
  }
}

export async function listNotifications(role, id, { limit = 20, before = null } = {}) {
  const params = [role, id];
  let sql = `SELECT id, type, title, body, booking_id, read_at, created_at
             FROM notifications WHERE recipient_role = $1 AND recipient_id = $2`;
  if (before) {
    params.push(before);
    sql += ` AND created_at < $${params.length}`;
  }
  params.push(limit);
  // seq (SERIAL) breaks same-millisecond ties deterministically.
  sql += ` ORDER BY seq DESC LIMIT $${params.length}`;
  const res = await query(sql, params);
  return res.rows.map(toPublicNotification);
}

export async function unreadCount(role, id) {
  const res = await query(
    'SELECT COUNT(*) AS n FROM notifications WHERE recipient_role = $1 AND recipient_id = $2 AND read_at IS NULL',
    [role, id],
  );
  return Number(res.rows[0].n);
}

export async function markRead(role, id, notifId) {
  const res = await query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND recipient_role = $2 AND recipient_id = $3 AND read_at IS NULL`,
    [notifId, role, id],
  );
  return res.rowCount;
}

export async function markAllRead(role, id) {
  const res = await query(
    `UPDATE notifications SET read_at = now()
     WHERE recipient_role = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [role, id],
  );
  return res.rowCount;
}

export async function notificationsSince(role, id, since) {
  const res = await query(
    `SELECT id, type, title, body, booking_id, read_at, created_at
     FROM notifications WHERE recipient_role = $1 AND recipient_id = $2 AND created_at > $3
     ORDER BY seq ASC LIMIT 50`,
    [role, id, since],
  );
  return res.rows.map(toPublicNotification);
}
