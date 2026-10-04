// Geoapify proxy (/api/geo/...). All routes require auth (any role) so the
// provider quota cannot be burned anonymously. Geocode + routing stay
// server-side — the Geoapify key never leaves the backend except inside the
// map tile template (standard public-map-key pattern, referrer-restricted
// in the Geoapify dashboard). Never log the key or full provider URL.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { geoAutocompleteSchema, geoRouteSchema, parseQuery } from '../validation/geo.js';
import {
  geoapifyAutocomplete,
  geoapifyRoute,
  geoapifyTileTemplate,
} from '../services/geoapify.js';
import { staleAfterMs, offlineAfterMs } from '../services/tracking.js';

export const geoRoutes = Router();

// Autocomplete + routing hit paid provider quota: dedicated limiter on top
// of the global /api limiter. Config (1 req/page) uses the global limiter only.
const geoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ok: false, error: 'too_many_attempts' },
});

// GET /api/geo/config — tile template (key embedded, fetched at runtime so
// HTML/JS never hard-codes it) + server tracking thresholds (no badge drift).
// Key missing -> enabled:false, frontend falls back to free OSM tiles.
geoRoutes.get('/config', requireAuth, async (req, res, next) => {
  try {
    const template = geoapifyTileTemplate();
    res.json({
      ok: true,
      geoapify: { enabled: template !== null },
      tiles: template
        ? {
          template,
          attribution: '&copy; OpenStreetMap contributors &copy; Geoapify',
        }
        : {
          template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution: '&copy; OpenStreetMap contributors',
        },
      thresholds: {
        stale_after_ms: staleAfterMs(),
        offline_after_ms: offlineAfterMs(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/geo/autocomplete?text=MG+Road&limit=5 — address suggestions.
geoRoutes.get('/autocomplete', requireAuth, geoLimiter, async (req, res, next) => {
  try {
    const { text, limit, lat, lng } = parseQuery(geoAutocompleteSchema, req.query);
    const results = await geoapifyAutocomplete(
      text,
      limit,
      lat !== undefined && lng !== undefined ? { lat, lng } : null,
    );
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/geo/route?pickup_lat=&pickup_lng=&drop_lat=&drop_lng= — driving
// route for the tracking map polyline (distance + duration + geometry).
geoRoutes.get('/route', requireAuth, geoLimiter, async (req, res, next) => {
  try {
    const q = parseQuery(geoRouteSchema, req.query);
    const route = await geoapifyRoute(
      { lat: q.pickup_lat, lng: q.pickup_lng },
      { lat: q.drop_lat, lng: q.drop_lng },
    );
    res.json({ ok: true, ...route });
  } catch (err) {
    next(err);
  }
});
