// Prune old READ notifications (retention hygiene).
// Usage: npm run notifications:prune   (requires DATABASE_URL in .env)
// Deletes only rows that are BOTH read AND older than NOTIF_RETENTION_DAYS.
// Unread rows are NEVER deleted — the bell must not lose unseen updates.
// Device tokens are registration state, not logs — untouched.
import pg from 'pg';
import 'dotenv/config';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[notifications:prune] DATABASE_URL khaali hai. .env banao (.env.example dekho).');
  process.exit(1);
}

const days = num('NOTIF_RETENTION_DAYS', 90);
const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  const res = await client.query(
    `DELETE FROM notifications
     WHERE read_at IS NOT NULL AND created_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  console.log(`[notifications:prune] ho gaya — ${res.rowCount} read rows older than ${days}d removed.`);
} catch (err) {
  console.error('[notifications:prune] fail:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
