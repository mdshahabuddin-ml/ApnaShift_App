// PM2 process file for ApnaShift backend (production, Ubuntu server).
// NOTE: extension .cjs is required — package.json has "type": "module",
// so a plain .js file here would be treated as ESM and module.exports would fail.
// Usage on server (app dir me):
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save            (current process list save karo taaki reboot par wapas aaye)
//   pm2 startup         (jo command ye print kare, use sudo ke saath ek baar chalao)
module.exports = {
  apps: [
    {
      name: 'apnashift-api', // pm2 logs apnashift-api / pm2 reload apnashift-api
      script: 'src/server.js', // npm start wala hi entry point (node src/server.js)
      cwd: '/opt/apnashift/apnashift-backend', // git clone wali jagah (DEPLOY.md dekho)
      instances: 1, // single instance: free-tier ARM me RAM kam hai, cluster mat chalao
      exec_mode: 'fork', // fork mode (cluster ke liye instances > 1 + exec_mode cluster chahiye)
      env_production: {
        NODE_ENV: 'production', // baaki secrets .env file se aate hain (dotenv), yahan secret mat likho
      },
      max_memory_restart: '350M', // memory leak ho to auto-restart (1GB free tier ke liye safe)
      exp_backoff_restart_delay: 3000, // crash loop me har restart ke beech badhta delay (DB down time me)
      max_restarts: 20, // isse zyada crash to PM2 rok dega (log me reason dikhega)
      min_uptime: '10s', // 10s se pehle crash = unstable, restart counter badhega
      kill_timeout: 8000, // server.js 10s me force-exit karta hai — usse pehle SIGKILL mat bhejo
      wait_ready: false,
      error_file: '/home/ubuntu/.pm2/logs/apnashift-api-error.log', // stderr log
      out_file: '/home/ubuntu/.pm2/logs/apnashift-api-out.log', // stdout log
      merge_logs: true,
      time: true, // har log line par timestamp
    },
  ],
};
