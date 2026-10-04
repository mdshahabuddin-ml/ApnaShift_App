// Zod schemas for live driver tracking. Coordinates validated here AND by
// DB CHECKs (migration 011) — never trust client GPS blindly.
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';
import { parseQuery } from './booking.js';

export { parseAuthBody as parseBody, parseQuery };

const latField = z
  .number({ invalid_type_error: 'lat number ho (-90 se 90).' })
  .min(-90, 'lat -90 se 90 ke beech.')
  .max(90, 'lat -90 se 90 ke beech.');

const lngField = z
  .number({ invalid_type_error: 'lng number ho (-180 se 180).' })
  .min(-180, 'lng -180 se 180 ke beech.')
  .max(180, 'lng -180 se 180 ke beech.');

// Driver GPS report. Server stamps recorded_at itself — client clocks lie.
// heading_deg follows the Geolocation API convention: degrees clockwise
// from true north (0..360). Devices without a compass send nothing (NULL).
export const locationReportSchema = z.object({
  lat: latField,
  lng: lngField,
  accuracy_m: z
    .number({ invalid_type_error: 'accuracy_m number ho.' })
    .min(0, 'accuracy_m 0 se kam nahi.')
    .max(10000, 'accuracy_m 10000 se zyada nahi.')
    .optional(),
  speed_mps: z
    .number({ invalid_type_error: 'speed_mps number ho.' })
    .min(0, 'speed_mps 0 se kam nahi.')
    .max(100, 'speed_mps 100 m/s se zyada nahi.')
    .optional(),
  heading_deg: z
    .number({ invalid_type_error: 'heading_deg number ho.' })
    .min(0, 'heading_deg 0 se 360 ke beech.')
    .max(360, 'heading_deg 0 se 360 ke beech.')
    .optional(),
});

// ?history=N recent points on the latest-location read (default 1, max 50).
export const locationQuerySchema = z.object({
  history: z.coerce.number().int().min(1).max(50).default(1),
});

// ?limit=N on the admin actives list (default 50, max 100).
export const trackingActivesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
