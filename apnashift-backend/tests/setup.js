// Runs BEFORE each test file's imports.
// src/config.js reads env at import time, so test values
// must be set here (setting them in test files will not work).
process.env.NODE_ENV ??= 'test';

// Test-only JWT secret (never put a real secret here).
process.env.JWT_SECRET ??= 'test-only-secret-please-change-in-prod-1234567890';
process.env.JWT_EXPIRES_IN ??= '7d';

// Keep auth limiter out of tests' way (10-req limit raised to 1000 here).
process.env.AUTH_RATE_LIMIT_MAX ??= '1000';
// Same for write limiter (booking/rating tests make many requests).
process.env.WRITE_RATE_LIMIT_MAX ??= '1000';
// Same for global + estimate limiters (whole suite runs in one process,
// counts accumulate — 100/60 defaults would return 429).
process.env.RATE_LIMIT_MAX ??= '10000';
process.env.ESTIMATE_RATE_LIMIT_MAX ??= '10000';
// Fast bcrypt (12 rounds take 30s+ for the suite, 4 is faster with same logic).
process.env.BCRYPT_ROUNDS ??= '4';

// Auth integration tests need a separate test DB:
//   TEST_DATABASE_URL=postgres://.../apnashift_test npx vitest run
// Auth tests skip if not set (health tests still run).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
