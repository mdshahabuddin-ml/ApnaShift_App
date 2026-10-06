// COD confirm + weekly settlement periods.
// Driver router (/api/driver/...): cash confirm (own payments only),
// own weekly periods. Admin router (/api/admin/...): generate, list,
// detail, pay, dispute, resolve. Auth model mirrors driver.js/admin.js:
// drivers see only their rows (else 404), admins see all.
import { Router } from 'express';
import { query, pool } from '../db.js';
import { toPaise, paiseToRs } from '../services/money.js';
import { publicPayment } from '../services/payments.js';
import {
  weekStartIST,
  toPublicPeriodList,
  generatePeriodsTx,
  payPeriodTx,
  disputePeriodTx,
  resolvePeriodTx,
} from '../services/settlements.js';
import { logAuditTx } from '../services/audit.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireVerifiedDriver } from '../middleware/driver.js';
import { validateIdParam } from '../utils/validate.js';
import {
  parseBody,
  parseQuery,
  periodGenerateSchema,
  periodPaySchema,
  periodDisputeSchema,
  periodListSchema,
} from '../validation/settlements.js';

// ---------- shared period list query (admin filterable, driver forced) ----------
async function listPeriods({ driverId, status, weekStart, page, limit }) {
  const conds = [];
  const params = [];
  let i = 1;
  if (driverId) {
    conds.push(`p.driver_id = $${i++}`);
    params.push(driverId);
  }
  if (weekStart) {
    conds.push(`p.week_start = $${i++}`);
    params.push(weekStart);
  }
  if (status && status !== 'OVERDUE') {
    conds.push(`p.status = $${i++}`);
    params.push(status);
  }
  if (status === 'OVERDUE') {
    // Derived: past week, still owed, not frozen.
    conds.push(`p.status IN ('DUE','PARTIALLY_PAID')`);
    conds.push(`p.week_end < $${i++}`);
    params.push(weekStartIST());
    conds.push(`p.commission_paise > p.settled_paise`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  const limitIdx = i;
  const offsetIdx = i + 1;
  const [rows, count] = await Promise.all([
    query(
      `SELECT p.*, d.name AS driver_name FROM settlement_periods p
        LEFT JOIN drivers d ON d.id = p.driver_id
       ${where} ORDER BY p.week_start DESC, p.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, limit, offset],
    ),
    query(`SELECT COUNT(*) AS total FROM settlement_periods p ${where}`, params),
  ]);
  return {
    rows: rows.rows.map((r) => ({ ...r })),
    total: Number(count.rows[0].total),
    driverNames: new Map(rows.rows.map((r) => [r.id, r.driver_name])),
  };
}

function withNames(list, names) {
  return toPublicPeriodList(list).map((p) => ({ ...p, driver_name: names.get(p.id) ?? null }));
}

// ================= driver =================
export const driverSettlementRoutes = Router();
driverSettlementRoutes.use(requireAuth, requireRole('driver'), requireVerifiedDriver);

// POST /api/driver/payments/:paymentId/confirm-cash — driver confirms the
// customer handed over full COD fare. Explicit only: the row must be a
// pending cash payment on a delivered booking of this driver. Repeat hits
// 409 already_confirmed (never double-counts).
driverSettlementRoutes.post('/payments/:id/confirm-cash', validateIdParam, async (req, res, next) => {
  const param = req.params.id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT p.id, p.payment_method, p.payment_status, p.driver_id,
              p.gross_amount, b.status AS booking_status
         FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE p.id = $1 AND p.driver_id = $2 FOR UPDATE OF p`,
      [param, req.user.id],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const row = found.rows[0];
    if (row.payment_method !== 'cash') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'not_cash' });
    }
    if (row.payment_status === 'collected') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'already_confirmed' });
    }
    if (row.payment_status !== 'pending' || row.booking_status !== 'delivered') {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'invalid_payment_state' });
    }
    const upd = await client.query(
      `UPDATE payments
          SET payment_status = 'collected', cash_confirmed_at = now(), collected_at = now()
        WHERE id = $1
       RETURNING id, booking_id, payment_method, payment_status, gross_amount,
                 driver_earning, platform_commission, commission_pct,
                 settlement_status, settled_amount, collected_at, cash_confirmed_at`,
      [row.id],
    );
    await logAuditTx(client, null, 'payment.cash_confirmed', 'payment', row.id, {
      driver_id: req.user.id,
      booking_id: row.booking_id,
      gross_rs: Number(row.gross_amount),
    });
    await client.query('COMMIT');
    res.json({ ok: true, payment: publicPayment(upd.rows[0], 'driver') });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/driver/settlement-periods — own weeks only.
driverSettlementRoutes.get('/settlement-periods', async (req, res, next) => {
  try {
    const { status, week_start, page, limit } = parseQuery(periodListSchema, req.query);
    const { rows, total, driverNames } = await listPeriods({
      driverId: req.user.id,
      status,
      weekStart: week_start,
      page,
      limit,
    });
    res.json({ ok: true, page, limit, total, periods: withNames(rows, driverNames) });
  } catch (err) {
    next(err);
  }
});

// GET /api/driver/settlement-periods/:id — own week detail + items.
driverSettlementRoutes.get('/settlement-periods/:id', validateIdParam, async (req, res, next) => {
  try {
    const period = await query('SELECT * FROM settlement_periods WHERE id = $1 AND driver_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (period.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const items = await query(
      `SELECT p.id, p.booking_id, p.payment_method, p.payment_status,
              p.gross_amount, p.driver_earning, p.platform_commission,
              p.settled_amount, p.collected_at, b.disputed AS booking_disputed
         FROM settlement_period_items i JOIN payments p ON p.id = i.payment_id
         LEFT JOIN bookings b ON b.id = p.booking_id
        WHERE i.period_id = $1 ORDER BY p.collected_at ASC`,
      [req.params.id],
    );
    const [pub] = toPublicPeriodList([period.rows[0]]);
    res.json({
      ok: true,
      period: pub,
      items: items.rows.map((r) => ({
        payment_id: r.id,
        booking_id: r.booking_id,
        booking_disputed: !!r.booking_disputed,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        gross_rs: Number(r.gross_amount),
        driver_earning_rs: Number(r.driver_earning),
        platform_commission_rs: Number(r.platform_commission),
        settled_rs: Number(r.settled_amount),
        collected_at: r.collected_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ================= admin =================
export const adminSettlementRoutes = Router();
adminSettlementRoutes.use(requireAuth, requireRole('admin'));

// POST /api/admin/settlement-periods/generate {driver_id?, week_start?}
// Idempotent: existing weeks are skipped (UNIQUE backstop), never doubled.
adminSettlementRoutes.post('/settlement-periods/generate', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { driver_id, week_start } = parseBody(periodGenerateSchema, req.body);
    await client.query('BEGIN');
    const out = await generatePeriodsTx(client, {
      driverId: driver_id ?? null,
      weekStart: week_start ?? null,
      adminId: req.user.id,
    });
    await client.query('COMMIT');
    res.json({ ok: true, ...out });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/admin/settlement-periods?driver_id=&status=&week_start=&page=&limit=
adminSettlementRoutes.get('/settlement-periods', async (req, res, next) => {
  try {
    const { driver_id, status, week_start, page, limit } = parseQuery(periodListSchema, req.query);
    const { rows, total, driverNames } = await listPeriods({
      driverId: driver_id,
      status,
      weekStart: week_start,
      page,
      limit,
    });
    res.json({ ok: true, page, limit, total, periods: withNames(rows, driverNames) });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/settlement-periods/:id — week detail + per-method split.
adminSettlementRoutes.get('/settlement-periods/:id', validateIdParam, async (req, res, next) => {
  try {
    const period = await query(
      `SELECT p.*, d.name AS driver_name, d.phone AS driver_phone
         FROM settlement_periods p LEFT JOIN drivers d ON d.id = p.driver_id
        WHERE p.id = $1`,
      [req.params.id],
    );
    if (period.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const items = await query(
      `SELECT p.id, p.booking_id, p.payment_method, p.payment_status,
              p.gross_amount, p.driver_earning, p.platform_commission,
              p.settled_amount, p.collected_at, b.disputed AS booking_disputed
         FROM settlement_period_items i JOIN payments p ON p.id = i.payment_id
         LEFT JOIN bookings b ON b.id = p.booking_id
        WHERE i.period_id = $1 ORDER BY p.collected_at ASC`,
      [req.params.id],
    );
    const [pub] = toPublicPeriodList([period.rows[0]]);
    const byMethod = {};
    for (const r of items.rows) {
      const m = r.payment_method;
      byMethod[m] ??= { count: 0, gross_paise: 0, commission_paise: 0 };
      byMethod[m].count += 1;
      byMethod[m].gross_paise += toPaise(r.gross_amount);
      byMethod[m].commission_paise += toPaise(r.platform_commission);
    }
    for (const m of Object.keys(byMethod)) {
      byMethod[m].gross_rs = paiseToRs(byMethod[m].gross_paise);
      byMethod[m].commission_rs = paiseToRs(byMethod[m].commission_paise);
      delete byMethod[m].gross_paise;
      delete byMethod[m].commission_paise;
    }
    res.json({
      ok: true,
      period: {
        ...pub,
        driver_name: period.rows[0].driver_name,
        driver_phone: period.rows[0].driver_phone,
      },
      by_method: byMethod,
      items: items.rows.map((r) => ({
        payment_id: r.id,
        booking_id: r.booking_id,
        booking_disputed: !!r.booking_disputed,
        payment_method: r.payment_method,
        payment_status: r.payment_status,
        gross_rs: Number(r.gross_amount),
        settled_rs: Number(r.settled_amount),
        collected_at: r.collected_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/settlement-periods/:id/payments — controlled verification:
// money moves only here, FIFO inside the week, receipt linked to the week.
adminSettlementRoutes.post('/settlement-periods/:id/payments', validateIdParam, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { amount_rs, method, reference_no, notes } = parseBody(periodPaySchema, req.body);
    await client.query('BEGIN');
    const out = await payPeriodTx(client, {
      periodId: req.params.id,
      amountPaise: toPaise(amount_rs),
      method,
      referenceNo: reference_no,
      notes,
      adminId: req.user.id,
    });
    await client.query('COMMIT');
    const remaining =
      Number(out.period.commission_rs) - Number(out.period.settled_rs);
    res.status(201).json({
      ok: true,
      settlement: {
        ...out.settlement,
        amount_rs: Number(out.settlement.amount),
      },
      period: out.period,
      outstanding_rs: Math.max(0, Math.round(remaining * 100) / 100),
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/admin/settlement-periods/:id/dispute + /resolve — verify flow.
// PAID is final (409); DISPUTED freezes pay until an admin resolves.
adminSettlementRoutes.patch('/settlement-periods/:id/dispute', validateIdParam, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { reason } = parseBody(periodDisputeSchema, req.body);
    await client.query('BEGIN');
    const period = await disputePeriodTx(client, {
      periodId: req.params.id,
      reason,
      adminId: req.user.id,
    });
    await client.query('COMMIT');
    res.json({ ok: true, period });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});

adminSettlementRoutes.patch('/settlement-periods/:id/resolve', validateIdParam, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const period = await resolvePeriodTx(client, { periodId: req.params.id, adminId: req.user.id });
    await client.query('COMMIT');
    res.json({ ok: true, period });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore — original error propagates.
    }
    next(err);
  } finally {
    client.release();
  }
});
