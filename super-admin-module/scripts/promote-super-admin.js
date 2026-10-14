// One-time super_admin promoter. MANUAL RUN ONLY — never in CI/seed/migrate.
// Usage: node super-admin-module/scripts/promote-super-admin.js <10-digit-phone>
// Promotes ONE existing admin row to super_admin (or demotes with --demote).
// Refuses unknown phones and prints the result. No defaults, no hardcoding.
import { createRequire } from 'node:module';
// Same anchoring as backend/superAdminRoutes.js: no new deps, no copies.
const need = createRequire(new URL('../../apnashift-backend/package.json', import.meta.url));
const pg = need('pg');
need('dotenv/config');

const phone = (process.argv[2] || '').replace(/\D/g, '').replace(/^91/, '').replace(/^0/, '');
const demote = process.argv.includes('--demote');

if (!/^[6-9][0-9]{9}$/.test(phone)) {
  console.error('Usage: node super-admin-module/scripts/promote-super-admin.js <10-digit-phone> [--demote]');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing hai — .env check karo.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const role = demote ? 'admin' : 'super_admin';
  const r = await pool.query(`UPDATE admins SET role = $1 WHERE phone = $2 RETURNING id, name, phone, role`, [role, phone]);
  if (r.rowCount === 0) {
    console.error(`Koi admin nahi mila phone ${phone} pe — pehle create-admin se banao.`);
    process.exit(1);
  }
  console.log(`Done: ${r.rows[0].name} (${r.rows[0].phone}) -> role=${r.rows[0].role}`);
} finally {
  await pool.end().catch(() => {});
}
