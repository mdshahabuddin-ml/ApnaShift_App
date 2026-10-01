// Price calculation. Pure functions — no DB/provider here.
// Rates always come from pricing_rules table (see route), never hardcoded.
import { getDistanceKm } from './distance.js';

// Single-city MVP: no bookings over 500 km (DB CHECK is the backup,
// rejected here with 400 for a clean client error).
export const MAX_DISTANCE_KM = 500;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function round10(n) {
  return Math.round(Number(n) / 10) * 10;
}

// distanceKm >= 0. Total to nearest Rs 10, range is -10% / +10% of total.
export function computeQuote({ distanceKm, baseRs, perKmRs, helperRs, helperNeeded }) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const base_fare = round2(baseRs);
  const distance_fare = round2(Number(perKmRs) * km);
  const helper_charge = helperNeeded ? round2(helperRs) : 0;
  const total = round10(base_fare + distance_fare + helper_charge);
  return {
    distance_km: round2(km),
    base_fare,
    distance_fare,
    helper_charge,
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
    }),
  };
}
