// Health routes. DB ko chhoote nahi (health), aur ek DB check (ready).
import { Router } from 'express';
import { query } from '../db.js';

export const healthRoutes = Router();

// Load balancer / uptime check ke liye — DB dependency nahi.
healthRoutes.get('/health', (req, res) => {
  res.json({ ok: true, service: 'apnashift-backend', time: new Date().toISOString() });
});

// DB reachable hai ya nahi — deploy ke baad ye check karo.
healthRoutes.get('/ready', async (req, res, next) => {
  try {
    await query('SELECT 1 AS one');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    next(err);
  }
});
