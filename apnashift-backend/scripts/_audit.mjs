// TEMP — READ-ONLY audit: production PostgreSQL (DATABASE_URL via `railway run`)
// vs local MSSQL ApnaShiftDB. SELECT/COUNT/information_schema only — never writes,
// never prints credentials or URLs. Guards: refuses non-production PG target and
// refuses any MSSQL database other than exactly ApnaShiftDB.
import 'dotenv/config';
import pg from 'pg';
import sql from 'mssql';
import { mssqlConfig } from '../src/mssql/config.js';

// ---- guard 1: PG side must be actual production (not local)
// Railway exposes: Database_url = "host:port" (public proxy) + libpq-style
// PGUSER/PGPASSWORD/PGDATABASE. Windows env is case-insensitive, so that value
// arrives as DATABASE_URL too. Build the connection IN MEMORY — never printed.
const raw = process.env.Database_url ?? process.env.DATABASE_URL;
if (!raw) {
  console.error('AUDIT ABORT: no Railway Database_url (railway run se chalao)');
  process.exit(2);
}
const localHosts = new Set(['localhost', '127.0.0.1', '::1', '']);
let conn = null;
let host = '';
let port = '';
let db = '';
if (/^[\w.-]+:\d+$/.test(raw.trim())) {
  // host:port form — credentials come from PG* libpq vars
  const [h, p] = raw.trim().split(':');
  host = h;
  port = p;
  db = process.env.PGDATABASE ?? process.env.POSTGRES_DB;
  const user = process.env.PGUSER ?? process.env.POSTGRES_USER;
  const pass = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD;
  if (!db || !user || !pass) {
    console.error('AUDIT ABORT: host:port form but PGUSER/PGPASSWORD/PGDATABASE incomplete');
    process.exit(2);
  }
  conn = { host, port: Number(port), database: db, user, password: pass };
} else if (raw.includes('://')) {
  const u2 = new URL(raw);
  host = u2.hostname;
  port = u2.port || '5432';
  db = (u2.pathname || '').replace(/^\//, '');
  conn = { connectionString: raw };
} else {
  console.error('AUDIT ABORT: unrecognized Database_url shape');
  process.exit(2);
}
console.log(`PG source: host=${host.slice(0, 10)}… db=${db} port=${port}`);
if (localHosts.has(host)) {
  console.error('AUDIT ABORT: host is local — this is not production. (Guard against fake audit.)');
  process.exit(2);
}

// ---- guard 2: MSSQL side must be exactly ApnaShiftDB (default), a *migrate*
// scratch, or an exact name approved via MIGRATE_ALLOW_TARGET (D2 allowlist).
// Never _test, never anything else.
const auditTarget = process.env.AUDIT_TARGET ?? 'ApnaShiftDB';
const allowedTargets = (process.env.MIGRATE_ALLOW_TARGET ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (
  auditTarget !== 'ApnaShiftDB' &&
  !/migrate/i.test(auditTarget) &&
  !allowedTargets.includes(auditTarget.toLowerCase())
) {
  console.error(`AUDIT ABORT: AUDIT_TARGET '${auditTarget}' nahi chalega (ApnaShiftDB, *migrate* scratch, ya MIGRATE_ALLOW_TARGET exact name).`);
  process.exit(2);
}
const mcfg = mssqlConfig();
mcfg.database = auditTarget;
console.log(`MSSQL target: ${mcfg.server}:${mcfg.port} db=${mcfg.database} (forced)`);

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- PG side (read-only; ssl for Railway postgres-ssl template)
const pgc = new pg.Client({
  ...conn,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 30000,
});
await pgc.connect();
const pgTables = (
  await pgc.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`,
  )
).rows.map((r) => r.table_name);
const pgCounts = {};
for (const t of pgTables) {
  if (!ident.test(t)) throw new Error('bad ident ' + t);
  pgCounts[t] = Number((await pgc.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
}
await pgc.end();

// ---- MSSQL side (read-only)
const pool = await new sql.ConnectionPool(mcfg).connect();
const mTables = (
  await pool
    .request()
    .query(
      `SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA='dbo' ORDER BY 1`,
    )
).recordset.map((r) => r.t);
const mCounts = {};
for (const t of mTables) {
  if (!ident.test(t)) throw new Error('bad ident ' + t);
  mCounts[t] = Number((await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`)).recordset[0].n);
}
await pool.close();

// ---- comparison
const pgSet = new Set(pgTables);
const msSet = new Set(mTables);
const all = [...new Set([...pgTables, ...mTables])].sort();

console.log('');
console.log(`tables: production-PG=${pgTables.length}  local-MSSQL=${mTables.length}`);
const missingInMs = pgTables.filter((t) => !msSet.has(t));
const extraInMs = mTables.filter((t) => !pgSet.has(t));
console.log(`missing in MSSQL: ${missingInMs.length ? missingInMs.join(', ') : '(none)'}`);
console.log(`extra in MSSQL  : ${extraInMs.length ? extraInMs.join(', ') : '(none)'}`);
console.log('');

let mismatch = 0;
let matched = 0;
const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('table', 28)} ${pad('PG', 10)} ${pad('MSSQL', 10)} status`);
for (const t of all) {
  const p = pgSet.has(t) ? pgCounts[t] : null;
  const m = msSet.has(t) ? mCounts[t] : null;
  let st;
  if (p === null) st = 'MISSING-IN-PG';
  else if (m === null) st = 'MISSING-IN-MSSQL';
  else if (p === m) st = 'OK';
  else st = 'COUNT-MISMATCH';
  if (st !== 'OK') mismatch++;
  else matched++;
  console.log(`${pad(t, 28)} ${pad(p ?? '-', 10)} ${pad(m ?? '-', 10)} ${st}`);
}

const totPg = Object.values(pgCounts).reduce((a, b) => a + b, 0);
const totMs = Object.values(mCounts).reduce((a, b) => a + b, 0);

// ---- schema differences (catalog reads only)
const pgColRows = (
  await (async () => {
    const c = new pg.Client({ ...conn, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, (column_default IS NOT NULL) AS has_def
       FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
    );
    const cons = await c.query(
      `SELECT contype, COUNT(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace GROUP BY contype`,
    );
    const fks = await c.query(
      `SELECT conrelid::regclass::text AS t, COUNT(*)::int AS n FROM pg_constraint
       WHERE contype='f' AND connamespace='public'::regnamespace GROUP BY 1`,
    );
    const uc = await c.query(
      `SELECT conrelid::regclass::text AS t, contype, COUNT(*)::int AS n FROM pg_constraint
       WHERE contype IN ('u','c') AND connamespace='public'::regnamespace GROUP BY 1, 2`,
    );
    const udefs = await c.query(
      `SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint
       WHERE contype='u' AND connamespace='public'::regnamespace ORDER BY 1, 2`,
    );
    await c.end();
    return { cols: r.rows, cons: cons.rows, fks: fks.rows, uc: uc.rows, udefs: udefs.rows };
  })()
);
const pool2 = await new sql.ConnectionPool(mcfg).connect();
const msColRows = {
  cols: (
    await pool2.request().query(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type,
              IS_NULLABLE AS is_nullable, CASE WHEN COLUMN_DEFAULT IS NULL THEN 0 ELSE 1 END AS has_def
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    )
  ).recordset,
  cons: (
    await pool2.request().query(
      `SELECT 'PK' AS contype, COUNT(*) AS n FROM sys.key_constraints WHERE type='PK'
       UNION ALL SELECT 'UQ',
         (SELECT COUNT(*) FROM sys.key_constraints WHERE type='UQ') +
         (SELECT COUNT(*) FROM sys.indexes WHERE is_unique=1 AND has_filter=1 AND is_primary_key=0)
       UNION ALL SELECT 'FK', COUNT(*) FROM sys.foreign_keys
       UNION ALL SELECT 'C', COUNT(*) FROM sys.check_constraints`,
    )
  ).recordset,
  fks: (
    await pool2.request().query(
      `SELECT OBJECT_NAME(parent_object_id) AS t, COUNT(*) AS n FROM sys.foreign_keys GROUP BY OBJECT_NAME(parent_object_id)`,
    )
  ).recordset,
  uc: (
    await pool2.request().query(
      `SELECT t, type, COUNT(*) AS n FROM (
         SELECT OBJECT_NAME(parent_object_id) AS t, 'u' AS type FROM sys.key_constraints WHERE type='UQ'
         UNION ALL
         SELECT OBJECT_NAME(object_id), 'u' FROM sys.indexes WHERE is_unique=1 AND has_filter=1 AND is_primary_key=0
         UNION ALL
         SELECT OBJECT_NAME(parent_object_id), 'c' FROM sys.check_constraints
       ) x GROUP BY t, type`,
    )
  ).recordset,
  udefs: (
    await pool2.request().query(
      `SELECT t, conname, cols FROM (
         SELECT OBJECT_NAME(kc.parent_object_id) AS t, kc.name AS conname, col.name AS cols
         FROM sys.key_constraints kc
         JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
         JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
         WHERE kc.type = 'UQ'
         UNION ALL
         SELECT OBJECT_NAME(i.object_id), i.name, col.name
         FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
         WHERE i.is_unique=1 AND i.has_filter=1 AND i.is_primary_key=0
       ) x ORDER BY 1, 2, 3`,
    )
  ).recordset,
};
await pool2.close();

const groupCols = (rows) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.table_name)) m.set(r.table_name, []);
    m.get(r.table_name).push(r);
  }
  return m;
};
const pgByT = groupCols(pgColRows.cols);
const msByT = groupCols(msColRows.cols);

console.log('');
console.log('=== schema: column diffs per shared table ===');
let schemaProblems = 0;
for (const t of pgTables) {
  if (!msSet.has(t)) continue;
  const p = pgByT.get(t) ?? [];
  const m = msByT.get(t) ?? [];
  const pMap = new Map(p.map((r) => [r.column_name, r]));
  const mMap = new Map(m.map((r) => [r.column_name, r]));
  const missC = [...pMap.keys()].filter((c) => !mMap.has(c));
  const extraC = [...mMap.keys()].filter((c) => !pMap.has(c));
  let nullDiff = 0;
  let defDiff = 0;
  const nullNames = [];
  const defNames = [];
  for (const [c, pr] of pMap) {
    const mr = mMap.get(c);
    if (!mr) continue;
    if (pr.is_nullable !== mr.is_nullable) {
      nullDiff++;
      if (nullNames.length < 8) nullNames.push(`${c}(pg=${pr.is_nullable},ms=${mr.is_nullable})`);
    }
    if (Number(pr.has_def) !== Number(mr.has_def)) {
      defDiff++;
      if (defNames.length < 8) defNames.push(`${c}(pg=${pr.has_def ? 'def' : 'none'},ms=${mr.has_def ? 'def' : 'none'})`);
    }
  }
  if (missC.length || extraC.length || nullDiff || defDiff) {
    schemaProblems++;
    console.log(
      `${t}: missing_cols=[${missC.join(', ')}] extra_cols=[${extraC.join(', ')}] nullable_diffs=[${nullNames.join('; ')}] default_diffs=[${defNames.join('; ')}]`,
    );
  }
}
if (!schemaProblems) console.log('(all shared tables: columns match — names, nullability, default presence)');

const typePairs = new Map();
for (const [t, pRows] of pgByT) {
  const mRows = msByT.get(t);
  if (!mRows) continue;
  const mMap = new Map(mRows.map((r) => [r.column_name, r]));
  for (const pr of pRows) {
    const mr = mMap.get(pr.column_name);
    if (!mr) continue;
    const pt = pr.data_type === 'ARRAY' ? `${pr.udt_name}[]` : pr.data_type;
    const k = `${pt} -> ${mr.data_type}`;
    typePairs.set(k, (typePairs.get(k) ?? 0) + 1);
  }
}
console.log('');
console.log('=== schema: type pairs (pg -> mssql) ===');
for (const [k, n] of [...typePairs.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)}x  ${k}`);

const pgConsMap = new Map(pgColRows.cons.map((r) => [r.contype, Number(r.n)]));
const msConsMap = new Map(msColRows.cons.map((r) => [r.contype, Number(r.n)]));
const consLabel = { p: 'PK', f: 'FK', u: 'UNIQUE', c: 'CHECK' };
console.log('');
console.log('=== schema: constraint totals (production-PG -> local-MSSQL) ===');
for (const ct of ['p', 'f', 'u', 'c']) {
  const a = pgConsMap.get(ct) ?? 0;
  const b = msConsMap.get(ct === 'u' ? 'UQ' : ct === 'c' ? 'C' : ct === 'p' ? 'PK' : 'FK') ?? 0;
  console.log(`${(consLabel[ct] + ':').padEnd(9)} ${a} -> ${b}${a === b ? '' : '   <-- DIFF'}`);
}

const pgUc = new Map(pgColRows.uc.map((r) => [`${r.t}|${r.contype}`, Number(r.n)]));
const msUc = new Map(msColRows.uc.map((r) => [`${r.t}|${r.type}`, Number(r.n)]));
console.log('');
console.log('=== schema: per-table UNIQUE/CHECK count diffs (only differing tables) ===');
let ucDiffs = 0;
const ucTables = [...new Set([...pgColRows.uc.map((r) => r.t), ...msColRows.uc.map((r) => r.t)])].sort();
for (const t of ucTables) {
  if (!pgSet.has(t) || !msSet.has(t)) continue;
  for (const ct of ['u', 'c']) {
    const a = pgUc.get(`${t}|${ct}`) ?? 0;
    const b = msUc.get(`${t}|${ct}`) ?? 0;
    if (a !== b) {
      ucDiffs++;
      console.log(`${t} ${ct === 'u' ? 'UNIQUE' : 'CHECK'}: PG=${a} MSSQL=${b}`);
    }
  }
}
if (!ucDiffs) console.log('(per-table UNIQUE/CHECK counts match)');
const diffUcTables = new Set();
for (const t of ucTables) {
  for (const ct of ['u', 'c']) {
    if ((pgUc.get(`${t}|${ct}`) ?? 0) !== (msUc.get(`${t}|${ct}`) ?? 0)) diffUcTables.add(t);
  }
}
if (diffUcTables.size) {
  console.log('--- UNIQUE details for differing tables (pg def -> mssql cols) ---');
  const msU = new Map();
  for (const r of msColRows.udefs) msU.set(r.t, [...(msU.get(r.t) ?? []), `${r.conname}(${r.cols})`]);
  for (const r of pgColRows.udefs) {
    if (diffUcTables.has(r.t)) console.log(`  PG  ${r.t}: ${r.conname} = ${r.d}`);
  }
  for (const [t, arr] of msU) {
    if (diffUcTables.has(t)) console.log(`  MS  ${t}: ${arr.join('; ')}`);
  }
}

const pgFk = new Map(pgColRows.fks.map((r) => [r.t, Number(r.n)]));
const msFk = new Map(msColRows.fks.map((r) => [r.t, Number(r.n)]));
let fkDiffs = 0;
for (const t of pgTables) {
  if (!msSet.has(t)) continue;
  const a = pgFk.get(t) ?? 0;
  const b = msFk.get(t) ?? 0;
  if (a !== b) {
    fkDiffs++;
    console.log(`FK count differs on ${t}: PG=${a} MSSQL=${b}`);
  }
}
if (!fkDiffs) console.log('(per-table FK counts match on all shared tables)');

console.log('');
console.log(`totals: production-PG=${totPg} rows  local-MSSQL=${totMs} rows`);
const verdictOk =
  mismatch === 0 &&
  missingInMs.length === 0 &&
  extraInMs.length === 0 &&
  schemaProblems === 0 &&
  fkDiffs === 0 &&
  ucDiffs === 0;
console.log(
  `verdict: counts ${matched}/23 identical, ${mismatch} count-problems; columns ${schemaProblems} table-issues; unique/check ${ucDiffs} table-issues; fk ${fkDiffs} table-issues`,
);
console.log(verdictOk ? 'MIGRATION-COMPLETE: yes (counts+schema parity)' : 'MIGRATION-COMPLETE: NO');
process.exit(verdictOk ? 0 : 1);
