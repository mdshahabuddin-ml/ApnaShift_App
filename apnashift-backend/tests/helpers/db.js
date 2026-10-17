// Shared helper for DB integration tests: apply schema + migrations + seed,
// truncate after each test. Mode decided by tests/setup.js (runs before test
// file imports — see vitest.config.js setupFiles):
//   TEST_DATABASE_URL set        -> pg against that URL (CI unchanged)
//   else MSSQL_* creds in .env   -> mssql against ApnaShiftDB_test
//   else                         -> no DB (suites skip via hasTestDb)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createMssqlPool, mssqlQuery } from '../../src/mssql/db.js';

export const testDbMode = process.env.TEST_DATABASE_URL
  ? 'pg'
  : process.env.MSSQL_USER
    ? 'mssql'
    : 'none';
export const hasTestDb = testDbMode !== 'none';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeTestClient() {
  if (testDbMode === 'pg') {
    return new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  }
  if (testDbMode === 'mssql') {
    return new MssqlTestClient();
  }
  throw new Error('makeTestClient: no test database configured (hasTestDb is false)');
}

// ---------------------------------------------------------------- mssql mode
// PG blocks a schema-load (schema.sql / DROP-all DO $$) must NOT be translated
// — the T-SQL equivalents live in db/mssql/*.sql. Detect them and run the
// guarded batches raw instead. seed.sql has none of these markers, so it goes
// through the normal translate path (MERGE DO NOTHING keeps custom rates).
const PG_SCHEMA_BLOB = /pg_tables|DO \$\$|CREATE EXTENSION|ApnaShift MVP schema/;

let schemaChecked = false;
let fkMetaCache = null;

async function ensureMssqlSchema() {
  // Schema is fully guarded (IF NOT EXISTS / OBJECT_ID) — run once per process.
  if (schemaChecked) return;
  const probe = await mssqlQuery('SELECT COUNT(*) AS n FROM sys.tables');
  if (Number(probe.recordset[0].n) >= 20) {
    schemaChecked = true;
    return;
  }
  const dir = path.join(ROOT, 'db', 'mssql');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const text = await readFile(path.join(dir, f), 'utf8');
    for (const batch of text.split(/^GO\s*$/mi)) {
      const s = batch.trim();
      if (s) await mssqlQuery(s); // raw — never through the translator
    }
  }
  schemaChecked = true;
}

async function fkMeta() {
  if (fkMetaCache) return fkMetaCache;
  const pool = await lazyPool();
  const fk = await pool.query(
    "SELECT OBJECT_NAME(parent_object_id) AS child, OBJECT_NAME(referenced_object_id) AS parent FROM sys.foreign_keys WHERE parent_object_id <> referenced_object_id",
  );
  const referers = new Map(); // parent -> Set(child that references it)
  for (const row of fk.rows) {
    if (!referers.has(row.parent)) referers.set(row.parent, new Set());
    referers.get(row.parent).add(row.child);
  }
  const ids = await pool.query('SELECT OBJECT_NAME(object_id) AS t FROM sys.identity_columns');
  const identity = new Set(ids.rows.map((r) => r.t));
  fkMetaCache = { referers, identity };
  return fkMetaCache;
}

let sharedPool = null;
function lazyPool() {
  if (!sharedPool) sharedPool = createMssqlPool();
  return sharedPool;
}

// TRUNCATE t1, t2 ... [RESTART IDENTITY] [CASCADE] is not T-SQL, and DELETE
// does not cascade the way PG's TRUNCATE ... CASCADE does. Emulate: expand the
// table set transitively to every table that REFERENCES a listed table (PG
// truncates those too — e.g. admins cascade-wipes platform_settings via
// updated_by, bookings wipes commission_history), delete children before
// parents, then reseed identity columns.
async function truncateViaDelete(text, pool) {
  const m = /^TRUNCATE\s+(?:TABLE\s+)?([\s\S]+)$/i.exec(text);
  if (!m) throw new Error('truncate: unparsable — ' + text.slice(0, 120));
  const listed = m[1]
    .replace(/\bRESTART\s+IDENTITY\b/gi, '')
    .replace(/\bCASCADE\b/gi, '')
    .replace(/\bRESTRICT\b/gi, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const t of listed) {
    if (!identRe.test(t)) throw new Error('truncate: bad identifier — ' + t);
  }
  if (!listed.length) throw new Error('truncate: no tables in — ' + text.slice(0, 120));

  const { referers, identity } = await fkMeta();
  const set = new Set(listed);
  const queue = [...listed];
  while (queue.length) {
    const t = queue.pop();
    for (const c of referers.get(t) ?? []) {
      if (!set.has(c)) {
        set.add(c);
        queue.push(c);
      }
    }
  }

  const remaining = new Set(set);
  const order = [];
  while (remaining.size) {
    let progressed = false;
    for (const t of [...remaining]) {
      const kids = referers.get(t);
      const blocked = kids && [...kids].some((c) => c !== t && remaining.has(c));
      if (!blocked) {
        order.push(t);
        remaining.delete(t);
        progressed = true;
      }
    }
    if (!progressed) {
      // FK cycle — should not happen in this schema; emit rest to surface it.
      order.push(...remaining);
      remaining.clear();
    }
  }

  const stmts = order.map((t) => `DELETE FROM [${t}]`);
  for (const t of order) {
    if (identity.has(t)) stmts.push(`DBCC CHECKIDENT ('${t}', RESEED, 0)`);
  }
  await pool.query(stmts.join(';\n'));
  return { rows: [], rowCount: 0 };
}

class MssqlTestClient {
  constructor() {
    this._pool = lazyPool();
  }

  async connect() {
    await this._pool.query('SELECT 1 AS ok');
  }

  async end() {
    await this._pool.end();
    sharedPool = null;
  }

  // PG schema.sql load = drop-all + recreate + seed (fresh, empty tables).
  // MSSQL equivalent: ensure guarded batches, then same wipe+seeds as a file
  // start (truncateAll re-seeds pricing_rules + platform_settings.commission).
  async rawSchema() {
    await ensureMssqlSchema();
    await truncateAll(this);
    return { rows: [], rowCount: 0 };
  }

  async query(text, params) {
    if (typeof text === 'string') {
      if (/^\s*TRUNCATE\b/i.test(text)) return truncateViaDelete(text, this._pool);
      if (PG_SCHEMA_BLOB.test(text)) return this.rawSchema();
    }
    return this._pool.query(text, params);
  }
}

// ------------------------------------------------------------- both modes
export async function applyTestSchema(client, root) {
  if (typeof client.rawSchema === 'function') {
    await client.rawSchema();
    return;
  }
  // Fresh schema per file: suites share one test DB sequentially, so wipe
  // all public tables first (extension/functions survive; triggers drop with
  // their tables). Without this, a previous file's schema makes
  // non-idempotent migration statements (e.g. 014 ADD CONSTRAINT) fail with
  // "already exists". Test-only helper — production migrate untouched.
  await client.query(
    `DO $$ DECLARE r RECORD; BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
         EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
       END LOOP;
     END $$;`,
  );
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
  // In mssql mode the TRUNCATE is emulated by the client (FK-ordered DELETEs).
  await client.query(
    'TRUNCATE users, drivers, admins, bookings, ratings, pricing_rules, audit_logs, pricing_history, idempotency_keys, enterprise_inquiries, driver_locations, payments, payment_adjustments, settlements, settlement_period_items, settlement_periods, password_reset_otps, driver_declines, wa_conversations, notifications, device_tokens RESTART IDENTITY CASCADE',
  );
  await client.query(
    `INSERT INTO pricing_rules
       (vehicle_type, base_rs, per_km_rs, helper_rs, minimum_fare,
        size_small_extra, size_big_extra,
        weight_0_100, weight_100_300, weight_300_500, weight_500_plus) VALUES
       ('Pickup', 250, 17.5, 200, 250, 0, 0, 0, 0, 0, 0),
       ('Mini Truck', 450, 22.5, 200, 450, 0, 0, 0, 0, 0, 0),
       ('Mini Tractor', 750, 30, 200, 750, 0, 0, 0, 0, 0, 0)`,
  );
  // Config reseed: TRUNCATE ... CASCADE follows FKs and wipes platform_settings
  // (updated_by -> admins). Every suite needs the default commission present.
  await client.query(
    `INSERT INTO platform_settings (key, value) VALUES ('commission', '{"pct": 15.00}')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
}
