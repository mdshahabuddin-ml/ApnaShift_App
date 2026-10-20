// Zod schemas for live driver tracking. Coordinates validated here AND by
// DB CHECKs (migration 011) — never trust client GPS blindly.
import { z } from 'zod';
import { parseBody as parseAuthBody } from './auth.js';
import { parseQuery } from './booking.js';

export { parseAuthBody as parseBody, parseQuery };

const latField = z
  .number({ invalid_type_error: 'lat must be a number (-90 to 90).' })
  .min(-90, 'lat must be between -90 and 90.')
  .max(90, 'lat must be between -90 and 90.');

const lngField = z
  .number({ invalid_type_error: 'lng must be a number (-180 to 180).' })
  .min(-180, 'lng must be between -180 and 180.')
  .max(180, 'lng must be between -180 and 180.');

// Driver GPS report. Server stamps recorded_at itself — client clocks lie.
// heading_deg follows the Geolocation API convention: degrees clockwise
// from true north (0..360). Devices without a compass send nothing (NULL).
export const locationReportSchema = z.object({
  lat: latField,
  lng: lngField,
  accuracy_m: z
    .number({ invalid_type_error: 'accuracy_m must be a number.' })
    .min(0, 'accuracy_m must be at least 0.')
    .max(10000, 'accuracy_m must be no more than 10000.')
    .optional(),
  speed_mps: z
    .number({ invalid_type_error: 'speed_mps must be a number.' })
    .min(0, 'speed_mps must be at least 0.')
    .max(100, 'speed_mps must be no more than 100 m/s.')
    .optional(),
  heading_deg: z
    .number({ invalid_type_error: 'heading_deg must be a number.' })
    .min(0, 'heading_deg must be between 0 and 360.')
    .max(360, 'heading_deg must be between 0 and 360.')
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
