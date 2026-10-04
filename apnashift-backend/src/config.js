// Central env config. All secrets come from process.env (.env file).
// When adding a secret, also add it to .env.example. Never log secrets.
import 'dotenv/config';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  bcryptRounds: num('BCRYPT_ROUNDS', 12),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  rateLimitWindowMs: num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  rateLimitMax: num('RATE_LIMIT_MAX', 100),
  authRateLimitWindowMs: num('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  authRateLimitMax: num('AUTH_RATE_LIMIT_MAX', 10),
  estimateRateLimitWindowMs: num('ESTIMATE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  estimateRateLimitMax: num('ESTIMATE_RATE_LIMIT_MAX', 60),
  writeRateLimitWindowMs: num('WRITE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  writeRateLimitMax: num('WRITE_RATE_LIMIT_MAX', 60),
  trustProxy: process.env.TRUST_PROXY ?? '',
  // Live tracking: dedicated limiter for driver GPS posts (GPS every few
  // seconds would blow through the generic write limiter).
  trackRateLimitWindowMs: num('TRACK_RATE_LIMIT_WINDOW_MS', 60 * 1000),
  trackRateLimitMax: num('TRACK_RATE_LIMIT_MAX', 60),
  // Minimum gap between two GPS posts from the same driver+booking.
  // Read per-request in services/tracking.js so tests can tune it via env.
  trackMinIntervalMs: num('TRACK_MIN_INTERVAL_MS', 3000),
  // Stale/offline thresholds for the live badge (ms since last point).
  trackStaleAfterMs: num('TRACK_STALE_AFTER_MS', 60 * 1000),
  trackOfflineAfterMs: num('TRACK_OFFLINE_AFTER_MS', 180 * 1000),
  // Operational retention for driver_locations (prune script).
  trackRetentionDays: num('TRACK_RETENTION_DAYS', 30),
  // Commission due cap (Rs): isse zyada baaki ho to driver naya accept nahi
  // kar sakta (admin assign unaffected). Gate reads env per-request.
  commissionDueLimitRs: num('COMMISSION_DUE_LIMIT', 1500),
  distanceProvider: process.env.DISTANCE_PROVIDER ?? 'haversine',
  googleMapsKey: process.env.GOOGLE_MAPS_KEY ?? '',
  // Geoapify (maps tiles + geocode autocomplete + routing). Key ONLY from
  // env (.env GEOAPIFY_API_KEY) — never hard-code, never log, never commit
  // .env. Frontend fetches the tile template via GET /api/geo/config;
  // geocode/route stay server-side proxied so the key is not scraped.
  geoapifyKey: process.env.GEOAPIFY_API_KEY ?? '',
};

if (config.env !== 'test') {
  if (!config.databaseUrl) {
    console.warn('[config] DATABASE_URL khaali hai — DB wale routes fail honge. .env check karo.');
  }
  if (!config.jwtSecret) {
    console.warn('[config] JWT_SECRET khaali hai — auth routes start nahi honge. .env me lamba random secret rakho.');
  }
}
