-- Migration 015: live tracking — heading (compass direction).
-- Reuses driver_locations (no new table). Devices without a compass send
-- NULL (frontend only sends heading_deg when Geolocation heading is valid).
-- Range 0..360 degrees clockwise from true north (same as Geolocation API).

ALTER TABLE driver_locations
  ADD COLUMN IF NOT EXISTS heading_deg NUMERIC(5, 1)
    CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360));
