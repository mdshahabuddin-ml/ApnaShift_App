// Indian mobile normalization.
// "+91 98765 43210" / "09876543210" / "98-765 43210" -> "9876543210".
// Always returns a 10-digit string; validate with PHONE_RE.
export const PHONE_RE = /^[6-9]\d{9}$/;

export function normalizePhone(raw) {
  let p = String(raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (p.startsWith('+91')) {
    p = p.slice(3);
  } else if (p.length === 12 && p.startsWith('91')) {
    p = p.slice(2);
  } else if (p.length === 11 && p.startsWith('0')) {
    p = p.slice(1);
  }
  return p;
}

export function isValidPhone(raw) {
  return PHONE_RE.test(normalizePhone(raw));
}
