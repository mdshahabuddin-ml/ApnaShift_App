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
  upi_id TEXT CHECK (upi_id IS NULL OR upi_id ~ '^[\w.\-]{2,255}@[a-zA-Z]{2,64}$'),
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
  -- 014: creation-time commission snapshot (rate lock) + dispute flag.
  commission_percent NUMERIC(5, 2) CHECK (
    commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)
  ),
  disputed BOOLEAN NOT NULL DEFAULT FALSE,
  dispute_reason TEXT CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 3 AND 500),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'arrived', 'in_transit', 'delivered', 'cancelled')),
  scheduled_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  -- 012: cancellation metadata (atomic flip pending/accepted -> cancelled;
  -- rows never deleted). cancelled_by is a role string for future reuse.
  cancel_reason TEXT CHECK (
    cancel_reason IS NULL OR cancel_reason IN (
      'wrong_pickup', 'wrong_drop', 'wrong_vehicle',
      'changed_plan', 'duplicate', 'driver_issue', 'other'
    )
  ),
  cancelled_by TEXT CHECK (
    cancelled_by IS NULL OR cancelled_by IN ('user', 'driver', 'admin', 'system')
  ),
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bookings_delivered_at_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  ),
  CONSTRAINT bookings_cancel_meta_ck CHECK (
    (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled')
  )
);
-- NOTE (007 pattern): idx_bookings_cancelled_at lives ONLY in migration 012.
-- schema.sql re-runs on older DBs where the 012 columns do not exist yet —
-- an index here would fail the whole migrate (IF NOT EXISTS tables skip,
-- but a bare CREATE INDEX does not). migrate.js always runs 012 afterwards.

-- 013/014: payment method on bookings (creation-time, immutable).
-- Creatable today: 'cash' + 'upi' (default 'upi'); 'online' reserved for a
-- future gateway. Old 'cash' rows stay valid.
-- NOTE: ALTER TABLE on an existing table always runs here — safe because the
-- migrations use ADD COLUMN IF NOT EXISTS and 014 swaps the CHECK by content.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'upi';
ALTER TABLE bookings ALTER COLUMN payment_method SET DEFAULT 'upi';
DO $$
DECLARE
  old_ck TEXT;
  old_def TEXT;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO old_ck, old_def FROM pg_constraint
   WHERE conrelid = 'bookings'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%payment_method%'
   LIMIT 1;
  IF old_ck IS NOT NULL AND old_def NOT LIKE '%upi%' THEN
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', old_ck);
    old_ck := NULL;
  END IF;
  IF old_ck IS NULL THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_payment_method_ck CHECK (
      payment_method IN ('cash', 'online', 'upi')
    );
  END IF;
END
$$;
-- NOTE (007 pattern): idx_bookings_disputed lives ONLY in migration 014
-- (disputed column does not exist on older DBs until 014 runs).

-- 013: one immutable financial transaction per delivered booking.
-- Money exact: NUMERIC holds whole-paise values only (integer-paise math
-- in src/services/money.js). Corrections via payment_adjustments.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  gross_amount NUMERIC(10, 2) NOT NULL CHECK (gross_amount >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'online', 'upi')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('collected', 'pending', 'failed', 'refunded')),
  driver_earning NUMERIC(10, 2) NOT NULL CHECK (driver_earning >= 0),
  platform_commission NUMERIC(10, 2) NOT NULL CHECK (platform_commission >= 0),
  commission_pct NUMERIC(5, 2) NOT NULL CHECK (commission_pct >= 0 AND commission_pct <= 100),
  settlement_status TEXT NOT NULL DEFAULT 'owed' CHECK (settlement_status IN ('owed', 'partial', 'settled')),
  settled_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_split_ck CHECK (driver_earning + platform_commission = gross_amount)
  -- NOTE: no settled_amount<=commission CHECK — positive adjustments can
  -- raise owed above the snapshot; over-settlement is blocked in code.
);
CREATE INDEX IF NOT EXISTS idx_payments_driver ON payments (driver_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_settlement ON payments (settlement_status, collected_at DESC);

CREATE TABLE IF NOT EXISTS payment_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  commission_delta_paise INTEGER NOT NULL,
  earning_delta_paise INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_adjustments_nonzero_ck CHECK (
    commission_delta_paise <> 0 OR earning_delta_paise <> 0
  )
);
CREATE INDEX IF NOT EXISTS idx_payment_adjustments_payment
  ON payment_adjustments (payment_id, created_at ASC);

CREATE TABLE IF NOT EXISTS settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'upi')),
  reference_no TEXT UNIQUE CHECK (reference_no IS NULL OR char_length(reference_no) BETWEEN 2 AND 100),
  admin_id UUID REFERENCES admins (id) ON DELETE SET NULL,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settlements_driver ON settlements (driver_id, settled_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value)
VALUES ('commission', '{"pct": 15.00}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS commission_history (
  id SERIAL PRIMARY KEY,
  old_pct NUMERIC(5, 2),
  new_pct NUMERIC(5, 2) NOT NULL,
  changed_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- 011: live driver tracking — one row per GPS report during an ACTIVE
-- booking (accepted/arrived/in_transit). Gating enforced in API layer.
-- Retention: prune rows older than 30 days (npm run tracking:prune).
CREATE TABLE IF NOT EXISTS driver_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m NUMERIC(8, 2) CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 10000)),
  speed_mps NUMERIC(6, 2) CHECK (speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps <= 100)),
  heading_deg NUMERIC(5, 1) CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_driver_locations_booking_time
  ON driver_locations (booking_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_time
  ON driver_locations (driver_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_locations_recorded
  ON driver_locations (recorded_at DESC);

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
  -- 014: per-vehicle commission % (snapshot into bookings at creation).
  commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 15 CHECK (
    commission_percent >= 0 AND commission_percent <= 100
  ),
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

-- 016: self-service password-reset OTPs (zero-cost dev mode).
-- Fresh DB ke liye yahin, existing DB ke liye db/migrations/016_* chalta hai.
-- otp_hash = HMAC-SHA256(otp, pepper), plain OTP kabhi store nahi hota.
CREATE TABLE IF NOT EXISTS password_reset_otps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_phone_created
  ON password_reset_otps (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_expires
  ON password_reset_otps (expires_at);

-- 017: COD confirm + weekly settlement periods (Mon–Sun IST).
-- payments.cash_confirmed_at set ONLY by driver confirm (cash + pending).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cash_confirmed_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_cash_confirm_ck') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_cash_confirm_ck CHECK (
      cash_confirmed_at IS NULL OR payment_method = 'cash'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS settlement_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers (id) ON DELETE RESTRICT,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  gross_paise BIGINT NOT NULL CHECK (gross_paise >= 0),
  commission_paise BIGINT NOT NULL CHECK (commission_paise >= 0),
  earning_paise BIGINT NOT NULL CHECK (earning_paise >= 0),
  settled_paise BIGINT NOT NULL DEFAULT 0 CHECK (settled_paise >= 0),
  status TEXT NOT NULL DEFAULT 'DUE'
    CHECK (status IN ('DUE', 'PARTIALLY_PAID', 'PAID', 'DISPUTED')),
  dispute_reason TEXT CHECK (dispute_reason IS NULL OR char_length(dispute_reason) BETWEEN 3 AND 500),
  created_by UUID REFERENCES admins (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlement_periods_week_ck CHECK (
    week_end = week_start + 6
    AND EXTRACT(ISODOW FROM week_start) = 1
  ),
  CONSTRAINT settlement_periods_settled_ck CHECK (settled_paise <= gross_paise),
  CONSTRAINT settlement_periods_unique_ck UNIQUE (driver_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_driver_week
  ON settlement_periods (driver_id, week_start DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_periods_status
  ON settlement_periods (status, week_end DESC);

CREATE TABLE IF NOT EXISTS settlement_period_items (
  period_id UUID NOT NULL REFERENCES settlement_periods (id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
  PRIMARY KEY (period_id, payment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_period_items_payment
  ON settlement_period_items (payment_id);
CREATE INDEX IF NOT EXISTS idx_settlement_period_items_period
  ON settlement_period_items (period_id);

ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settlement_period_id UUID
  REFERENCES settlement_periods (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_settlements_period
  ON settlements (settlement_period_id);
