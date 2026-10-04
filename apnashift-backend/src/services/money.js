// Exact money math in integer paise — never float arithmetic on money.
// DB NUMERIC(10,2) columns only ever receive whole-paise values (paise/100
// always has <= 2 decimals), so storage is exact too.
// Rounding policy: half-up to the nearest paise, per transaction.

export function toPaise(rs) {
  const n = Number(rs);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('invalid_amount');
    err.status = 400;
    throw err;
  }
  return Math.round(n * 100);
}

export function paiseToRs(paise) {
  return paise / 100;
}

// Commission stored as percent (NUMERIC 5,2, e.g. 15.00).
export function pctToBps(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    const err = new Error('invalid_commission');
    err.status = 400;
    throw err;
  }
  return Math.round(n * 100); // 15.00% -> 1500 bps
}

// Split gross paise into { commissionPaise, earningPaise }.
// Example: 100000 paise @1500bps -> { 15000, 85000 }.
export function splitFare(grossPaise, bps) {
  if (!Number.isInteger(grossPaise) || grossPaise < 0) {
    const err = new Error('invalid_amount');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    const err = new Error('invalid_commission');
    err.status = 400;
    throw err;
  }
  const commissionPaise = Math.floor((grossPaise * bps + 5000) / 10000);
  return { commissionPaise, earningPaise: grossPaise - commissionPaise };
}
