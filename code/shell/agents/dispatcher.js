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
  OPS: 'ops'
}

const TASK_CLASSIFICATION_PROMPT = `你是一个任务分类器。将用户请求分类到以下 agent：

1. FRONT_AGENT - 前台接待，处理所有用户输入
2. PLANNING_AGENT - 规划 agent，拆解复杂任务
3. EXECUTION_AGENT - 执行 agent，执行具体操作
4. VALIDATION_AGENT - 验证 agent，验证执行结果
5. REVIEW_AGENT - 复盘 agent，任务完成后复盘
6. OPS_AGENT - 运维 agent，服务器监控和维护

分类规则：
- 简单查询、文档创建、数据处理 → EXECUTION_AGENT
- 复杂多步骤任务 → PLANNING_AGENT
- 服务器监控、健康检查、服务重启 → OPS_AGENT
- 验证执行结果 → VALIDATION_AGENT
- 任务完成后复盘 → REVIEW_AGENT
- 默认 → FRONT_AGENT 处理

返回 JSON 格式：
{
  "agent": "agent_type",
  "confidence": 0.0-1.0,
  "reason": "分类理由"
}`

function classifyTask(request) {
  const text = request?.text || ''

  if (/(监控 | 健康 | 重启 | 服务 | 端口 | 进程|pm2|nginx|mysql|redis)/.test(text)) {
    return {
      agent: AGENT_TYPES.OPS,
      confidence: 0.9,
      reason: '运维相关请求'
    }
  }

  const validationKeywords = ['验证', '检查', '确认', '测试', 'verify', 'check', 'test']
  if (validationKeywords.some(k => text.includes(k))) {
    return {
      agent: AGENT_TYPES.VALIDATION,
      confidence: 0.85,
      reason: '验证相关请求'
    }
  }

  const reviewKeywords = ['复盘', '总结', '回顾', '反思', 'review', 'summary']
  if (reviewKeywords.some(k => text.includes(k))) {
    return {
      agent: AGENT_TYPES.REVIEW,
      confidence: 0.85,
      reason: '复盘相关请求'
    }
  }

  const planningKeywords = ['规划', '计划', '拆解', '步骤', '流程', 'plan', 'step']
  if (planningKeywords.some(k => text.includes(k))) {
    return {
      agent: AGENT_TYPES.PLANNING,
      confidence: 0.8,
      reason: '规划相关请求'
    }
  }

  const executionKeywords = ['创建', '执行', '运行', '处理', '生成', '发送', 'create', 'run', 'execute']
  if (executionKeywords.some(k => text.includes(k))) {
    return {
      agent: AGENT_TYPES.EXECUTION,
      confidence: 0.75,
      reason: '执行相关请求'
    }
  }

  return {
    agent: AGENT_TYPES.FRONT,
    confidence: 0.6,
    reason: '默认前台处理'
  }
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
    [AGENT_TYPES.OPS]: { tasks: 0, completed: 0, failed: 0 }
  }

  async function classifyWithLLM(request) {
    if (!bailianProvider) {
      return classifyTask(request)
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'classification',
        systemPrompt: TASK_CLASSIFICATION_PROMPT,
        prompt: `用户请求：${request.text || ''}`
      })

      const response = JSON.parse(result.response.content || '{}')
      return {
        agent: response.agent || AGENT_TYPES.FRONT,
        confidence: response.confidence || 0.6,
        reason: response.reason || 'LLM 分类'
      }
    } catch (error) {
      console.error('LLM classification failed:', error.message)
      return classifyTask(request)
    }
  }

  async function dispatch(request, context = {}) {
    const classification = await classifyWithLLM(request)

    const task = {
      id: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      agent: classification.agent,
      request,
      context,
      classification,
      status: 'pending',
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null
    }

    taskQueue.push(task)

    const agent = getOrCreateAgent(classification.agent)
    activeAgents.set(task.id, agent)

    return {
      taskId: task.id,
      agent: classification.agent,
      status: 'queued',
      classification
    }
  }

  function getOrCreateAgent(agentType) {
    if (!activeAgents.has(agentType)) {
      activeAgents.set(agentType, createSpecializedAgent(agentType))
    }
    return activeAgents.get(agentType)
  }

  async function processQueue() {
    while (taskQueue.length > 0) {
      const task = taskQueue.shift()
      task.status = 'processing'
      task.startedAt = Date.now()

      const agent = getOrCreateAgent(task.agent)
      agentStats[task.agent].tasks++

      try {
        const result = await agent.execute(task.request, task.context)
        task.status = 'completed'
        task.result = result
        agentStats[task.agent].completed++
      } catch (error) {
        task.status = 'failed'
        task.error = error.message
        agentStats[task.agent].failed++
      }

      task.completedAt = Date.now()
    }
  }

  function getTaskStatus(taskId) {
    const task = taskQueue.find(t => t.id === taskId)
    if (!task) {
      return { status: 'not_found' }
    }

    return {
      taskId: task.id,
      agent: task.agent,
      status: task.status,
      progress: task.status === 'processing' ? 50 : (task.status === 'completed' ? 100 : 0),
      result: task.result,
      error: task.error,
      createdAt: task.createdAt,
      completedAt: task.completedAt
    }
  }

  function getStats() {
    return {
      queueLength: taskQueue.length,
      activeAgents: activeAgents.size,
      agentStats
    }
  }

  return {
    dispatch,
    processQueue,
    getTaskStatus,
    getStats,
    getQueue: () => [...taskQueue],
    cancelTask: (taskId) => {
      const index = taskQueue.findIndex(t => t.id === taskId)
      if (index >= 0) {
        taskQueue.splice(index, 1)
        return { status: 'cancelled' }
      }
      return { status: 'not_found' }
    }
  }
}

function createSpecializedAgent(agentType) {
  const agentConfigs = {
    [AGENT_TYPES.FRONT]: {
      name: 'Front Agent',
      description: '前台接待 agent，处理用户交互',
      maxSteps: 2,
      priority: 'high'
    },
    [AGENT_TYPES.PLANNING]: {
      name: 'Planning Agent',
      description: '规划 agent，拆解复杂任务',
      maxSteps: 10,
      priority: 'medium'
    },
    [AGENT_TYPES.EXECUTION]: {
      name: 'Execution Agent',
      description: '执行 agent，执行具体操作',
      maxSteps: 5,
      priority: 'high'
    },
    [AGENT_TYPES.VALIDATION]: {
      name: 'Validation Agent',
      description: '验证 agent，验证执行结果',
      maxSteps: 3,
      priority: 'medium'
    },
    [AGENT_TYPES.REVIEW]: {
      name: 'Review Agent',
      description: '复盘 agent，任务完成后复盘',
      maxSteps: 2,
      priority: 'low'
    },
    [AGENT_TYPES.OPS]: {
      name: 'Ops Agent',
      description: '运维 agent，服务器监控和维护',
      maxSteps: 5,
      priority: 'critical'
    }
  }

  const config = agentConfigs[agentType] || agentConfigs[AGENT_TYPES.FRONT]

  return {
    type: agentType,
    config,
    async execute(request, context) {
      console.log(`[${config.name}] Executing task:`, request.text)
      return {
        agent: agentType,
        status: 'completed',
        message: `${config.name} completed task`
      }
    }
  }
}

export { AGENT_TYPES, classifyTask }
