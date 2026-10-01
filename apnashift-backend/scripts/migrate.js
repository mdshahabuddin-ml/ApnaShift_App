// DB migrate + seed (cross-platform, no psql install needed).
// Usage: npm run db:migrate   (requires DATABASE_URL in .env)
// Runs db/schema.sql then db/seed.sql — both contain only static SQL.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[migrate] DATABASE_URL khaali hai. .env banao (.env.example dekho).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  // Order: base schema -> migrations (002, 003...) -> seed. All static SQL.
  const files = ['db/schema.sql'];
  try {
    const migs = (await readdir(path.join(root, 'db', 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join('db', 'migrations', f));
    files.push(...migs);
  } catch {
    // Skip if migrations folder is absent (legacy setup).
  }
  files.push('db/seed.sql');
  for (const file of files) {
    const sql = await readFile(path.join(root, file), 'utf8');
    console.log(`[migrate] chala rahe hain: ${file}`);
    await client.query(sql);
  }
  console.log('[migrate] ho gaya — tables + pricing seed ready.');
} catch (err) {
  console.error('[migrate] fail:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
