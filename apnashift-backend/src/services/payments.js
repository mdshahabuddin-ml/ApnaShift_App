// Payment/commission/settlement domain logic. Backend is the source of truth:
// all splits, estimates, outstanding and allocations are computed here in
// integer paise (services/money.js). Frontend values are never trusted.
import { query, pool } from '../db.js';
import { toPaise, paiseToRs, pctToBps, splitFare } from './money.js';
import { logAuditTx } from './audit.js';

export const DEFAULT_COMMISSION_PCT = 15.0;

// Current platform commission pct (e.g. 15.00). Throws loud if unconfigured
// (migration 013 seeds it) — never silently fall back to a hard-coded rate.
export async function getCommissionPct(runner = query) {
  const found = await runner(`SELECT value FROM platform_settings WHERE key = 'commission'`);
  if (found.rowCount === 0 || found.rows[0].value?.pct === undefined) {
    const err = new Error('commission_not_configured');
    err.status = 500;
    throw err;
  }
  const pct = Number(found.rows[0].value.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    const err = new Error('commission_not_configured');
    err.status = 500;
    throw err;
  }
  return pct;
}

// Server-side estimate (driver pre-accept view). Always labeled estimated —
// the locked numbers are snapshotted into payments at delivery.
export function estimateFor(grossRs, pct, paymentMethod = 'cash') {
  const grossPaise = toPaise(grossRs);
  const { commissionPaise, earningPaise } = splitFare(grossPaise, pctToBps(pct));
  return {
    estimated: true,
    payment_method: paymentMethod,
    gross_rs: paiseToRs(grossPaise),
    commission_pct: Number(pct),
    commission_rs: paiseToRs(commissionPaise),
    earning_rs: paiseToRs(earningPaise),
  };
}

// Public payment shape. Customers see fare/method/status only —
// commission and earnings are driver/admin-private.
export function publicPayment(row, viewer = 'admin') {
  const base = {
    id: row.id,
    booking_id: row.booking_id,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    gross_rs: Number(row.gross_amount),
    collected_at: row.collected_at,
  };
  if (viewer === 'user') return base;
  return {
    ...base,
    driver_earning_rs: Number(row.driver_earning),
    platform_commission_rs: Number(row.platform_commission),
    commission_pct: Number(row.commission_pct),
    settlement_status: row.settlement_status,
    settled_rs: Number(row.settled_amount),
  };
}

// Batch-attach payment rows to public bookings (one extra query per endpoint).
export async function attachPayments(items, viewer = 'admin') {
  if (!items.length) return items;
  const ids = [...new Set(items.map((b) => b.id))];
  const rows = await query(
    `SELECT id, booking_id, payment_method, payment_status, gross_amount,
            driver_earning, platform_commission, commission_pct,
            settlement_status, settled_amount, collected_at
      FROM payments WHERE booking_id = ANY($1)`,
    [ids],
  );
  const byBooking = new Map(rows.rows.map((r) => [r.booking_id, r]));
  for (const item of items) {
    const found = byBooking.get(item.id);
    item.payment = found ? publicPayment(found, viewer) : null;
    if (item.estimate === undefined) item.estimate = null;
  }
  return items;
}

// Per-vehicle commission % from pricing_rules, global setting as fallback.
// Booking snapshot (creation time) always wins when present — rate lock.
export async function getVehicleCommissionPct(vehicleDb, runner = query) {
  const found = await runner('SELECT commission_percent FROM pricing_rules WHERE vehicle_type = $1', [
    vehicleDb,
  ]);
  if (found.rowCount > 0 && found.rows[0].commission_percent !== null) {
    return Number(found.rows[0].commission_percent);
  }
  return getCommissionPct(runner);
}

export async function resolveBookingCommissionPct({ snapshot, vehicleDb }, runner = query) {
  if (snapshot !== null && snapshot !== undefined) return Number(snapshot);
  return getVehicleCommissionPct(vehicleDb, runner);
}

// { vehicleDb: pct } map for estimate batching (one query per endpoint).
export async function vehicleCommissionMap(runner = query) {
  const rows = await runner('SELECT vehicle_type, commission_percent FROM pricing_rules');
  const map = new Map(rows.rows.map((r) => [r.vehicle_type, Number(r.commission_percent)]));
  const fallback = await getCommissionPct(runner);
  return { map, fallback };
}

// Attach server-computed estimates (driver pre-accept / pre-delivery view).
// getPct(item) resolves the locked rate: booking snapshot -> vehicle -> global.
export async function attachEstimates(items, getPct) {
  for (const item of items) {
    if (!item.payment) {
      item.estimate = estimateFor(item.price_rs, getPct(item), item.payment_method ?? 'upi');
    } else if (item.estimate === undefined) {
      item.estimate = null;
    }
  }
  return items;
}

// Insert the immutable payment row at delivery (call inside the delivery tx).
// Gross comes from the delivered booking price, rate from the booking snapshot
// (creation-time lock) — never from the client, never the live rate.
export async function insertPaymentTx(client, { bookingId, userId, driverId, grossRs, paymentMethod, commissionPct }) {
  const pct = commissionPct ?? (await getCommissionPct(client.query.bind(client)));
  const grossPaise = toPaise(grossRs);
  const { commissionPaise, earningPaise } = splitFare(grossPaise, pctToBps(pct));
  // Cash/UPI: customer pays the driver directly. Online (future): pending
  // until the gateway confirms.
  const status = paymentMethod === 'online' ? 'pending' : 'collected';
  const inserted = await client.query(
    `INSERT INTO payments
       (booking_id, user_id, driver_id, gross_amount, payment_method, payment_status,
        driver_earning, platform_commission, commission_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, booking_id, payment_method, payment_status, gross_amount,
               driver_earning, platform_commission, commission_pct,
               settlement_status, settled_amount, collected_at`,
    [
      bookingId,
      userId,
      driverId,
      paiseToRs(grossPaise),
      paymentMethod,
      status,
      paiseToRs(earningPaise),
      paiseToRs(commissionPaise),
      pct,
    ],
  );
  return inserted.rows[0];
}

// Driver money summary — derived, never stored (no balance column exists,
// so no one can silently rewrite a balance). All values in paise + rs.
export async function driverBalance(runner, driverId) {
  const [pay, adj, stl] = await Promise.all([
    runner(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(gross_amount), 0) AS gross,
              COALESCE(SUM(driver_earning), 0) AS earning,
              COALESCE(SUM(platform_commission), 0) AS commission,
              COALESCE(SUM(settled_amount), 0) AS settled
        FROM payments WHERE driver_id = $1`,
      [driverId],
    ),
    runner(
      `SELECT COALESCE(SUM(a.commission_delta_paise), 0) AS c,
              COALESCE(SUM(a.earning_delta_paise), 0) AS e
        FROM payment_adjustments a JOIN payments p ON p.id = a.payment_id
        WHERE p.driver_id = $1`,
      [driverId],
    ),
    runner(`SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE driver_id = $1`, [driverId]),
  ]);
  const p = pay.rows[0];
  const grossPaise = toPaise(p.gross);
  const earningPaise = toPaise(p.earning) + Number(adj.rows[0].e);
  const commissionPaise = toPaise(p.commission) + Number(adj.rows[0].c);
  const allocatedPaise = toPaise(p.settled);
  const settledTxPaise = toPaise(stl.rows[0].s);
  const outstandingPaise = Math.max(0, commissionPaise - allocatedPaise);
  return {
    completed_cash_bookings: Number(p.n),
    cash_collected_paise: grossPaise,
    cash_collected_rs: paiseToRs(grossPaise),
    driver_earning_paise: earningPaise,
    driver_earning_rs: paiseToRs(earningPaise),
    commission_paise: commissionPaise,
    commission_rs: paiseToRs(commissionPaise),
    allocated_paise: allocatedPaise,
    settled_rs: paiseToRs(settledTxPaise),
    outstanding_paise: outstandingPaise,
    outstanding_rs: paiseToRs(outstandingPaise),
  };
}

// Record a settlement + FIFO-allocate across oldest owed payments, atomically.
// Guards: amount>0 (validated), amount <= outstanding (409 otherwise — this is
// also the duplicate-submit guard: a replayed full settlement finds 0 owed).
export async function createSettlementTx(client, { driverId, amountPaise, method, referenceNo, notes, settledAt, adminId }) {
  // Serialize concurrent settlements for this driver on the owed rows.
  const owed = await client.query(
    `SELECT p.id, p.platform_commission,
            COALESCE((SELECT SUM(a.commission_delta_paise) FROM payment_adjustments a WHERE a.payment_id = p.id), 0) AS adj_c,
            p.settled_amount
      FROM payments p WHERE p.driver_id = $1
      ORDER BY p.collected_at ASC, p.id ASC
      FOR UPDATE`,
    [driverId],
  );
  let outstanding = 0;
  const targets = [];
  for (const r of owed.rows) {
    const owedPaise = toPaise(r.platform_commission) + Number(r.adj_c) - toPaise(r.settled_amount);
    if (owedPaise > 0) {
      outstanding += owedPaise;
      targets.push({ id: r.id, owedPaise, settledPaise: toPaise(r.settled_amount) });
    }
  }
  if (amountPaise > outstanding) {
    const err = new Error('settlement_exceeds_outstanding');
    err.status = 409;
    err.details = [{ field: 'amount_rs', message: `Outstanding se zyada nahi (Rs ${paiseToRs(outstanding)}).` }];
    throw err;
  }
  let inserted;
  try {
    inserted = await client.query(
      `INSERT INTO settlements (driver_id, amount, method, reference_no, admin_id, notes, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, driver_id, amount, method, reference_no, admin_id, notes, settled_at, created_at`,
      [
        driverId,
        paiseToRs(amountPaise),
        method,
        referenceNo ?? null,
        adminId,
        notes ?? null,
        settledAt ? new Date(settledAt) : new Date(),
      ],
    );
  } catch (err) {
    // Same reference twice (e.g. double-click with a reference) -> 409, not 500.
    if (err.code === '23505') {
      const dup = new Error('duplicate_settlement');
      dup.status = 409;
      throw dup;
    }
    throw err;
  }
  // FIFO: oldest owed payment first.
  let left = amountPaise;
  for (const t of targets) {
    if (left <= 0) break;
    const take = Math.min(t.owedPaise, left);
    const next = t.settledPaise + take;
    const status = next >= t.owedPaise ? 'settled' : 'partial';
    await client.query(
      `UPDATE payments SET settled_amount = $1, settlement_status = $2 WHERE id = $3`,
      [paiseToRs(next), status, t.id],
    );
    left -= take;
  }
  await logAuditTx(client, adminId, 'settlement.create', 'settlement', inserted.rows[0].id, {
    driver_id: driverId,
    amount_rs: paiseToRs(amountPaise),
    method,
  });
  return inserted.rows[0];
}

export { pool };
