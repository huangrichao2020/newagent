/**
 * Agent 分派器
 * 根据任务类型分派给专用 agent
 */

const AGENT_TYPES = {
  FRONT: 'front',
  PLANNING: 'planning',
  EXECUTION: 'execution',
  VALIDATION: 'validation',
  REVIEW: 'review',
  OPS: 'ops',
  VERIFICATION: 'verification'
}

const TASK_CLASSIFICATION_PROMPT = `你是一个任务分类器。将用户请求分类到以下 agent：

1. FRONT_AGENT - 前台接待
2. PLANNING_AGENT - 规划 agent
3. EXECUTION_AGENT - 执行 agent
4. VALIDATION_AGENT - 验证 agent
5. REVIEW_AGENT - 复盘 agent
6. OPS_AGENT - 运维 agent
7. VERIFICATION_AGENT - 激进验证 agent

返回 JSON: {"agent": "agent_type", "confidence": 0.0-1.0, "reason": "分类理由"}
`

function classifyTask(request) {
  const text = request?.text || ''

  // OPS: 运维相关
  if (text.includes('监控') || text.includes('健康') || text.includes('重启') || 
      text.includes('服务') || text.includes('端口') || text.includes('进程') ||
      text.includes('pm2') || text.includes('nginx') || text.includes('mysql') || text.includes('redis')) {
    return { agent: AGENT_TYPES.OPS, confidence: 0.9, reason: '运维相关请求' }
  }

  // VERIFICATION: 激进验证 (部署前/上线前检查)
  if (text.includes('验证') || text.includes('部署前') || text.includes('上线前')) {
    return { agent: AGENT_TYPES.VERIFICATION, confidence: 0.9, reason: '验证相关请求 - 激进模式' }
  }

  // VALIDATION: 普通验证
  if (text.includes('检查') || text.includes('确认') || text.includes('测试') ||
      text.includes('verify') || text.includes('check') || text.includes('test')) {
    return { agent: AGENT_TYPES.VALIDATION, confidence: 0.85, reason: '验证相关请求' }
  }

  // REVIEW: 复盘
  if (text.includes('复盘') || text.includes('总结') || text.includes('回顾') ||
      text.includes('反思') || text.includes('review') || text.includes('summary')) {
    return { agent: AGENT_TYPES.REVIEW, confidence: 0.85, reason: '复盘相关请求' }
  }

  // PLANNING: 规划
  if (text.includes('规划') || text.includes('计划') || text.includes('拆解') ||
      text.includes('步骤') || text.includes('流程') || text.includes('plan') || text.includes('step')) {
    return { agent: AGENT_TYPES.PLANNING, confidence: 0.8, reason: '规划相关请求' }
  }

  // EXECUTION: 执行
  if (text.includes('创建') || text.includes('执行') || text.includes('运行') ||
      text.includes('处理') || text.includes('生成') || text.includes('发送') ||
      text.includes('create') || text.includes('run') || text.includes('execute')) {
    return { agent: AGENT_TYPES.EXECUTION, confidence: 0.75, reason: '执行相关请求' }
  }

  return { agent: AGENT_TYPES.FRONT, confidence: 0.6, reason: '默认前台处理' }
}

export function createDispatcher({
  bailianProvider,
  agentProfiles = {}
} = {}) {
  const activeAgents = new Map()
  const taskQueue = []
  const agentStats = {
    [AGENT_TYPES.FRONT]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.PLANNING]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.EXECUTION]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.VALIDATION]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.REVIEW]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.OPS]: { tasks: 0, completed: 0, failed: 0 },
    [AGENT_TYPES.VERIFICATION]: { tasks: 0, completed: 0, failed: 0 }
  }

  async function classifyWithLLM(request) {
    if (!bailianProvider) {
      return classifyTask(request)
    }
    // LLM 分类逻辑...
    return classifyTask(request)
  }

  async function dispatch(request, context = {}) {
    const classification = await classifyWithLLM(request)
    const task = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      agent: classification.agent,
      request,
      context,
      classification,
      status: 'pending',
      createdAt: Date.now()
    }
    taskQueue.push(task)
    return { taskId: task.id, agent: classification.agent, status: 'queued', classification }
  }

  function getTaskStatus(taskId) {
    const task = taskQueue.find(t => t.id === taskId)
    if (!task) return { status: 'not_found' }
    return { taskId: task.id, agent: task.agent, status: task.status }
  }

  function getStats() {
    return { queueLength: taskQueue.length, activeAgents: activeAgents.size, agentStats }
  }

  return { dispatch, getTaskStatus, getStats, getQueue: () => [...taskQueue] }
}

export { AGENT_TYPES, classifyTask }
