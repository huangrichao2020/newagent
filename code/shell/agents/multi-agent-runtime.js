/**
 * 多 Agent 运行时
 * 统一管理 6 个专用 agent + Verification
 */

import { createMessageMerger } from './message-merger.js'
import { createDispatcher, AGENT_TYPES } from './dispatcher.js'
import { createFrontAgent } from './front-agent.js'
import { createPlanningAgent } from './planning-agent.js'
import { createExecutionAgent } from './execution-agent.js'
import { createValidationAgent } from './validation-agent.js'
import { createReviewAgent } from './review-agent.js'
import { createOpsAgent } from './ops-agent.js'
import { createVerificationAgent } from './verification-agent.js'

export function createMultiAgentRuntime({
  storageRoot,
  bailianProvider = null,
  agentExecutor = null,
  toolRuntime = null,
  feishuGateway = null,
  serverConfig = {}
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

  const verificationAgent = createVerificationAgent({
    bailianProvider,
    toolRuntime
  })

  const frontAgent = createFrontAgent({
    dispatcher,
    messageMerger,
    bailianProvider,
    verificationAgent
  })

  const agents = {
    [AGENT_TYPES.FRONT]: frontAgent,
    [AGENT_TYPES.PLANNING]: planningAgent,
    [AGENT_TYPES.EXECUTION]: executionAgent,
    [AGENT_TYPES.VALIDATION]: validationAgent,
    [AGENT_TYPES.REVIEW]: reviewAgent,
    [AGENT_TYPES.OPS]: opsAgent,
    [AGENT_TYPES.VERIFICATION]: verificationAgent
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

  return {
    receiveFeishuMessage,
    getTaskStatus,
    getRuntimeStats,
    agents,
    dispatcher,
    messageMerger,
    frontAgent,
    queue: {
      length: messageQueue.length,
      processing: processingState.active
    },
    cleanup: async () => {
      frontAgent.cleanup()
      messageQueue.length = 0
      processingState.active = false
    }
  }
}

export { AGENT_TYPES }
