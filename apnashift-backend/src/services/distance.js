// Distance providers. Interface: async (a, b) => km (number).
// a/b = { lat, lng }. Key kabhi log mat karo (URL me hoti hai).
import { config } from '../config.js';

export const ROAD_FACTOR = 1.3;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// (a) haversine: seedhi line x 1.3 road factor. Default, free, key nahi chahiye.
export function haversineKm(a, b) {
  const R = 6371; // earth radius km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const straight = 2 * Math.asin(Math.sqrt(s)) * R;
  return straight * ROAD_FACTOR;
}

// (b) google: Google Distance Matrix (driving). Sirf tab jab GOOGLE_MAPS_KEY set ho.
export async function googleDistanceKm(a, b) {
  if (!config.googleMapsKey) {
    throw new Error('GOOGLE_MAPS_KEY missing — DISTANCE_PROVIDER=google kaam nahi karega.');
  }
  const url =
    `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${a.lat},${a.lng}&destinations=${b.lat},${b.lng}` +
    `&mode=driving&key=${encodeURIComponent(config.googleMapsKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`google distance http ${res.status}`);
  }
  const data = await res.json();
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK' || typeof el.distance?.value !== 'number') {
    throw new Error(`google distance status: ${el?.status ?? 'unknown'}`);
  }
  return el.distance.value / 1000; // metres -> km
}

export const distanceProviders = {
  haversine: async (a, b) => haversineKm(a, b),
  google: googleDistanceKm,
};

// Provider DISTANCE_PROVIDER se chunta hai. 'google' bina key ke error dega —
// isliye key lagaye bina env mat badlo (README me switch guide hai).
export async function getDistanceKm(a, b) {
  if (config.distanceProvider === 'google') {
    return distanceProviders.google(a, b);
  }
  return distanceProviders.haversine(a, b);
}
