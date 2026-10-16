-- ApnaShift MS SQL Server seed (idempotent — safe to re-run).
-- Mirrors db/seed.sql (pricing) + migration 013 (commission default).
-- Run: npm run db:migrate:mssql

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Pickup')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent, minimum_fare, size_small_extra, size_big_extra, weight_0_100, weight_100_300, weight_300_500, weight_500_plus)
  VALUES ('Pickup', 250, 17.5, 200, 15, 250, 0, 0, 0, 0, 0, 0);

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Mini Truck')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent, minimum_fare, size_small_extra, size_big_extra, weight_0_100, weight_100_300, weight_300_500, weight_500_plus)
  VALUES ('Mini Truck', 450, 22.5, 200, 15, 450, 0, 0, 0, 0, 0, 0);

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Mini Tractor')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent, minimum_fare, size_small_extra, size_big_extra, weight_0_100, weight_100_300, weight_300_500, weight_500_plus)
  VALUES ('Mini Tractor', 750, 30, 200, 15, 750, 0, 0, 0, 0, 0, 0);

IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE [key] = 'commission')
  INSERT INTO platform_settings ([key], value) VALUES ('commission', '{"pct": 15.00}');
