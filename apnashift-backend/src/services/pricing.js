// Price calculation. Pure functions — no DB/provider here.
// Rates always come from pricing_rules table (see route), never hardcoded.
// Formula (023):
//   raw = base + distance*rate + size_extra + weight_slab
//       + (bulky ? 100 : 0) + max(0, item_count-5)*20 + (helper ? helper_rs : 0)
//   total = round10(MAX(minimum_fare, raw))
// Weight slabs (kg): <=100 -> weight_0_100, <=300 -> weight_100_300,
// <=500 -> weight_300_500, >500 -> weight_500_plus.
// Size tiers: 'chhota' -> size_small_extra, 'bada' -> size_big_extra.
import { getDistanceKm } from './distance.js';

// Single-city MVP: no bookings over 500 km (DB CHECK is the backup,
// rejected here with 400 for a clean client error).
export const MAX_DISTANCE_KM = 500;

// Formula constants (spec-fixed, not admin-editable):
// bulky item surcharge + per-item charge beyond 5 items.
export const BULKY_CHARGE_RS = 100;
export const EXTRA_ITEM_CHARGE_RS = 20;
export const FREE_ITEM_COUNT = 5;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function round10(n) {
  return Math.round(Number(n) / 10) * 10;
}

export function weightSlabCharge(weightKg, rule) {
  const w = Math.max(0, Number(weightKg) || 0);
  if (w <= 100) return round2(rule.weight0100 ?? rule.weight_0_100 ?? 0);
  if (w <= 300) return round2(rule.weight100300 ?? rule.weight_100_300 ?? 0);
  if (w <= 500) return round2(rule.weight300500 ?? rule.weight_300_500 ?? 0);
  return round2(rule.weight500plus ?? rule.weight_500_plus ?? 0);
}

export function sizeCharge(sizeTier, rule) {
  if (sizeTier === 'bada') return round2(rule.sizeBigExtra ?? rule.size_big_extra ?? 0);
  return round2(rule.sizeSmallExtra ?? rule.size_small_extra ?? 0);
}

// distanceKm >= 0. Total to nearest Rs 10, range is -10% / +10% of total.
export function computeQuote({
  distanceKm,
  baseRs,
  perKmRs,
  helperRs,
  helperNeeded,
  minimumFare = 0,
  sizeSmallExtra = 0,
  sizeBigExtra = 0,
  weight0100 = 0,
  weight100300 = 0,
  weight300500 = 0,
  weight500plus = 0,
  weight_0_100,
  weight_100_300,
  weight_300_500,
  weight_500_plus,
  size_small_extra,
  size_big_extra,
  vehicleSizeTier = 'chhota',
  goodsWeightKg = 0,
  itemCount = 1,
  hasBulkyItem = false,
}) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const rule = {
    size_small_extra: size_small_extra ?? sizeSmallExtra ?? 0,
    size_big_extra: size_big_extra ?? sizeBigExtra ?? 0,
    weight_0_100: weight_0_100 ?? weight0100 ?? 0,
    weight_100_300: weight_100_300 ?? weight100300 ?? 0,
    weight_300_500: weight_300_500 ?? weight300500 ?? 0,
    weight_500_plus: weight_500_plus ?? weight500plus ?? 0,
  };
  const base_fare = round2(baseRs);
  const distance_fare = round2(Number(perKmRs) * km);
  const size_charge = sizeCharge(vehicleSizeTier, rule);
  const weight_charge = weightSlabCharge(goodsWeightKg, rule);
  const bulky_charge = hasBulkyItem ? BULKY_CHARGE_RS : 0;
  const count = Math.max(1, Math.min(100, Math.trunc(Number(itemCount) || 1)));
  const items_charge = Math.max(0, count - FREE_ITEM_COUNT) * EXTRA_ITEM_CHARGE_RS;
  const helper_charge = helperNeeded ? round2(helperRs) : 0;
  const minimum_fare = round2(minimumFare);
  const raw = base_fare + distance_fare + size_charge + weight_charge + bulky_charge + items_charge + helper_charge;
  const total = round10(Math.max(minimum_fare, raw));
  return {
    distance_km: round2(km),
    base_fare,
    distance_fare,
    size_charge,
    weight_charge,
    bulky_charge,
    items_charge,
    helper_charge,
    minimum_fare,
    total,
    estimate_min: round10(total * 0.9),
    estimate_max: round10(total * 1.1),
  };
}

// Full estimate: pass a real provider via measure, or a mock fn in tests.
export async function buildEstimate({
  pickup,
  drop,
  vehicleType,
  helperNeeded,
  rates,
  vehicleSizeTier = 'chhota',
  goodsWeightKg = 0,
  itemCount = 1,
  hasBulkyItem = false,
  measure = getDistanceKm,
}) {
  const rule = rates[vehicleType];
  if (!rule) {
    const err = new Error('unknown_vehicle');
    err.status = 400;
    throw err;
  }
  const km = await measure(pickup, drop);
  if (round2(km) > MAX_DISTANCE_KM) {
    const err = new Error('distance_too_far');
    err.status = 400;
    throw err;
  }
  return {
    vehicle_type: vehicleType,
    ...computeQuote({
      distanceKm: km,
      baseRs: rule.baseRs,
      perKmRs: rule.perKmRs,
      helperRs: rule.helperRs,
      helperNeeded,
      minimumFare: rule.minimumFare ?? rule.minimum_fare ?? 0,
      size_small_extra: rule.sizeSmallExtra ?? rule.size_small_extra ?? 0,
      size_big_extra: rule.sizeBigExtra ?? rule.size_big_extra ?? 0,
      weight_0_100: rule.weight0100 ?? rule.weight_0_100 ?? 0,
      weight_100_300: rule.weight100300 ?? rule.weight_100_300 ?? 0,
      weight_300_500: rule.weight300500 ?? rule.weight_300_500 ?? 0,
      weight_500_plus: rule.weight500plus ?? rule.weight_500_plus ?? 0,
      vehicleSizeTier,
      goodsWeightKg,
      itemCount,
      hasBulkyItem,
    }),
  };
}
