-- ApnaShift pricing seed. Run after schema:
--   npm run db:migrate   (runs both schema + seed)
-- Or directly: psql $env:DATABASE_URL -f db/seed.sql
--
-- Quote formula (quote API computes from this):
--   total = base_rs + per_km_rs * distance_km + (helper ? helper_rs : 0)
--
-- ONLY-IF-NOT-EXISTS: inserts defaults once, on re-migrate
-- does not overwrite custom rates (DO NOTHING, no DO UPDATE).

INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs) VALUES
  ('Pickup', 350, 17.5, 200),
  ('Mini Truck', 600, 22.5, 200),
  ('Mini Tractor', 1000, 30, 200)
ON CONFLICT (vehicle_type) DO NOTHING;
