module.exports = {
  apps: [
    {
      name: 'newagent-scrapling-worker',
      cwd: '/root/newagent/code',
      script: './workers/scrapling_worker/app.py',
      args: '--host 127.0.0.1 --port 7771',
      interpreter: 'python3',
      env: {
        PYTHONUNBUFFERED: '1'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      time: true
    }
  ]
}
