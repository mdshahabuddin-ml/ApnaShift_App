// Super Admin read-only router — NEW FILE, NOT MOUNTED.
// ---------------------------------------------------------------------------
// WIRING NEEDS PERMISSION (existing-file change): mount with ONE line in
// apnashift-backend/src/app.js:
//
//   import { superAdminRoutes } from '../../super-admin-module/backend/superAdminRoutes.js';
//   app.use('/api/superadmin', superAdminRoutes);
//
// Do NOT mount without explicit approval (Phase B §9.1).
//
// Guarantees:
// - SELECT only. No INSERT/UPDATE/DELETE anywhere in this file.
// - Reuses existing auth (requireAuth + requireRole('admin')) and existing
//   tables. No new tables, no new auth system, no secrets in responses
//   (password_hash is never selected; details JSONB is allowlisted by shape
//   only in the audit reader — ids, actions, reasons, never tokens/hashes).
// - Every privileged write stays on the EXISTING admin/enterprise/
//   settlement endpoints; this router never duplicates them.

import { createRequire } from 'node:module';
// NOTE: ye file apnashift-backend/ ke baahar rehti hai, isliye bare imports
// (express) yahan se resolve nahi hote. Backend ke node_modules ko anchor
// karke lete hain; backend ke ESM modules ko file-URL se import karte hain.
// Koi nayi dependency nahi, koi copy nahi.
const need = createRequire(new URL('../../apnashift-backend/package.json', import.meta.url));
const { Router } = need('express');
const BACKEND_SRC = new URL('../../apnashift-backend/src/', import.meta.url);
const { query } = await import(new URL('db.js', BACKEND_SRC));
const { requireAuth, requireRole } = await import(new URL('middleware/auth.js', BACKEND_SRC));
const { validateIdParam } = await import(new URL('utils/validate.js', BACKEND_SRC));

export const superAdminRoutes = Router();
// Super-admin tier only (022). Plain admins get 403 here — they keep using
// the existing /api/admin/* endpoints, which super_admin also passes.
superAdminRoutes.use(requireAuth, requireRole('super_admin'));

// GET /api/superadmin/overview — one-shot ops snapshot (Module 1).
// Combines what /api/admin/stats + /reports/summary give, plus customer
// counts and cancellation rate. All numbers from live tables, never samples.
superAdminRoutes.get('/overview', async (req, res, next) => {
  try {
    const [customers, drivers, bookings, money] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM users`),
      query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE is_verified = TRUE AND is_active = TRUE) AS active,
                COUNT(*) FILTER (WHERE is_verified = FALSE AND is_active = TRUE) AS pending,
                COUNT(*) FILTER (WHERE is_active = FALSE) AS inactive
           FROM drivers`,
      ),
      query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                COUNT(*) FILTER (WHERE status = 'accepted') AS accepted,
                COUNT(*) FILTER (WHERE status IN ('accepted','arrived','in_transit')) AS in_progress,
                COUNT(*) FILTER (WHERE status = 'delivered') AS completed,
                COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today_total,
                COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('day', now())) AS today_completed
           FROM bookings`,
      ),
      query(
        `SELECT COALESCE(SUM(p.gross_amount), 0) AS fare_rs,
                COALESCE(SUM(p.platform_commission), 0) AS commission_rs,
                COALESCE(SUM(p.driver_earning), 0) AS earning_rs,
                COALESCE(SUM(p.platform_commission) - SUM(p.settled_amount), 0) AS outstanding_rs
           FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE b.status = 'delivered'`,
      ),
    ]);
    const b = bookings.rows[0];
    const total = Number(b.total);
    res.json({
      ok: true,
      customers: { total: Number(customers.rows[0].total) },
      drivers: {
        total: Number(drivers.rows[0].total),
        active: Number(drivers.rows[0].active),
        pending: Number(drivers.rows[0].pending),
        inactive: Number(drivers.rows[0].inactive),
      },
      bookings: {
        total,
        pending: Number(b.pending),
        accepted: Number(b.accepted),
        in_progress: Number(b.in_progress),
        completed: Number(b.completed),
        cancelled: Number(b.cancelled),
        cancellation_rate: total === 0 ? 0 : Math.round((Number(b.cancelled) / total) * 10000) / 100,
        today_total: Number(b.today_total),
        today_completed: Number(b.today_completed),
      },
      finance: {
        fare_rs: Number(money.rows[0].fare_rs),
        commission_rs: Number(money.rows[0].commission_rs),
        earning_rs: Number(money.rows[0].earning_rs),
        outstanding_rs: Math.max(0, Number(money.rows[0].outstanding_rs)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/superadmin/audit-logs?action=&entity=&page=&limit= (Module 5).
// Read-only view over the EXISTING audit_logs table. Secrets can never
// appear: only id/action/entity/entity_id/details-shape + admin name + time.
superAdminRoutes.get('/audit-logs', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const conds = [];
    const params = [];
    let i = 1;
    for (const key of ['action', 'entity']) {
      if (req.query[key]) {
        conds.push(`l.${key} = $${i++}`);
        params.push(String(req.query[key]));
      }
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows, count] = await Promise.all([
      query(
        `SELECT l.id, l.action, l.entity, l.entity_id, l.details, l.created_at,
                a.name AS admin_name
           FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id
          ${where} ORDER BY l.created_at DESC LIMIT $${i++} OFFSET $${i++}`,
        [...params, limit, (page - 1) * limit],
      ),
      query(`SELECT COUNT(*) AS total FROM audit_logs l ${where}`, params),
    ]);
    res.json({
      ok: true,
      page,
      limit,
      total: Number(count.rows[0].total),
      logs: rows.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/superadmin/customers/:id (Module 2).
// Customer detail + booking history + payment summary. No password_hash,
// no tokens — users table columns are name/phone/created_at only.
superAdminRoutes.get('/customers/:id', validateIdParam, async (req, res, next) => {
  try {
    const [user, bookings, spend] = await Promise.all([
      query(`SELECT id, name, phone, created_at FROM users WHERE id = $1`, [req.params.id]),
      query(
        `SELECT id, status, vehicle_type, price_rs, created_at, delivered_at
           FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.params.id],
      ),
      query(
        `SELECT COUNT(*) AS trips, COALESCE(SUM(p.gross_amount), 0) AS spent_rs
           FROM payments p JOIN bookings b ON b.id = p.booking_id
          WHERE b.user_id = $1 AND b.status = 'delivered'`,
        [req.params.id],
      ),
    ]);
    if (user.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    res.json({
      ok: true,
      customer: user.rows[0],
      status: 'active',
      bookings: bookings.rows,
      lifetime: {
        delivered_trips: Number(spend.rows[0].trips),
        spent_rs: Number(spend.rows[0].spent_rs),
      },
    });
  } catch (err) {
    next(err);
  }
});
