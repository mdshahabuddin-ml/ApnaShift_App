-- ApnaShift pricing seed. Schema ke baad chalao:
--   npm run db:migrate   (schema + seed dono chalata hai)
-- Ya seedha: psql $env:DATABASE_URL -f db/seed.sql
--
-- Quote formula (quote API isi se ginata hai):
--   total = base_rs + per_km_rs * distance_km + (helper ? helper_rs : 0)
--
-- ONLY-IF-NOT-EXISTS: pehli baar defaults dalta hai, dobara migrate par
-- custom rates overwrite nahi karta (DO NOTHING, DO UPDATE nahi).

INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs) VALUES
  ('Pickup', 350, 17.5, 200),
  ('Mini Truck', 600, 22.5, 200),
  ('Mini Tractor', 1000, 30, 200)
ON CONFLICT (vehicle_type) DO NOTHING;
