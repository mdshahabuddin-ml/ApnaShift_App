-- ApnaShift MVP schema (one city). PostgreSQL.
-- Table names are fixed, do not change without review:
-- users, drivers, bookings, ratings, pricing_rules, admins,
-- audit_logs, pricing_history, idempotency_keys.
--
-- This file is canonical — matches db/migrations/*.
-- Fresh DB: this file is sufficient (all columns/indexes/triggers included).
-- Existing DB: run npm run db:migrate (this file + migrations in order,
-- all IF NOT EXISTS / DROP IF EXISTS, so re-running is safe).
--
-- Run (via migrate script, recommended):
--   npm run db:migrate
-- Or directly via psql:
--   PowerShell: psql $env:DATABASE_URL -f db/schema.sql
--   Bash:       psql "$DATABASE_URL" -f db/schema.sql
-- Then seed: db/seed.sql (pricing rules).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- App users (customers). Driver onboarding is manual, so drivers use a separate table.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) >= 2 AND char_length(name) <= 80),
  phone VARCHAR(15) NOT NULL UNIQUE CHECK (phone ~ '^[6-9][0-9]{9}$'),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Drivers (manual onboarding; staff sets is_verified).
-- avg_rating/needs_review via ratings trigger (003), total_trips via bookings trigger
-- also synced (008) so delivered count stays correct without ratings.
-- rejection_reason holds the reason on reject, NULL on verify (see 004).
-- Extended profile columns come from Driver Partner Registration (009) —
-- included here for fresh installs, applied via migration 009 on existing DBs.
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
  email TEXT UNIQUE CHECK (email IS NULL OR (char_length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  dob DATE CHECK (dob IS NULL OR (dob <= CURRENT_DATE - INTERVAL '18 years' AND dob >= CURRENT_DATE - INTERVAL '100 years')),
  gender TEXT CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
  city TEXT CHECK (city IS NULL OR (char_length(city) BETWEEN 2 AND 120)),
  state TEXT CHECK (state IS NULL OR (char_length(state) BETWEEN 2 AND 80)),
  address TEXT CHECK (address IS NULL OR (char_length(address) BETWEEN 5 AND 500)),
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_year INTEGER CHECK (vehicle_year IS NULL OR (vehicle_year BETWEEN 1990 AND 2100)),
  capacity_kg INTEGER CHECK (capacity_kg IS NULL OR (capacity_kg >= 0 AND capacity_kg <= 50000)),
  fuel_type TEXT CHECK (fuel_type IS NULL OR fuel_type IN ('diesel', 'petrol', 'cng', 'electric', 'other')),
  ownership TEXT CHECK (ownership IS NULL OR ownership IN ('owned', 'financed', 'rented', 'other')),
  license_number TEXT UNIQUE,
  license_type TEXT,
  license_expiry DATE CHECK (license_expiry IS NULL OR license_expiry > CURRENT_DATE),
  license_state TEXT,
  rc_number TEXT,
  insurance_expiry DATE,
  pollution_expiry DATE,
  permit_number TEXT,
  service_city TEXT,
  service_state TEXT,
  service_areas TEXT,
  service_radius_km INTEGER CHECK (service_radius_km IS NULL OR (service_radius_km BETWEEN 1 AND 200)),
  emergency_name TEXT,
  emergency_relation TEXT,
  emergency_phone TEXT CHECK (emergency_phone IS NULL OR emergency_phone ~ '^[6-9][0-9]{9}$'),
  application_ref TEXT NOT NULL UNIQUE,
  consent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bookings (one user, optional driver, one vehicle type).
-- Status machine: pending -> accepted -> arrived -> in_transit -> delivered (+ cancelled).
-- pickup/drop lat-lng + item_description added in 002 (older rows may have NULL/'').
-- distance_km for one city is 0 < d <= 500 (app returns 400 distance_too_far, DB CHECK backup).
-- delivered_at added in 007: set only on delivered (backfill: updated_at/created_at),
-- invariant delivered <=> delivered_at NOT NULL (CHECK below).
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
-- 005: composite indexes for common queries.
CREATE INDEX IF NOT EXISTS idx_bookings_available
  ON bookings (status, vehicle_type, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_bookings_user_created
  ON bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_driver_created
  ON bookings (driver_id, created_at DESC);
-- Indexes from 007 (driver_delivered, delivered_at) are not here — they live in the migration.
-- Reason: schema.sql also re-runs on older DBs (IF NOT EXISTS);
-- the delivered_at column does not exist there until 007 runs,
-- so only 007 creates indexes on that column (migrate.js always runs it).

-- updated_at auto-refresh trigger (for bookings).
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

-- Ratings (one rating per booking).
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
-- needs_review is TRUE when ratings >= 5 AND avg < 3.0. No auto-ban.
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

-- 008: driver total_trips trigger (on delivered bookings).
-- refresh_driver_stats runs only on ratings, so delivered bookings
-- without ratings left total_trips stale. This trigger recounts
-- total_trips from the delivered count on driver_id/status changes.
-- avg_rating/needs_review stay with the ratings trigger (untouched here).
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
    -- UPDATE: recount only when driver or status changes (avoids extra writes).
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

-- 004: audit log (which admin did what) + pricing history.
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

-- 006: idempotency keys (POST /api/bookings, Option A: separate table, per-user scope).
-- booking + key inserts run in one transaction (see route). No expiry (MVP).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (char_length(key) >= 1 AND char_length(key) <= 64),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_booking ON idempotency_keys (booking_id);

-- 010: enterprise_inquiries (B2B lead/inquiry flow; see migration 010 for details).
CREATE TABLE IF NOT EXISTS enterprise_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 100),
  email TEXT NOT NULL CHECK (char_length(email) <= 160 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone VARCHAR(15) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  company_name TEXT NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 160),
  website TEXT CHECK (website IS NULL OR char_length(website) <= 255),
  designation TEXT CHECK (designation IS NULL OR char_length(designation) <= 100),
  business_type TEXT,
  company_size TEXT,
  cities TEXT CHECK (cities IS NULL OR char_length(cities) <= 300),
  operating_state TEXT CHECK (operating_state IS NULL OR char_length(operating_state) <= 80),
  locations_count INTEGER CHECK (locations_count IS NULL OR (locations_count BETWEEN 1 AND 100000)),
  services_required TEXT[] NOT NULL DEFAULT '{}',
  vehicle_types TEXT[] NOT NULL DEFAULT '{}',
  fleet_size TEXT,
  monthly_trips TEXT,
  start_date DATE,
  service_frequency TEXT,
  budget_range TEXT,
  requirements TEXT CHECK (requirements IS NULL OR char_length(requirements) <= 1000),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'IN_DISCUSSION', 'CONVERTED', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enterprise_inquiries_status_idx ON enterprise_inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_inquiries_email_idx ON enterprise_inquiries (email);
