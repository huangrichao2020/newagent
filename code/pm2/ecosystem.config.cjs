module.exports = {
  apps: [
    {
      name: 'newagent-manager',
      cwd: '/root/newagent/code',
      script: './bin/newagent.js',
      args: 'manager feishu-serve --storage-root /root/newagent/storage',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production'
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      time: true
    }
  ]
}
