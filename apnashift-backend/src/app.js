// Express app factory (server.js listen karta hai, tests import karte hain).
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { driverRoutes as driverRegisterRoutes } from './routes/drivers.js';
import { adminRoutes } from './routes/admin.js';
import { bookingsRoutes } from './routes/bookings.js';
import { driverRoutes as driverBookingRoutes } from './routes/driver.js';
import { driversPublicRoutes } from './routes/driversPublic.js';

export function createApp() {
  const app = express();

  // Framework batane wala header band (info leak)
  # framwork teller is blocked .
  app.disable('x-powered-by');

  // Proxy ke peeche ho to TRUST_PROXY=1 (rate limit sahi IP dekhe).
  // Default off — galat trust se attacker IP spoof karke limit bypass kar sakta hai.
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

  // Basic abuse protection sab /api routes par.
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

  // 404 — unknown routes.
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'not_found' });
  });

  // Central error handler. Stack sirf development me; secrets kabhi nahi.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Toota JSON body: parser ka message bahar nahi (generic code).
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    const status = err.status ?? err.statusCode ?? 500;
    console.error('[api] error:', err.message);
    res.status(status).json({
      ok: false,
      error: status === 500 ? 'server_error' : err.message,
      // Zod details me sirf field+message hote hain (values nahi) — safe hai.
      ...(err.details ? { details: err.details } : {}),
      ...(config.env === 'development' && status === 500 ? { stack: err.stack } : {}),
    });
  });

  return app;
}

export const app = createApp();
