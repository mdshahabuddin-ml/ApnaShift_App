// Har test file ke import se PEHLE chalta hai.
// src/config.js env ko import-time par padhta hai, isliye test wale
// values yahan set karna zaroori hai (test file me likhne se kaam nahi karega).
process.env.NODE_ENV ??= 'test';

// Test-only JWT secret (real secret kabhi yahan mat likho).
process.env.JWT_SECRET ??= 'test-only-secret-please-change-in-prod-1234567890';
process.env.JWT_EXPIRES_IN ??= '7d';

// Auth limiter tests me tang na kare (10 req wali limit yahan 1000).
process.env.AUTH_RATE_LIMIT_MAX ??= '1000';
// Write limiter bhi (booking/rating tests me kaafi requests hain).
process.env.WRITE_RATE_LIMIT_MAX ??= '1000';
// Global + estimate limiter bhi (poora suite ek process me chalta hai,
// ginati accumulate hoti hai — 100/60 default se 429 aata hai).
process.env.RATE_LIMIT_MAX ??= '10000';
process.env.ESTIMATE_RATE_LIMIT_MAX ??= '10000';
// Bcrypt fast (12 rounds me suite 30s+ lagta hai, 4 me same logic tez).
process.env.BCRYPT_ROUNDS ??= '4';

// Auth integration tests ko alag test DB chahiye:
//   TEST_DATABASE_URL=postgres://.../apnashift_test npx vitest run
// Set nahi hai to auth tests skip honge (health tests phir bhi chalenge).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
