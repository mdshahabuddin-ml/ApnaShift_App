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
  distanceProvider: process.env.DISTANCE_PROVIDER ?? 'haversine',
  googleMapsKey: process.env.GOOGLE_MAPS_KEY ?? '',
};

if (config.env !== 'test') {
  if (!config.databaseUrl) {
    console.warn('[config] DATABASE_URL khaali hai — DB wale routes fail honge. .env check karo.');
  }
  if (!config.jwtSecret) {
    console.warn('[config] JWT_SECRET khaali hai — auth routes start nahi honge. .env me lamba random secret rakho.');
  }
}
