// Live tracking helpers: lifecycle gate, stale/offline computation,
// per-driver post throttle, and the in-memory SSE fan-out hub.
//
// Real-time architecture (single instance, zero new dependencies):
//   driver POST /api/driver/bookings/:id/location
//     -> INSERT driver_locations (+ here: hub.publish)
//     -> SSE subscribers on GET /api/bookings/:id/location/stream
//        receive `event: location` within the same process.
// Customer/admin UIs additionally poll GET .../location every ~10s as a
// fallback (SSE drops on flaky mobile networks).
// NOTE: hub is in-memory — multi-instance deploy would need Redis.
// Localhost/dev runs a single instance, so this is correct here.

import { config } from '../config.js';

// Booking statuses during which GPS sharing is allowed. Anything else
// (pending = not assigned yet, delivered/cancelled = trip over) rejects
// driver posts with 409 tracking_not_active — tracking auto starts/stops
// with the lifecycle, no explicit start/stop calls needed.
export const TRACKING_ACTIVE_STATUSES = ['accepted', 'arrived', 'in_transit'];

export function isTrackingActiveStatus(status) {
  return TRACKING_ACTIVE_STATUSES.includes(status);
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Read per-request so tests can tune via env without re-importing.
export function minIntervalMs() {
  return numEnv('TRACK_MIN_INTERVAL_MS', config.trackMinIntervalMs);
}

export function staleAfterMs() {
  return numEnv('TRACK_STALE_AFTER_MS', config.trackStaleAfterMs);
}

export function offlineAfterMs() {
  return numEnv('TRACK_OFFLINE_AFTER_MS', config.trackOfflineAfterMs);
}

// Badge state from newest point age + booking status. Never invented:
// no point -> offline (with points_count 0 so UI can say "not shared yet").
export function trackingState({ bookingStatus, recordedAt, now = Date.now() }) {
  if (bookingStatus === 'delivered' || bookingStatus === 'cancelled') return 'ended';
  if (!recordedAt) return 'offline';
  const ageMs = now - new Date(recordedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'live';
  if (ageMs <= staleAfterMs()) return 'live';
  if (ageMs <= offlineAfterMs()) return 'stale';
  return 'offline';
}

// ---- Per-driver post throttle (abuse + GPS-spam guard) ----
// Key: `${driverId}:${bookingId}` -> last accepted post epoch ms.
const lastPostAt = new Map();

export function checkThrottle(driverId, bookingId, now = Date.now()) {
  const key = `${driverId}:${bookingId}`;
  const prev = lastPostAt.get(key);
  const gap = minIntervalMs();
  if (prev !== undefined && now - prev < gap) {
    return { allowed: false, retryAfterMs: gap - (now - prev) };
  }
  lastPostAt.set(key, now);
  // Opportunistic cleanup so the map cannot grow forever.
  if (lastPostAt.size > 10000) {
    const cutoff = now - 10 * 60 * 1000;
    for (const [k, t] of lastPostAt) {
      if (t < cutoff) lastPostAt.delete(k);
    }
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function clearThrottle() {
  lastPostAt.clear();
}

// ---- SSE fan-out hub ----
const subscribers = new Map(); // bookingId -> Set<http.ServerResponse>

export function subscribe(bookingId, res) {
  let set = subscribers.get(bookingId);
  if (!set) {
    set = new Set();
    subscribers.set(bookingId, set);
  }
  set.add(res);
  return () => unsubscribe(bookingId, res);
}

export function unsubscribe(bookingId, res) {
  const set = subscribers.get(bookingId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) subscribers.delete(bookingId);
}

export function subscriberCount(bookingId) {
  return subscribers.get(bookingId)?.size ?? 0;
}

export function clearSubscribers() {
  for (const [, set] of subscribers) {
    for (const res of set) {
      try {
        res.end();
      } catch {
        // ignore — test/closed sockets.
      }
    }
  }
  subscribers.clear();
}

// Payload must already be the public, privacy-checked shape
// (no phones/hashes — only ids, coords, status, timestamps).
export function publish(bookingId, payload) {
  const set = subscribers.get(bookingId);
  if (!set || set.size === 0) return 0;
  const data = `event: location\ndata: ${JSON.stringify(payload)}\n\n`;
  let delivered = 0;
  for (const res of [...set]) {
    try {
      res.write(data);
      delivered += 1;
    } catch {
      unsubscribe(bookingId, res);
    }
  }
  return delivered;
}

// Public point shape for API responses (numbers as numbers).
export function toPublicPoint(row) {
  return {
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracy_m: row.accuracy_m === null || row.accuracy_m === undefined ? null : Number(row.accuracy_m),
    speed_mps: row.speed_mps === null || row.speed_mps === undefined ? null : Number(row.speed_mps),
    heading_deg:
      row.heading_deg === null || row.heading_deg === undefined ? null : Number(row.heading_deg),
    recorded_at: row.recorded_at,
  };
}
