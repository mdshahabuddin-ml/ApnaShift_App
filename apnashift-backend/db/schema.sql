-- ApnaShift MVP schema (one city). PostgreSQL.
-- Table names fixed hain, bina pooche mat badalna:
-- users, drivers, bookings, ratings, pricing_rules, admins,
-- audit_logs, pricing_history, idempotency_keys.
--
-- Ye file canonical hai — db/migrations/* ke saath match karti hai.
-- Fresh DB: ye file kaafi hai (saare columns/indexes/triggers included).
-- Existing DB: npm run db:migrate chalao (ye file + migrations order me,
-- sab IF NOT EXISTS / DROP IF EXISTS, isliye dobara chalana safe hai).
--
-- Run (migrate script se, recommended):
--   npm run db:migrate
-- Ya seedha psql se:
--   PowerShell: psql $env:DATABASE_URL -f db/schema.sql
--   Bash:       psql "$DATABASE_URL" -f db/schema.sql
-- Uske baad seed: db/seed.sql (pricing rules).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- App users (customers). Driver onboarding manual hai, isliye drivers alag table.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 80),
  phone VARCHAR(15) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drivers (manual onboarding; is_verified staff set karta hai).
-- avg_rating/needs_review ratings-trigger se (003), total_trips bookings-trigger
-- se bhi sync hota hai (008) taaki bina rating ke delivered count sahi rahe.
-- rejection_reason reject par wajah, verify par NULL (004 dekho).
CREATE TABLE IF NOT EXISTS drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 80),
  phone VARCHAR(15) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  password_hash TEXT NOT NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  vehicle_number TEXT NOT NULL CHECK (char_length(vehicle_number) >= 4 AND char_length(vehicle_number) <= 20),
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  avg_rating NUMERIC(3, 2),
  total_trips INTEGER NOT NULL DEFAULT 0,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bookings (ek user, optional driver, ek gaadi type).
-- Status machine: pending -> accepted -> arrived -> in_transit -> delivered (+ cancelled).
-- pickup/drop lat-lng + item_description 002 me aaye (purani rows me NULL/'' ho sakta hai).
-- distance_km ek sheher ke liye 0 < d <= 500 (app me 400 distance_too_far, DB CHECK backup).
-- delivered_at 007 me aaya: sirf delivered par set (backfill: updated_at/created_at),
-- invariant delivered <=> delivered_at NOT NULL (CHECK neeche).
CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  driver_id UUID REFERENCES drivers (id) ON DELETE SET NULL,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  pickup_address TEXT NOT NULL CHECK (char_length(pickup_address) >= 3 AND char_length(pickup_address) <= 300),
  drop_address TEXT NOT NULL CHECK (char_length(drop_address) >= 3 AND char_length(drop_address) <= 300),
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  drop_lat DOUBLE PRECISION,
  drop_lng DOUBLE PRECISION,
  item_description TEXT NOT NULL DEFAULT '',
  distance_km NUMERIC(8, 2) NOT NULL CHECK (distance_km > 0 AND distance_km <= 500),
  helper BOOLEAN NOT NULL DEFAULT FALSE,
  price_rs NUMERIC(10, 2) NOT NULL CHECK (price_rs >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'arrived', 'in_transit', 'delivered', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_delivered_at_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_bookings_user_id ON bookings (user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_id ON bookings (driver_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings (status);
-- 005: common queries par composite indexes.
CREATE INDEX IF NOT EXISTS idx_bookings_available
  ON bookings (status, vehicle_type, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_created
  ON bookings (driver_id, created_at DESC);
-- 007 ke indexes (driver_delivered, delivered_at) yahan nahi — migration me hain.
-- Wajah: schema.sql purani DB par bhi dobara chalta hai (IF NOT EXISTS);
-- delivered_at column wahan tab tak nahi hota jab tak 007 na chale,
-- isliye us column par index sirf 007 banata hai (migrate.js use hamesha chalata hai).

-- updated_at auto-refresh trigger (bookings ke liye).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_updated_at ON bookings;
CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Ratings (ek booking par ek rating).
CREATE TABLE IF NOT EXISTS ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  stars INTEGER NOT NULL CHECK (stars >= 1 AND stars <= 5),
  comment TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ratings_driver_id ON ratings (driver_id);

-- 003: driver stats trigger (avg_rating/total_trips/needs_review).
-- needs_review TRUE jab ratings >= 5 AUR avg < 3.0. Auto-ban nahi.
CREATE OR REPLACE FUNCTION refresh_driver_stats()
RETURNS TRIGGER AS $$
DECLARE
  did UUID;
  r_count INTEGER;
  r_avg NUMERIC;
  trips INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    did := OLD.driver_id;
  ELSE
    did := NEW.driver_id;
  END IF;

  SELECT COUNT(*), ROUND(AVG(stars), 2) INTO r_count, r_avg
  FROM ratings WHERE driver_id = did;

  SELECT COUNT(*) INTO trips
  FROM bookings WHERE driver_id = did AND status = 'delivered';

  UPDATE drivers
  SET avg_rating = r_avg,
      total_trips = trips,
      needs_review = (r_count >= 5 AND COALESCE(r_avg, 5) < 3.0)
  WHERE id = did;

  IF TG_OP = 'UPDATE' AND OLD.driver_id IS DISTINCT FROM NEW.driver_id THEN
    SELECT COUNT(*), ROUND(AVG(stars), 2) INTO r_count, r_avg
    FROM ratings WHERE driver_id = OLD.driver_id;
    SELECT COUNT(*) INTO trips
    FROM bookings WHERE driver_id = OLD.driver_id AND status = 'delivered';
    UPDATE drivers
    SET avg_rating = r_avg,
        total_trips = trips,
        needs_review = (r_count >= 5 AND COALESCE(r_avg, 5) < 3.0)
    WHERE id = OLD.driver_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ratings_refresh ON ratings;
CREATE TRIGGER trg_ratings_refresh
  AFTER INSERT OR UPDATE OR DELETE ON ratings
  FOR EACH ROW
  EXECUTE FUNCTION refresh_driver_stats();

-- 008: driver total_trips trigger (bookings delivered par).
-- refresh_driver_stats sirf ratings par chalta hai, isliye bina rating ke
-- delivered bookings ka total_trips stale rehta tha. Ye trigger bookings ke
-- driver_id/status change par total_trips ko delivered count se sync karta hai.
-- avg_rating/needs_review ratings-trigger ke paas rehte hain (yahan untouched).
CREATE OR REPLACE FUNCTION sync_driver_trips()
RETURNS TRIGGER AS $$
DECLARE
  did UUID;
  old_did UUID;
  trips INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    did := OLD.driver_id;
    IF did IS NOT NULL THEN
      SELECT COUNT(*) INTO trips
      FROM bookings WHERE driver_id = did AND status = 'delivered';
      UPDATE drivers SET total_trips = trips WHERE id = did;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    did := NEW.driver_id;
    IF did IS NOT NULL THEN
      SELECT COUNT(*) INTO trips
      FROM bookings WHERE driver_id = did AND status = 'delivered';
      UPDATE drivers SET total_trips = trips WHERE id = did;
    END IF;
    RETURN NEW;
  ELSE
    -- UPDATE: driver ya status badla tabhi recount (faltu writes nahi).
    IF NEW.driver_id IS DISTINCT FROM OLD.driver_id
      OR NEW.status IS DISTINCT FROM OLD.status THEN
      IF NEW.driver_id IS NOT NULL THEN
        SELECT COUNT(*) INTO trips
        FROM bookings WHERE driver_id = NEW.driver_id AND status = 'delivered';
        UPDATE drivers SET total_trips = trips WHERE id = NEW.driver_id;
      END IF;
      old_did := OLD.driver_id;
      IF old_did IS NOT NULL AND old_did IS DISTINCT FROM NEW.driver_id THEN
        SELECT COUNT(*) INTO trips
        FROM bookings WHERE driver_id = old_did AND status = 'delivered';
        UPDATE drivers SET total_trips = trips WHERE id = old_did;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_bookings_trips ON bookings;
CREATE TRIGGER trg_bookings_trips
  AFTER INSERT OR UPDATE OF driver_id, status OR DELETE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION sync_driver_trips();

-- Pricing rules (seed: db/seed.sql). Quote formula:
--   total = base_rs + per_km_rs * distance_km + (helper ? helper_rs : 0)
CREATE TABLE IF NOT EXISTS pricing_rules (
  id SERIAL PRIMARY KEY,
  vehicle_type TEXT NOT NULL UNIQUE CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  base_rs NUMERIC(10, 2) NOT NULL CHECK (base_rs >= 0),
  per_km_rs NUMERIC(10, 2) NOT NULL CHECK (per_km_rs >= 0),
  helper_rs NUMERIC(10, 2) NOT NULL DEFAULT 200 CHECK (helper_rs >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admins (staff login; manual insert).
CREATE TABLE IF NOT EXISTS admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 80),
  phone VARCHAR(15) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 004: audit log (kaunse admin ne kya kiya) + pricing history.
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_admin ON audit_logs (admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS pricing_history (
  id SERIAL PRIMARY KEY,
  vehicle_type TEXT NOT NULL,
  old_base_rs NUMERIC(10, 2),
  old_per_km_rs NUMERIC(10, 2),
  old_helper_rs NUMERIC(10, 2),
  new_base_rs NUMERIC(10, 2) NOT NULL,
  new_per_km_rs NUMERIC(10, 2) NOT NULL,
  new_helper_rs NUMERIC(10, 2) NOT NULL,
  changed_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_hist_vehicle ON pricing_history (vehicle_type);

-- 006: idempotency keys (POST /api/bookings, Option A: alag table, per-user scope).
-- booking insert + key insert ek transaction me (route dekho). Expiry nahi (MVP).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (char_length(key) >= 1 AND char_length(key) <= 64),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_booking ON idempotency_keys (booking_id);
