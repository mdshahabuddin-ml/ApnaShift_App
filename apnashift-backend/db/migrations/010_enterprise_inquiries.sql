-- Migration 010: enterprise_inquiries (B2B lead/inquiry flow).
-- Business customer submits requirements, admin reviews and contacts
-- them. Separate from booking flow (no driver/price logic).
-- Run: npm run db:migrate (runs migrations folder in order).
--
-- Notes:
-- - services_required / vehicle_types are TEXT[] (multi-select). These are only
--   inquiry preferences — separate from the drivers/bookings vehicle enum,
--   in a different namespace, no conflict.
-- - Duplicate rule (same email + company, 30 days) is app-level
--   (duplicate_inquiry) — more flexible than a partial unique index.
-- - Status machine: NEW -> CONTACTED -> IN_DISCUSSION -> CONVERTED/CLOSED.
--   Transition guard is in the app; DB only constrains allowed values.

CREATE TABLE IF NOT EXISTS enterprise_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 100),
  email TEXT NOT NULL CHECK (char_length(email) <= 160 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone VARCHAR(15) NOT NULL CHECK (phone ~ '^[6-9][0-9]{9}$'),
  company_name TEXT NOT NULL CHECK (char_length(company_name) BETWEEN 2 AND 160),
  website TEXT CHECK (website IS NULL OR char_length(website) <= 255),
  designation TEXT CHECK (designation IS NULL OR char_length(designation) <= 100),
  business_type TEXT CHECK (business_type IS NULL OR business_type IN (
    'ecommerce', 'retail', 'manufacturing', 'construction', 'hospitality',
    'healthcare', 'education', 'corporate', 'other')),
  company_size TEXT CHECK (company_size IS NULL OR company_size IN (
    '1-10', '11-50', '51-200', '201-500', '500+')),
  cities TEXT CHECK (cities IS NULL OR char_length(cities) <= 300),
  operating_state TEXT CHECK (operating_state IS NULL OR char_length(operating_state) <= 80),
  locations_count INTEGER CHECK (locations_count IS NULL OR (locations_count BETWEEN 1 AND 100000)),
  services_required TEXT[] NOT NULL DEFAULT '{}',
  vehicle_types TEXT[] NOT NULL DEFAULT '{}',
  fleet_size TEXT CHECK (fleet_size IS NULL OR fleet_size IN (
    '1-5', '6-20', '21-50', '51-100', '100+')),
  monthly_trips TEXT CHECK (monthly_trips IS NULL OR monthly_trips IN (
    '1-100', '101-500', '501-1000', '1000+')),
  start_date DATE,
  service_frequency TEXT CHECK (service_frequency IS NULL OR service_frequency IN (
    'daily', 'weekly', 'monthly', 'on_demand')),
  budget_range TEXT CHECK (budget_range IS NULL OR budget_range IN (
    'under_25k', '25k_50k', '50k_1l', '1l_plus', 'discuss')),
  requirements TEXT CHECK (requirements IS NULL OR char_length(requirements) <= 1000),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN (
    'NEW', 'CONTACTED', 'IN_DISCUSSION', 'CONVERTED', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enterprise_inquiries_status_idx
  ON enterprise_inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS enterprise_inquiries_email_idx
  ON enterprise_inquiries (email);
