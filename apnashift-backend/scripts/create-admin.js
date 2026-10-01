// Script to create an owner/admin (same for localhost + server).
// Usage:
//   node scripts/create-admin.js "Owner" 9876543210 "StrongPass123"
//   npm run admin:create -- "Owner" 9876543210 "StrongPass123"
import bcrypt from 'bcrypt';
import pg from 'pg';
import 'dotenv/config';

const [name, rawPhone, password] = process.argv.slice(2);

if (!name || !rawPhone || !password) {
  console.error('Usage: node scripts/create-admin.js "Naam" 9876543210 "StrongPass123"');
  process.exit(1);
}

// Normalize phone (as in login schema): strip +91/space/0 to 10 digits.
let phone = String(rawPhone).trim().replace(/[\s\-().]/g, '');
if (phone.startsWith('+91')) phone = phone.slice(3);
else if (phone.length === 12 && phone.startsWith('91')) phone = phone.slice(2);
else if (phone.length === 11 && phone.startsWith('0')) phone = phone.slice(1);

if (!/^[6-9]\d{9}$/.test(phone)) {
  console.error('[admin:create] Phone 10 digit Indian mobile ho (6-9 se shuru).');
  process.exit(1);
}
if (password.length < 8) {
  console.error('[admin:create] Password kam se kam 8 akshar.');
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('[admin:create] DATABASE_URL khaali hai. .env banao.');
  process.exit(1);
}

const rounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
const client = new pg.Client({ connectionString: dbUrl });
try {
  await client.connect();
  const hash = await bcrypt.hash(password, rounds);
  const r = await client.query(
    `INSERT INTO admins (name, phone, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
     RETURNING id, name, phone`,
    [name.trim(), phone, hash],
  );
  console.log('[admin:create] OK:', r.rows[0]);
  console.log('[admin:create] Login: POST /api/admin/login { phone, password }');
} catch (err) {
  console.error('[admin:create] fail:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
