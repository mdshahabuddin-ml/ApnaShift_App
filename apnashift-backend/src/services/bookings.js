// Booking creation core shared by the HTTP route and the WhatsApp webhook.
// Moved verbatim from routes/bookings.js (estimate -> snapshot -> INSERT):
// same queries, same order, same values. HTTP concerns (validation,
// idempotency, mapping, events) stay in the routes.
import { query } from '../db.js';
import { buildEstimate } from './pricing.js';
import { getCommissionPct } from './payments.js';
import { assertBookingsAllowed } from './announcements.js';
import { VEHICLE_TO_DB } from '../validation/auth.js';

export async function ratesFor(vehicleType) {
  const found = await query(
    `SELECT base_rs, per_km_rs, helper_rs, minimum_fare,
            size_small_extra, size_big_extra,
            weight_0_100, weight_100_300, weight_300_500, weight_500_plus
       FROM pricing_rules WHERE vehicle_type = $1`,
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
      minimumFare: Number(rule.minimum_fare ?? 0),
      sizeSmallExtra: Number(rule.size_small_extra ?? 0),
      sizeBigExtra: Number(rule.size_big_extra ?? 0),
      weight0100: Number(rule.weight_0_100 ?? 0),
      weight100300: Number(rule.weight_100_300 ?? 0),
      weight300500: Number(rule.weight_300_500 ?? 0),
      weight500plus: Number(rule.weight_500_plus ?? 0),
    },
  };
}

// Single place that mints a booking row. runQuery is either the pool query
// fn (plain create) or a transaction client's bound query (keyed create).
// source defaults to WEB; WhatsApp passes WHATSAPP. Returns the raw row.
// Old bookings keep their price_rs snapshot — rate changes never rewrite rows.
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
    vehicleSizeTier = 'chhota',
    goodsWeightKg = 0,
    itemCount = 1,
    hasBulkyItem = false,
  },
) {
  // Maintenance mode: block EVERY writer (HTTP route has the middleware
  // too — this covers WhatsApp + future callers at the single choke point).
  await assertBookingsAllowed();
  const estimate = await buildEstimate({
    pickup: { lat: pickup.lat, lng: pickup.lng },
    drop: { lat: drop.lat, lng: drop.lng },
    vehicleType,
    helperNeeded,
    vehicleSizeTier,
    goodsWeightKg,
    itemCount,
    hasBulkyItem,
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
         commission_percent, booking_source,
         vehicle_size_tier, goods_weight_kg, item_count, has_bulky_item)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending', $14, $15, $16,
               $17, $18, $19, $20)
       RETURNING id, user_id, driver_id, pickup_address, pickup_lat, pickup_lng,
         drop_address, drop_lat, drop_lng, vehicle_type, helper, item_description,
         scheduled_at, delivered_at, distance_km, price_rs, status, created_at, updated_at,
         cancel_reason, cancelled_by, cancelled_at, payment_method,
         commission_percent, booking_source, disputed, dispute_reason,
         vehicle_size_tier, goods_weight_kg, item_count, has_bulky_item`,
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
      vehicleSizeTier,
      goodsWeightKg,
      itemCount,
      hasBulkyItem,
    ],
  );
  return inserted.rows[0];
}
