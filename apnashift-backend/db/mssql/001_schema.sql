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
  commission_due DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (commission_due >= 0),
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
  -- 023 (pricing v2 inputs) + 019 (booking source): fresh installs get them
  -- here; existing tables are patched by the guarded ALTERs below.
  vehicle_size_tier NVARCHAR(10) NOT NULL DEFAULT 'chhota'
    CHECK (vehicle_size_tier IN ('chhota', 'bada')),
  goods_weight_kg DECIMAL(10, 2) NOT NULL DEFAULT 0
    CHECK (goods_weight_kg >= 0 AND goods_weight_kg <= 5000),
  item_count INT NOT NULL DEFAULT 1
    CHECK (item_count >= 1 AND item_count <= 100),
  has_bulky_item BIT NOT NULL DEFAULT 0,
  booking_source NVARCHAR(20) NOT NULL DEFAULT 'WEB'
    CHECK (booking_source IN ('WEB', 'WHATSAPP', 'ADMIN', 'MOBILE')),
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

-- 023 + 019 backfill for databases created before these columns existed
-- (CREATE TABLE above is skipped when the table exists — these are not).
IF COL_LENGTH('bookings', 'vehicle_size_tier') IS NULL
  ALTER TABLE bookings ADD vehicle_size_tier NVARCHAR(10) NOT NULL DEFAULT 'chhota';
GO
IF COL_LENGTH('bookings', 'goods_weight_kg') IS NULL
  ALTER TABLE bookings ADD goods_weight_kg DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('bookings', 'item_count') IS NULL
  ALTER TABLE bookings ADD item_count INT NOT NULL DEFAULT 1;
GO
IF COL_LENGTH('bookings', 'has_bulky_item') IS NULL
  ALTER TABLE bookings ADD has_bulky_item BIT NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('bookings', 'booking_source') IS NULL
  ALTER TABLE bookings ADD booking_source NVARCHAR(20) NOT NULL DEFAULT 'WEB';
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'bookings_size_tier_ck')
  ALTER TABLE bookings ADD CONSTRAINT bookings_size_tier_ck CHECK (
    vehicle_size_tier IN ('chhota', 'bada'));
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'bookings_weight_ck')
  ALTER TABLE bookings ADD CONSTRAINT bookings_weight_ck CHECK (
    goods_weight_kg >= 0 AND goods_weight_kg <= 5000);
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'bookings_item_count_ck')
  ALTER TABLE bookings ADD CONSTRAINT bookings_item_count_ck CHECK (
    item_count >= 1 AND item_count <= 100);
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'bookings_source_ck')
  ALTER TABLE bookings ADD CONSTRAINT bookings_source_ck CHECK (
    booking_source IN ('WEB', 'WHATSAPP', 'ADMIN', 'MOBILE'));
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_bookings_source_created')
  CREATE INDEX idx_bookings_source_created ON bookings (booking_source, created_at DESC);
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
  minimum_fare DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (minimum_fare >= 0),
  size_small_extra DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (size_small_extra >= 0),
  size_big_extra DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (size_big_extra >= 0),
  weight_0_100 DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (weight_0_100 >= 0),
  weight_100_300 DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (weight_100_300 >= 0),
  weight_300_500 DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (weight_300_500 >= 0),
  weight_500_plus DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (weight_500_plus >= 0),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
-- Backfill for databases created before the 023 columns existed
-- (CREATE TABLE above is skipped when the table exists — these are not).
IF COL_LENGTH('pricing_rules', 'minimum_fare') IS NULL
  ALTER TABLE pricing_rules ADD minimum_fare DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'size_small_extra') IS NULL
  ALTER TABLE pricing_rules ADD size_small_extra DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'size_big_extra') IS NULL
  ALTER TABLE pricing_rules ADD size_big_extra DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'weight_0_100') IS NULL
  ALTER TABLE pricing_rules ADD weight_0_100 DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'weight_100_300') IS NULL
  ALTER TABLE pricing_rules ADD weight_100_300 DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'weight_300_500') IS NULL
  ALTER TABLE pricing_rules ADD weight_300_500 DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO
IF COL_LENGTH('pricing_rules', 'weight_500_plus') IS NULL
  ALTER TABLE pricing_rules ADD weight_500_plus DECIMAL(10, 2) NOT NULL DEFAULT 0;
GO

-- Admins (staff login; manual insert).
IF OBJECT_ID('admins', 'U') IS NULL
CREATE TABLE admins (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  name NVARCHAR(80) NOT NULL CHECK (LEN(name) BETWEEN 2 AND 80),
  phone NVARCHAR(15) NOT NULL UNIQUE CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  password_hash NVARCHAR(MAX) NOT NULL,
  -- 022: role tiers (PG: TEXT DEFAULT 'admin').
  role NVARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
-- 022 backfill for pre-existing admins tables.
IF COL_LENGTH('admins', 'role') IS NULL
  ALTER TABLE admins ADD role NVARCHAR(20) NOT NULL DEFAULT 'admin';
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'admins_role_ck')
  ALTER TABLE admins ADD CONSTRAINT admins_role_ck CHECK (role IN ('admin', 'super_admin'));
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_admins_role')
  CREATE INDEX idx_admins_role ON admins (role);
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
  -- 023: new-field snapshots (nullable so old history rows stay valid).
  old_minimum_fare DECIMAL(10, 2) NULL,
  new_minimum_fare DECIMAL(10, 2) NULL,
  old_size_small_extra DECIMAL(10, 2) NULL,
  new_size_small_extra DECIMAL(10, 2) NULL,
  old_size_big_extra DECIMAL(10, 2) NULL,
  new_size_big_extra DECIMAL(10, 2) NULL,
  old_weight_0_100 DECIMAL(10, 2) NULL,
  new_weight_0_100 DECIMAL(10, 2) NULL,
  old_weight_100_300 DECIMAL(10, 2) NULL,
  new_weight_100_300 DECIMAL(10, 2) NULL,
  old_weight_300_500 DECIMAL(10, 2) NULL,
  new_weight_300_500 DECIMAL(10, 2) NULL,
  old_weight_500_plus DECIMAL(10, 2) NULL,
  new_weight_500_plus DECIMAL(10, 2) NULL,
  changed_by UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
-- 023 backfill for pre-existing pricing_history tables.
IF COL_LENGTH('pricing_history', 'old_minimum_fare') IS NULL
  ALTER TABLE pricing_history ADD old_minimum_fare DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_minimum_fare') IS NULL
  ALTER TABLE pricing_history ADD new_minimum_fare DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_size_small_extra') IS NULL
  ALTER TABLE pricing_history ADD old_size_small_extra DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_size_small_extra') IS NULL
  ALTER TABLE pricing_history ADD new_size_small_extra DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_size_big_extra') IS NULL
  ALTER TABLE pricing_history ADD old_size_big_extra DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_size_big_extra') IS NULL
  ALTER TABLE pricing_history ADD new_size_big_extra DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_weight_0_100') IS NULL
  ALTER TABLE pricing_history ADD old_weight_0_100 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_weight_0_100') IS NULL
  ALTER TABLE pricing_history ADD new_weight_0_100 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_weight_100_300') IS NULL
  ALTER TABLE pricing_history ADD old_weight_100_300 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_weight_100_300') IS NULL
  ALTER TABLE pricing_history ADD new_weight_100_300 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_weight_300_500') IS NULL
  ALTER TABLE pricing_history ADD old_weight_300_500 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_weight_300_500') IS NULL
  ALTER TABLE pricing_history ADD new_weight_300_500 DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'old_weight_500_plus') IS NULL
  ALTER TABLE pricing_history ADD old_weight_500_plus DECIMAL(10, 2) NULL;
GO
IF COL_LENGTH('pricing_history', 'new_weight_500_plus') IS NULL
  ALTER TABLE pricing_history ADD new_weight_500_plus DECIMAL(10, 2) NULL;
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
  heading_deg DECIMAL(5, 1) NULL CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),
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
  -- 017: COD driver-confirm timestamp (NULL = not confirmed / legacy row).
  cash_confirmed_at DATETIME2 NULL,
  CONSTRAINT payments_split_ck CHECK (driver_earning + platform_commission = gross_amount),
  CONSTRAINT payments_cash_confirm_ck CHECK (
    cash_confirmed_at IS NULL OR payment_method = 'cash'
  )
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
-- 017 backfill for pre-existing payments tables.
IF COL_LENGTH('payments', 'cash_confirmed_at') IS NULL
  ALTER TABLE payments ADD cash_confirmed_at DATETIME2 NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'payments_cash_confirm_ck')
  ALTER TABLE payments ADD CONSTRAINT payments_cash_confirm_ck CHECK (
    cash_confirmed_at IS NULL OR payment_method = 'cash'
  );
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

-- 017: weekly settlement periods (PG money is BIGINT paise; UNIQUE driver+week).
IF OBJECT_ID('settlement_periods', 'U') IS NULL
CREATE TABLE settlement_periods (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id),
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  gross_paise BIGINT NOT NULL CHECK (gross_paise >= 0),
  commission_paise BIGINT NOT NULL CHECK (commission_paise >= 0),
  earning_paise BIGINT NOT NULL CHECK (earning_paise >= 0),
  settled_paise BIGINT NOT NULL DEFAULT 0 CHECK (settled_paise >= 0),
  status NVARCHAR(20) NOT NULL DEFAULT 'DUE'
    CHECK (status IN ('DUE', 'PARTIALLY_PAID', 'PAID', 'DISPUTED')),
  dispute_reason NVARCHAR(MAX) NULL CHECK (dispute_reason IS NULL OR LEN(dispute_reason) BETWEEN 3 AND 500),
  created_by UNIQUEIDENTIFIER NULL REFERENCES admins (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT settlement_periods_week_ck CHECK (
    week_end = DATEADD(DAY, 6, week_start)
    AND ((DATEPART(WEEKDAY, week_start) + @@DATEFIRST - 2) % 7 + 1) = 1
  ),
  CONSTRAINT settlement_periods_settled_ck CHECK (settled_paise <= gross_paise),
  CONSTRAINT settlement_periods_unique_ck UNIQUE (driver_id, week_start)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlement_periods_driver_week')
  CREATE INDEX idx_settlement_periods_driver_week ON settlement_periods (driver_id, week_start DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlement_periods_status')
  CREATE INDEX idx_settlement_periods_status ON settlement_periods (status, week_end DESC);
GO

IF OBJECT_ID('settlement_period_items', 'U') IS NULL
CREATE TABLE settlement_period_items (
  period_id UNIQUEIDENTIFIER NOT NULL REFERENCES settlement_periods (id) ON DELETE CASCADE,
  payment_id UNIQUEIDENTIFIER NOT NULL REFERENCES payments (id),
  PRIMARY KEY (period_id, payment_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlement_period_items_payment')
  CREATE UNIQUE INDEX idx_settlement_period_items_payment ON settlement_period_items (payment_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlement_period_items_period')
  CREATE INDEX idx_settlement_period_items_period ON settlement_period_items (period_id);
GO

-- 017: optional link from admin receipts to a weekly period (PG: UUID ... SET NULL).
IF COL_LENGTH('settlements', 'settlement_period_id') IS NULL
  ALTER TABLE settlements ADD settlement_period_id UNIQUEIDENTIFIER NULL REFERENCES settlement_periods (id) ON DELETE SET NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_settlements_period')
  CREATE INDEX idx_settlements_period ON settlements (settlement_period_id);
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

-- 021: in-app notifications (PG UNIQUE doubles as dedupe guard) + push tokens.
IF OBJECT_ID('notifications', 'U') IS NULL
CREATE TABLE notifications (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  seq INT IDENTITY(1,1),
  recipient_role NVARCHAR(20) NOT NULL CHECK (recipient_role IN ('user', 'driver')),
  recipient_id UNIQUEIDENTIFIER NOT NULL,
  booking_id UNIQUEIDENTIFIER NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  type NVARCHAR(30) NOT NULL CHECK (type IN (
    'booking_created', 'booking_accepted', 'driver_arrived',
    'trip_started', 'trip_completed', 'booking_cancelled',
    'assignment_received'
  )),
  title NVARCHAR(MAX) NOT NULL,
  body NVARCHAR(MAX) NOT NULL,
  data NVARCHAR(MAX) NOT NULL DEFAULT '{}',
  read_at DATETIME2 NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT notifications_dedupe_ck UNIQUE (booking_id, recipient_role, recipient_id, type)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notif_recipient_time')
  CREATE INDEX idx_notif_recipient_time ON notifications (recipient_role, recipient_id, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notif_unread')
  CREATE INDEX idx_notif_unread ON notifications (recipient_role, recipient_id) WHERE read_at IS NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notif_booking')
  CREATE INDEX idx_notif_booking ON notifications (booking_id);
GO

IF OBJECT_ID('device_tokens', 'U') IS NULL
CREATE TABLE device_tokens (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  owner_role NVARCHAR(20) NOT NULL CHECK (owner_role IN ('user', 'driver')),
  owner_id UNIQUEIDENTIFIER NOT NULL,
  platform NVARCHAR(20) NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  token NVARCHAR(512) NOT NULL CHECK (LEN(token) BETWEEN 1 AND 512),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT device_tokens_owner_token_ck UNIQUE (owner_role, owner_id, token)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_device_tokens_owner')
  CREATE INDEX idx_device_tokens_owner ON device_tokens (owner_role, owner_id);
GO

-- 016: password-reset OTPs (PG: HMAC hash, no FK — phone is the key).
IF OBJECT_ID('password_reset_otps', 'U') IS NULL
CREATE TABLE password_reset_otps (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  phone NVARCHAR(15) NOT NULL CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  otp_hash NVARCHAR(MAX) NOT NULL,
  expires_at DATETIME2 NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_password_reset_otps_phone_created')
  CREATE INDEX idx_password_reset_otps_phone_created ON password_reset_otps (phone, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_password_reset_otps_expires')
  CREATE INDEX idx_password_reset_otps_expires ON password_reset_otps (expires_at);
GO

-- 019: WhatsApp dialog state (PG data JSONB -> NVARCHAR(MAX) JSON '{}').
IF OBJECT_ID('wa_conversations', 'U') IS NULL
CREATE TABLE wa_conversations (
  id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
  phone NVARCHAR(15) NOT NULL UNIQUE CHECK (LEN(phone) = 10 AND phone LIKE '[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  state NVARCHAR(50) NOT NULL DEFAULT 'START',
  data NVARCHAR(MAX) NOT NULL DEFAULT '{}',
  booking_id UNIQUEIDENTIFIER NULL REFERENCES bookings (id) ON DELETE SET NULL,
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_wa_conversations_updated')
  CREATE INDEX idx_wa_conversations_updated ON wa_conversations (updated_at DESC);
GO

-- 018: driver decline records (append-only; never touches bookings rows).
IF OBJECT_ID('driver_declines', 'U') IS NULL
CREATE TABLE driver_declines (
  driver_id UNIQUEIDENTIFIER NOT NULL REFERENCES drivers (id) ON DELETE CASCADE,
  booking_id UNIQUEIDENTIFIER NOT NULL REFERENCES bookings (id),
  created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
  PRIMARY KEY (driver_id, booking_id)
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_driver_declines_booking')
  CREATE INDEX idx_driver_declines_booking ON driver_declines (booking_id, created_at DESC);
GO
