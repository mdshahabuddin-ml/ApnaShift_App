// MS SQL Server migrate (separate from PostgreSQL migrate — PG untouched).
// Usage: npm run db:migrate:mssql   (requires MSSQL_* in .env)
// Runs db/mssql/*.sql in order. Files use GO batch separators
// (CREATE TRIGGER must start its own batch). Non-destructive:
// schema objects are IF NOT EXISTS guarded, seed is NOT EXISTS guarded.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sql from 'mssql';
import 'dotenv/config';

function mssqlConfig() {
  const server = process.env.MSSQL_SERVER ?? 'localhost';
  const instance = process.env.MSSQL_INSTANCE ?? '';
  const cfg = {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    database: process.env.MSSQL_DATABASE ?? 'ApnaShift',
    options: {
      instanceName: instance || undefined,
      encrypt: (process.env.MSSQL_ENCRYPT ?? 'false') === 'true',
      trustServerCertificate: true,
      connectTimeout: 10000,
      requestTimeout: 60000,
    },
  };
  if (!cfg.user || !cfg.password) {
    console.error('[migrate:mssql] MSSQL_USER / MSSQL_PASSWORD khaali hai. .env me set karo (.env.example dekho).');
    process.exit(1);
  }
  cfg.server = instance ? server : server;
  return cfg;
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pool = new sql.ConnectionPool(mssqlConfig());
try {
  await pool.connect();
  const files = (await readdir(path.join(root, 'db', 'mssql')))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join('db', 'mssql', f));
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8');
    const batches = text.split(/^\s*GO\s*$/gim).map((b) => b.trim()).filter(Boolean);
    console.log(`[migrate:mssql] chala rahe hain: ${file} (${batches.length} batches)`);
    for (const batch of batches) {
      await pool.request().batch(batch);
    }
  }
  console.log('[migrate:mssql] ho gaya — tables + seed ready.');
} catch (err) {
  // Never print connection config (may hold secrets) — message only.
  console.error('[migrate:mssql] fail:', err.message);
  process.exitCode = 1;
} finally {
  await pool.close();
}
