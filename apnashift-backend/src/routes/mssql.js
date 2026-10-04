// MS SQL Server verification endpoint (read-only).
// GET /api/mssql/health — does NOT touch PostgreSQL and changes nothing:
// connects (if configured), runs SELECT @@SERVERNAME + user-table count.
// Unreachable/misconfigured -> 503 with reason (never secrets, never stack).
import { Router } from 'express';
import { isMssqlEnabled, mssqlQuery } from '../mssql/db.js';
import { mssqlTarget } from '../mssql/config.js';

export const mssqlRoutes = Router();

// GET /api/mssql/health (public, read-only)
mssqlRoutes.get('/health', async (req, res) => {
  if (!isMssqlEnabled()) {
    return res.status(503).json({ ok: false, error: 'mssql_not_configured', target: mssqlTarget() });
  }
  try {
    const srv = await mssqlQuery('SELECT @@SERVERNAME AS srv, DB_NAME() AS db');
    const tables = await mssqlQuery('SELECT COUNT(*) AS n FROM sys.tables');
    res.json({
      ok: true,
      service: 'apnashift-mssql',
      server: srv.recordset[0].srv,
      database: srv.recordset[0].db,
      user_tables: Number(tables.recordset[0].n),
    });
  } catch (err) {
    console.error('[mssql] health fail:', err.message);
    res.status(503).json({ ok: false, error: 'mssql_unreachable', target: mssqlTarget() });
  }
});
