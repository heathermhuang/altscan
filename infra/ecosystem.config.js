// PM2 process manager config — manages all 4 processes on the Hetzner server.
// Start:   pm2 start infra/ecosystem.config.js
// Status:  pm2 status
// Logs:    pm2 logs
// Reload:  pm2 reload all    (zero-downtime for web apps)
// Persist: pm2 save && pm2 startup

module.exports = {
  apps: [
    // ── Web apps ──────────────────────────────────────────────────────
    {
      name: 'bnbscan-web',
      script: 'apps/web/.next/standalone/server.js',
      cwd: '/opt/bnbscan',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '127.0.0.1',
      },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '800M',
      out_file: '/var/log/bnbscan/web-out.log',
      error_file: '/var/log/bnbscan/web-err.log',
      time: true,
    },
    {
      name: 'ethscan-web',
      script: 'apps/ethscan/.next/standalone/server.js',
      cwd: '/opt/bnbscan',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOSTNAME: '127.0.0.1',
      },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '800M',
      out_file: '/var/log/bnbscan/ethscan-out.log',
      error_file: '/var/log/bnbscan/ethscan-err.log',
      time: true,
    },

    // ── Indexers ──────────────────────────────────────────────────────
    {
      name: 'bnb-indexer',
      script: 'apps/indexer/dist/index.js',
      cwd: '/opt/bnbscan',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 5000,
      max_restarts: 10,
      out_file: '/var/log/bnbscan/bnb-indexer-out.log',
      error_file: '/var/log/bnbscan/bnb-indexer-err.log',
      time: true,
    },
    {
      name: 'eth-indexer',
      script: 'apps/eth-indexer/dist/index.js',
      cwd: '/opt/bnbscan',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 5000,
      max_restarts: 10,
      out_file: '/var/log/bnbscan/eth-indexer-out.log',
      error_file: '/var/log/bnbscan/eth-indexer-err.log',
      time: true,
    },
  ],
}
