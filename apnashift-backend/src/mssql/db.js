// MS SQL Server pool (mssql/tedious driver) exposing the SAME surface as the
// pg pool in src/db.js so route/service code stays byte-identical:
//   pool.query(text, params) -> { rows, rowCount }
//   pool.connect()           -> { query(text, params), release() }
//   pool.end()               -> close; pool.on() -> no-op (pg compatibility)
// SQL text is translated PG->T-SQL via ./translate.js; params are bound as
// @p1..@pn (NEVER string-interpolated). Errors get pg-style .code values so
// existing `err.code === '23505'` branches keep working.
// The pool connects lazily on first query. Failures surface to callers —
// never secrets, never stack traces to clients.
import sql from 'mssql';
import { mssqlConfig, isMssqlConfigured } from './config.js';
import { translateToMssql } from './translate.js';

let poolPromise = null;

export function isMssqlEnabled() {
  return isMssqlConfigured();
}

async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(mssqlConfig()).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// -------------------------------------------------------------- pg parity
// pg maps: int8/numeric -> JS string; bool -> boolean; uuid -> string.
// mssql returns numbers for BIGINT/DECIMAL — stringify those to match the
// shapes all existing code (and tests) were written against.
function stringifyPgNumericTypes(recordset) {
  const meta = recordset?.columns;
  if (!meta) return recordset ?? [];
  const T = sql.TYPES ?? sql.types ?? {};
  const numericIds = new Set(
    [T.BigInt?.id, T.Decimal?.id, T.Numeric?.id, T.Money?.id, T.SmallMoney?.id].filter(
      (v) => v !== undefined,
    ),
  );
  const cols = Array.isArray(meta)
    ? meta
    : Object.entries(meta).map(([k, v]) => ({ name: v?.name ?? k, ...v }));
  const byName = new Map(cols.map((c) => [c.name, c]));
  const names = Object.keys(recordset[0] ?? {});
  const targets = [];
  for (const name of names) {
    const c = byName.get(name);
    const id = c ? (c.typeId ?? c.type?.id) : undefined;
    if (id !== undefined && numericIds.has(id)) targets.push(name);
  }
  if (!targets.length) return recordset;
  return recordset.map((row) => {
    const out = { ...row };
    for (const name of targets) {
      if (out[name] !== null && out[name] !== undefined) out[name] = String(out[name]);
    }
    return out;
  });
}

// PG jsonb/TEXT[] columns were auto-parsed by pg into JS objects/arrays.
// MSSQL stores them as NVARCHAR JSON — parse strings that look like JSON.
function autoJson(rows) {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (typeof v === 'string' && (v[0] === '{' || v[0] === '[')) {
        try {
          row[k] = JSON.parse(v);
        } catch {
          // not JSON — leave as-is (matches pg text columns)
        }
      }
    }
  }
  return rows;
}

// Params: pg accepted undefined->null, JS arrays->array params, ISO strings
// as timestamptz. Mirror that for tedious (which rejects undefined/arrays,
// and cannot parse the trailing 'Z' in datetime comparisons).
function normalizeParam(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return JSON.stringify(v);
  if (v instanceof Date) return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return v;
}

// pg error codes callers depend on: 23505 unique, 23514 check, 42P01 missing
// table, 23503 FK. mssql sets err.code='EREQUEST' — overwrite it.
function mapPgError(err) {
  const n = err?.number;
  if (n === 2601 || n === 2627) err.code = '23505';
  else if (n === 547) err.code = /FOREIGN KEY/i.test(err.message ?? '') ? '23503' : '23514';
  else if (n === 208) err.code = '42P01';
  return err;
}

async function runQuery(conn, text, params = []) {
  const req = new sql.Request(conn);
  const list = Array.isArray(params) ? params : [];
  list.forEach((v, i) => req.input(`p${i + 1}`, normalizeParam(v)));
  let result;
  try {
    result = await req.query(translateToMssql(text));
  } catch (err) {
    throw mapPgError(err);
  }
  const rows = autoJson(stringifyPgNumericTypes(result.recordset ?? []));
  const rowCount = result.recordset
    ? result.recordset.length
    : (result.rowsAffected?.[0] ?? 0);
  return { rows, rowCount };
}

const TXN_BEGIN = new Set(['BEGIN', 'BEGIN TRANSACTION', 'BEGIN TRAN', 'START TRANSACTION']);
const TXN_COMMIT = new Set(['COMMIT', 'COMMIT TRANSACTION', 'COMMIT TRAN']);
const TXN_ROLLBACK = new Set(['ROLLBACK', 'ROLLBACK TRANSACTION', 'ROLLBACK TRAN']);

// Transaction wrapper: BEGIN/COMMIT/ROLLBACK texts map to sql.Transaction;
// every other statement runs inside the transaction (or on the pool when no
// transaction is open — same autocommit semantics as pg).
function makeClient(getConn) {
  let txn = null;
  let active = false;

  return {
    async query(text, params) {
      const bare = typeof text === 'string' ? text.trim().toUpperCase() : '';
      if (TXN_BEGIN.has(bare)) {
        if (!active) {
          txn = new sql.Transaction(getConn());
          await txn.begin();
          active = true;
        }
        return { rows: [], rowCount: 0 };
      }
      if (TXN_COMMIT.has(bare)) {
        if (active && txn) {
          await txn.commit();
          active = false;
          txn = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (TXN_ROLLBACK.has(bare)) {
        if (active && txn) {
          await txn.rollback();
          active = false;
          txn = null;
        }
        return { rows: [], rowCount: 0 };
      }
      return runQuery(active && txn ? txn : getConn(), text, params);
    },
    async release() {
      if (active && txn) {
        try {
          await txn.rollback();
        } catch {
          // already-closed transaction — nothing to release
        }
        active = false;
        txn = null;
      }
    },
  };
}

export function createMssqlPool() {
  const pool = {
    async query(text, params) {
      return runQuery(await getPool(), text, params);
    },
    async connect() {
      const p = await getPool();
      return makeClient(() => p);
    },
    async end() {
      return mssqlClose();
    },
    on() {
      // pg pool emits 'error'; mssql surfaces errors per-request. No-op.
      return pool;
    },
  };
  return pool;
}

// Read-only helper for the /api/mssql/verification endpoint.
export async function mssqlQuery(text, params = []) {
  const pool = await getPool();
  const req = pool.request();
  params.forEach((v, i) => {
    req.input(`p${i + 1}`, v);
  });
  const converted = text.replace(/\$(\d+)/g, (_, n) => `@p${n}`);
  return req.query(converted);
}

export async function mssqlClose() {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null);
    poolPromise = null;
    if (pool) await pool.close().catch(() => {});
  }
}
