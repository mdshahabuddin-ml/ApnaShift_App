-- Migration 009: driver partner registration — extended profile columns.
-- New NULLABLE columns for the Driver Partner Registration flow.
-- All nullable/additive: existing clients/rows will not break.
-- Run: npm run db:migrate (runs migrations folder in order).
--
-- Design notes (existing conventions reuse):
-- - Same 3 vehicle types (Pickup/Mini Truck/Mini Tractor) — no new enum.
-- - Pending status = is_verified=FALSE (no duplicate status system).
-- - UNIQUE for email/license/vehicle dup-checks (NULLs allowed — Postgres
--   allows multiple NULLs in UNIQUE, so old rows stay safe).
-- - No DB UNIQUE on vehicle_number (legacy column, prod data unknown) —
--   duplicates checked at app level (vehicle_already_registered).
-- - No bank/payout columns (payout system out of scope — storing plaintext
--   bank numbers unnecessarily is a security risk).

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS dob DATE,
  ADD COLUMN IF NOT EXISTS gender TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_make TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_year INTEGER,
  ADD COLUMN IF NOT EXISTS capacity_kg INTEGER,
  ADD COLUMN IF NOT EXISTS fuel_type TEXT,
  ADD COLUMN IF NOT EXISTS ownership TEXT,
  ADD COLUMN IF NOT EXISTS license_number TEXT,
  ADD COLUMN IF NOT EXISTS license_type TEXT,
  ADD COLUMN IF NOT EXISTS license_expiry DATE,
  ADD COLUMN IF NOT EXISTS license_state TEXT,
  ADD COLUMN IF NOT EXISTS rc_number TEXT,
  ADD COLUMN IF NOT EXISTS insurance_expiry DATE,
  ADD COLUMN IF NOT EXISTS pollution_expiry DATE,
  ADD COLUMN IF NOT EXISTS permit_number TEXT,
  ADD COLUMN IF NOT EXISTS service_city TEXT,
  ADD COLUMN IF NOT EXISTS service_state TEXT,
  ADD COLUMN IF NOT EXISTS service_areas TEXT,
  ADD COLUMN IF NOT EXISTS service_radius_km INTEGER,
  ADD COLUMN IF NOT EXISTS emergency_name TEXT,
  ADD COLUMN IF NOT EXISTS emergency_relation TEXT,
  ADD COLUMN IF NOT EXISTS emergency_phone TEXT,
  ADD COLUMN IF NOT EXISTS application_ref TEXT,
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;

-- Assign application IDs to old rows (deterministic from id — unique).
UPDATE drivers
SET application_ref = 'AS-' || to_char(created_at, 'YYYY') || '-' || upper(substring(id::text, 1, 6))
WHERE application_ref IS NULL;

ALTER TABLE drivers ALTER COLUMN application_ref SET NOT NULL;

-- Uniqueness (email/license/app-ref). vehicle_number intentionally excluded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_email_unique') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_email_unique UNIQUE (email);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_license_unique') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_license_unique UNIQUE (license_number);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_appref_unique') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_appref_unique UNIQUE (application_ref);
  END IF;
END
$$;

-- Field-level guards (NULL always allowed — old rows/clients safe).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_email_fmt') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_email_fmt CHECK (
      email IS NULL OR (char_length(email) <= 120 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_dob_eligible') THEN
    -- 18+ (legal eligibility), not over 100.
    ALTER TABLE drivers ADD CONSTRAINT drivers_dob_eligible CHECK (
      dob IS NULL OR (dob <= CURRENT_DATE - INTERVAL '18 years' AND dob >= CURRENT_DATE - INTERVAL '100 years')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_gender_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_gender_ck CHECK (
      gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_city_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_city_ck CHECK (
      city IS NULL OR (char_length(city) BETWEEN 2 AND 120)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_state_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_state_ck CHECK (
      state IS NULL OR (char_length(state) BETWEEN 2 AND 80)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_address_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_address_ck CHECK (
      address IS NULL OR (char_length(address) BETWEEN 5 AND 500)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_vehicle_year_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_vehicle_year_ck CHECK (
      vehicle_year IS NULL OR (vehicle_year BETWEEN 1990 AND 2100)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_capacity_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_capacity_ck CHECK (
      capacity_kg IS NULL OR (capacity_kg >= 0 AND capacity_kg <= 50000)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_fuel_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_fuel_ck CHECK (
      fuel_type IS NULL OR fuel_type IN ('diesel', 'petrol', 'cng', 'electric', 'other')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_ownership_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_ownership_ck CHECK (
      ownership IS NULL OR ownership IN ('owned', 'financed', 'rented', 'other')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_license_expiry_ck') THEN
    -- Expired licenses cannot register — only future dates allowed.
    ALTER TABLE drivers ADD CONSTRAINT drivers_license_expiry_ck CHECK (
      license_expiry IS NULL OR license_expiry > CURRENT_DATE
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_radius_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_radius_ck CHECK (
      service_radius_km IS NULL OR (service_radius_km BETWEEN 1 AND 200)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drivers_emg_phone_ck') THEN
    ALTER TABLE drivers ADD CONSTRAINT drivers_emg_phone_ck CHECK (
      emergency_phone IS NULL OR emergency_phone ~ '^[6-9][0-9]{9}$'
    );
  END IF;
END
$$;
