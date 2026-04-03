/**
 * Multi-Agent Runtime - 多 Agent 运行时
 * 统一管理 6 个专用 agent + Feishu 长连接
 * 
 * 架构说明：
 * - FRONT: 前台接待，接收用户输入
 * - PLANNING: 规划 agent，拆解任务
 * - EXECUTION: 执行 agent，调用工具
 * - VALIDATION: 验证 agent，检查结果
 * - REVIEW: 复盘 agent，总结经验
 * - OPS: 运维 agent，服务器管理
 */

import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { createMessageMerger } from './message-merger.js'
import { createDispatcher, AGENT_TYPES } from './dispatcher.js'
import { createFrontAgent } from './front-agent.js'
import { createPlanningAgent } from './planning-agent.js'
import { createExecutionAgent } from './execution-agent.js'
import { createValidationAgent } from './validation-agent.js'
import { createReviewAgent } from './review-agent.js'
import { createOpsAgent } from './ops-agent.js'

// 新架构说明：
// - 删除了 verification-agent（与 quality-review 功能重复）
// - 删除了 external_review 配置（未实际使用）
// - 删除了 background_precompute 配置（默认关闭，增加复杂度）

const DEFAULT_CONTEXT_COMPACTION_INTERVAL_MS = 5 * 60 * 60 * 1000
const DEFAULT_MAINTENANCE_POLL_INTERVAL_MS = 5 * 60 * 1000

export function createMultiAgentRuntime({
  storageRoot,
  bailianProvider = null,
  agentExecutor = null,
  toolRuntime = null,
  feishuGateway = null,
  serverConfig = {},
  agentProfile = {}
} = {}) {
  const messageMerger = createMessageMerger({
    mergeWindowMs: 5 * 60 * 1000,
    maxConversationHistory: 10
  })

  const dispatcher = createDispatcher({
    bailianProvider,
    agentProfiles: {}
  })

  const planningAgent = createPlanningAgent({
    bailianProvider,
    agentExecutor
  })

  const executionAgent = createExecutionAgent({
    agentExecutor,
    toolRuntime,
    bailianProvider
  })

  const validationAgent = createValidationAgent({
    bailianProvider,
    toolRuntime
  })

  const reviewAgent = createReviewAgent({
    bailianProvider
  })

  const opsAgent = createOpsAgent({
    bailianProvider,
    toolRuntime,
    serverConfig
  })

  const frontAgent = createFrontAgent({
    dispatcher,
    messageMerger,
    bailianProvider
  })

  const agents = {
    [AGENT_TYPES.FRONT]: frontAgent,
    [AGENT_TYPES.PLANNING]: planningAgent,
    [AGENT_TYPES.EXECUTION]: executionAgent,
    [AGENT_TYPES.VALIDATION]: validationAgent,
    [AGENT_TYPES.REVIEW]: reviewAgent,
    [AGENT_TYPES.OPS]: opsAgent
  }

  const messageQueue = []
  const processingState = {
    active: false,
    currentTask: null,
    lastProcessedAt: null
  }

  async function processMessageQueue() {
    if (processingState.active) {
      return
    }

    processingState.active = true

    while (messageQueue.length > 0) {
      const { message, conversationId, resolve, reject } = messageQueue.shift()

      try {
        const result = await frontAgent.receiveMessage(message, conversationId)
        processingState.currentTask = result.taskId
        processingState.lastProcessedAt = Date.now()
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    processingState.active = false
  }

  async function receiveFeishuMessage(message) {
    return new Promise((resolve, reject) => {
      const conversationId = message.chat_id || 'default'

      messageQueue.push({
        message,
        conversationId,
        resolve,
        reject
      })

      processMessageQueue()
    })
  }

  async function getTaskStatus(taskId) {
    return dispatcher.getTaskStatus(taskId)
  }

  async function getRuntimeStats() {
    const conversations = frontAgent.getActiveConversations()
    const dispatcherStats = dispatcher.getStats()

    return {
      queueLength: messageQueue.length,
      processing: processingState.active,
      currentTask: processingState.currentTask,
      conversations: conversations.size,
      dispatcher: dispatcherStats,
      agents: {
        front: 'active',
        planning: 'active',
        execution: 'active',
        validation: 'active',
        review: 'active',
        ops: 'active'
      }
    }
  }

  // ========== Feishu Long Connection Support ==========

  async function startFeishuLoop({
    seedAliyun = true,
    autoReply = true,
    autoPlan = true,
    autoExecuteSafeInspect = true
  } = {}) {
    if (!feishuGateway) {
      throw new Error('Feishu gateway is required to start the Feishu loop')
    }

    const state = await feishuGateway.start({
      immediateReactionEmojiType: autoReply ? '👍' : null,
      immediateReplyText: autoReply ? '收到，正在处理...' : null,
      onMessage: async (message) => {
        const normalizedMessage = message

        return new Promise((resolve, reject) => {
          enqueueFeishuMessage({
            message: normalizedMessage,
            options: {
              autoReply,
              autoPlan,
              autoExecuteSafeInspect
            },
            resolve,
            reject
          })
        })
      }
    })

    const maintenance = startFeishuMaintenanceLoop()

    return {
      bootstrap: { seedAliyun, preserved: true },
      channel_state: state,
      maintenance_state: {
        started: maintenance.started,
        poll_interval_ms: maintenance.poll_interval_ms,
        background_precompute_enabled: agentProfile.background_precompute?.enabled === true
      }
    }
  }

  function enqueueFeishuMessage({ message, options, resolve, reject }) {
    messageQueue.push({
      message,
      conversationId: message.chat_id || 'feishu_default',
      options,
      resolve,
      reject
    })

    if (!processingState.active) {
      processMessageQueue()
    }
  }

  function startFeishuMaintenanceLoop() {
    const pollIntervalMs = DEFAULT_MAINTENANCE_POLL_INTERVAL_MS
    let started = false
    let timer = null

    const tick = () => {
      // 定期清理超时会话
      frontAgent.cleanup(30 * 60 * 1000)
    }

    const start = () => {
      if (started) return
      started = true
      timer = setInterval(tick, pollIntervalMs)
    }

    const stop = () => {
      if (!started) return
      started = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }

    start()

    return {
      started,
      poll_interval_ms: pollIntervalMs,
      start,
      stop
    }
  }

  async function handleChannelMessage({ channel, message, autoReply = true, autoPlan = true }) {
    if (channel === 'feishu' && feishuGateway) {
      return receiveFeishuMessage(message)
    }

    // 其他通道直接分派
    return dispatcher.dispatch(message, { channel })
  }

  return {
    // Core API
    receiveFeishuMessage,
    getTaskStatus,
    getRuntimeStats,
    handleChannelMessage,

    // Agent access
    agents,
    dispatcher,
    messageMerger,
    frontAgent,

    // Feishu loop
    startFeishuLoop,

    // Queue management
    queue: {
      length: messageQueue.length,
      processing: processingState.active
    },

    // Cleanup
    cleanup: async () => {
      frontAgent.cleanup()
      messageQueue.length = 0
      processingState.active = false
    }
  }
}

export { AGENT_TYPES }
