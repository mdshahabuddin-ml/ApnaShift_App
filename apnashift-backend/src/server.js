// Entry point: sirf listen + graceful shutdown. Business logic yahan nahi.
import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

// JWT ke bina auth ka koi matlab nahi — chupchaap start mat karo.
if (!config.jwtSecret) {
  console.error('[server] JWT_SECRET missing hai — .env me set karke dobara start karo.');
  process.exit(1);
}
// Chhota secret brute-force ho jata hai — kam se kam 32 chars.
if (config.jwtSecret.length < 32) {
  console.error('[server] JWT_SECRET bahut chhota hai (min 32 chars) — lamba random secret rakho.');
  process.exit(1);
}

const server = app.listen(config.port, () => {
  // Port + env hi log karo — DATABASE_URL/JWT kabhi nahi.
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
