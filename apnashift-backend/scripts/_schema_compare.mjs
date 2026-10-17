// TEMP — read-only schema compare: local PG (DATABASE_URL) vs local MSSQL (MSSQL_*).
// Prints diffs only; never writes, never prints credentials/URLs.
import 'dotenv/config';
import pg from 'pg';
import sql from 'mssql';
import { mssqlConfig } from '../src/mssql/config.js';

const out = [];
const say = (s = '') => out.push(s);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL nahi hai .env me');
  process.exit(1);
}
const u = new URL(process.env.DATABASE_URL);
say(`PG     : ${u.hostname}:${u.port || '5432'} db=${u.pathname.slice(1)}`);
const mcfg = mssqlConfig();
say(`MSSQL  : ${mcfg.server}:${mcfg.port ?? 1433} db=${mcfg.database}`);

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- PG side (read-only)
const pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
await pgc.connect();
const pgTables = (
  await pgc.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`,
  )
).rows.map((r) => r.table_name);
const pgCols = (
  await pgc.query(
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
  )
).rows;
const pgCounts = {};
for (const t of pgTables) {
  if (!ident.test(t)) throw new Error('bad ident ' + t);
  pgCounts[t] = Number((await pgc.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
}
await pgc.end();

// ---- MSSQL side (read-only)
const pool = await new sql.ConnectionPool(mssqlConfig()).connect();
const mTables = (
  await pool
    .request()
    .query(
      `SELECT TABLE_NAME AS t FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_SCHEMA='dbo' ORDER BY 1`,
    )
).recordset.map((r) => r.t);
const mCols = (
  await pool
    .request()
    .query(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, DATA_TYPE AS dt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    )
).recordset;
const mCounts = {};
for (const t of mTables) {
  if (!ident.test(t)) throw new Error('bad ident ' + t);
  mCounts[t] = Number((await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`)).recordset[0].n);
}
await pool.close();

// ---- diff
say('');
say(`tables: PG=${pgTables.length}  MSSQL=${mTables.length}`);
const pgSet = new Set(pgTables);
const msSet = new Set(mTables);
const missing = pgTables.filter((t) => !msSet.has(t));
const extra = mTables.filter((t) => !pgSet.has(t));
say(`missing in MSSQL: ${missing.length ? missing.map((t) => `${t}(${pgCounts[t]})`).join(', ') : '(none)'}`);
say(`extra in MSSQL  : ${extra.length ? extra.join(', ') : '(none)'}`);

const byTable = (rows, tk, ck) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[tk])) m.set(r[tk], []);
    m.get(r[tk]).push(r[ck]);
  }
  return m;
};
const pgBy = byTable(pgCols, 'table_name', 'column_name');
const msBy = byTable(mCols, 'tbl', 'col');

say('');
say('=== column-name diffs (per shared table) ===');
let colDiffs = 0;
for (const t of pgTables) {
  if (!msSet.has(t)) continue;
  const p = new Set(pgBy.get(t) ?? []);
  const m = new Set(msBy.get(t) ?? []);
  const missC = [...p].filter((c) => !m.has(c));
  const extraC = [...m].filter((c) => !p.has(c));
  if (missC.length || extraC.length) {
    colDiffs++;
    say(
      `${t}: missing=[${missC.join(', ')}] extra=[${extraC.join(', ')}]`,
    );
  }
}
if (!colDiffs) say('(all shared tables: column names match)');

// ---- type pairs for shared (table, column)
const pgType = new Map(pgCols.map((r) => [`${r.table_name}.${r.column_name}`, r]));
const pairs = new Map();
for (const r of mCols) {
  const key = `${r.tbl}.${r.col}`;
  const p = pgType.get(key);
  if (!p) continue;
  const pt = p.data_type === 'ARRAY' ? `${p.udt_name}[]` : p.data_type;
  const pk = `${pt} -> ${r.dt}`;
  if (!pairs.has(pk)) pairs.set(pk, { n: 0, ex: [] });
  const e = pairs.get(pk);
  e.n++;
  if (e.ex.length < 3) e.ex.push(key);
}
say('');
say('=== type pairs (pg -> mssql) ===');
for (const [k, v] of [...pairs.entries()].sort((a, b) => b[1].n - a[1].n)) {
  say(`${String(v.n).padStart(3)}x  ${k}   e.g. ${v.ex.join(', ')}`);
}

say('');
say('=== PG row counts (non-zero; migration volume) ===');
const nz = Object.entries(pgCounts).filter(([, n]) => n > 0);
say(nz.length ? nz.map(([t, n]) => `${t}=${n}`).join(', ') : '(all zero)');
say('');
say('=== MSSQL row counts (non-zero) ===');
const nz2 = Object.entries(mCounts).filter(([, n]) => n > 0);
say(nz2.length ? nz2.map(([t, n]) => `${t}=${n}`).join(', ') : '(all zero)');

console.log(out.join('\n'));
