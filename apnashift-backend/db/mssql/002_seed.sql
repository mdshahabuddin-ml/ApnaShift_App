-- ApnaShift MS SQL Server seed (idempotent — safe to re-run).
-- Mirrors db/seed.sql (pricing) + migration 013 (commission default).
-- Run: npm run db:migrate:mssql

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Pickup')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent)
  VALUES ('Pickup', 350, 17.5, 200, 15);

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Mini Truck')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent)
  VALUES ('Mini Truck', 600, 22.5, 200, 15);

IF NOT EXISTS (SELECT 1 FROM pricing_rules WHERE vehicle_type = 'Mini Tractor')
  INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs, commission_percent)
  VALUES ('Mini Tractor', 1000, 30, 200, 15);

IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE [key] = 'commission')
  INSERT INTO platform_settings ([key], value) VALUES ('commission', '{"pct": 15.00}');
