// Local data migration: PostgreSQL -> MS SQL Server (development/testing).
//   Usage: MSSQL_DATABASE=ApnaShiftDB_migrate node scripts/migrate-data-mssql.js
// Safety rails (by design):
//   - source must be localhost, UNLESS Railway form (host:port + PG* vars) is
//     present AND explicit consent MIGRATE_ALLOW_REMOTE_SOURCE=1 is set
//   - target DB name must contain 'migrate' (can never hit ApnaShiftDB / _test)
//   - source is read-only (SELECTs + catalog reads only)
//   - refuses a non-empty target (never deletes/truncates anything)
//   - schema on target = db/mssql files WITHOUT seed (data comes from source)
// Type handling: literals built from typed PG values (deterministic —
//   timestamptz -> UTC wall-clock string, arrays/jsonb -> JSON, bool -> 1/0).
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import sql from 'mssql';
import 'dotenv/config';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHUNK = 100;

function fail(msg) {
  console.error(`[data-migrate] FAIL: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- source conn
// Local: full postgres:// URL (default). Railway: raw "host:port" (their
// Database_url; Windows case-insensitivity delivers it as DATABASE_URL) with
// credentials from libpq-style PG* vars. Connection built in memory, never
// logged — only masked host + db name are printed.
const rawDbUrl = process.env.DATABASE_URL ?? '';
const railwayForm = /^[\w.-]+:\d+$/.test(rawDbUrl.trim());
let srcConn;
let srcHost;
let srcPort;
let srcDb;
if (railwayForm) {
  if (process.env.MIGRATE_ALLOW_REMOTE_SOURCE !== '1') {
    fail(
      'remote source (Railway host:port) dikha — prod read deliberate hona chahiye: MIGRATE_ALLOW_REMOTE_SOURCE=1 set karke dobara chalao.',
    );
  }
  const [h, p] = rawDbUrl.trim().split(':');
  const user = process.env.PGUSER ?? process.env.POSTGRES_USER;
  const pass = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD;
  const db = process.env.PGDATABASE ?? process.env.POSTGRES_DB;
  if (!user || !pass || !db) fail('Railway form: PGUSER / PGPASSWORD / PGDATABASE incomplete.');
  srcConn = {
    host: h,
    port: Number(p),
    database: db,
    user,
    password: pass,
    ssl: { rejectUnauthorized: false },
  };
  srcHost = h;
  srcPort = p;
  srcDb = `/${db}`;
  console.log('[data-migrate] source mode: PRODUCTION (Railway) — read-only, consent flag present');
} else {
  if (!rawDbUrl) fail('.env me DATABASE_URL (source PG) chahiye.');
  const src = new URL(rawDbUrl);
  srcHost = src.hostname;
  srcPort = src.port || '5433';
  srcDb = src.pathname;
  if (!['localhost', '127.0.0.1', '::1'].includes(srcHost)) {
    fail(
      `source host '${srcHost}' localhost nahi hai. Prod/Railway export sirf Railway-form + MIGRATE_ALLOW_REMOTE_SOURCE=1 se chalta hai.`,
    );
  }
  srcConn = { connectionString: rawDbUrl };
}
if (!process.env.MSSQL_USER || !process.env.MSSQL_PASSWORD)
  fail('.env me MSSQL_USER / MSSQL_PASSWORD chahiye.');
const targetDb = process.env.MSSQL_DATABASE ?? '';
// D2 allowlist: exact names (comma-separated) beyond the /migrate/i scratch
// pattern — e.g. MIGRATE_ALLOW_TARGET=ApnaShiftDB_prod. Exact match only,
// no wildcards, case-insensitive; still refuses any other DB (no deletes).
const allowedTargets = (process.env.MIGRATE_ALLOW_TARGET ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (!/migrate/i.test(targetDb) && !allowedTargets.includes(targetDb.toLowerCase())) {
  fail(
    `MSSQL_DATABASE='${targetDb}' allowed nahi hai. Scratch DB ka naam 'migrate' rakho (jaise ApnaShiftDB_migrate) ya exact naam MIGRATE_ALLOW_TARGET me do (comma-separated) — real/test DBs par data load kabhi nahi hoga.`,
  );
}
const targetName = /^[A-Za-z0-9_]+$/.test(targetDb) ? targetDb : null;
if (!targetName) fail('MSSQL_DATABASE me sirf letters/digits/underscore chahiye.');

const mcfg = {
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER ?? 'localhost',
  ...(process.env.MSSQL_PORT ? { port: Number(process.env.MSSQL_PORT) } : {}),
  database: targetName,
  options: {
    encrypt: (process.env.MSSQL_ENCRYPT ?? 'false') === 'true',
    trustServerCertificate: (process.env.MSSQL_TRUST_CERT ?? 'true') === 'true',
    connectTimeout: process.env.MSSQL_CONNECT_TIMEOUT
      ? Number(process.env.MSSQL_CONNECT_TIMEOUT)
      : 8000,
    requestTimeout: 60000,
  },
  pool: { max: 5 },
};
console.log(`[data-migrate] source: ${srcHost}:${srcPort}${srcDb} (read-only)`);
console.log(`[data-migrate] target: ${mcfg.server}:${mcfg.port ?? 1433}/${targetName}`);

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ---------------------------------------------------------------- read source
const pgc = new pg.Client(srcConn);
await pgc.connect();

const tables = (
  await pgc.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`,
  )
).rows.map((r) => r.table_name);
for (const t of tables) if (!ident.test(t)) fail(`bad source table name: ${t}`);

const colsByTable = new Map();
for (const t of tables) {
  const r = await pgc.query(
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [t],
  );
  colsByTable.set(t, r.rows);
}

const fkRows = (
  await pgc.query(
    `SELECT cl.relname AS child, cf.relname AS parent
     FROM pg_constraint c
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_class cf ON cf.oid = c.confrelid
     JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'`,
  )
).rows;
const deps = new Map(); // child -> Set(parent)
for (const r of fkRows) {
  if (!deps.has(r.child)) deps.set(r.child, new Set());
  if (r.child !== r.parent) deps.get(r.child).add(r.parent);
}

// parents first (children wait)
const remaining = new Set(tables);
const order = [];
while (remaining.size) {
  const ready = [...remaining].filter((t) =>
    [...(deps.get(t) ?? [])].every((p) => !remaining.has(p)),
  );
  if (!ready.length) fail(`FK cycle among: ${[...remaining].join(', ')}`);
  for (const t of ready) {
    order.push(t);
    remaining.delete(t);
  }
}

// ---------------------------------------------------------------- target setup
try {
  const master = await new sql.ConnectionPool({ ...mcfg, database: 'master' }).connect();
  await master
    .request()
    .query(`IF DB_ID(N'${targetName}') IS NULL CREATE DATABASE [${targetName}]`);
  await master.close();
} catch (e) {
  fail(`target DB create nahi hui (${e.message}). sqlcmd -E se pehle create kar lo: IF DB_ID('ApnaShiftDB_migrate') IS NULL CREATE DATABASE [ApnaShiftDB_migrate];`);
}

const pool = await new sql.ConnectionPool(mcfg).connect();

// schema WITHOUT seed (source carries its own seed rows)
const existing = Number(
  (
    await pool
      .request()
      .query(
        `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA='dbo'`,
      )
  ).recordset[0].n,
);
if (existing === 0) {
  const files = (await readdir(path.join(root, 'db', 'mssql')))
    .filter((f) => f.endsWith('.sql') && !/seed/i.test(f))
    .sort();
  for (const f of files) {
    const text = await readFile(path.join(root, 'db', 'mssql', f), 'utf8');
    for (const b of text.split(/^\s*GO\s*$/gim)) {
      const s = b.trim();
      if (s) await pool.request().batch(s);
    }
  }
  console.log(`[data-migrate] schema applied (${files.length} files, seed skipped)`);
} else if (existing !== tables.length) {
  await pool.close();
  fail(`target me ${existing} tables hain, source me ${tables.length}. Partial schema — scratch DB drop karke dobara chalao.`);
}

// refuse non-empty target (no deletes, ever)
const occupied = [];
for (const t of tables) {
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`);
  if (Number(r.recordset[0].n) > 0) occupied.push(t);
}
if (occupied.length) {
  await pool.close();
  fail(`target non-empty hai (${occupied.join(', ')}) — main kuch delete nahi karta. Naya scratch DB banao ya isko drop karke dobara chalao.`);
}

const tgtCols = new Map();
for (const t of tables) {
  const r = await pool
    .request()
    .query(
      `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME='${t}' ORDER BY ORDINAL_POSITION`,
    );
  tgtCols.set(t, new Set(r.recordset.map((x) => x.c)));
}
const idr = await pool
  .request()
  .query(`SELECT OBJECT_NAME(object_id) AS t FROM sys.identity_columns`);

// ---------------------------------------------------------------- literals
function lit(v, col) {
  if (v === null || v === undefined) return 'NULL';
  const where = col.table_name + '.' + col.column_name;
  switch (col.data_type) {
    case 'timestamp with time zone': {
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error(`bad timestamptz at ${where}`);
      return `'${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}'`;
    }
    case 'date': {
      if (v instanceof Date) {
        // pg parses DATE at LOCAL midnight (TZ-aware Date) — use local getters,
        // NOT UTC (getUTC* on IST local-midnight shifts back one day = D-1 bug).
        return `'${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}'`;
      }
      const s = String(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new Error(`bad date at ${where}: ${s}`);
      return `'${s.slice(0, 10)}'`;
    }
    case 'boolean':
      return v === true || v === 't' || v === 'true' ? '1' : '0';
    case 'ARRAY':
      return sq(Array.isArray(v) ? JSON.stringify(v) : String(v));
    case 'jsonb':
      return sq(typeof v === 'string' ? v : JSON.stringify(v));
    case 'uuid':
    case 'text':
    case 'character varying':
    case 'character':
    case 'name':
      return sq(String(v));
    case 'numeric':
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'double precision': {
      const s = typeof v === 'string' ? v : String(v);
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) throw new Error(`bad number at ${where}: ${s}`);
      return s;
    }
    default:
      throw new Error(`unhandled pg type '${col.data_type}' at ${where}`);
  }
}

// ---------------------------------------------------------------- load + verify
let total = 0;
const mismatches = [];
console.log(`[data-migrate] order: ${order.join(', ')}`);

for (const t of order) {
  const cols = colsByTable.get(t);
  const missing = cols.filter((c) => !tgtCols.get(t).has(c.column_name));
  if (missing.length) {
    await pool.close();
    await pgc.end();
    fail(`${t}: target me columns nahi hain: ${missing.map((c) => c.column_name).join(', ')}`);
  }
  const names = cols.map((c) => c.column_name);
  const colList = names.map((c) => `[${c}]`).join(', ');

  const srcRes = await pgc.query(`SELECT * FROM "${t}"`);
  const rows = srcRes.rows;
  if (rows.length) {
    const hasIdentity = idr.recordset.some((x) => x.t === t);
    // SET IDENTITY_INSERT is session-scoped and separate request.query() calls
    // may NOT land on the same pooled session — put ON + INSERT + OFF inside
    // ONE request (one batch = one session; probe-verified).
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = slice
        .map((r) => '(' + cols.map((c) => lit(r[c.column_name], c)).join(', ') + ')')
        .join(',\n');
      const insert = `INSERT INTO [${t}] (${colList}) VALUES\n${values};`;
      const text = hasIdentity
        ? `SET IDENTITY_INSERT [${t}] ON;\n${insert}\nSET IDENTITY_INSERT [${t}] OFF;`
        : insert;
      try {
        await pool.request().query(text);
      } catch (err) {
        await pool.close();
        await pgc.end();
        throw err;
      }
    }
  }

  const tgtCount = Number(
    (await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`)).recordset[0].n,
  );
  const ok = tgtCount === rows.length;
  if (!ok) mismatches.push(`${t}: pg=${rows.length} mssql=${tgtCount}`);
  total += rows.length;
  console.log(`[data-migrate] ${t}: ${tgtCount}/${rows.length} ${ok ? 'OK' : 'MISMATCH'}`);
}

await pgc.end();
await pool.close();

if (mismatches.length) {
  console.error('[data-migrate] VERIFY FAIL:');
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`[data-migrate] VERIFY OK — ${tables.length} tables, ${total} rows, counts match.`);
