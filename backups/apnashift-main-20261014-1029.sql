--
-- PostgreSQL database dump
--

\restrict JfncDOzLh8WlYI3aDjTH3sqztQcd1efcV0s3AZXnYfh2QrKgae2DBNwobc1a8Up

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: refresh_driver_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_driver_stats() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

  -- driver_id rarely changes (booking is fixed), but stay safe:
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
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


--
-- Name: sync_driver_trips(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_driver_trips() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    phone character varying(15) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admins_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 80))),
    CONSTRAINT admins_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    driver_id uuid,
    vehicle_type text NOT NULL,
    pickup_address text NOT NULL,
    drop_address text NOT NULL,
    pickup_lat double precision,
    pickup_lng double precision,
    drop_lat double precision,
    drop_lng double precision,
    item_description text DEFAULT ''::text NOT NULL,
    distance_km numeric(8,2) NOT NULL,
    helper boolean DEFAULT false NOT NULL,
    price_rs numeric(10,2) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    scheduled_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payment_method text DEFAULT 'upi'::text NOT NULL,
    cancel_reason text,
    cancelled_by text,
    cancelled_at timestamp with time zone,
    commission_percent numeric(5,2),
    disputed boolean DEFAULT false NOT NULL,
    dispute_reason text,
    booking_source text DEFAULT 'WEB'::text NOT NULL,
    CONSTRAINT bookings_cancel_meta_ck CHECK ((((status <> 'cancelled'::text) AND (cancel_reason IS NULL) AND (cancelled_by IS NULL) AND (cancelled_at IS NULL)) OR (status = 'cancelled'::text))),
    CONSTRAINT bookings_cancel_reason_ck CHECK (((cancel_reason IS NULL) OR (cancel_reason = ANY (ARRAY['wrong_pickup'::text, 'wrong_drop'::text, 'wrong_vehicle'::text, 'changed_plan'::text, 'duplicate'::text, 'driver_issue'::text, 'other'::text])))),
    CONSTRAINT bookings_cancelled_by_ck CHECK (((cancelled_by IS NULL) OR (cancelled_by = ANY (ARRAY['user'::text, 'driver'::text, 'admin'::text, 'system'::text])))),
    CONSTRAINT bookings_commission_pct_ck CHECK (((commission_percent IS NULL) OR ((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric)))),
    CONSTRAINT bookings_delivered_at_check CHECK ((((status = 'delivered'::text) AND (delivered_at IS NOT NULL)) OR ((status <> 'delivered'::text) AND (delivered_at IS NULL)))),
    CONSTRAINT bookings_dispute_reason_ck CHECK (((dispute_reason IS NULL) OR ((char_length(dispute_reason) >= 3) AND (char_length(dispute_reason) <= 500)))),
    CONSTRAINT bookings_distance_km_check CHECK (((distance_km > (0)::numeric) AND (distance_km <= (500)::numeric))),
    CONSTRAINT bookings_drop_address_check CHECK (((char_length(drop_address) >= 3) AND (char_length(drop_address) <= 300))),
    CONSTRAINT bookings_payment_method_ck CHECK ((payment_method = ANY (ARRAY['cash'::text, 'online'::text, 'upi'::text]))),
    CONSTRAINT bookings_pickup_address_check CHECK (((char_length(pickup_address) >= 3) AND (char_length(pickup_address) <= 300))),
    CONSTRAINT bookings_price_rs_check CHECK ((price_rs >= (0)::numeric)),
    CONSTRAINT bookings_source_ck CHECK ((booking_source = ANY (ARRAY['WEB'::text, 'WHATSAPP'::text, 'ADMIN'::text, 'MOBILE'::text]))),
    CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'arrived'::text, 'in_transit'::text, 'delivered'::text, 'cancelled'::text]))),
    CONSTRAINT bookings_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['Pickup'::text, 'Mini Truck'::text, 'Mini Tractor'::text])))
);


--
-- Name: commission_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commission_history (
    id integer NOT NULL,
    old_pct numeric(5,2),
    new_pct numeric(5,2) NOT NULL,
    changed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: commission_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.commission_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: commission_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.commission_history_id_seq OWNED BY public.commission_history.id;


--
-- Name: driver_declines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_declines (
    driver_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: driver_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    accuracy_m numeric(8,2),
    speed_mps numeric(6,2),
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    heading_deg numeric(5,1),
    CONSTRAINT driver_locations_accuracy_m_check CHECK (((accuracy_m IS NULL) OR ((accuracy_m >= (0)::numeric) AND (accuracy_m <= (10000)::numeric)))),
    CONSTRAINT driver_locations_heading_deg_check CHECK (((heading_deg IS NULL) OR ((heading_deg >= (0)::numeric) AND (heading_deg <= (360)::numeric)))),
    CONSTRAINT driver_locations_lat_check CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision))),
    CONSTRAINT driver_locations_lng_check CHECK (((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision))),
    CONSTRAINT driver_locations_speed_mps_check CHECK (((speed_mps IS NULL) OR ((speed_mps >= (0)::numeric) AND (speed_mps <= (100)::numeric))))
);


--
-- Name: drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drivers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    phone character varying(15) NOT NULL,
    password_hash text NOT NULL,
    vehicle_type text NOT NULL,
    vehicle_number text NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    avg_rating numeric(3,2),
    total_trips integer DEFAULT 0 NOT NULL,
    needs_review boolean DEFAULT false NOT NULL,
    rejection_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    email text,
    dob date,
    gender text,
    city text,
    state text,
    address text,
    vehicle_make text,
    vehicle_model text,
    vehicle_year integer,
    capacity_kg integer,
    fuel_type text,
    ownership text,
    license_number text,
    license_type text,
    license_expiry date,
    license_state text,
    rc_number text,
    insurance_expiry date,
    pollution_expiry date,
    permit_number text,
    service_city text,
    service_state text,
    service_areas text,
    service_radius_km integer,
    emergency_name text,
    emergency_relation text,
    emergency_phone text,
    application_ref text NOT NULL,
    consent_at timestamp with time zone,
    upi_id text,
    CONSTRAINT drivers_address_ck CHECK (((address IS NULL) OR ((char_length(address) >= 5) AND (char_length(address) <= 500)))),
    CONSTRAINT drivers_capacity_ck CHECK (((capacity_kg IS NULL) OR ((capacity_kg >= 0) AND (capacity_kg <= 50000)))),
    CONSTRAINT drivers_city_ck CHECK (((city IS NULL) OR ((char_length(city) >= 2) AND (char_length(city) <= 120)))),
    CONSTRAINT drivers_dob_eligible CHECK (((dob IS NULL) OR ((dob <= (CURRENT_DATE - '18 years'::interval)) AND (dob >= (CURRENT_DATE - '100 years'::interval))))),
    CONSTRAINT drivers_email_fmt CHECK (((email IS NULL) OR ((char_length(email) <= 120) AND (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text)))),
    CONSTRAINT drivers_emg_phone_ck CHECK (((emergency_phone IS NULL) OR (emergency_phone ~ '^[6-9][0-9]{9}$'::text))),
    CONSTRAINT drivers_fuel_ck CHECK (((fuel_type IS NULL) OR (fuel_type = ANY (ARRAY['diesel'::text, 'petrol'::text, 'cng'::text, 'electric'::text, 'other'::text])))),
    CONSTRAINT drivers_gender_ck CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['male'::text, 'female'::text, 'other'::text, 'prefer_not_to_say'::text])))),
    CONSTRAINT drivers_license_expiry_ck CHECK (((license_expiry IS NULL) OR (license_expiry > CURRENT_DATE))),
    CONSTRAINT drivers_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 80))),
    CONSTRAINT drivers_ownership_ck CHECK (((ownership IS NULL) OR (ownership = ANY (ARRAY['owned'::text, 'financed'::text, 'rented'::text, 'other'::text])))),
    CONSTRAINT drivers_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text)),
    CONSTRAINT drivers_radius_ck CHECK (((service_radius_km IS NULL) OR ((service_radius_km >= 1) AND (service_radius_km <= 200)))),
    CONSTRAINT drivers_state_ck CHECK (((state IS NULL) OR ((char_length(state) >= 2) AND (char_length(state) <= 80)))),
    CONSTRAINT drivers_upi_id_ck CHECK (((upi_id IS NULL) OR (upi_id ~ '^[\w.\-]{2,255}@[a-zA-Z]{2,64}$'::text))),
    CONSTRAINT drivers_vehicle_number_check CHECK (((char_length(vehicle_number) >= 4) AND (char_length(vehicle_number) <= 20))),
    CONSTRAINT drivers_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['Pickup'::text, 'Mini Truck'::text, 'Mini Tractor'::text]))),
    CONSTRAINT drivers_vehicle_year_ck CHECK (((vehicle_year IS NULL) OR ((vehicle_year >= 1990) AND (vehicle_year <= 2100))))
);


--
-- Name: enterprise_inquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.enterprise_inquiries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    phone character varying(15) NOT NULL,
    company_name text NOT NULL,
    website text,
    designation text,
    business_type text,
    company_size text,
    cities text,
    operating_state text,
    locations_count integer,
    services_required text[] DEFAULT '{}'::text[] NOT NULL,
    vehicle_types text[] DEFAULT '{}'::text[] NOT NULL,
    fleet_size text,
    monthly_trips text,
    start_date date,
    service_frequency text,
    budget_range text,
    requirements text,
    status text DEFAULT 'NEW'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enterprise_inquiries_cities_check CHECK (((cities IS NULL) OR (char_length(cities) <= 300))),
    CONSTRAINT enterprise_inquiries_company_name_check CHECK (((char_length(company_name) >= 2) AND (char_length(company_name) <= 160))),
    CONSTRAINT enterprise_inquiries_designation_check CHECK (((designation IS NULL) OR (char_length(designation) <= 100))),
    CONSTRAINT enterprise_inquiries_email_check CHECK (((char_length(email) <= 160) AND (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::text))),
    CONSTRAINT enterprise_inquiries_full_name_check CHECK (((char_length(full_name) >= 2) AND (char_length(full_name) <= 100))),
    CONSTRAINT enterprise_inquiries_locations_count_check CHECK (((locations_count IS NULL) OR ((locations_count >= 1) AND (locations_count <= 100000)))),
    CONSTRAINT enterprise_inquiries_operating_state_check CHECK (((operating_state IS NULL) OR (char_length(operating_state) <= 80))),
    CONSTRAINT enterprise_inquiries_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text)),
    CONSTRAINT enterprise_inquiries_requirements_check CHECK (((requirements IS NULL) OR (char_length(requirements) <= 1000))),
    CONSTRAINT enterprise_inquiries_status_check CHECK ((status = ANY (ARRAY['NEW'::text, 'CONTACTED'::text, 'IN_DISCUSSION'::text, 'CONVERTED'::text, 'CLOSED'::text]))),
    CONSTRAINT enterprise_inquiries_website_check CHECK (((website IS NULL) OR (char_length(website) <= 255)))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    user_id uuid NOT NULL,
    key text NOT NULL,
    booking_id uuid NOT NULL,
    request_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_key_check CHECK (((char_length(key) >= 1) AND (char_length(key) <= 64)))
);


--
-- Name: password_reset_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone character varying(15) NOT NULL,
    otp_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT password_reset_otps_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT password_reset_otps_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text))
);


--
-- Name: payment_adjustments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    commission_delta_paise integer NOT NULL,
    earning_delta_paise integer NOT NULL,
    reason text NOT NULL,
    admin_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payment_adjustments_nonzero_ck CHECK (((commission_delta_paise <> 0) OR (earning_delta_paise <> 0))),
    CONSTRAINT payment_adjustments_reason_check CHECK (((char_length(reason) >= 3) AND (char_length(reason) <= 500)))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    user_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    gross_amount numeric(10,2) NOT NULL,
    payment_method text NOT NULL,
    payment_status text NOT NULL,
    driver_earning numeric(10,2) NOT NULL,
    platform_commission numeric(10,2) NOT NULL,
    commission_pct numeric(5,2) NOT NULL,
    settlement_status text DEFAULT 'owed'::text NOT NULL,
    settled_amount numeric(10,2) DEFAULT 0 NOT NULL,
    collected_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cash_confirmed_at timestamp with time zone,
    CONSTRAINT payments_cash_confirm_ck CHECK (((cash_confirmed_at IS NULL) OR (payment_method = 'cash'::text))),
    CONSTRAINT payments_commission_pct_check CHECK (((commission_pct >= (0)::numeric) AND (commission_pct <= (100)::numeric))),
    CONSTRAINT payments_driver_earning_check CHECK ((driver_earning >= (0)::numeric)),
    CONSTRAINT payments_gross_amount_check CHECK ((gross_amount >= (0)::numeric)),
    CONSTRAINT payments_payment_method_check CHECK ((payment_method = ANY (ARRAY['cash'::text, 'online'::text, 'upi'::text]))),
    CONSTRAINT payments_payment_status_check CHECK ((payment_status = ANY (ARRAY['collected'::text, 'pending'::text, 'failed'::text, 'refunded'::text]))),
    CONSTRAINT payments_platform_commission_check CHECK ((platform_commission >= (0)::numeric)),
    CONSTRAINT payments_settled_amount_check CHECK ((settled_amount >= (0)::numeric)),
    CONSTRAINT payments_settlement_status_check CHECK ((settlement_status = ANY (ARRAY['owed'::text, 'partial'::text, 'settled'::text]))),
    CONSTRAINT payments_split_ck CHECK (((driver_earning + platform_commission) = gross_amount))
);


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_history (
    id integer NOT NULL,
    vehicle_type text NOT NULL,
    old_base_rs numeric(10,2),
    old_per_km_rs numeric(10,2),
    old_helper_rs numeric(10,2),
    new_base_rs numeric(10,2) NOT NULL,
    new_per_km_rs numeric(10,2) NOT NULL,
    new_helper_rs numeric(10,2) NOT NULL,
    changed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pricing_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pricing_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pricing_history_id_seq OWNED BY public.pricing_history.id;


--
-- Name: pricing_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_rules (
    id integer NOT NULL,
    vehicle_type text NOT NULL,
    base_rs numeric(10,2) NOT NULL,
    per_km_rs numeric(10,2) NOT NULL,
    helper_rs numeric(10,2) DEFAULT 200 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_percent numeric(5,2) DEFAULT 15 NOT NULL,
    CONSTRAINT pricing_commission_pct_ck CHECK (((commission_percent >= (0)::numeric) AND (commission_percent <= (100)::numeric))),
    CONSTRAINT pricing_rules_base_rs_check CHECK ((base_rs >= (0)::numeric)),
    CONSTRAINT pricing_rules_helper_rs_check CHECK ((helper_rs >= (0)::numeric)),
    CONSTRAINT pricing_rules_per_km_rs_check CHECK ((per_km_rs >= (0)::numeric)),
    CONSTRAINT pricing_rules_vehicle_type_check CHECK ((vehicle_type = ANY (ARRAY['Pickup'::text, 'Mini Truck'::text, 'Mini Tractor'::text])))
);


--
-- Name: pricing_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pricing_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pricing_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pricing_rules_id_seq OWNED BY public.pricing_rules.id;


--
-- Name: ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ratings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    booking_id uuid NOT NULL,
    user_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    stars integer NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ratings_comment_check CHECK (((comment IS NULL) OR (char_length(comment) <= 500))),
    CONSTRAINT ratings_stars_check CHECK (((stars >= 1) AND (stars <= 5)))
);


--
-- Name: settlement_period_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_period_items (
    period_id uuid NOT NULL,
    payment_id uuid NOT NULL
);


--
-- Name: settlement_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlement_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    week_start date NOT NULL,
    week_end date NOT NULL,
    gross_paise bigint NOT NULL,
    commission_paise bigint NOT NULL,
    earning_paise bigint NOT NULL,
    settled_paise bigint DEFAULT 0 NOT NULL,
    status text DEFAULT 'DUE'::text NOT NULL,
    dispute_reason text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_periods_commission_paise_check CHECK ((commission_paise >= 0)),
    CONSTRAINT settlement_periods_dispute_reason_check CHECK (((dispute_reason IS NULL) OR ((char_length(dispute_reason) >= 3) AND (char_length(dispute_reason) <= 500)))),
    CONSTRAINT settlement_periods_earning_paise_check CHECK ((earning_paise >= 0)),
    CONSTRAINT settlement_periods_gross_paise_check CHECK ((gross_paise >= 0)),
    CONSTRAINT settlement_periods_settled_ck CHECK ((settled_paise <= gross_paise)),
    CONSTRAINT settlement_periods_settled_paise_check CHECK ((settled_paise >= 0)),
    CONSTRAINT settlement_periods_status_check CHECK ((status = ANY (ARRAY['DUE'::text, 'PARTIALLY_PAID'::text, 'PAID'::text, 'DISPUTED'::text]))),
    CONSTRAINT settlement_periods_week_ck CHECK (((week_end = (week_start + 6)) AND (EXTRACT(isodow FROM week_start) = (1)::numeric)))
);


--
-- Name: settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    amount numeric(10,2) NOT NULL,
    method text NOT NULL,
    reference_no text,
    admin_id uuid,
    notes text,
    settled_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settlement_period_id uuid,
    CONSTRAINT settlements_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT settlements_method_check CHECK ((method = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'upi'::text]))),
    CONSTRAINT settlements_notes_check CHECK (((notes IS NULL) OR (char_length(notes) <= 500))),
    CONSTRAINT settlements_reference_no_check CHECK (((reference_no IS NULL) OR ((char_length(reference_no) >= 2) AND (char_length(reference_no) <= 100))))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    phone character varying(15) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 80))),
    CONSTRAINT users_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text))
);


--
-- Name: wa_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wa_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    phone character varying(15) NOT NULL,
    state text DEFAULT 'START'::text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    booking_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wa_conversations_phone_check CHECK (((phone)::text ~ '^[6-9][0-9]{9}$'::text))
);


--
-- Name: commission_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_history ALTER COLUMN id SET DEFAULT nextval('public.commission_history_id_seq'::regclass);


--
-- Name: pricing_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_history ALTER COLUMN id SET DEFAULT nextval('public.pricing_history_id_seq'::regclass);


--
-- Name: pricing_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules ALTER COLUMN id SET DEFAULT nextval('public.pricing_rules_id_seq'::regclass);


--
-- Data for Name: admins; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.admins (id, name, phone, password_hash, created_at) FROM stdin;
f417b1e7-7001-4cd3-8e45-4183aa1facf7	E2E Staff	9840013692	$2b$04$H9.9RlApt/Fzn2Ux7Kr4VOs125XdC1ED0Gsl0iEI1.TmNdE.m9NnW	2026-10-04 16:46:55.46429+00
ed642e9c-ab89-485e-b290-67ffcd1790b8	Smoke Admin	9876543210	$2b$12$s4NNBjPjcJiypjVABKe4LeK4YnZqy5loTTD3FV95/5psI0IR4b7su	2026-09-30 19:29:50.921182+00
\.


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.audit_logs (id, admin_id, action, entity, entity_id, details, created_at) FROM stdin;
f39ed934-74b1-4830-95a6-1b632b287ccd	ed642e9c-ab89-485e-b290-67ffcd1790b8	inquiry.status	enterprise_inquiry	c1f4bb72-9fe7-4621-8c24-441e710e4e38	{"status": "CONTACTED"}	2026-09-30 20:14:46.667005+00
29d28094-f8e3-4882-bff3-77bd0185f93b	ed642e9c-ab89-485e-b290-67ffcd1790b8	inquiry.status	enterprise_inquiry	17d7f9fd-6f59-471d-b45b-b5b6cae3cf33	{"status": "CONTACTED"}	2026-09-30 20:15:26.691285+00
0d8d1d0c-27e6-4071-b4ec-ba6dcbc1afeb	ed642e9c-ab89-485e-b290-67ffcd1790b8	inquiry.status	enterprise_inquiry	b0172e96-8880-4565-acb6-56c363a45c39	{"status": "CONTACTED"}	2026-10-01 14:07:46.886057+00
9abc5e99-ed66-428a-a4c1-ad9558cc92b9	ed642e9c-ab89-485e-b290-67ffcd1790b8	driver.verify	driver	09c2dfaa-611c-44e3-ac87-6a80ceb7475d	{}	2026-10-01 19:43:35.693925+00
0885066e-bc2a-4927-a53c-3b41d79f625b	ed642e9c-ab89-485e-b290-67ffcd1790b8	inquiry.status	enterprise_inquiry	1ac6b3cc-6f02-4dda-bf5b-f6b871347669	{"status": "CONTACTED"}	2026-10-01 19:43:36.384154+00
e539452f-724a-4c52-98d0-74ddb76300d3	\N	payment.collected	payment	ed7fdd0a-a722-4e55-b9b9-059c983f7834	{"gross_rs": 640, "booking_id": "8fbd3bdf-3f78-4af0-a957-eae899ba5334"}	2026-10-04 16:47:13.959823+00
36c2a6c5-8616-446a-9640-696e763b2423	\N	payment.created	payment	c63ea18b-395b-4cc2-9128-bbdc64c6be20	{"gross_rs": 610, "booking_id": "452cf2a0-d8a5-482b-b888-80e83d474f09"}	2026-10-05 21:17:05.521776+00
e2ef0aa8-a298-4b4a-bcb4-a2409305c28b	\N	payment.created	payment	a1456e54-edfe-4488-a3eb-f5da7638d977	{"gross_rs": 640, "booking_id": "929c40e1-89ee-4275-aa78-f823af8c8a4f"}	2026-10-07 12:14:38.824575+00
c24f2dac-6c89-48fb-8cee-8c0e5fd99bae	\N	booking.created	booking	8dfbd16b-6735-45ce-8016-8022d1dc5b5a	{"user_id": "d2415230-127e-43b5-b882-b3d34cf54d1a", "price_rs": "670.00", "vehicle_type": "pickup"}	2026-10-07 13:08:08.759268+00
0b3f1e50-3dcc-4412-b3f2-669003a768ce	\N	booking.created	booking	0b1a8b31-dcd3-4f97-993e-ed611477cdb7	{"user_id": "4f2a53f4-b838-4ac2-91db-836770b800d5", "price_rs": "640.00", "vehicle_type": "mini_truck"}	2026-10-07 13:58:15.666699+00
89771e7d-345f-41f4-818a-10759593fa1d	\N	booking.created	booking	e5eeaee9-265f-4c8b-afdc-c1807a6afa03	{"user_id": "d2415230-127e-43b5-b882-b3d34cf54d1a", "price_rs": "950.00", "vehicle_type": "mini_truck"}	2026-10-07 16:20:40.77744+00
718ff97e-9a58-494d-99ff-9660221a6a81	\N	payment.collected	payment	d22cbc4e-3b54-4ed3-a612-e18f6a1d6219	{"gross_rs": 640, "booking_id": "0b1a8b31-dcd3-4f97-993e-ed611477cdb7"}	2026-10-07 18:19:37.463925+00
6fdabf8f-24ff-4956-bb26-becffaac6824	\N	booking.created	booking	b5dd066d-f35e-4e62-9a71-f244de69e1fd	{"user_id": "d2415230-127e-43b5-b882-b3d34cf54d1a", "price_rs": "670.00", "vehicle_type": "pickup"}	2026-10-07 21:50:54.939935+00
d08af572-6189-40d7-9b7c-e3640474352e	\N	booking.created	booking	88b61928-1f82-4fb4-a332-b5ec8087774c	{"user_id": "932caca9-391d-4366-957e-8427a7fbd6d9", "price_rs": "890.00", "vehicle_type": "mini_truck"}	2026-10-13 19:50:29.733331+00
aa383d27-2a0e-4f94-b053-4b06662b856a	\N	booking.created	booking	63afed68-7a1e-4ca3-8331-ef4ca1188ef1	{"user_id": "932caca9-391d-4366-957e-8427a7fbd6d9", "price_rs": "1610.00", "vehicle_type": "mini_tractor"}	2026-10-13 20:01:20.818969+00
\.


--
-- Data for Name: bookings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.bookings (id, user_id, driver_id, vehicle_type, pickup_address, drop_address, pickup_lat, pickup_lng, drop_lat, drop_lng, item_description, distance_km, helper, price_rs, status, scheduled_at, delivered_at, created_at, updated_at, payment_method, cancel_reason, cancelled_by, cancelled_at, commission_percent, disputed, dispute_reason, booking_source) FROM stdin;
8fbd3bdf-3f78-4af0-a957-eae899ba5334	ab5d18e7-3901-4fe7-a9a1-21b545d593bb	c71e1274-5a2c-4bcc-8da6-6496f20038d5	Mini Truck	12 MG Road, Indore	45 AB Road, Indore	22.7196	75.8577	22.7296	75.8677		1.97	f	640.00	delivered	\N	2026-10-04 16:47:13.922228+00	2026-10-04 16:46:56.310759+00	2026-10-04 16:47:13.922228+00	upi	\N	\N	\N	15.00	f	\N	WEB
452cf2a0-d8a5-482b-b888-80e83d474f09	d2415230-127e-43b5-b882-b3d34cf54d1a	ad93fd3b-37af-4f81-8a8c-83746d475ba5	Mini Truck	Bob ji ka dera Near by Bissau hotel	Apex university jaipur	22.7196	75.8577	22.72	75.86	1 double bed, 2 furnithure ,1 Sofa, and 1 Refrigrator	0.31	f	610.00	delivered	2026-10-06 17:00:00+00	2026-10-05 21:17:05.501183+00	2026-10-05 20:56:24.404073+00	2026-10-05 21:17:05.501183+00	cash	\N	\N	\N	15.00	f	\N	WEB
54a6d612-7461-4f75-a692-68ad26f02e90	d2415230-127e-43b5-b882-b3d34cf54d1a	\N	Pickup	Apex University Jaipur	Sitapura Jaipur	26.898152185155052	75.82950571156329	26.77572903786941	75.82662590197405	1,double Bed,2 sofa,and 1 Refrigrator	17.70	t	860.00	pending	2026-10-15 14:40:00+00	\N	2026-10-07 08:10:48.481841+00	2026-10-07 08:10:48.481841+00	cash	\N	\N	\N	15.00	f	\N	WEB
094b8388-74ea-4f00-9748-98dae1a76b69	d2415230-127e-43b5-b882-b3d34cf54d1a	\N	Pickup	Apex institute of engineering and technology  Jaipur	Malvia nagar  near by GT  Mall Jaipur	26.767261367768427	75.85171414868968	26.919716636753385	75.7794495585261	2 double bed furniture,2 Refrigrator and 2  sofa	23.93	t	970.00	pending	2026-10-13 15:40:00+00	\N	2026-10-07 08:16:41.010981+00	2026-10-07 08:16:41.010981+00	cash	\N	\N	\N	15.00	f	\N	WEB
929c40e1-89ee-4275-aa78-f823af8c8a4f	f186d8b4-4cc0-458a-9f3b-2c3d9b3c1d37	a5ad7245-7e71-431c-98b0-32cf969f1220	Mini Truck	12 MG Road, Indore	45 AB Road, Indore	22.7196	75.8577	22.7296	75.8677		1.97	f	640.00	delivered	\N	2026-10-07 12:14:38.811681+00	2026-10-07 12:13:50.677883+00	2026-10-07 12:14:38.811681+00	cash	\N	\N	\N	15.00	f	\N	WEB
8dfbd16b-6735-45ce-8016-8022d1dc5b5a	d2415230-127e-43b5-b882-b3d34cf54d1a	\N	Pickup	Malvia Nagar Jaipur	Apex university Jaipur	26.937556335576467	75.79609394073488	26.898467932212867	75.82948207855226	1 table,2 double bed and 2 sofa	7.10	t	670.00	pending	2026-10-12 16:38:00+00	\N	2026-10-07 13:08:08.734672+00	2026-10-07 13:08:08.734672+00	cash	\N	\N	\N	15.00	f	\N	WEB
e5eeaee9-265f-4c8b-afdc-c1807a6afa03	d2415230-127e-43b5-b882-b3d34cf54d1a	\N	Mini Truck	Malvia Nagar Jaipur	Apex university Jaipur	26.937556335576467	75.79609394073488	26.89970220769648	75.82682132720947	1 sofa,1  table ,2 dyiening table ,2 refigrator	6.75	t	950.00	pending	2026-10-12 16:40:00+00	\N	2026-10-07 16:20:40.696998+00	2026-10-07 16:20:40.696998+00	cash	\N	\N	\N	15.00	f	\N	WEB
0b1a8b31-dcd3-4f97-993e-ed611477cdb7	4f2a53f4-b838-4ac2-91db-836770b800d5	ad93fd3b-37af-4f81-8a8c-83746d475ba5	Mini Truck	12 MG Road, Indore	45 AB Road, Indore	22.7196	75.8577	22.7296	75.8677	e2e samaan	1.97	f	640.00	delivered	\N	2026-10-07 18:19:37.448043+00	2026-10-07 13:58:15.646832+00	2026-10-07 18:19:37.448043+00	upi	\N	\N	\N	15.00	f	\N	WEB
5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	d2415230-127e-43b5-b882-b3d34cf54d1a	ad93fd3b-37af-4f81-8a8c-83746d475ba5	Mini Truck	Chanpol Jaipur	Apex university Jaipur	22.59372606392932	76.05487330567252	19.31114335506464	76.7403119171465	1 double bed, 4 boxes, 1 refrigerator	483.44	t	11680.00	arrived	2026-10-12 12:40:00+00	\N	2026-10-06 21:02:48.402324+00	2026-10-07 18:19:38.788916+00	cash	\N	\N	\N	15.00	f	\N	WEB
b5dd066d-f35e-4e62-9a71-f244de69e1fd	d2415230-127e-43b5-b882-b3d34cf54d1a	\N	Pickup	Malvia Nagar Jaipur	Apex university Jaipur	26.937556335576467	75.79609394073488	26.898467932212867	75.82943916320802	1 sofa,2 double bed ,3 furnitures  almari ,and 1 refrigrator	7.10	t	670.00	pending	2026-10-16 16:42:00+00	\N	2026-10-07 21:50:54.91192+00	2026-10-07 21:50:54.91192+00	cash	\N	\N	\N	15.00	f	\N	WEB
88b61928-1f82-4fb4-a332-b5ec8087774c	932caca9-391d-4366-957e-8427a7fbd6d9	\N	Mini Truck	Lajpat Nagar (Violet Line), Feroze Gandhi Road, Defence Colony Tehsil, Delhi - 110065, India	Okhla Sabzi Mandi, Captain Gaur Marg, Greater Kailash, Delhi - 110065, India	28.570652912719336	77.23646163940431	28.55829004400586	77.26289749145509	4 furniture Bed ,2 sofa ,1 Refrigrator and 4 Diening table	3.80	t	890.00	pending	2026-10-15 13:40:00+00	\N	2026-10-13 19:50:29.497251+00	2026-10-13 19:50:29.497251+00	cash	\N	\N	\N	15.00	f	\N	WEB
63afed68-7a1e-4ca3-8331-ef4ca1188ef1	932caca9-391d-4366-957e-8427a7fbd6d9	\N	Mini Tractor	Raja Park, Govind Marg, Adarsh Nagar, Jaipur Municipal Corporation - 302004, RJ, India	JECRC University, Mahal Road, Jagatpura, Jaipur Municipal Corporation - 302025, RJ, India	26.89813304894136	75.82317352294923	26.80763996403054	75.85512399673462	5 double bed,2 fridge ,and 2 Sofa	13.71	t	1610.00	pending	2026-10-17 09:35:00+00	\N	2026-10-13 20:01:20.788206+00	2026-10-13 20:01:20.788206+00	upi	\N	\N	\N	15.00	f	\N	WEB
\.


--
-- Data for Name: commission_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.commission_history (id, old_pct, new_pct, changed_by, created_at) FROM stdin;
\.


--
-- Data for Name: driver_declines; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.driver_declines (driver_id, booking_id, created_at) FROM stdin;
\.


--
-- Data for Name: driver_locations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.driver_locations (id, booking_id, driver_id, lat, lng, accuracy_m, speed_mps, recorded_at, heading_deg) FROM stdin;
7777df4e-5afa-4e32-9911-f69a499ce376	8fbd3bdf-3f78-4af0-a957-eae899ba5334	c71e1274-5a2c-4bcc-8da6-6496f20038d5	22.7196	75.8577	8.50	5.20	2026-10-04 16:46:56.464112+00	90.0
33c29f8b-603e-4e5e-aa7e-32a69074b025	8fbd3bdf-3f78-4af0-a957-eae899ba5334	c71e1274-5a2c-4bcc-8da6-6496f20038d5	22.7201	75.8581	\N	\N	2026-10-04 16:46:59.749951+00	135.5
d535bbfe-8279-4cc5-a194-ce6b175cb959	8fbd3bdf-3f78-4af0-a957-eae899ba5334	c71e1274-5a2c-4bcc-8da6-6496f20038d5	22.721	75.859	\N	\N	2026-10-04 16:47:03.086275+00	180.0
95f7dbe8-6d86-428d-8d34-69b9c86a05b2	8fbd3bdf-3f78-4af0-a957-eae899ba5334	c71e1274-5a2c-4bcc-8da6-6496f20038d5	22.721	75.859	\N	\N	2026-10-04 16:47:06.321365+00	180.0
9737b2d3-c972-455c-a03d-e740296a4064	929c40e1-89ee-4275-aa78-f823af8c8a4f	a5ad7245-7e71-431c-98b0-32cf969f1220	22.721	75.859	\N	\N	2026-10-07 12:13:50.793954+00	\N
ab24fcb4-0efb-42d5-84e6-272f1ecf25e1	929c40e1-89ee-4275-aa78-f823af8c8a4f	a5ad7245-7e71-431c-98b0-32cf969f1220	22.725	75.863	\N	\N	2026-10-07 12:13:54.853967+00	\N
ed271930-b9c8-4c23-ae53-5ac9ac27bb00	5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	ad93fd3b-37af-4f81-8a8c-83746d475ba5	26.930229875447015	75.809660425558	131.00	\N	2026-10-07 18:19:34.122045+00	\N
ae1f4503-713b-4cd3-9500-6dcd962c61c4	5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	ad93fd3b-37af-4f81-8a8c-83746d475ba5	26.930228626054895	75.8096781738354	137.00	\N	2026-10-07 18:19:54.829453+00	\N
d4e5f228-d511-4b95-98c4-6a9a0913ed3a	5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	ad93fd3b-37af-4f81-8a8c-83746d475ba5	26.93006617179414	75.80982578358261	182.00	\N	2026-10-07 18:22:48.95256+00	\N
aa88ae22-1d8f-4609-8fb1-570b3900cd8b	5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	ad93fd3b-37af-4f81-8a8c-83746d475ba5	26.930121215174687	75.80977804407804	129.00	\N	2026-10-07 18:23:03.147441+00	\N
f44d164d-1766-447d-aa74-ca6d886c32e0	5fc5dc63-abb8-48b7-bb5a-e49ce3d0bd34	ad93fd3b-37af-4f81-8a8c-83746d475ba5	26.930216662309096	75.80970133015249	113.00	\N	2026-10-07 21:51:45.303361+00	\N
\.


--
-- Data for Name: drivers; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.drivers (id, name, phone, password_hash, vehicle_type, vehicle_number, is_verified, is_active, avg_rating, total_trips, needs_review, rejection_reason, created_at, email, dob, gender, city, state, address, vehicle_make, vehicle_model, vehicle_year, capacity_kg, fuel_type, ownership, license_number, license_type, license_expiry, license_state, rc_number, insurance_expiry, pollution_expiry, permit_number, service_city, service_state, service_areas, service_radius_km, emergency_name, emergency_relation, emergency_phone, application_ref, consent_at, upi_id) FROM stdin;
35ab9b04-1bb2-4543-845d-5f0a94bc7d16	Dbg	9900001122	$2b$12$zAFmy2aVDZx2yFnscrAq/.9TgbbwgiGTy3xCY.BWzbhWykQv7UirW	Mini Truck	MP09D1111	f	t	\N	0	f	\N	2026-10-07 13:58:25.101745+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-70131A	\N	\N
43b64c83-4e06-47aa-8fcd-3b184480feb3	Dbg2	9900001133	$2b$12$MSZLw3UuPczKf2NFNFv3zeWMB6fKB64DwmVVmUoCMNAC4x2C0NlbW	Mini Truck	MP09D2222	f	t	\N	0	f	\N	2026-10-07 13:58:47.220908+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-1FAECF	\N	\N
ad93fd3b-37af-4f81-8a8c-83746d475ba5	Shyam	8527281618	$2b$12$3Wo2ONaXSJ8qxBVk6JHnn.5t5997q6vJ9E3NiaR1APC46UmS5Pvay	Mini Truck	JP08 2023756	t	t	2.00	2	f	\N	2026-10-05 21:08:29.332069+00	shayam@123gmail.com	\N	\N	Jaipur	\N	\N	\N	Tata Ace	2023	760	\N	\N	MP09 22346789761	\N	2030-02-10	\N	RJ14-DEMO-001	2030-02-10	\N	\N	Jaipur	\N	\N	\N	\N	\N	\N	AS-2026-9F0BE0	2026-10-05 21:08:29.332069+00	\N
f943bf26-9055-46fc-8e39-923125405429	Test Driver	9830000001	$2b$12$6h4zE2ySl58pq7wAipWLm.w/oZErP.QI13brzCmLuYX15rIeIKq7C	Mini Truck	MP09T1234	t	t	\N	0	f	\N	2026-10-05 21:00:37.691164+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-729EEA	\N	\N
c71e1274-5a2c-4bcc-8da6-6496f20038d5	E2E Driver	9820013692	$2b$12$ksrsb7E.Eb1Vvy1bfPdtNeqE8tghu.q310SAlH9o67f7Cqd.Fs6xW	Mini Truck	MP09E2E3692	t	t	\N	1	f	\N	2026-10-04 16:46:55.375526+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-D94383	\N	\N
a5ad7245-7e71-431c-98b0-32cf969f1220	E2E Driver	9841000002	$2b$12$7ZfT//mrsf.Jt0mt0JQIxOHveY7JJREz1y.rPRKXmPW5HvQkyocgW	Mini Truck	MP09E2E01	t	t	\N	1	f	\N	2026-10-07 12:11:47.533157+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-F54905	\N	\N
c48baee9-9ba4-4fad-92a7-77b311d38bd0	E2E A	9810094639	$2b$12$zqfnvDrtFd4xMacJRmao9.Z7khwfATUoKuJPSTSP64yZYTp/o8PPC	Mini Truck	MP09E24639	f	t	\N	0	f	\N	2026-10-07 13:58:15.30157+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-6B3157	\N	\N
eabf1b8d-6698-41b8-a107-735fe386d76b	E2E B	9820094639	$2b$12$c2JzY12qvPNUxhsLVBC7wOABmcvNaZRP9/D3tTMrRliDsvXu0twDa	Mini Truck	MP09E34639	f	t	\N	0	f	\N	2026-10-07 13:58:15.607432+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-97E5D0	\N	\N
f957656b-be34-45d8-b8ff-47bfb2a68cf8	Smoke Driver	9709446879	$2b$12$3jxAz7dz5YLZRWbCfEAvee1gvJa3nDCAWOV7PnddUgNn1cPRAk0Om	Mini Truck	SM446390	f	t	\N	0	f	\N	2026-10-07 21:44:07.325968+00	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	\N	AS-2026-0A33F5	\N	\N
709a7ea4-5c63-479b-a4c8-89203dc299c3	Vikky Kumar	8527281613	$2b$12$AuBOXJbDlnkegZ8q0H9XDu3UshTdZ/OUwH.oVOdRWfWbarRktYSp.	Mini Truck	JP 03 3037384913	f	t	\N	0	f	\N	2026-10-07 21:56:34.411509+00	vikky@123gmail.com	\N	\N	Jaipur	\N	\N	\N	Bolero Pickup	2023	1000	\N	\N	MP09 223389764563	\N	2026-10-13	\N	RJ14-DEMO-001	2030-10-12	\N	\N	Jaipur	\N	\N	\N	\N	\N	\N	AS-2026-917FEF	2026-10-07 21:56:34.411509+00	\N
\.


--
-- Data for Name: enterprise_inquiries; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.enterprise_inquiries (id, full_name, email, phone, company_name, website, designation, business_type, company_size, cities, operating_state, locations_count, services_required, vehicle_types, fleet_size, monthly_trips, start_date, service_frequency, budget_range, requirements, status, created_at, updated_at) FROM stdin;
053cea3d-258d-498a-b53d-39d2878af74f	Rahul Sharma	rahul@sharmacorp.in	9876543210	Sharma Retail	https://example.com	Manager	retail	11-50	Delhi, Noida	Delhi	5	{local_delivery}	{mini_truck}	6-20	1-100	2026-10-09	weekly	25k_50k	Need daily store deliveries	NEW	2026-10-07 09:23:40.3688+00	2026-10-07 09:23:40.3688+00
4702bc74-2f6d-4214-9d61-e5f56ba25601	Rahul Sharma	rahul2@sharmacorp.in	9876543211	Sharma Retail2	https://example.com	\N	\N	\N	\N	\N	\N	{}	{}	\N	\N	\N	\N	\N	\N	NEW	2026-10-07 09:24:33.000627+00	2026-10-07 09:24:33.000627+00
721c97b9-643a-4116-aaa6-8c630363a353	Mohammad Junaid Isha	mdshahabuddinktr1370@gmail.com	9587839871	Apnashift	https://github.com/mdshahabuddin-ml/portfolio_websites	Operational Manager	ecommerce	1-10	Jaipur	Rajasthan	2	{local_delivery,goods_transport}	{mini_truck}	1-5	1-100	2026-10-12	daily	under_25k	Implement the ApnaShift Enterprise Page as a professional B2B enterprise inquiry form. Use English-only text. Include company/business information, contact details, business type, number of vehicles required, monthly trips, start date, service frequency, budget range, requirements textarea with a 1000-character limit and live counter, mandatory business communication consent checkbox, and Submit button. Add complete frontend and backend validation, prevent duplicate submissions, show loading/success/error states, and connect the form to POST /api/enterprise/inquiry. Store all submitted information in the existing enterprise_inquiries PostgreSQL table with default status NEW. Do not break or modify unrelated pages, APIs, database tables, authentication, or existing functionality. Make the UI responsive, accessible, and professional for Indian business customers.	NEW	2026-10-07 09:42:03.984946+00	2026-10-07 09:42:03.984946+00
5515a25e-2582-4273-ac83-5524aee81758	WA Test	watest1791366971@company.com	9876543220	WACo1791366971 Pvt Ltd	\N	\N	\N	\N	\N	\N	\N	{}	{}	\N	\N	\N	\N	\N	\N	NEW	2026-10-07 09:56:11.597358+00	2026-10-07 09:56:11.597358+00
\.


--
-- Data for Name: idempotency_keys; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.idempotency_keys (user_id, key, booking_id, request_hash, created_at) FROM stdin;
\.


--
-- Data for Name: password_reset_otps; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.password_reset_otps (id, phone, otp_hash, expires_at, attempts, created_at) FROM stdin;
\.


--
-- Data for Name: payment_adjustments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payment_adjustments (id, payment_id, commission_delta_paise, earning_delta_paise, reason, admin_id, created_at) FROM stdin;
\.


--
-- Data for Name: payments; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.payments (id, booking_id, user_id, driver_id, gross_amount, payment_method, payment_status, driver_earning, platform_commission, commission_pct, settlement_status, settled_amount, collected_at, created_at, cash_confirmed_at) FROM stdin;
ed7fdd0a-a722-4e55-b9b9-059c983f7834	8fbd3bdf-3f78-4af0-a957-eae899ba5334	ab5d18e7-3901-4fe7-a9a1-21b545d593bb	c71e1274-5a2c-4bcc-8da6-6496f20038d5	640.00	upi	collected	544.00	96.00	15.00	owed	0.00	2026-10-04 16:47:13.922228+00	2026-10-04 16:47:13.922228+00	\N
c63ea18b-395b-4cc2-9128-bbdc64c6be20	452cf2a0-d8a5-482b-b888-80e83d474f09	d2415230-127e-43b5-b882-b3d34cf54d1a	ad93fd3b-37af-4f81-8a8c-83746d475ba5	610.00	cash	pending	518.50	91.50	15.00	owed	0.00	2026-10-05 21:17:05.501183+00	2026-10-05 21:17:05.501183+00	\N
a1456e54-edfe-4488-a3eb-f5da7638d977	929c40e1-89ee-4275-aa78-f823af8c8a4f	f186d8b4-4cc0-458a-9f3b-2c3d9b3c1d37	a5ad7245-7e71-431c-98b0-32cf969f1220	640.00	cash	pending	544.00	96.00	15.00	owed	0.00	2026-10-07 12:14:38.811681+00	2026-10-07 12:14:38.811681+00	\N
d22cbc4e-3b54-4ed3-a612-e18f6a1d6219	0b1a8b31-dcd3-4f97-993e-ed611477cdb7	4f2a53f4-b838-4ac2-91db-836770b800d5	ad93fd3b-37af-4f81-8a8c-83746d475ba5	640.00	upi	collected	544.00	96.00	15.00	owed	0.00	2026-10-07 18:19:37.448043+00	2026-10-07 18:19:37.448043+00	\N
\.


--
-- Data for Name: platform_settings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.platform_settings (key, value, updated_by, updated_at) FROM stdin;
commission	{"pct": 15.00}	\N	2026-10-04 16:37:11.788141+00
\.


--
-- Data for Name: pricing_history; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pricing_history (id, vehicle_type, old_base_rs, old_per_km_rs, old_helper_rs, new_base_rs, new_per_km_rs, new_helper_rs, changed_by, created_at) FROM stdin;
\.


--
-- Data for Name: pricing_rules; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.pricing_rules (id, vehicle_type, base_rs, per_km_rs, helper_rs, updated_at, commission_percent) FROM stdin;
1	Pickup	350.00	17.50	200.00	2026-09-30 12:18:18.860168+00	15.00
2	Mini Truck	600.00	22.50	200.00	2026-09-30 12:18:18.860168+00	15.00
3	Mini Tractor	1000.00	30.00	200.00	2026-09-30 12:18:18.860168+00	15.00
\.


--
-- Data for Name: ratings; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.ratings (id, booking_id, user_id, driver_id, stars, comment, created_at) FROM stdin;
82eba6b0-7ba1-4b0e-b89b-ce9c35f8f7fb	452cf2a0-d8a5-482b-b888-80e83d474f09	d2415230-127e-43b5-b882-b3d34cf54d1a	ad93fd3b-37af-4f81-8a8c-83746d475ba5	2	Driver arrived at right time	2026-10-05 21:22:18.043779+00
\.


--
-- Data for Name: settlement_period_items; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settlement_period_items (period_id, payment_id) FROM stdin;
\.


--
-- Data for Name: settlement_periods; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settlement_periods (id, driver_id, week_start, week_end, gross_paise, commission_paise, earning_paise, settled_paise, status, dispute_reason, created_by, created_at) FROM stdin;
\.


--
-- Data for Name: settlements; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.settlements (id, driver_id, amount, method, reference_no, admin_id, notes, settled_at, created_at, settlement_period_id) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.users (id, name, phone, password_hash, created_at) FROM stdin;
ab5d18e7-3901-4fe7-a9a1-21b545d593bb	E2E User	9810013692	$2b$12$cuKG0Xwp94D7QSDv6Zr5UuwBVjLGptdb/Ua8JfAKXzVyglPqOKBSO	2026-10-04 16:46:54.620848+00
14223720-a926-4a49-b37b-ba1801a9e152	Stranger	9830013692	$2b$12$8YUlaeLZ4DYoq2CHthK3/.b40SDa4QGr27U1YFWHsVWjHpt7h5M8e	2026-10-04 16:46:56.278764+00
d2415230-127e-43b5-b882-b3d34cf54d1a	Local Test	9881000001	$2b$12$R74/ROeRN2MtDs037D.YxuEMH8PevC6zGWPOuqk9AGC7egl2NNNIW	2026-10-05 16:12:56.652796+00
f186d8b4-4cc0-458a-9f3b-2c3d9b3c1d37	E2E User	9841000001	$2b$12$uSmd.QEf3GzCf0u2ZggjgeaxQnzvuP/5v.4RwSOGMun1aDdS8nTDO	2026-10-07 12:11:46.969247+00
4f2a53f4-b838-4ac2-91db-836770b800d5	E2E User	9800094639	$2b$12$m/AP19OFcT.9pzx0dlWRguYeQmiiFHdot6C2l4opZo3sr7tJ25wvm	2026-10-07 13:58:14.990965+00
b5e65023-0f32-4a1e-b449-41c08722369c	Smoke User	9809446390	$2b$12$7ZKlKzig2WVItgWGAMAmJ.U2a0Xjs6MISDP29q5yVxs.ctnV7qC2a	2026-10-07 21:44:06.846007+00
932caca9-391d-4366-957e-8427a7fbd6d9	Mohammad Rahman	9853246514	$2b$12$JtLqLdmadQt.lOFVBcL5LuMjrtAEga2r1BmbKgw467BcyiO/v9D0i	2026-10-13 19:45:30.037987+00
\.


--
-- Data for Name: wa_conversations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.wa_conversations (id, phone, state, data, booking_id, created_at, updated_at) FROM stdin;
\.


--
-- Name: commission_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.commission_history_id_seq', 1, false);


--
-- Name: pricing_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pricing_history_id_seq', 1, false);


--
-- Name: pricing_rules_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.pricing_rules_id_seq', 45, true);


--
-- Name: admins admins_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_phone_key UNIQUE (phone);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: commission_history commission_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_history
    ADD CONSTRAINT commission_history_pkey PRIMARY KEY (id);


--
-- Name: driver_declines driver_declines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_declines
    ADD CONSTRAINT driver_declines_pkey PRIMARY KEY (driver_id, booking_id);


--
-- Name: driver_locations driver_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_appref_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_appref_unique UNIQUE (application_ref);


--
-- Name: drivers drivers_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_email_unique UNIQUE (email);


--
-- Name: drivers drivers_license_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_license_unique UNIQUE (license_number);


--
-- Name: drivers drivers_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_phone_key UNIQUE (phone);


--
-- Name: drivers drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);


--
-- Name: enterprise_inquiries enterprise_inquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.enterprise_inquiries
    ADD CONSTRAINT enterprise_inquiries_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, key);


--
-- Name: password_reset_otps password_reset_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps
    ADD CONSTRAINT password_reset_otps_pkey PRIMARY KEY (id);


--
-- Name: payment_adjustments payment_adjustments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_adjustments
    ADD CONSTRAINT payment_adjustments_pkey PRIMARY KEY (id);


--
-- Name: payments payments_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_booking_id_key UNIQUE (booking_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: pricing_history pricing_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_history
    ADD CONSTRAINT pricing_history_pkey PRIMARY KEY (id);


--
-- Name: pricing_rules pricing_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_pkey PRIMARY KEY (id);


--
-- Name: pricing_rules pricing_rules_vehicle_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_rules
    ADD CONSTRAINT pricing_rules_vehicle_type_key UNIQUE (vehicle_type);


--
-- Name: ratings ratings_booking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_booking_id_key UNIQUE (booking_id);


--
-- Name: ratings ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_pkey PRIMARY KEY (id);


--
-- Name: settlement_period_items settlement_period_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_period_items
    ADD CONSTRAINT settlement_period_items_pkey PRIMARY KEY (period_id, payment_id);


--
-- Name: settlement_periods settlement_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_periods
    ADD CONSTRAINT settlement_periods_pkey PRIMARY KEY (id);


--
-- Name: settlement_periods settlement_periods_unique_ck; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_periods
    ADD CONSTRAINT settlement_periods_unique_ck UNIQUE (driver_id, week_start);


--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_reference_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_reference_no_key UNIQUE (reference_no);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: wa_conversations wa_conversations_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_conversations
    ADD CONSTRAINT wa_conversations_phone_key UNIQUE (phone);


--
-- Name: wa_conversations wa_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_conversations
    ADD CONSTRAINT wa_conversations_pkey PRIMARY KEY (id);


--
-- Name: enterprise_inquiries_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_inquiries_email_idx ON public.enterprise_inquiries USING btree (email);


--
-- Name: enterprise_inquiries_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX enterprise_inquiries_status_idx ON public.enterprise_inquiries USING btree (status, created_at DESC);


--
-- Name: idx_audit_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_admin ON public.audit_logs USING btree (admin_id);


--
-- Name: idx_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_created ON public.audit_logs USING btree (created_at DESC);


--
-- Name: idx_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_entity ON public.audit_logs USING btree (entity, entity_id);


--
-- Name: idx_bookings_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_available ON public.bookings USING btree (status, vehicle_type, created_at);


--
-- Name: idx_bookings_cancelled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_cancelled_at ON public.bookings USING btree (status, cancelled_at DESC);


--
-- Name: idx_bookings_delivered_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_delivered_at ON public.bookings USING btree (delivered_at DESC);


--
-- Name: idx_bookings_disputed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_disputed ON public.bookings USING btree (disputed, created_at DESC);


--
-- Name: idx_bookings_driver_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_driver_created ON public.bookings USING btree (driver_id, created_at DESC);


--
-- Name: idx_bookings_driver_delivered; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_driver_delivered ON public.bookings USING btree (driver_id, delivered_at DESC);


--
-- Name: idx_bookings_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_driver_id ON public.bookings USING btree (driver_id);


--
-- Name: idx_bookings_source_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_source_created ON public.bookings USING btree (booking_source, created_at DESC);


--
-- Name: idx_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_status ON public.bookings USING btree (status);


--
-- Name: idx_bookings_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_user_created ON public.bookings USING btree (user_id, created_at DESC);


--
-- Name: idx_bookings_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_user_id ON public.bookings USING btree (user_id);


--
-- Name: idx_driver_declines_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_declines_booking ON public.driver_declines USING btree (booking_id, created_at DESC);


--
-- Name: idx_driver_locations_booking_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_booking_time ON public.driver_locations USING btree (booking_id, recorded_at DESC);


--
-- Name: idx_driver_locations_driver_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_driver_time ON public.driver_locations USING btree (driver_id, recorded_at DESC);


--
-- Name: idx_driver_locations_recorded; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_driver_locations_recorded ON public.driver_locations USING btree (recorded_at DESC);


--
-- Name: idx_idempotency_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_idempotency_booking ON public.idempotency_keys USING btree (booking_id);


--
-- Name: idx_password_reset_otps_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_otps_expires ON public.password_reset_otps USING btree (expires_at);


--
-- Name: idx_password_reset_otps_phone_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_otps_phone_created ON public.password_reset_otps USING btree (phone, created_at DESC);


--
-- Name: idx_payment_adjustments_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_adjustments_payment ON public.payment_adjustments USING btree (payment_id, created_at);


--
-- Name: idx_payments_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_driver ON public.payments USING btree (driver_id, collected_at DESC);


--
-- Name: idx_payments_settlement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_settlement ON public.payments USING btree (settlement_status, collected_at DESC);


--
-- Name: idx_payments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_user ON public.payments USING btree (user_id, collected_at DESC);


--
-- Name: idx_pricing_hist_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_hist_vehicle ON public.pricing_history USING btree (vehicle_type);


--
-- Name: idx_ratings_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ratings_driver_id ON public.ratings USING btree (driver_id);


--
-- Name: idx_settlement_period_items_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_settlement_period_items_payment ON public.settlement_period_items USING btree (payment_id);


--
-- Name: idx_settlement_period_items_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_period_items_period ON public.settlement_period_items USING btree (period_id);


--
-- Name: idx_settlement_periods_driver_week; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_periods_driver_week ON public.settlement_periods USING btree (driver_id, week_start DESC);


--
-- Name: idx_settlement_periods_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlement_periods_status ON public.settlement_periods USING btree (status, week_end DESC);


--
-- Name: idx_settlements_driver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlements_driver ON public.settlements USING btree (driver_id, settled_at DESC);


--
-- Name: idx_settlements_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_settlements_period ON public.settlements USING btree (settlement_period_id);


--
-- Name: idx_wa_conversations_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_conversations_updated ON public.wa_conversations USING btree (updated_at DESC);


--
-- Name: bookings trg_bookings_trips; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bookings_trips AFTER INSERT OR DELETE OR UPDATE OF driver_id, status ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.sync_driver_trips();


--
-- Name: bookings trg_bookings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: ratings trg_ratings_refresh; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ratings_refresh AFTER INSERT OR DELETE OR UPDATE ON public.ratings FOR EACH ROW EXECUTE FUNCTION public.refresh_driver_stats();


--
-- Name: audit_logs audit_logs_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: bookings bookings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: commission_history commission_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commission_history
    ADD CONSTRAINT commission_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: driver_declines driver_declines_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_declines
    ADD CONSTRAINT driver_declines_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE RESTRICT;


--
-- Name: driver_declines driver_declines_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_declines
    ADD CONSTRAINT driver_declines_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: driver_locations driver_locations_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: driver_locations driver_locations_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_locations
    ADD CONSTRAINT driver_locations_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payment_adjustments payment_adjustments_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_adjustments
    ADD CONSTRAINT payment_adjustments_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: payment_adjustments payment_adjustments_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_adjustments
    ADD CONSTRAINT payment_adjustments_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;


--
-- Name: payments payments_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE RESTRICT;


--
-- Name: payments payments_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT;


--
-- Name: payments payments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: platform_settings platform_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: pricing_history pricing_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_history
    ADD CONSTRAINT pricing_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: ratings ratings_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: ratings ratings_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT;


--
-- Name: ratings ratings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ratings
    ADD CONSTRAINT ratings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: settlement_period_items settlement_period_items_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_period_items
    ADD CONSTRAINT settlement_period_items_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE RESTRICT;


--
-- Name: settlement_period_items settlement_period_items_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_period_items
    ADD CONSTRAINT settlement_period_items_period_id_fkey FOREIGN KEY (period_id) REFERENCES public.settlement_periods(id) ON DELETE CASCADE;


--
-- Name: settlement_periods settlement_periods_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_periods
    ADD CONSTRAINT settlement_periods_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: settlement_periods settlement_periods_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlement_periods
    ADD CONSTRAINT settlement_periods_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: settlements settlements_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_settlement_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_settlement_period_id_fkey FOREIGN KEY (settlement_period_id) REFERENCES public.settlement_periods(id) ON DELETE SET NULL;


--
-- Name: wa_conversations wa_conversations_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wa_conversations
    ADD CONSTRAINT wa_conversations_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

\unrestrict JfncDOzLh8WlYI3aDjTH3sqztQcd1efcV0s3AZXnYfh2QrKgae2DBNwobc1a8Up

