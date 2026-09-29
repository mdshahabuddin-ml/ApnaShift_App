// Postgres pool (pg driver, no ORM).
// Rule: hamesha parameterized query — query(text, [params]) me $1, $2 use karo.
// String jodkar SQL kabhi mat banao. Query text/params kabhi log mat karo
// (isme phone number ya hash ho sakta hai).
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool(
  config.databaseUrl ? { connectionString: config.databaseUrl } : {},
);

pool.on('error', (err) => {
  // Sirf message — connection string ya values kabhi nahi.
  console.error('[db] pool error:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}
