// Weekly COD settlement domain (Mon–Sun, Asia/Kolkata calendar).
// Reuses payments rows as the single money record — periods only GROUP
// collected payments and track settlement progress. All math in integer
// paise (services/money.js). Stored statuses: DUE/PARTIALLY_PAID/PAID/
// DISPUTED; OVERDUE is derived on read (past week, still owed, not frozen).
import { toPaise, paiseToRs } from './money.js';
import { logAuditTx } from './audit.js';

export const IST_OFFSET_MIN = 330; // Asia/Kolkata has no DST — fixed +5:30.
export const PERIOD_STATUSES = ['DUE', 'PARTIALLY_PAID', 'PAID', 'DISPUTED'];
export const EFFECTIVE_STATUSES = [...PERIOD_STATUSES, 'OVERDUE'];

function pad(n) {
  return String(n).padStart(2, '0');
}

// Monday (IST calendar) of the week containing `input`, as 'YYYY-MM-DD'.
export function weekStartIST(input = new Date()) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    const err = new Error('invalid_week');
    err.status = 400;
    throw err;
  }
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  const dowMon0 = (ist.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  ist.setUTCDate(ist.getUTCDate() - dowMon0);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

export function isMondayDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s ?? '')) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return ((dt.getUTCDay() + 6) % 7) === 0;
}

// [start, end) UTC instants for an IST week starting Monday `weekStart'.
export function weekRangeUTC(weekStart) {
  if (!isMondayDate(weekStart)) {
    const err = new Error('invalid_week');
    err.status = 400;
    throw err;
  }
  const start = new Date(`${weekStart}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 7 * 24 * 3600 * 1000) };
}

export function weekEndOf(weekStart) {
  const { end } = weekRangeUTC(weekStart);
  const last = new Date(end.getTime() - 1);
  const ist = new Date(last.getTime() + IST_OFFSET_MIN * 60000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

// Stored -> effective status (OVERDUE derived, never stored).
export function effectiveStatus(row, now = new Date()) {
  const stored = row.status;
  if (stored === 'PAID' || stored === 'DISPUTED') return stored;
  // pg DATE columns arrive as Date objects; normalize to YYYY-MM-DD first.
  const we = row.week_end instanceof Date
    ? row.week_end.toISOString().slice(0, 10)
    : String(row.week_end ?? '').slice(0, 10);
  const weekEnd = new Date(`${we}T00:00:00+05:30`);
  const thisMonday = weekRangeUTC(weekStartIST(now)).start;
  const owed = toPaise(row.commission_paise ?? row.commission_rs ?? 0)
    - toPaise(row.settled_paise ?? row.settled_rs ?? 0);
  if (weekEnd.getTime() < thisMonday.getTime() && owed > 0) return 'OVERDUE';
  return stored;
}

export function statusFor(commissionPaise, settledPaise, stored) {
  if (stored === 'DISPUTED') return 'DISPUTED';
  if (commissionPaise <= 0) return 'DUE';
  if (settledPaise >= commissionPaise) return 'PAID';
  if (settledPaise > 0) return 'PARTIALLY_PAID';
  return 'DUE';
}

function publicPeriod(row, now) {
  return {
    id: row.id,
    driver_id: row.driver_id,
    week_start: row.week_start instanceof Date ? row.week_start.toISOString().slice(0, 10) : row.week_start,
    week_end: row.week_end instanceof Date ? row.week_end.toISOString().slice(0, 10) : row.week_end,
    gross_rs: Number(row.gross_paise != null ? paiseToRs(row.gross_paise) : row.gross_rs),
    commission_rs: Number(row.commission_paise != null ? paiseToRs(row.commission_paise) : row.commission_rs),
    earning_rs: Number(row.earning_paise != null ? paiseToRs(row.earning_paise) : row.earning_rs),
    settled_rs: Number(row.settled_paise != null ? paiseToRs(row.settled_paise) : row.settled_rs),
    status: row.status,
    effective_status: effectiveStatus(row, now),
    dispute_reason: row.dispute_reason ?? null,
    created_at: row.created_at,
  };
}

// Idempotent weekly generation. Only 'collected' payments in the IST week
// that are not in any period yet. Drivers with nothing (or zero commission)
// are skipped, never empty-DUE. Returns created + skipped.
// UNIQUE(driver_id, week_start) is the backstop against doubles.
export async function generatePeriodsTx(client, { driverId = null, weekStart, adminId }) {
  const start = weekStart ?? weekStartIST();
  const { start: from, end: to } = weekRangeUTC(start);
  const weekEnd = weekEndOf(start);

  if (driverId) {
    const drv = await client.query('SELECT id FROM drivers WHERE id = $1', [driverId]);
    if (drv.rowCount === 0) {
      const err = new Error('unknown_driver');
      err.status = 404;
      throw err;
    }
  }
  const drivers = driverId
    ? [{ id: driverId }]
    : (
      await client.query(
        `SELECT DISTINCT p.driver_id AS id FROM payments p
          LEFT JOIN settlement_period_items i ON i.payment_id = p.id
         WHERE p.payment_status = 'collected'
           AND p.collected_at >= $1 AND p.collected_at < $2
           AND i.payment_id IS NULL`,
        [from.toISOString(), to.toISOString()],
      )
    ).rows;

  const created = [];
  const skipped = [];
  for (const d of drivers) {
    const existing = await client.query(
      'SELECT id FROM settlement_periods WHERE driver_id = $1 AND week_start = $2',
      [d.id, start],
    );
    if (existing.rowCount > 0) {
      skipped.push({ driver_id: d.id, reason: 'already_generated' });
      continue;
    }
    const sums = await client.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(p.gross_amount), 0) AS gross,
              COALESCE(SUM(p.platform_commission), 0) AS commission,
              COALESCE(SUM(p.driver_earning), 0) AS earning,
              COALESCE(SUM((SELECT COALESCE(SUM(a.commission_delta_paise), 0)
                             FROM payment_adjustments a WHERE a.payment_id = p.id)), 0) AS adj_c,
              COALESCE(SUM((SELECT COALESCE(SUM(a.earning_delta_paise), 0)
                             FROM payment_adjustments a WHERE a.payment_id = p.id)), 0) AS adj_e
         FROM payments p LEFT JOIN settlement_period_items i ON i.payment_id = p.id
        WHERE p.driver_id = $1 AND p.payment_status = 'collected'
          AND p.collected_at >= $2 AND p.collected_at < $3
          AND i.payment_id IS NULL`,
      [d.id, from.toISOString(), to.toISOString()],
    );
    const s = sums.rows[0];
    if (Number(s.n) === 0) {
      skipped.push({ driver_id: d.id, reason: 'no_payments' });
      continue;
    }
    const grossPaise = toPaise(s.gross);
    const commissionPaise = toPaise(s.commission) + Number(s.adj_c);
    const earningPaise = toPaise(s.earning) + Number(s.adj_e);
    if (commissionPaise <= 0) {
      skipped.push({ driver_id: d.id, reason: 'no_commission' });
      continue;
    }
    const period = await client.query(
      `INSERT INTO settlement_periods
         (driver_id, week_start, week_end, gross_paise, commission_paise,
          earning_paise, settled_paise, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'DUE', $7)
       RETURNING *`,
      [d.id, start, weekEnd, grossPaise, commissionPaise, earningPaise, adminId ?? null],
    );
    const ids = await client.query(
      `SELECT p.id FROM payments p LEFT JOIN settlement_period_items i ON i.payment_id = p.id
        WHERE p.driver_id = $1 AND p.payment_status = 'collected'
          AND p.collected_at >= $2 AND p.collected_at < $3
          AND i.payment_id IS NULL ORDER BY p.collected_at ASC, p.id ASC`,
      [d.id, from.toISOString(), to.toISOString()],
    );
    for (const r of ids.rows) {
      await client.query(
        'INSERT INTO settlement_period_items (period_id, payment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [period.rows[0].id, r.id],
      );
    }
    await logAuditTx(client, adminId ?? null, 'settlement.period_generate', 'settlement_period', period.rows[0].id, {
      driver_id: d.id,
      week_start: start,
      payments: ids.rows.length,
    });
    created.push(publicPeriod(period.rows[0]));
  }
  return { week_start: start, week_end: weekEnd, created, skipped };
}

// Pay down ONE period (FIFO inside the period only). Creates a settlements
// receipt linked to the period. PAID/DISPUTED are frozen (409).
export async function payPeriodTx(client, { periodId, amountPaise, method, referenceNo, notes, adminId }) {
  const prow = await client.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [periodId]);
  if (prow.rowCount === 0) {
    const err = new Error('not_found');
    err.status = 404;
    throw err;
  }
  const period = prow.rows[0];
  if (period.status === 'PAID') {
    const err = new Error('settlement_finalized');
    err.status = 409;
    throw err;
  }
  if (period.status === 'DISPUTED') {
    const err = new Error('settlement_disputed');
    err.status = 409;
    throw err;
  }
  const remaining = Number(period.commission_paise) - Number(period.settled_paise);
  if (amountPaise > remaining) {
    const err = new Error('settlement_exceeds_outstanding');
    err.status = 409;
    err.details = [{ field: 'amount_rs', message: `Is week me sirf Rs ${paiseToRs(remaining)} baaki hai.` }];
    throw err;
  }
  const owed = await client.query(
    `SELECT p.id, p.platform_commission,
            COALESCE((SELECT SUM(a.commission_delta_paise) FROM payment_adjustments a WHERE a.payment_id = p.id), 0) AS adj_c,
            p.settled_amount
       FROM settlement_period_items i JOIN payments p ON p.id = i.payment_id
      WHERE i.period_id = $1 ORDER BY p.collected_at ASC, p.id ASC FOR UPDATE OF p`,
    [periodId],
  );
  let inserted;
  try {
    inserted = await client.query(
      `INSERT INTO settlements (driver_id, amount, method, reference_no, admin_id, notes, settlement_period_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, driver_id, amount, method, reference_no, admin_id, notes, settled_at, created_at`,
      [
        period.driver_id,
        paiseToRs(amountPaise),
        method,
        referenceNo ?? null,
        adminId,
        notes ?? null,
        periodId,
      ],
    );
  } catch (err) {
    if (err.code === '23505') {
      const dup = new Error('duplicate_settlement');
      dup.status = 409;
      throw dup;
    }
    throw err;
  }
  let left = amountPaise;
  for (const r of owed.rows) {
    if (left <= 0) break;
    const owedPaise = toPaise(r.platform_commission) + Number(r.adj_c) - toPaise(r.settled_amount);
    if (owedPaise <= 0) continue;
    const take = Math.min(owedPaise, left);
    const next = toPaise(r.settled_amount) + take;
    const full = toPaise(r.platform_commission) + Number(r.adj_c);
    await client.query('UPDATE payments SET settled_amount = $1, settlement_status = $2 WHERE id = $3', [
      paiseToRs(next),
      next >= full ? 'settled' : 'partial',
      r.id,
    ]);
    left -= take;
  }
  const settled = Number(period.settled_paise) + amountPaise;
  const status = statusFor(Number(period.commission_paise), settled, period.status);
  const upd = await client.query(
    'UPDATE settlement_periods SET settled_paise = $1, status = $2 WHERE id = $3 RETURNING *',
    [settled, status, periodId],
  );
  await logAuditTx(client, adminId, 'settlement.period_pay', 'settlement_period', periodId, {
    driver_id: period.driver_id,
    amount_rs: paiseToRs(amountPaise),
    method,
    settlement_id: inserted.rows[0].id,
  });
  return { settlement: inserted.rows[0], period: publicPeriod(upd.rows[0]) };
}

export async function disputePeriodTx(client, { periodId, reason, adminId }) {
  const prow = await client.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [periodId]);
  if (prow.rowCount === 0) {
    const err = new Error('not_found');
    err.status = 404;
    throw err;
  }
  if (prow.rows[0].status === 'PAID') {
    const err = new Error('settlement_finalized');
    err.status = 409;
    throw err;
  }
  if (prow.rows[0].status === 'DISPUTED') {
    const err = new Error('already_disputed');
    err.status = 409;
    throw err;
  }
  const upd = await client.query(
    'UPDATE settlement_periods SET status = $1, dispute_reason = $2 WHERE id = $3 RETURNING *',
    ['DISPUTED', reason ?? null, periodId],
  );
  await logAuditTx(client, adminId, 'settlement.period_dispute', 'settlement_period', periodId, {
    driver_id: prow.rows[0].driver_id,
    reason: reason ?? null,
  });
  return publicPeriod(upd.rows[0]);
}

export async function resolvePeriodTx(client, { periodId, adminId }) {
  const prow = await client.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [periodId]);
  if (prow.rowCount === 0) {
    const err = new Error('not_found');
    err.status = 404;
    throw err;
  }
  if (prow.rows[0].status !== 'DISPUTED') {
    const err = new Error('not_disputed');
    err.status = 409;
    throw err;
  }
  const status = statusFor(Number(prow.rows[0].commission_paise), Number(prow.rows[0].settled_paise), 'DUE');
  const upd = await client.query(
    'UPDATE settlement_periods SET status = $1, dispute_reason = NULL WHERE id = $2 RETURNING *',
    [status, periodId],
  );
  await logAuditTx(client, adminId, 'settlement.period_resolve', 'settlement_period', periodId, {
    driver_id: prow.rows[0].driver_id,
  });
  return publicPeriod(upd.rows[0]);
}

// Re-sync periods after out-of-band money moves (global settlement /
// adjustment). Only touches non-frozen periods; frozen ones are guarded
// at the mutation site instead (409, never silent).
export async function recomputePeriodsForPayments(client, paymentIds) {
  if (!paymentIds.length) return;
  const found = await client.query(
    `SELECT DISTINCT i.period_id FROM settlement_period_items i WHERE i.payment_id = ANY($1)`,
    [paymentIds],
  );
  for (const r of found.rows) {
    const p = await client.query('SELECT * FROM settlement_periods WHERE id = $1 FOR UPDATE', [r.period_id]);
    if (!p.rowCount || p.rows[0].status === 'DISPUTED' || p.rows[0].status === 'PAID') continue;
    const sums = await client.query(
      `SELECT COALESCE(SUM(p.settled_amount), 0) AS s,
              COALESCE(SUM(p.platform_commission), 0) AS c,
              COALESCE(SUM((SELECT COALESCE(SUM(a.commission_delta_paise), 0)
                             FROM payment_adjustments a WHERE a.payment_id = p.id)), 0) AS adj
         FROM settlement_period_items i JOIN payments p ON p.id = i.payment_id
        WHERE i.period_id = $1`,
      [r.period_id],
    );
    const s = sums.rows[0];
    const settled = toPaise(s.s);
    const commission = toPaise(s.c) + Number(s.adj);
    await client.query('UPDATE settlement_periods SET settled_paise = $1, status = $2 WHERE id = $3', [
      settled,
      statusFor(commission, settled, p.rows[0].status),
      r.period_id,
    ]);
  }
}

// 409 if any payment sits in a frozen (PAID/DISPUTED) period.
export async function assertPaymentsMoveable(client, paymentIds) {
  if (!paymentIds.length) return;
  const hit = await client.query(
    `SELECT 1 FROM settlement_period_items i
      JOIN settlement_periods p ON p.id = i.period_id
     WHERE i.payment_id = ANY($1) AND p.status IN ('PAID', 'DISPUTED') LIMIT 1`,
    [paymentIds],
  );
  if (hit.rowCount > 0) {
    const err = new Error('settlement_finalized');
    err.status = 409;
    throw err;
  }
}

export async function periodOfPayment(client, paymentId) {
  const found = await client.query(
    `SELECT p.* FROM settlement_period_items i
      JOIN settlement_periods p ON p.id = i.period_id
     WHERE i.payment_id = $1`,
    [paymentId],
  );
  return found.rows[0] ?? null;
}

// Apply an admin correction to the week's snapshot totals. Frozen
// (PAID/DISPUTED) weeks reject (409) — finalized numbers never move silently.
export async function applyAdjustmentToPeriods(client, paymentId, commDeltaPaise, earnDeltaPaise) {
  await assertPaymentsMoveable(client, [paymentId]);
  const periods = await client.query(
    `SELECT p.id FROM settlement_period_items i
      JOIN settlement_periods p ON p.id = i.period_id
     WHERE i.payment_id = $1 FOR UPDATE OF p`,
    [paymentId],
  );
  for (const r of periods.rows) {
    await client.query(
      `UPDATE settlement_periods
          SET commission_paise = GREATEST(0, commission_paise + $1),
              earning_paise = GREATEST(0, earning_paise + $2)
        WHERE id = $3`,
      [commDeltaPaise, earnDeltaPaise, r.id],
    );
    const cur = await client.query(
      'SELECT commission_paise, settled_paise, status FROM settlement_periods WHERE id = $1',
      [r.id],
    );
    const c = cur.rows[0];
    await client.query('UPDATE settlement_periods SET status = $1 WHERE id = $2', [
      statusFor(Number(c.commission_paise), Number(c.settled_paise), c.status),
      r.id,
    ]);
  }
}

export function toPublicPeriodList(rows, now = new Date()) {
  return rows.map((r) => publicPeriod(r, now));
}

export { paiseToRs };
