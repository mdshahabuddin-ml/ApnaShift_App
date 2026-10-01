// Auth middleware: JWT Bearer check + role gate.
// req.user = { id, role } — never contains hash/phone.
import { verifyToken } from '../utils/jwt.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ ok: false, error: 'missing_token' });
  }
  try {
    const payload = verifyToken(token);
    if (!payload || typeof payload.id !== 'string' || typeof payload.role !== 'string') {
      throw new Error('bad token payload');
    }
    req.user = { id: payload.id, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'missing_token' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
  };
}
