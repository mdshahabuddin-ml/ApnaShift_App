// DB integration tests ka shared helper: schema + migrations + seed lagao,
// har test ke baad truncate karo. (TEST_DATABASE_URL tests/setup.js se aata hai.)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function applyTestSchema(client, root) {
  await client.query(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));
  let migs = [];
  try {
    migs = (await readdir(path.join(root, 'db', 'migrations')))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    // migrations folder na ho to skip.
  }
  for (const f of migs) {
    await client.query(await readFile(path.join(root, 'db', 'migrations', f), 'utf8'));
  }
  await client.query(await readFile(path.join(root, 'db', 'seed.sql'), 'utf8'));
}

export async function truncateAll(client) {
  // Sab transactional tables saaf + pricing seed wapas (nahi to ratesFor 400 unknown_vehicle dega).
  // pricing_rules TRUNCATE hoti hai (pricing PUT wale mutation leak na ho), phir seed re-insert.
  await client.query(
    'TRUNCATE users, drivers, admins, bookings, ratings, pricing_rules, audit_logs, pricing_history, idempotency_keys RESTART IDENTITY CASCADE',
  );
  await client.query(
    `INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs) VALUES
       ('Pickup', 350, 17.5, 200),
       ('Mini Truck', 600, 22.5, 200),
       ('Mini Tractor', 1000, 30, 200)`,
  );
}
