// Shared helper for DB integration tests: apply schema + migrations + seed,
// truncate after each test. (TEST_DATABASE_URL comes from tests/setup.js.)
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
    // Skip if migrations folder is missing.
  }
  for (const f of migs) {
    await client.query(await readFile(path.join(root, 'db', 'migrations', f), 'utf8'));
  }
  await client.query(await readFile(path.join(root, 'db', 'seed.sql'), 'utf8'));
}

export async function truncateAll(client) {
  // Clear all transactional tables + restore pricing seed (else ratesFor returns 400 unknown_vehicle).
  // pricing_rules is TRUNCATEd (so pricing PUT mutations do not leak), then seed re-inserted.
  await client.query(
    'TRUNCATE users, drivers, admins, bookings, ratings, pricing_rules, audit_logs, pricing_history, idempotency_keys, enterprise_inquiries RESTART IDENTITY CASCADE',
  );
  await client.query(
    `INSERT INTO pricing_rules (vehicle_type, base_rs, per_km_rs, helper_rs) VALUES
       ('Pickup', 350, 17.5, 200),
       ('Mini Truck', 600, 22.5, 200),
       ('Mini Tractor', 1000, 30, 200)`,
  );
}
