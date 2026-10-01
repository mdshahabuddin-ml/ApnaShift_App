import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Test env (JWT secret, limiter off, test DB) — before test file imports.
    setupFiles: ['tests/setup.js'],
    // DB suites share one test DB (they TRUNCATE) —
    // parallel files would wipe each other's data. Run sequentially.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
