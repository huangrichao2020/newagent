/**
 * Ops Agent - 运维 agent
 * 负责服务器监控、健康检查、自动修复
 */

const OPS_PROMPT = `你是一个专业的运维工程师。负责：
1. 服务器监控
2. 服务健康检查
3. 故障诊断
4. 自动修复

可用命令：
- pm2 list/status/restart
- systemctl status/restart
- netstat -tlnp
- df -h / free -m
- curl/wget 健康检查`

export function createOpsAgent({
  bailianProvider,
  toolRuntime,
  serverConfig = {}
} = {}) {
  const HEALTH_CHECKS = {
    pm2: 'pm2 list',
    ports: 'netstat -tlnp | grep LISTEN',
    disk: 'df -h',
    memory: 'free -m',
    services: 'systemctl list-units --type=service --state=running'
  }

  async function checkHealth(serviceName) {
    const checks = []

    if (!serviceName || serviceName === 'all') {
      checks.push({ name: 'pm2', command: HEALTH_CHECKS.pm2 })
      checks.push({ name: 'ports', command: HEALTH_CHECKS.ports })
      checks.push({ name: 'disk', command: HEALTH_CHECKS.disk })
      checks.push({ name: 'memory', command: HEALTH_CHECKS.memory })
    } else {
      checks.push({
        name: serviceName,
        command: `pm2 status ${serviceName}`
      })
    }

    return {
      agent: 'ops',
      status: 'checking',
      checks,
      message: `开始健康检查：${serviceName || '全部服务'}`
    }
  }

  async function diagnose(issue) {
    const diagnosis = {
      issue,
      possibleCauses: [],
      suggestedActions: []
    }

    if (issue.includes('服务') || issue.includes('pm2')) {
      diagnosis.possibleCauses = [
        '进程崩溃',
        '内存不足',
        '端口冲突',
        '配置错误'
      ]
      diagnosis.suggestedActions = [
        '检查 PM2 日志',
        '重启服务',
        '检查系统资源'
      ]
    }

    if (issue.includes('磁盘') || issue.includes('空间')) {
      diagnosis.possibleCauses = [
        '日志文件过大',
        '临时文件未清理',
        '数据增长过快'
      ]
      diagnosis.suggestedActions = [
        '清理日志文件',
        '删除临时文件',
        '扩容磁盘'
      ]
    }

    return {
      agent: 'ops',
      status: 'diagnosed',
      diagnosis,
      message: `诊断完成：${issue}`
    }
  }

  async function fix(action) {
    const fixActions = {
      restart_pm2: 'pm2 restart all',
      restart_service: 'systemctl restart $SERVICE',
      clean_logs: 'find /var/log -name "*.log" -mtime +7 -delete',
      clean_temp: 'rm -rf /tmp/*'
    }

    const command = fixActions[action] || action

    return {
      agent: 'ops',
      status: 'fixed',
      action,
      command,
      message: `执行修复：${action}`
    }
  }

  async function execute(request, context = {}) {
    const text = request.text || ''

    if (text.includes('健康') || text.includes('检查')) {
      const serviceName = text.match(/(\w+)(服务 | 健康 | 检查)/)?.[1]
      return checkHealth(serviceName)
    }

    if (text.includes('诊断') || text.includes('问题') || text.includes('故障')) {
      const issue = text.replace(/.*(诊断 | 问题 | 故障).*/, '$1')
      return diagnose(issue)
    }

    if (text.includes('修复') || text.includes('重启') || text.includes('清理')) {
      const action = text.match(/(修复 | 重启 | 清理)(\w+)/)?.[2] || 'unknown'
      return fix(action)
    }

    return {
      agent: 'ops',
      status: 'completed',
      message: '运维请求已处理'
    }
  }

  async function monitor(intervalMs = 60000) {
    const monitoring = {
      active: true,
      interval: intervalMs,
      lastCheck: null,
      alerts: []
    }

    const timer = setInterval(async () => {
      monitoring.lastCheck = Date.now()
      const health = await checkHealth('all')

      if (health.status === 'failed') {
        monitoring.alerts.push({
          type: 'health_check_failed',
          timestamp: Date.now(),
          details: health
        })
      }
    }, intervalMs)

    return {
      monitoring,
      stop: () => {
        monitoring.active = false
        clearInterval(timer)
      }
    }
  }

  return {
    type: 'ops',
    checkHealth,
    diagnose,
    fix,
    execute,
    monitor
  }
}
