import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Test env (JWT secret, limiter off, test DB) — test files ke import se pehle.
    setupFiles: ['tests/setup.js'],
    // DB wale suites ek hi test DB par hain (TRUNCATE karte hain) —
    // files parallel chali to ek doosre ka data udaa dengi. Sequential chalao.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
