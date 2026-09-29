// Driver gate: login ke baad verified + active check.
// Unverified driver ko bookings nahi dikhengi (403, 404 nahi — wajah batani hai).
import { query } from '../db.js';

export async function requireVerifiedDriver(req, res, next) {
  try {
    const found = await query('SELECT id, vehicle_type, is_verified, is_active FROM drivers WHERE id = $1', [
      req.user.id,
    ]);
    if (found.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const driver = found.rows[0];
    if (!driver.is_verified) {
      return res.status(403).json({ ok: false, error: 'driver_unverified' });
    }
    if (!driver.is_active) {
      return res.status(403).json({ ok: false, error: 'driver_inactive' });
    }
    req.driver = driver;
    next();
  } catch (err) {
    next(err);
  }
}
