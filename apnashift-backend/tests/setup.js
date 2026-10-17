// Runs BEFORE each test file's imports.
// src/config.js reads env at import time, so test values
// must be set here (setting them in test files will not work).
import { createRequire } from 'node:module';

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
// Tracking limiter likewise (many GPS posts per test file).
process.env.TRACK_RATE_LIMIT_MAX ??= '10000';
process.env.TRACK_RATE_LIMIT_WINDOW_MS ??= '60000';
// Notification endpoints likewise (bell polling per test file).
process.env.NOTIFY_RATE_LIMIT_MAX ??= '10000';
// Throttle tuned per-test via TRACK_MIN_INTERVAL_MS (read per-request).
process.env.TRACK_MIN_INTERVAL_MS ??= '0';
// Fast bcrypt (12 rounds take 30s+ for the suite, 4 is faster with same logic).
process.env.BCRYPT_ROUNDS ??= '4';

// Load .env AFTER the ??= defaults above (dotenv never overrides existing
// keys, so test values win over .env). Needed for MSSQL_* on local dev.
const require = createRequire(import.meta.url);
require('dotenv').config();

// Test DB mode:
// 1. TEST_DATABASE_URL set (CI / local PG) -> pg driver against that URL,
//    regardless of local MSSQL_* creds in .env.
// 2. Else MSSQL creds present -> mssql driver against the test database
//    (ApnaShiftDB_test by default; override with TEST_MSSQL_DATABASE).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DB_DRIVER = 'pg';
} else if (process.env.MSSQL_USER) {
  process.env.DB_DRIVER = 'mssql';
  process.env.MSSQL_DATABASE = process.env.TEST_MSSQL_DATABASE ?? 'ApnaShiftDB_test';
}
