-- ApnaShift MS SQL Server schema (local SSMS instance: .\SQLEXPRESS01).
-- Ported from PostgreSQL (db/schema.sql + db/migrations/*). PostgreSQL stays
-- the live database — this is a SEPARATE structure for SQL Server verification.
-- No production data is migrated here. Run: npm run db:migrate:mssql
--
-- Type mapping (documented simplifications vs PostgreSQL):
--   UUID/gen_random_uuid() -> UNIQUEIDENTIFIER DEFAULT NEWID()
--   TEXT                  -> NVARCHAR(MAX) (or sized NVARCHAR where bounded)
--   TIMESTAMPTZ/now()     -> DATETIME2 DEFAULT SYSUTCDATETIME() (UTC, no tz)
--   BOOLEAN               -> BIT (0/1)
--   NUMERIC(p,s)          -> DECIMAL(p,s) | DOUBLE PRECISION -> FLOAT
--   SERIAL                -> INT IDENTITY(1,1)
--   TEXT[] (enterprise)   -> NVARCHAR(MAX) holding a JSON array ('[]')
--   JSONB (audit details, settings) -> NVARCHAR(MAX) holding JSON
--   phone regex ^[6-9][0-9]{9}$ -> LIKE '[6-9][0-9]...' + LEN = 10
--   email/UPI regexes     -> LIKE '%_@_%._%' / '%@%' + length checks
--   ON CONFLICT DO NOTHING -> NOT EXISTS guards in 002_seed.sql
-- Batches are separated by GO (CREATE TRIGGER must start its own batch).

-- App users (customers).
IF OBJECT_ID('users', 'U') IS NULL
CREATE TABLE users (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  name NVARCHAR(80) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 80),
  phone NVARCHAR(15) NOT NULL UNIQUE CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  password_hash NVARCHAR(MAX) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Drivers (manual onboarding; staff sets is_verified).
IF OBJECT_ID('drivers', 'U') IS NULL
CREATE TABLE drivers (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  name NVARCHAR(80) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 80),
  phone NVARCHAR(15) NOT NULL UNIQUE CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  password_hash NVARCHAR(MAX) NOT NULL,
  vehicle_type NVARCHAR(20) NOT NULL CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  vehicle_number NVARCHAR(20) NOT NULL CHECK (LEN(vehicle_number) BETWEEN 4 AND 20),
  is_verified BIT NOT NULL DEFAULT 0,
  is_active BIT NOT NULL DEFAULT 1,
  avg_rating DECIMAL(3, 2) NULL,
  total_trips INT NOT NULL DEFAULT 0,
  needs_review BIT NOT NULL DEFAULT 0,
  rejection_reason NVARCHAR(MAX) NULL,
  email NVARCHAR(120) NULL UNIQUE,
  dob DATE NULL,
  gender NVARCHAR(20) NULL CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'prefer_not_to_say')),
  city NVARCHAR(120) NULL,
  state NVARCHAR(80) NULL,
  address NVARCHAR(500) NULL,
  vehicle_make NVARCHAR(MAX) NULL,
  vehicle_model NVARCHAR(MAX) NULL,
  vehicle_year INT NULL CHECK (vehicle_year IS NULL OR (vehicle_year BETWEEN 1990 AND 2100)),
  capacity_kg INT NULL CHECK (capacity_kg IS NULL OR (capacity_kg >= 0 AND capacity_kg <= 50000)),
  fuel_type NVARCHAR(20) NULL CHECK (fuel_type IS NULL OR fuel_type IN ('diesel', 'petrol', 'cng', 'electric', 'other')),
  ownership NVARCHAR(20) NULL CHECK (ownership IS NULL OR ownership IN ('owned', 'financed', 'rented', 'other')),
  license_number NVARCHAR(25) NULL UNIQUE,
  license_type NVARCHAR(MAX) NULL,
  license_expiry DATE NULL,
  license_state NVARCHAR(MAX) NULL,
  rc_number NVARCHAR(MAX) NULL,
  insurance_expiry DATE NULL,
  pollution_expiry DATE NULL,
  permit_number NVARCHAR(MAX) NULL,
  service_city NVARCHAR(MAX) NULL,
  service_state NVARCHAR(MAX) NULL,
  service_areas NVARCHAR(MAX) NULL,
  service_radius_km INT NULL CHECK (service_radius_km IS NULL OR (service_radius_km BETWEEN 1 AND 200)),
  emergency_name NVARCHAR(MAX) NULL,
  emergency_relation NVARCHAR(MAX) NULL,
  emergency_phone NVARCHAR(15) NULL,
  application_ref NVARCHAR(20) NOT NULL UNIQUE,
  consent_at DATETIME2 NULL,
  upi_id NVARCHAR(321) NULL CHECK (upi_id IS NULL OR (LEN(upi_id) BETWEEN 4 AND 321 AND upi_id LIKE '%@%')),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Bookings (status machine: pending -> accepted -> arrived -> in_transit -> delivered + cancelled).
IF OBJECT_ID('bookings', 'U') IS NULL
CREATE TABLE bookings (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users (id),
  driver_id UNIQUEIDENTIFIER NULL REFERENCES drivers (id),
  vehicle_type NVARCHAR(20) NOT NULL CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  pickup_address NVARCHAR(300) NOT NULL CHECK (LEN(pickup_address) BETWEEN 3 AND 300),
  drop_address NVARCHAR(300) NOT NULL CHECK (LEN(drop_address) BETWEEN 3 AND 300),
  pickup_lat FLOAT NULL,
  pickup_lng FLOAT NULL,
  drop_lat FLOAT NULL,
  drop_lng FLOAT NULL,
  item_description NVARCHAR(MAX) NOT NULL DEFAULT '',
  distance_km DECIMAL(8, 2) NOT NULL CHECK (distance_km > 0 AND distance_km <= 500),
  helper BIT NOT NULL DEFAULT 0,
  price_rs DECIMAL(10, 2) NOT NULL CHECK (price_rs >= 0),
  status NVARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'arrived', 'in_transit', 'delivered', 'cancelled')),
  scheduled_at DATETIME2 NULL,
  delivered_at DATETIME2 NULL,
  payment_method NVARCHAR(20) NOT NULL DEFAULT 'upi' CHECK (payment_method IN ('cash', 'online', 'upi')),
  commission_percent DECIMAL(5, 2) NULL CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)),
  cancel_reason NVARCHAR(MAX) NULL CHECK (cancel_reason IS NULL OR cancel_reason IN (
    'wrong_pickup', 'wrong_drop', 'wrong_vehicle', 'changed_plan', 'duplicate', 'driver_issue', 'other')),
  cancelled_by NVARCHAR(20) NULL CHECK (cancelled_by IS NULL OR cancelled_by IN ('user', 'driver', 'admin', 'system')),
  cancelled_at DATETIME2 NULL,
  disputed BIT NOT NULL DEFAULT 0,
  dispute_reason NVARCHAR(500) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT bookings_delivered_at_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  ),
  CONSTRAINT bookings_cancel_meta_ck CHECK (
    (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_by IS NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled')
  )
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_user_id')
  CREATE INDEX idx_bookings_user_id ON bookings (user_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_driver_id')
  CREATE INDEX idx_bookings_driver_id ON bookings (driver_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_status')
  CREATE INDEX idx_bookings_status ON bookings (status);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_available')
  CREATE INDEX idx_bookings_available ON bookings (status, vehicle_type, created_at ASC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_user_created')
  CREATE INDEX idx_bookings_user_created ON bookings (user_id, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_driver_created')
  CREATE INDEX idx_bookings_driver_created ON bookings (driver_id, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_disputed')
  CREATE INDEX idx_bookings_disputed ON bookings (disputed, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_cancelled_at')
  CREATE INDEX idx_bookings_cancelled_at ON bookings (status, cancelled_at DESC);
GO

-- updated_at auto-refresh (TRIGGER_NESTLEVEL stops the self-update recursion).
IF OBJECT_ID('trg_bookings_updated_at', 'TR') IS NOT NULL DROP TRIGGER trg_bookings_updated_at;
GO
CREATE TRIGGER trg_bookings_updated_at ON bookings AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF TRIGGER_NESTLEVEL() > 1 RETURN;
  UPDATE b SET updated_at = SYSUTCDATETIME()
  FROM bookings b JOIN inserted i ON b.id = i.id;
END;
GO

-- Ratings (one per booking).
IF OBJECT_ID('ratings', 'U') IS NULL
CREATE TABLE ratings (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  booking_id UNIQUEIDENTIFIER NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE CASCADE,
  user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users (id),
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id),
  stars INT NOT NULL CHECK (stars >= 1 AND stars <= 5),
  comment NVARCHAR(500) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_ratings_driver_id')
  CREATE INDEX idx_ratings_driver_id ON ratings (driver_id);
GO

-- Driver stats refresh on ratings (avg_rating/total_trips/needs_review, no auto-ban).
IF OBJECT_ID('trg_ratings_refresh', 'TR') IS NOT NULL DROP TRIGGER trg_ratings_refresh;
GO
CREATE TRIGGER trg_ratings_refresh ON ratings AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  WITH dids AS (
    SELECT driver_id FROM inserted WHERE driver_id IS NOT NULL
    UNION
    SELECT driver_id FROM deleted WHERE driver_id IS NOT NULL
  )
  UPDATE d SET
    avg_rating = agg.r_avg,
    total_trips = agg.trips,
    needs_review = CASE WHEN agg.r_count >= 5 AND ISNULL(agg.r_avg, 5) < 3.0 THEN 1 ELSE 0 END
  FROM drivers d JOIN (
    SELECT dids.driver_id,
      COUNT(r.id) AS r_count,
      ROUND(AVG(CAST(r.stars AS DECIMAL(10, 2))), 2) AS r_avg,
      (SELECT COUNT(*) FROM bookings b WHERE b.driver_id = dids.driver_id AND b.status = 'delivered') AS trips
    FROM dids LEFT JOIN ratings r ON r.driver_id = dids.driver_id
    GROUP BY dids.driver_id
  ) agg ON agg.driver_id = d.id;
END;
GO

-- Driver total_trips recount on booking driver/status changes.
IF OBJECT_ID('trg_bookings_trips', 'TR') IS NOT NULL DROP TRIGGER trg_bookings_trips;
GO
CREATE TRIGGER trg_bookings_trips ON bookings AFTER INSERT, UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  WITH dids AS (
    SELECT driver_id FROM inserted WHERE driver_id IS NOT NULL
    UNION
    SELECT driver_id FROM deleted WHERE driver_id IS NOT NULL
  )
  UPDATE d SET total_trips = (
    SELECT COUNT(*) FROM bookings b WHERE b.driver_id = d.id AND b.status = 'delivered'
  )
  FROM drivers d JOIN dids ON dids.driver_id = d.id;
END;
GO

-- Pricing rules (per-vehicle commission included).
IF OBJECT_ID('pricing_rules', 'U') IS NULL
CREATE TABLE pricing_rules (
  id INT IDENTITY(1,1) PRIMARY KEY,
  vehicle_type NVARCHAR(20) NOT NULL UNIQUE CHECK (vehicle_type IN ('Pickup', 'Mini Truck', 'Mini Tractor')),
  base_rs DECIMAL(10, 2) NOT NULL CHECK (base_rs >= 0),
  per_km_rs DECIMAL(10, 2) NOT NULL CHECK (per_km_rs >= 0),
  helper_rs DECIMAL(10, 2) NOT NULL DEFAULT 200 CHECK (helper_rs >= 0),
  commission_percent DECIMAL(5, 2) NOT NULL DEFAULT 15 CHECK (commission_percent >= 0 AND commission_percent <= 100),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Admins (staff login; manual insert).
IF OBJECT_ID('admins', 'U') IS NULL
CREATE TABLE admins (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  name NVARCHAR(80) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 80),
  phone NVARCHAR(15) NOT NULL UNIQUE CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  password_hash NVARCHAR(MAX) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Audit log + pricing history.
IF OBJECT_ID('audit_logs', 'U') IS NULL
CREATE TABLE audit_logs (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  admin_id UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  action NVARCHAR(100) NOT NULL,
  entity NVARCHAR(100) NOT NULL,
  entity_id NVARCHAR(100) NULL,
  details NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_admin')
  CREATE INDEX idx_audit_admin ON audit_logs (admin_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_entity')
  CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_audit_created')
  CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
GO

IF OBJECT_ID('pricing_history', 'U') IS NULL
CREATE TABLE pricing_history (
  id INT IDENTITY(1,1) PRIMARY KEY,
  vehicle_type NVARCHAR(20) NOT NULL,
  old_base_rs DECIMAL(10, 2) NULL,
  old_per_km_rs DECIMAL(10, 2) NULL,
  old_helper_rs DECIMAL(10, 2) NULL,
  new_base_rs DECIMAL(10, 2) NOT NULL,
  new_per_km_rs DECIMAL(10, 2) NOT NULL,
  new_helper_rs DECIMAL(10, 2) NOT NULL,
  changed_by UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Idempotency keys (per-user scope).
IF OBJECT_ID('idempotency_keys', 'U') IS NULL
CREATE TABLE idempotency_keys (
  user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  [key] NVARCHAR(64) NOT NULL CHECK (LEN([key]) BETWEEN 1 AND 64),
  booking_id UNIQUEIDENTIFIER NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  request_hash NVARCHAR(MAX) NOT NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (user_id, [key])
);
GO

-- Enterprise inquiries (TEXT[] arrays -> NVARCHAR(MAX) JSON arrays).
IF OBJECT_ID('enterprise_inquiries', 'U') IS NULL
CREATE TABLE enterprise_inquiries (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  full_name NVARCHAR(100) NOT NULL CHECK (LEN(full_name) BETWEEN 2 AND 100),
  email NVARCHAR(160) NOT NULL,
  phone NVARCHAR(15) NOT NULL CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  company_name NVARCHAR(160) NOT NULL CHECK (LEN(company_name) BETWEEN 2 AND 160),
  website NVARCHAR(255) NULL,
  designation NVARCHAR(100) NULL,
  business_type NVARCHAR(MAX) NULL,
  company_size NVARCHAR(MAX) NULL,
  cities NVARCHAR(300) NULL,
  operating_state NVARCHAR(80) NULL,
  locations_count INT NULL CHECK (locations_count IS NULL OR (locations_count BETWEEN 1 AND 100000)),
  services_required NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  vehicle_types NVARCHAR(MAX) NOT NULL DEFAULT '[]',
  fleet_size NVARCHAR(MAX) NULL,
  monthly_trips NVARCHAR(MAX) NULL,
  start_date DATE NULL,
  service_frequency NVARCHAR(MAX) NULL,
  budget_range NVARCHAR(MAX) NULL,
  requirements NVARCHAR(1000) NULL,
  status NVARCHAR(20) NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'IN_DISCUSSION', 'CONVERTED', 'CLOSED')),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

-- Live tracking location history.
IF OBJECT_ID('driver_locations', 'U') IS NULL
CREATE TABLE driver_locations (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  booking_id UNIQUEIDENTIFIER NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  lat FLOAT NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng FLOAT NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m DECIMAL(8, 2) NULL CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 10000)),
  speed_mps DECIMAL(6, 2) NULL CHECK (speed_mps IS NULL OR (speed_mps >= 0 AND speed_mps <= 100)),
  recorded_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_driver_locations_booking_time')
  CREATE INDEX idx_driver_locations_booking_time ON driver_locations (booking_id, recorded_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_driver_locations_driver_time')
  CREATE INDEX idx_driver_locations_driver_time ON driver_locations (driver_id, recorded_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_driver_locations_recorded')
  CREATE INDEX idx_driver_locations_recorded ON driver_locations (recorded_at DESC);
GO

-- Cash payments ledger (immutable money fields; corrections via adjustments).
IF OBJECT_ID('payments', 'U') IS NULL
CREATE TABLE payments (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  booking_id UNIQUEIDENTIFIER NOT NULL UNIQUE REFERENCES bookings (id),
  user_id UNIQUEIDENTIFIER NOT NULL REFERENCES users (id),
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id),
  gross_amount DECIMAL(10, 2) NOT NULL CHECK (gross_amount >= 0),
  payment_method NVARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'online', 'upi')),
  payment_status NVARCHAR(20) NOT NULL CHECK (payment_status IN ('collected', 'pending', 'failed', 'refunded')),
  driver_earning DECIMAL(10, 2) NOT NULL CHECK (driver_earning >= 0),
  platform_commission DECIMAL(10, 2) NOT NULL CHECK (platform_commission >= 0),
  commission_pct DECIMAL(5, 2) NOT NULL CHECK (commission_pct >= 0 AND commission_pct <= 100),
  settlement_status NVARCHAR(20) NOT NULL DEFAULT 'owed' CHECK (settlement_status IN ('owed', 'partial', 'settled')),
  settled_amount DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  collected_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT payments_split_ck CHECK (driver_earning + platform_commission = gross_amount)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_payments_driver')
  CREATE INDEX idx_payments_driver ON payments (driver_id, collected_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_payments_user')
  CREATE INDEX idx_payments_user ON payments (user_id, collected_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_payments_settlement')
  CREATE INDEX idx_payments_settlement ON payments (settlement_status, collected_at DESC);
GO

IF OBJECT_ID('payment_adjustments', 'U') IS NULL
CREATE TABLE payment_adjustments (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  payment_id UNIQUEIDENTIFIER NOT NULL REFERENCES payments (id),
  commission_delta_paise INT NOT NULL,
  earning_delta_paise INT NOT NULL,
  reason NVARCHAR(500) NOT NULL CHECK (LEN(reason) BETWEEN 3 AND 500),
  admin_id UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT payment_adjustments_nonzero_ck CHECK (
    commission_delta_paise <> 0 OR earning_delta_paise <> 0
  )
);
GO

IF OBJECT_ID('settlements', 'U') IS NULL
CREATE TABLE settlements (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id),
  amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
  method NVARCHAR(20) NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'upi')),
  reference_no NVARCHAR(100) NULL UNIQUE,
  admin_id UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  notes NVARCHAR(500) NULL,
  settled_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlements_driver')
  CREATE INDEX idx_settlements_driver ON settlements (driver_id, settled_at DESC);
GO

-- Platform settings (commission fallback) + commission history.
IF OBJECT_ID('platform_settings', 'U') IS NULL
CREATE TABLE platform_settings (
  [key] NVARCHAR(100) PRIMARY KEY,
  value NVARCHAR(MAX) NOT NULL,
  updated_by UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO

IF OBJECT_ID('commission_history', 'U') IS NULL
CREATE TABLE commission_history (
  id INT IDENTITY(1,1) PRIMARY KEY,
  old_pct DECIMAL(5, 2) NULL,
  new_pct DECIMAL(5, 2) NOT NULL,
  changed_by UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
