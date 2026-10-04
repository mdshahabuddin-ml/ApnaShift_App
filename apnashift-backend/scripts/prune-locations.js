// Prune old driver GPS points (operational retention, default 30 days).
// Usage: npm run tracking:prune   (requires DATABASE_URL in .env)
// Only deletes driver_locations rows — bookings/drivers untouched.
import pg from 'pg';
import 'dotenv/config';

const daysRaw = process.env.TRACK_RETENTION_DAYS ?? '30';
const days = Number(daysRaw);
if (!Number.isFinite(days) || days < 1) {
  console.error('[tracking:prune] TRACK_RETENTION_DAYS 1 ya zyada din ho.');
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[tracking:prune] DATABASE_URL khaali hai. .env banao.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  const r = await client.query(
    'DELETE FROM driver_locations WHERE recorded_at < now() - make_interval(days => $1)',
    [Math.floor(days)],
  );
  console.log(`[tracking:prune] OK: ${r.rowCount} purani location rows delete (${days} din se purani).`);
} catch (err) {
  console.error('[tracking:prune] fail:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
