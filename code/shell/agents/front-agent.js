/**
 * Front Agent - 前台 agent
 * 负责接收用户输入，初步处理，分派任务
 */

export function createFrontAgent({
  dispatcher,
  messageMerger,
  bailianProvider
} = {}) {
  const activeConversations = new Map()
  const pendingMessages = new Map()

  const FRONT_AGENT_PROMPT = `你是前台接待 agent，负责：
1. 接收用户输入
2. 判断是否是多轮对话的延续
3. 初步理解用户意图
4. 将任务分派给合适的专用 agent

回复风格：
- 友好、专业
- 简洁明了
- 主动确认需求`

  async function receiveMessage(message, conversationId) {
    const now = Date.now()
    const conversation = activeConversations.get(conversationId)

    if (!conversation) {
      return startNewConversation(message, conversationId)
    }

    const timeGap = now - conversation.lastMessageAt
    const mergeResult = messageMerger.shouldMerge(
      message,
      conversation.lastMessage,
      timeGap
    )

    if (mergeResult.shouldMerge) {
      return mergeIntoConversation(message, conversation, mergeResult)
    } else {
      return startNewTaskInConversation(message, conversation, mergeResult)
    }
  }

  async function startNewConversation(message, conversationId) {
    const conversation = {
      id: conversationId,
      messages: [message],
      tasks: [],
      status: 'active',
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      lastMessage: message
    }

    activeConversations.set(conversationId, conversation)
    messageMerger.addToHistory(message)

    const dispatchResult = await dispatcher.dispatch(message, {
      conversationId,
      isContinuation: false
    })

    conversation.tasks.push(dispatchResult)

    return {
      type: 'new_conversation',
      conversationId,
      taskId: dispatchResult.taskId,
      agent: dispatchResult.agent,
      message: '收到，我来处理。'
    }
  }

  async function mergeIntoConversation(message, conversation, mergeResult) {
    conversation.messages.push(message)
    conversation.lastMessage = message
    conversation.lastMessageAt = Date.now()
    messageMerger.addToHistory(message)

    const lastTask = conversation.tasks[conversation.tasks.length - 1]

    if (lastTask && lastTask.status === 'pending') {
      return {
        type: 'merged_message',
        conversationId: conversation.id,
        taskId: lastTask.taskId,
        message: '收到补充，会一起处理。',
        mergeReason: mergeResult.reason,
        confidence: mergeResult.confidence
      }
    }

    const dispatchResult = await dispatcher.dispatch(message, {
      conversationId: conversation.id,
      isContinuation: true,
      parentTaskId: lastTask?.taskId
    })

    conversation.tasks.push(dispatchResult)

    return {
      type: 'new_task_merged',
      conversationId: conversation.id,
      taskId: dispatchResult.taskId,
      agent: dispatchResult.agent,
      message: '收到，添加到当前任务。',
      mergeReason: mergeResult.reason
    }
  }

  async function startNewTaskInConversation(message, conversation, mergeResult) {
    conversation.messages.push(message)
    conversation.lastMessage = message
    conversation.lastMessageAt = Date.now()
    messageMerger.addToHistory(message)

    const dispatchResult = await dispatcher.dispatch(message, {
      conversationId: conversation.id,
      isContinuation: false
    })

    conversation.tasks.push(dispatchResult)

    return {
      type: 'new_task',
      conversationId: conversation.id,
      taskId: dispatchResult.taskId,
      agent: dispatchResult.agent,
      message: '收到新任务，开始处理。',
      newTaskReason: mergeResult.reason
    }
  }

  function getConversation(conversationId) {
    return activeConversations.get(conversationId)
  }

  function getConversationStats(conversationId) {
    const conversation = activeConversations.get(conversationId)
    if (!conversation) {
      return null
    }

    return {
      id: conversation.id,
      messageCount: conversation.messages.length,
      taskCount: conversation.tasks.length,
      status: conversation.status,
      duration: Date.now() - conversation.createdAt
    }
  }

  return {
    receiveMessage,
    getConversation,
    getConversationStats,
    getActiveConversations: () => new Map(activeConversations),
    closeConversation: (conversationId) => {
      const conversation = activeConversations.get(conversationId)
      if (conversation) {
        conversation.status = 'closed'
        conversation.closedAt = Date.now()
      }
    },
    cleanup: (maxAgeMs = 30 * 60 * 1000) => {
      const now = Date.now()
      for (const [id, conv] of activeConversations.entries()) {
        if (now - conv.lastMessageAt > maxAgeMs && conv.status === 'active') {
          conv.status = 'timeout'
          activeConversations.delete(id)
        }
      }
    }
  }
}
