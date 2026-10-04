// Express app factory (server.js listens, tests import it).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { driverRoutes as driverRegisterRoutes } from './routes/drivers.js';
import { adminRoutes } from './routes/admin.js';
import { bookingsRoutes } from './routes/bookings.js';
import { driverRoutes as driverBookingRoutes } from './routes/driver.js';
import { driversPublicRoutes } from './routes/driversPublic.js';
import { enterpriseRoutes } from './routes/enterprise.js';
import { geoRoutes } from './routes/geo.js';
import { mssqlRoutes } from './routes/mssql.js';

export function createApp() {
  const app = express();

  // Disable framework header (info leak).
  app.disable('x-powered-by');

  // Behind a proxy, set TRUST_PROXY=1 (rate limiter sees correct IP).
  // Default off — wrong trust lets attackers spoof IP and bypass limits.
  if (config.trustProxy !== '') {
    app.set('trust proxy', Number(config.trustProxy) || config.trustProxy);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? '*' : config.corsOrigin.split(',').map((s) => s.trim()),
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  // Owner admin page (public/admin.html -> /admin.html). API routes
  // will not match first since /api prefix differs — static is safe.
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(publicDir));

  // Clean URL: /enterprise -> public/enterprise.html (static file pattern).
  app.get('/enterprise', (req, res) => {
    res.sendFile(path.join(publicDir, 'enterprise.html'));
  });

  // Basic abuse protection for all /api routes.
  app.use(
    '/api',
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );

  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/drivers', driverRegisterRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/bookings', bookingsRoutes);
  app.use('/api/driver', driverBookingRoutes);
  app.use('/api/drivers', driversPublicRoutes);
  app.use('/api/enterprise', enterpriseRoutes);
  // Geoapify proxy (maps config + geocode autocomplete + routing).
  // Auth-gated server-side so the provider key/quota stays protected.
  app.use('/api/geo', geoRoutes);
  // MS SQL Server verification (read-only; PostgreSQL flows untouched).
  app.use('/api/mssql', mssqlRoutes);

  // 404 — unknown routes.
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Central error handler. Stack traces in development only; never secrets.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Malformed JSON body: do not expose parser message (generic code).
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    const status = err.status ?? err.statusCode ?? 500;
    console.error('[api] error:', err.message);
    res.status(status).json({
      ok: false,
      error: status === 500 ? 'server_error' : err.message,
      // Zod details hold only field+message (no values) — safe.
      ...(err.details ? { details: err.details } : {}),
      ...(config.env === 'development' && status === 500 ? { stack: err.stack } : {}),
    });
  });

  return app;
}

export const app = createApp();
