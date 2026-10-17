// TEMP spot-check: migrated VALUES match source (not just counts).
// Compares wall-clock UTC timestamp strings, JSON, uuid, numeric, bit.
import 'dotenv/config';
import pg from 'pg';
import sql from 'mssql';

const src = new URL(process.env.DATABASE_URL);
console.log(`spot: ${src.hostname}${src.pathname} vs ${process.env.MSSQL_SERVER}:${process.env.MSSQL_PORT}/${process.env.MSSQL_DATABASE}`);

const pgc = new pg.Client({ connectionString: process.env.DATABASE_URL });
await pgc.connect();
const pool = await new sql.ConnectionPool({
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  server: process.env.MSSQL_SERVER ?? 'localhost',
  port: Number(process.env.MSSQL_PORT || 14330),
  database: process.env.MSSQL_DATABASE,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();

let fails = 0;
const cmp = async (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) console.log(`       pg=${JSON.stringify(a)}\n       ms=${JSON.stringify(b)}`);
};

// bookings: uuid + timestamptz (UTC wall clock) + numeric + bit
const pgB = await pgc.query(
  `SELECT id, created_at, scheduled_at, helper, distance_km, item_count FROM bookings ORDER BY id`,
);
const msB = await pool.request().query(
  `SELECT id, CONVERT(varchar(30), created_at, 126) AS created_at,
          CONVERT(varchar(30), scheduled_at, 126) AS scheduled_at,
          helper, distance_km, item_count FROM bookings ORDER BY id`,
);
const normPgTime = (d) =>
  d instanceof Date ? d.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23) : String(d);
const normMsTime = (s) => String(s).replace('T', ' ').replace(/(\.\d{3})\d+$/, '$1');
const normUuid = (u) => String(u).toLowerCase();
const sortRows = (rows, idKey = 'id') => [...rows].sort((a, b) => String(a[idKey]).toLowerCase().localeCompare(String(b[idKey]).toLowerCase()));
await cmp(
  'bookings rows',
  sortRows(pgB.rows).map((r) => [normUuid(r.id), normPgTime(r.created_at), normPgTime(r.scheduled_at), r.helper, String(r.distance_km), r.item_count]),
  sortRows(msB.recordset).map((r) => [normUuid(r.id), normMsTime(r.created_at), normMsTime(r.scheduled_at), r.helper === 1, String(r.distance_km), r.item_count]),
);

// platform_settings: JSON value survives verbatim
const pgP = await pgc.query(`SELECT key, value FROM platform_settings ORDER BY key`);
const msP = await pool.request().query(`SELECT [key], value FROM platform_settings ORDER BY [key]`);
await cmp(
  'platform_settings json',
  pgP.rows.map((r) => [r.key, typeof r.value === 'string' ? r.value : JSON.stringify(r.value)]),
  msP.recordset.map((r) => [r.key, r.value]),
);

// notifications: jsonb parsed by pg -> must deep-equal parsed mssql string
const pgN = await pgc.query(`SELECT id, data, type FROM notifications ORDER BY id`);
const msN = await pool.request().query(`SELECT id, data, type FROM notifications ORDER BY id`);
await cmp(
  'notifications jsonb',
  sortRows(pgN.rows).map((r) => [normUuid(r.id), r.data, r.type]),
  sortRows(msN.recordset).map((r) => [normUuid(r.id), typeof r.data === 'string' ? JSON.parse(r.data) : r.data, r.type]),
);

// device_tokens: uuid pair + timestamptz on a small table
const pgD = await pgc.query(`SELECT token, owner_id FROM device_tokens ORDER BY token`);
const msD = await pool.request().query(`SELECT token, owner_id FROM device_tokens ORDER BY token`);
await cmp(
  'device_tokens',
  sortRows(pgD.rows, 'token').map((r) => [normUuid(r.token), normUuid(r.owner_id)]),
  sortRows(msD.recordset, 'token').map((r) => [normUuid(r.token), normUuid(r.owner_id)]),
);

await pgc.end();
await pool.close();
console.log(fails ? `SPOT FAIL (${fails})` : 'SPOT OK — values match');
process.exit(fails ? 1 : 0);
