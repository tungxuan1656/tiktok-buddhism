const { dirname, join } = require('node:path');

module.exports = {
  apps: [{
    name: 'buddhism-telegram',
    cwd: __dirname,
    script: join(__dirname, 'telegram/cli.mjs'),
    interpreter: process.execPath,
    node_args: [`--env-file=${join(__dirname, '.env')}`],
    exec_mode: 'fork',
    instances: 1,
    watch: false,
    autorestart: true,
    restart_delay: 5000,
    min_uptime: 10000,
    max_restarts: 10,
    kill_timeout: 10000,
    filter_env: ['TELEGRAM_'],
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}` },
    merge_logs: true,
    time: true,
  }],
};
