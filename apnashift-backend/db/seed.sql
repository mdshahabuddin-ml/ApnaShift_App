-- ApnaShift pricing seed. Run after schema:
--   npm run db:migrate   (runs both schema + seed)
-- Or directly: psql $env:DATABASE_URL -f db/seed.sql
--
-- Quote formula (023, quote API computes from this):
--   raw = base_rs + per_km_rs * distance_km + size_extra + weight_slab
--       + (bulky ? 100 : 0) + max(0, item_count-5)*20 + (helper ? helper_rs : 0)
--   total = round10(MAX(minimum_fare, raw))
--
-- ONLY-IF-NOT-EXISTS: inserts defaults once, on re-migrate
-- does not overwrite custom rates (DO NOTHING, no DO UPDATE).
-- Existing DBs get new fares via migration 023 (UPDATE base/minimum).

INSERT INTO pricing_rules
  (vehicle_type, base_rs, per_km_rs, helper_rs, minimum_fare,
   size_small_extra, size_big_extra,
   weight_0_100, weight_100_300, weight_300_500, weight_500_plus) VALUES
  ('Pickup', 250, 17.5, 200, 250, 0, 0, 0, 0, 0, 0),
  ('Mini Truck', 450, 22.5, 200, 450, 0, 0, 0, 0, 0, 0),
  ('Mini Tractor', 750, 30, 200, 750, 0, 0, 0, 0, 0, 0)
ON CONFLICT (vehicle_type) DO NOTHING;
