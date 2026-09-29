// Idempotency-Key support (POST /api/bookings, Option A: DB-backed alag table).
// Header optional hai. Bhejo to scope (user_id, key) me pehli success replay hoti hai.
// Same key + alag payload par 422 idempotency_conflict. Format galat par 400.
import crypto from 'node:crypto';

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Header se key nikalo: absent/blank -> null (normal flow).
// Galat format -> 400 invalid_idempotency_key.
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

// Replay me payload badla ya nahi, ye pakadne ke liye stable hash.
// Sirf booking intent wale fields (price/distance nahi — wo server ginata hai).
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
