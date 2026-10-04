// MS SQL Server pool (mssql/tedious driver). PARALLEL to src/db.js (pg) —
// PostgreSQL remains the live database; nothing here replaces it.
// The pool connects lazily on first query. All failures surface as
// { ok:false, error } via callers — never secrets, never stack to clients.
import sql from 'mssql';
import { mssqlConfig, isMssqlConfigured } from './config.js';

let poolPromise = null;

export function isMssqlEnabled() {
  return isMssqlConfigured();
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(mssqlConfig()).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// Read-only helper for verification endpoints. Writes belong to future
// migration work (parameterized requests only — never string-built SQL).
export async function mssqlQuery(text, params = []) {
  const pool = await getPool();
  const req = pool.request();
  params.forEach((v, i) => {
    req.input(`p${i + 1}`, v);
  });
  // Convert $1, $2 placeholders to @p1, @p2 so pg-style text is reusable.
  const converted = text.replace(/\$(\d+)/g, (_, n) => `@p${n}`);
  return req.query(converted);
}

export async function mssqlClose() {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null);
    poolPromise = null;
    if (pool) await pool.close().catch(() => {});
  }
}
