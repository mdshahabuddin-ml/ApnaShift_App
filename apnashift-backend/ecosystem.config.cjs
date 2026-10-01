// PM2 process file for ApnaShift backend (production, Ubuntu server).
// NOTE: extension .cjs is required — package.json has "type": "module",
// so a plain .js file here would be treated as ESM and module.exports would fail.
// Usage on server (in app dir):
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save            (save current process list to restore after reboot)
//   pm2 startup         (run the printed command once with sudo)
module.exports = {
  apps: [
    {
      name: 'apnashift-api', // pm2 logs apnashift-api / pm2 reload apnashift-api
      script: 'src/server.js', // same entry point as npm start (node src/server.js)
      cwd: '/opt/apnashift/apnashift-backend', // git clone location (see DEPLOY.md)
      instances: 1, // single instance: low RAM on free-tier ARM, do not use cluster
      exec_mode: 'fork', // fork mode (cluster needs instances > 1 + exec_mode cluster)
      env_production: {
        NODE_ENV: 'production', // remaining secrets come from .env (dotenv), never write secrets here
      },
      max_memory_restart: '350M', // auto-restart on memory leak (safe for 1GB free tier)
      exp_backoff_restart_delay: 3000, // growing delay between restarts on crash loop (DB downtime)
      max_restarts: 20, // PM2 stops after more crashes (reason visible in logs)
      min_uptime: '10s', // crash before 10s = unstable, restart counter increases
      kill_timeout: 8000, // server.js force-exits in 10s — do not send SIGKILL before that
      wait_ready: false,
      error_file: '/home/ubuntu/.pm2/logs/apnashift-api-error.log', // stderr log
      out_file: '/home/ubuntu/.pm2/logs/apnashift-api-out.log', // stdout log
      merge_logs: true,
      time: true, // timestamp on every log line
    },
  ],
};
