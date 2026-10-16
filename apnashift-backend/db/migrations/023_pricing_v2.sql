-- Migration 023: pricing v2 — new base/minimum fares + admin-editable
-- vehicle size tiers (chhota/bada) + weight slabs (0-100/100-300/300-500/500+).
-- All additive (IF NOT EXISTS); old bookings untouched (price_rs snapshot).
-- New fares: Pickup base 250/min 250, Mini Truck base 450/min 450,
-- Mini Tractor base 750/min 750. per_km unchanged (17.5/22.5/30).

-- 1. pricing_rules: new columns (admin-editable, never hardcoded).
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS minimum_fare NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS size_small_extra NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS size_big_extra NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS weight_0_100 NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS weight_100_300 NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS weight_300_500 NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE pricing_rules ADD COLUMN IF NOT EXISTS weight_500_plus NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_minimum_fare_ck') THEN
    ALTER TABLE pricing_rules ADD CONSTRAINT pricing_minimum_fare_ck CHECK (minimum_fare >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_size_extra_ck') THEN
    ALTER TABLE pricing_rules ADD CONSTRAINT pricing_size_extra_ck CHECK (
      size_small_extra >= 0 AND size_big_extra >= 0
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_weight_slab_ck') THEN
    ALTER TABLE pricing_rules ADD CONSTRAINT pricing_weight_slab_ck CHECK (
      weight_0_100 >= 0 AND weight_100_300 >= 0 AND weight_300_500 >= 0 AND weight_500_plus >= 0
    );
  END IF;
END
$$;

-- 2. New base + minimum fares (per_km untouched).
UPDATE pricing_rules SET base_rs = 250, minimum_fare = 250 WHERE vehicle_type = 'Pickup';
UPDATE pricing_rules SET base_rs = 450, minimum_fare = 450 WHERE vehicle_type = 'Mini Truck';
UPDATE pricing_rules SET base_rs = 750, minimum_fare = 750 WHERE vehicle_type = 'Mini Tractor';

-- 3. bookings: store pricing inputs per booking (audit; old rows get safe defaults).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS vehicle_size_tier TEXT NOT NULL DEFAULT 'chhota';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS goods_weight_kg NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS item_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS has_bulky_item BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_size_tier_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_size_tier_ck CHECK (
      vehicle_size_tier IN ('chhota', 'bada')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_weight_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_weight_ck CHECK (
      goods_weight_kg >= 0 AND goods_weight_kg <= 5000
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_item_count_ck') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_item_count_ck CHECK (
      item_count >= 1 AND item_count <= 100
    );
  END IF;
END
$$;

-- 4. pricing_history: track new fields (nullable so old history rows stay valid).
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_minimum_fare NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_minimum_fare NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_size_small_extra NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_size_small_extra NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_size_big_extra NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_size_big_extra NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_weight_0_100 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_weight_0_100 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_weight_100_300 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_weight_100_300 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_weight_300_500 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_weight_300_500 NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS old_weight_500_plus NUMERIC(10, 2);
ALTER TABLE pricing_history ADD COLUMN IF NOT EXISTS new_weight_500_plus NUMERIC(10, 2);
