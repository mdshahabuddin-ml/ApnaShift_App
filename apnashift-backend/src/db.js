// Postgres pool (pg driver, no ORM).
// Rule: always use parameterized queries — $1, $2 in query(text, [params]).
// Never build SQL via string concatenation. Never log query text/params
// (they may contain phone numbers or hashes).
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool(
  config.databaseUrl ? { connectionString: config.databaseUrl } : {},
);

pool.on('error', (err) => {
  // Log message only — never connection string or values.
  console.error('[db] pool error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}
