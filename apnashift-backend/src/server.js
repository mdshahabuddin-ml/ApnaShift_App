// Entry point: listen + graceful shutdown only. No business logic here.
import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

// Auth is meaningless without JWT — do not start silently.
if (!config.jwtSecret) {
  console.error('[server] JWT_SECRET missing hai — .env me set karke dobara start karo.');
  process.exit(1);
}
// Short secrets are brute-forceable — minimum 32 chars.
if (config.jwtSecret.length < 32) {
  console.error('[server] JWT_SECRET bahut chhota hai (min 32 chars) — lamba random secret rakho.');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  // Log only port + env — never DATABASE_URL/JWT.
  console.log(`[server] ApnaShift API listening on port ${config.port} (${config.env})`);
});

function shutdown(signal) {
  console.log(`[server] ${signal} mila — band kar rahe hain...`);
  server.close(() => {
    pool
      .end()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err?.message ?? err);
  process.exit(1);
});
