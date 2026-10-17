// TEMP — READ-ONLY value verification: production PostgreSQL vs local scratch
// ApnaShiftDB_migrate (post-migration). Compares ALL rows of every non-empty
// table (normalizing types), plus verifies HEAD-only v2 columns took their
// schema defaults. Never prints row values (PII/secrets) — only table/column
// names and counts. Requires Railway form + consent flag; refuses any target
// that is not a *migrate* scratch.
import 'dotenv/config';
import pg from 'pg';
import sql from 'mssql';

function fail(msg) {
  console.error(`[spot-prod] FAIL: ${msg}`);
  process.exit(1);
}

const raw = process.env.DATABASE_URL ?? '';
if (!/^[\w.-]+:\d+$/.test(raw.trim())) fail('railway run se chalao (host:port Database_url nahi mila).');
if (process.env.MIGRATE_ALLOW_REMOTE_SOURCE !== '1') fail('consent flag chahiye: MIGRATE_ALLOW_REMOTE_SOURCE=1');
const user = process.env.PGUSER ?? process.env.POSTGRES_USER;
const pass = process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD;
const db = process.env.PGDATABASE ?? process.env.POSTGRES_DB;
if (!user || !pass || !db) fail('PGUSER/PGPASSWORD/PGDATABASE incomplete.');
const [ph, pp] = raw.trim().split(':');

const targetDb = process.env.MSSQL_DATABASE ?? '';
if (!/migrate/i.test(targetDb)) fail(`MSSQL_DATABASE='${targetDb}' migrate scratch nahi hai.`);

const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
let failures = 0;
const say = (s) => console.log(s);

const pgc = new pg.Client({
  host: ph,
  port: Number(pp),
  database: db,
  user,
  password: pass,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 60000,
});
await pgc.connect();
const pool = await new sql.ConnectionPool({
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER ?? 'localhost',
  port: Number(process.env.MSSQL_PORT || 14330),
  database: targetDb,
  options: { encrypt: false, trustServerCertificate: true, connectTimeout: 8000, requestTimeout: 60000 },
}).connect();

const tables = (
  await pgc.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`,
  )
).rows.map((r) => r.table_name);
for (const t of tables) if (!ident.test(t)) fail('bad table name ' + t);

const pgColsByT = new Map();
{
  const r = await pgc.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
  );
  for (const row of r.rows) {
    if (!pgColsByT.has(row.table_name)) pgColsByT.set(row.table_name, []);
    pgColsByT.get(row.table_name).push(row);
  }
}
const msColsByT = new Map();
{
  const r = await pool.request().query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA='dbo' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  );
  for (const row of r.recordset) {
    if (!msColsByT.has(row.t)) msColsByT.set(row.t, []);
    msColsByT.get(row.t).push(row);
  }
}

// ---- normalize helpers (both sides fed through PG's type knowledge)
const utc = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ` +
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:` +
  `${String(d.getUTCSeconds()).padStart(2, '0')}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
const norm = (col, v) => {
  if (v === null || v === undefined) return null;
  switch (col.data_type) {
    case 'timestamp with time zone': {
      if (typeof v === 'string') {
        // both sides already projected to canonical strings (pg to_char / ms CONVERT)
        return v.replace('T', ' ').replace(/(\.\d{3})\d+$/, '$1');
      }
      return utc(v instanceof Date ? v : new Date(v));
    }
    case 'date':
      return v instanceof Date
        ? `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`
        : String(v).slice(0, 10);
    case 'boolean':
      return v === true || v === 1 || v === '1' || v === 't' || v === 'true' ? '1' : '0';
    case 'numeric':
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'double precision':
    case 'real':
      return String(Number(v));
    case 'jsonb':
    case 'ARRAY':
      return typeof v === 'string' ? v : JSON.stringify(v);
    case 'uuid':
      return String(v).toLowerCase(); // MSSQL uniqueidentifier surfaces uppercase
    default:
      return String(v);
  }
};
const pgProj = (cols) =>
  cols
    .map((c) => {
      const q = `"${c.column_name}"`;
      if (c.data_type === 'timestamp with time zone')
        return `to_char(${q} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS ${q}`;
      if (c.data_type === 'date') return `to_char(${q}, 'YYYY-MM-DD') AS ${q}`;
      return q;
    })
    .join(', ');
const msProj = (msCols) =>
  msCols
    .map((c) => {
      const q = `[${c.c}]`;
      if (c.dt === 'datetime2') return `CONVERT(varchar(30), ${q}, 126) AS ${q}`;
      if (c.dt === 'date') return `CONVERT(char(10), ${q}, 23) AS ${q}`;
      return q;
    })
    .join(', ');

let totalCompared = 0;
for (const t of tables) {
  const pgAll = pgColsByT.get(t) ?? [];
  const msAll = msColsByT.get(t) ?? [];
  const msNames = new Set(msAll.map((c) => c.c));
  const shared = pgAll.filter((c) => msNames.has(c.column_name));
  const pgN = Number((await pgc.query(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
  if (pgN === 0) continue;
  const msN = Number((await pool.request().query(`SELECT COUNT(*) AS n FROM [${t}]`)).recordset[0].n);
  if (pgN !== msN) {
    failures++;
    say(`FAIL ${t}: row counts pg=${pgN} ms=${msN}`);
    continue;
  }
  const pgRows = (await pgc.query(`SELECT ${pgProj(shared)} FROM "${t}"`)).rows;
  const msByName = new Map(msAll.map((c) => [c.c, c]));
  const msShared = shared.map((c) => msByName.get(c.column_name));
  const msRows = (await pool.request().query(`SELECT ${msProj(msShared)} FROM [${t}]`)).recordset;
  const normRow = (r) => shared.map((c) => norm(c, r[c.column_name]));
  const normPg = pgRows.map((r) => normRow(r));
  const normMs = msRows.map((r) => normRow(r));
  const sortKey = (arr) => JSON.stringify(arr);
  normPg.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  normMs.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  let bad = 0;
  let firstDetail = '';
  for (let i = 0; i < normPg.length; i++) {
    const a = normPg[i];
    const b = normMs[i];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      for (let j = 0; j < shared.length; j++) {
        if (a[j] !== b[j]) {
          bad++;
          if (!firstDetail)
            firstDetail = `${t}.${shared[j].column_name} @sorted-row-${i} (pg ${a[j] === null ? 'null' : typeof a[j]}:${String(a[j]).length}ch vs ms ${b[j] === null ? 'null' : typeof b[j]}:${String(b[j]).length}ch)`;
        }
      }
    }
  }
  totalCompared += pgRows.length;
  if (bad) {
    failures++;
    say(`FAIL ${t}: ${bad} value mismatches of ${pgRows.length} rows x ${shared.length} cols — first: ${firstDetail}`);
  } else {
    say(`OK   ${t}: ${pgRows.length} rows x ${shared.length} cols values match`);
  }
}

// ---- HEAD-only v2 columns must hold schema defaults (source has no such cols)
{
  const r = await pool.request().query(
    `SELECT vehicle_size_tier, goods_weight_kg, item_count, has_bulky_item FROM bookings`,
  );
  const ok = r.recordset.every(
    (x) => x.vehicle_size_tier === 'chhota' && Number(x.goods_weight_kg) === 0 && Number(x.item_count) === 1 && (x.has_bulky_item === 0 || x.has_bulky_item === false),
  );
  if (!ok) {
    failures++;
    say('FAIL bookings v2 default columns: unexpected values');
  } else say(`OK   bookings v2 defaults on ${r.recordset.length} rows (chhota/0/1/false)`);
}
{
  const r = await pool.request().query(
    `SELECT minimum_fare, size_small_extra, size_big_extra, weight_0_100, weight_100_300, weight_300_500, weight_500_plus FROM pricing_rules`,
  );
  const cols = ['minimum_fare', 'size_small_extra', 'size_big_extra', 'weight_0_100', 'weight_100_300', 'weight_300_500', 'weight_500_plus'];
  const ok = r.recordset.every((x) => cols.every((c) => Number(x[c]) === 0));
  if (!ok) {
    failures++;
    say('FAIL pricing_rules v2 default columns: unexpected values');
  } else say(`OK   pricing_rules v2 defaults on ${r.recordset.length} rows (all 0)`);
}

await pgc.end();
await pool.close();
say(failures ? `SPOT-PROD FAILED (${failures})` : `SPOT-PROD OK — ${totalCompared} rows across all non-empty tables verified + v2 defaults`);
process.exit(failures ? 1 : 0);
