// Zod schemas for the Geoapify proxy (src/routes/geo.js). Coordinates are
// validated here — Geoapify is never called with out-of-range input.
import { z } from 'zod';
import { parseQuery as parseBookingQuery } from './booking.js';

export { parseBookingQuery as parseQuery };

const latField = z
  .coerce
  .number({ invalid_type_error: 'lat number ho (-90 se 90).' })
  .min(-90)
  .max(90);

const lngField = z
  .coerce
  .number({ invalid_type_error: 'lng number ho (-180 se 180).' })
  .min(-180)
  .max(180);

// GET /api/geo/autocomplete?text=...&limit=... (+ optional bias lat/lng).
export const geoAutocompleteSchema = z.object({
  text: z.string().trim().min(3).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(5),
  lat: latField.optional(),
  lng: lngField.optional(),
});

// GET /api/geo/route?pickup_lat=&pickup_lng=&drop_lat=&drop_lng=
export const geoRouteSchema = z.object({
  pickup_lat: latField,
  pickup_lng: lngField,
  drop_lat: latField,
  drop_lng: lngField,
});
