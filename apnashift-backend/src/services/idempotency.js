// Idempotency-Key support (POST /api/bookings, Option A: separate DB-backed table).
// Header is optional. When sent, first success replays within (user_id, key) scope.
// Same key + different payload returns 422 idempotency_conflict. Bad format is 400.
import crypto from 'node:crypto';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Extract key from header: absent/blank -> null (normal flow).
// Invalid format -> 400 invalid_idempotency_key.
export function parseIdempotencyKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  if (key === '') return null;
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    const err = new Error('invalid_idempotency_key');
    err.status = 400;
    throw err;
  }
  return key;
}

// Stable hash to detect payload changes on replay.
// Only booking-intent fields (not price/distance — server computes those).
export function hashBookingRequest({
  pickup,
  drop,
  vehicle_type,
  helper_needed,
  item_description,
  scheduled_time,
}) {
  const canonical = JSON.stringify({
    pickup,
    drop,
    vehicle_type,
    helper_needed,
    item_description: item_description ?? '',
    scheduled_time: scheduled_time ?? null,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
