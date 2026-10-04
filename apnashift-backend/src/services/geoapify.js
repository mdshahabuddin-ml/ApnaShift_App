// Geoapify integration: geocode autocomplete + routing, server-side only.
// The API key lives in config.geoapifyKey (env GEOAPIFY_API_KEY) — this
// module is the ONLY place that puts it on a URL, and it never logs the
// URL/key. Responses are sanitized to { formatted, lat, lng } / route
// summary + geometry so no provider internals leak to clients.
import { config } from '../config.js';

function requireKey() {
  if (!config.geoapifyKey) {
    const err = new Error('geoapify_unavailable');
    err.status = 503;
    throw err;
  }
  return config.geoapifyKey;
}

// Sanitize autocomplete results: keep only what booking/tracking UIs need.
export async function geoapifyAutocomplete(text, limit = 5, bias = null, fetchFn = fetch) {
  const key = requireKey();
  const params = new URLSearchParams({
    text,
    limit: String(limit),
    format: 'json',
    apiKey: key,
  });
  // Bias results toward the operating city when the caller knows it.
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    params.set('bias', `proximity:${bias.lng},${bias.lat}`);
  }
  params.set('filter', 'countrycode:in');
  const res = await fetchFn(`https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`);
  if (!res.ok) {
    const err = new Error('geoapify_error');
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r) => typeof r?.lat === 'number' && typeof r?.lon === 'number')
    .slice(0, limit)
    .map((r) => ({
      formatted: r.formatted ?? r.address_line1 ?? text,
      lat: r.lat,
      lng: r.lon,
    }));
}

// Routing: pickup -> drop driving route. Returns distance/duration plus a
// decimated geometry (Geoapify returns full MultiLineString; we flatten to
// [lat,lng] pairs capped at 200 points for the Leaflet polyline).
export async function geoapifyRoute(pickup, drop, fetchFn = fetch) {
  const key = requireKey();
  const params = new URLSearchParams({
    waypoints: `${pickup.lat},${pickup.lng}|${drop.lat},${drop.lng}`,
    mode: 'drive',
    apiKey: key,
  });
  const res = await fetchFn(`https://api.geoapify.com/v1/routing?${params.toString()}`);
  if (!res.ok) {
    const err = new Error('geoapify_error');
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const feature = data?.features?.[0];
  const props = feature?.properties ?? {};
  const coords = feature?.geometry?.coordinates?.[0] ?? feature?.geometry?.coordinates ?? [];
  // Geometry is [lng,lat] pairs (possibly nested). Flatten one level.
  const flat = Array.isArray(coords[0]?.[0]) && typeof coords[0][0] !== 'number'
    ? coords.flat()
    : coords;
  const line = flat
    .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    .map(([lng, lat]) => ({ lat, lng }));
  // Decimate to max 200 points so the SSE/poll payloads stay small.
  const step = line.length > 200 ? Math.ceil(line.length / 200) : 1;
  const geometry = line.filter((_, i) => i % step === 0 || i === line.length - 1);
  return {
    distance_m: typeof props.distance === 'number' ? Math.round(props.distance) : null,
    duration_s: typeof props.time === 'number' ? Math.round(props.time) : null,
    geometry,
  };
}

// Tile template for the frontend Leaflet map. The key is embedded here
// (fetched at runtime via /api/geo/config, never hard-coded in HTML/JS).
// This is the standard public-map-key pattern — restrict it by HTTP
// referrer in the Geoapify dashboard so only ApnaShift origins can use it.
export function geoapifyTileTemplate() {
  if (!config.geoapifyKey) return null;
  return `https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}.png?apiKey=${config.geoapifyKey}`;
}
