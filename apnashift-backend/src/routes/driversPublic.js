// Public driver ratings (no login required).
// User phone numbers never leave — users table is never touched.
import { Router } from 'express';
import { query } from '../db.js';
import { VEHICLE_TO_API } from '../validation/auth.js';
import { validateIdParam } from '../utils/validate.js';

export const driversPublicRoutes = Router();

// GET /api/drivers/:id/ratings (public)
driversPublicRoutes.get('/:id/ratings', validateIdParam, async (req, res, next) => {
  try {
    const driver = await query(
      'SELECT id, name, vehicle_type, avg_rating, total_trips FROM drivers WHERE id = $1',
      [req.params.id],
    );
    if (driver.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    const d = driver.rows[0];

    const [countRes, commentsRes] = await Promise.all([
      query('SELECT COUNT(*) AS count FROM ratings WHERE driver_id = $1', [d.id]),
      query(
        `SELECT stars, comment, created_at FROM ratings
         WHERE driver_id = $1 AND comment IS NOT NULL AND comment <> ''
         ORDER BY created_at DESC LIMIT 10`,
        [d.id],
      ),
    ]);
    res.json({
      ok: true,
      driver: {
        id: d.id,
        name: d.name,
        vehicle_type: VEHICLE_TO_API[d.vehicle_type] ?? d.vehicle_type,
        avg_rating: d.avg_rating === null ? 0 : Number(d.avg_rating),
        total_trips: Number(d.total_trips),
      },
      average: d.avg_rating === null ? 0 : Number(d.avg_rating),
      count: Number(countRes.rows[0].count),
      comments: commentsRes.rows.map((c) => ({
        stars: c.stars,
        comment: c.comment,
        created_at: c.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});
