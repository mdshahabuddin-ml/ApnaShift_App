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
import { whatsappRoutes } from './routes/whatsapp.js';
import { driverSettlementRoutes, adminSettlementRoutes } from './routes/settlements.js';
import { mssqlRoutes } from './routes/mssql.js';
import { notificationsRoutes } from './routes/notifications.js';
// Super-admin panel lives OUTSIDE the docker context (repo-root
// super-admin-module/), so a static import crashes the production image
// with ERR_MODULE_NOT_FOUND. Dynamic import + graceful skip: full repo
// (local/CI tests) mounts /api/superadmin, docker image runs without it.
let superAdminRoutes = null;
try {
  ({ superAdminRoutes } = await import('../../super-admin-module/backend/superAdminRoutes.js'));
} catch {
  // Info (not warn): the docker image intentionally excludes
  // super-admin-module/ (outside the build context), so this is the
  // expected state in production — log platforms must not flag it Error.
  console.info('[app] super-admin module not bundled — /api/superadmin disabled.');
}

export function createApp() {
  const app = express();

  // Disable framework header (info leak).
  app.disable('x-powered-by');

  // Behind a proxy, set TRUST_PROXY=1 (rate limiter sees correct IP).
  // Default off — wrong trust lets attackers spoof IP and bypass limits.
  if (config.trustProxy !== '') {
    app.set('trust proxy', Number(config.trustProxy) || config.trustProxy);
  }

  // Helmet default CSP blocks inline <script>/<style> — but all 24
  // frontend pages are inline-script apps served from here, so allow
  // 'unsafe-inline' for scripts + styles (no inline event handlers exist).
  // connect-src must allow the production API + localhost (pages call the
  // API cross-origin in local testing) — else fetch() is CSP-blocked.
  // Maps (Leaflet via unpkg + Geoapify/OSM tiles) need script + img access:
  // without these the tracking map and booking map-picker stay dead.
  // Everything else keeps helmet's strict defaults.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
          'style-src': ["'self'", "'unsafe-inline'", 'https:'],
          'img-src': ["'self'", 'data:', 'https:'],
          'connect-src': ["'self'", 'https:', 'http://localhost:3000'],
        },
      },
    }),
  );
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

  // Browsers auto-ask /favicon.ico — 204 keeps consoles clean (no icon yet).
  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
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
  app.use('/api/driver', driverSettlementRoutes);
  app.use('/api/admin', adminSettlementRoutes);
  app.use('/api/drivers', driversPublicRoutes);
  app.use('/api/enterprise', enterpriseRoutes);
  // Geoapify proxy (maps config + geocode autocomplete + routing).
  // Auth-gated server-side so the provider key/quota stays protected.
  app.use('/api/geo', geoRoutes);
  // WhatsApp webhook (public — Meta calls it; no JWT by design).
  app.use('/api/whatsapp', whatsappRoutes);
  // MS SQL Server verification (read-only; PostgreSQL flows untouched).
  app.use('/api/mssql', mssqlRoutes);
  // In-app notifications (customer/driver, owner-scoped; admin role 403).
  app.use('/api/notifications', notificationsRoutes);
  // Super Admin read-only panel (SELECT-only router from super-admin-module/).
  // Docker image me module nahi hota — tab ye mount skip hota hai.
  if (superAdminRoutes) app.use('/api/superadmin', superAdminRoutes);

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
