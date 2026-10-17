// Database pool selector. ONE entry point for all routes/services.
//   driver 'pg'     -> unchanged PostgreSQL path (Railway/CI use this;
//                      byte-identical behavior when MSSQL_* is unset).
//   driver 'mssql'  -> local SQL Server via src/mssql/ (same query API:
//                      { rows, rowCount } + pg-compatible error codes).
// Selection: DB_DRIVER env wins; else mssql when MSSQL_USER/MSSQL_PASSWORD
// are set; else pg. Both drivers accept pg-style text ($1) + params[].
// Rule: always parameterized queries — never string-built SQL, never log
// query text/params (they may contain phone numbers or hashes).
import pg from 'pg';
import { config } from './config.js';
import { isMssqlConfigured } from './mssql/config.js';
import { createMssqlPool } from './mssql/db.js';

export const dbDriver = (
  process.env.DB_DRIVER ?? (isMssqlConfigured() ? 'mssql' : 'pg')
).toLowerCase();

let pool;
let query;

if (dbDriver === 'mssql') {
  pool = createMssqlPool();
  query = (text, params) => pool.query(text, params);
} else {
  pool = new pg.Pool(
    config.databaseUrl ? { connectionString: config.databaseUrl } : {},
  );

  pool.on('error', (err) => {
    // Log message only — never connection string or values.
    console.error('[db] pool error:', err.message);
  });

  query = (text, params) => pool.query(text, params);
}

export { pool, query };
