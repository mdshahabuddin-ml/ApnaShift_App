// Booking creation core shared by the HTTP route and the WhatsApp webhook.
// Moved verbatim from routes/bookings.js (estimate -> snapshot -> INSERT):
// same queries, same order, same values. HTTP concerns (validation,
// idempotency, mapping, events) stay in the routes.
import { query } from '../db.js';
import { buildEstimate } from './pricing.js';
import { getCommissionPct } from './payments.js';
import { VEHICLE_TO_DB } from '../validation/auth.js';

export async function ratesFor(vehicleType) {
  const found = await query(
    'SELECT base_rs, per_km_rs, helper_rs FROM pricing_rules WHERE vehicle_type = $1',
    [VEHICLE_TO_DB[vehicleType]],
  );
  if (found.rowCount === 0) {
    const err = new Error('unknown_vehicle');
    err.status = 400;
    throw err;
  }
  const rule = found.rows[0];
  return {
    [vehicleType]: {
      baseRs: Number(rule.base_rs),
      perKmRs: Number(rule.per_km_rs),
      helperRs: Number(rule.helper_rs),
    },
  };
}

// Single place that mints a booking row. runQuery is either the pool query
// fn (plain create) or a transaction client's bound query (keyed create).
// source defaults to WEB; WhatsApp passes WHATSAPP. Returns the raw row.
export async function createBookingRow(
  runQuery,
  {
    userId,
    vehicleType,
    pickup,
    drop,
    helperNeeded,
    itemDescription,
    scheduledAt,
    paymentMethod,
    source = 'WEB',
  },
) {
  const estimate = await buildEstimate({
    pickup: { lat: pickup.lat, lng: pickup.lng },
    drop: { lat: drop.lat, lng: drop.lng },
    vehicleType,
    helperNeeded,
    rates: await ratesFor(vehicleType),
  });

  // CORE RULE: commission snapshot from creation-time pricing_rules —
  // later rate changes never touch old bookings.
  const rateRow = await query(
    'SELECT commission_percent FROM pricing_rules WHERE vehicle_type = $1',
    [VEHICLE_TO_DB[vehicleType]],
  );
  const snapshotPct =
    rateRow.rowCount > 0 && rateRow.rows[0].commission_percent !== null
      ? Number(rateRow.rows[0].commission_percent)
      : await getCommissionPct();

  const inserted = await runQuery(
    `INSERT INTO bookings
        (user_id, vehicle_type, pickup_address, pickup_lat, pickup_lng,
         drop_address, drop_lat, drop_lng, distance_km, helper,
         item_description, scheduled_at, price_rs, status, payment_method,
         commission_percent, booking_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14, $15, $16)
       RETURNING id, user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
         drop_address, drop_lat, drop_lng, vehicle_type, helper, item_description,
         scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at,
         cancel_reason, cancelled_by, cancelled_at, payment_method,
         commission_percent, booking_source, disputed, dispute_reason`,
    [
      userId,
      VEHICLE_TO_DB[vehicleType],
      pickup.address,
      pickup.lat,
      pickup.lng,
      drop.address,
      drop.lat,
      drop.lng,
      estimate.distance_km,
      helperNeeded,
      itemDescription,
      scheduledAt ? new Date(scheduledAt) : null,
      estimate.total,
      paymentMethod,
      snapshotPct,
      source,
    ],
  );
  return inserted.rows[0];
}
