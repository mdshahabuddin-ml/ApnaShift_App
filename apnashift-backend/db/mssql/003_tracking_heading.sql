-- Migration 003 (MSSQL): live tracking — heading (compass direction).
-- Mirrors PostgreSQL db/migrations/015_tracking_heading.sql.
-- Reuses driver_locations (no new table). Devices without a compass send
-- NULL (frontend only sends heading_deg when Geolocation heading is valid).
-- Range 0..360 degrees clockwise from true north (same as Geolocation API).
-- Guarded: fresh DBs get the column from 001_schema; this adds it on
-- databases created before it existed (re-run safe, never destructive).
IF COL_LENGTH('driver_locations', 'heading_deg') IS NULL
  ALTER TABLE driver_locations ADD heading_deg DECIMAL(5, 1) NULL
    CONSTRAINT driver_locations_heading_ck
    CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360));
GO
