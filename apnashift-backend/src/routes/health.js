// Health routes. Health avoids DB; ready checks DB.
import { Router } from 'express';
import { query } from '../db.js';

export const healthRoutes = Router();

// For load balancer / uptime checks — no DB dependency.
healthRoutes.get('/health', (req, res) => {
  res.json({ ok: true, service: 'apnashift-backend', time: new Date().toISOString() });
});

// Checks DB reachability — verify after deploy.
healthRoutes.get('/ready', async (req, res, next) => {
  try {
    await query('SELECT 1 AS one');
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    next(err);
  }
});
