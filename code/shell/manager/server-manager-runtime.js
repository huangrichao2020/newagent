import { createSessionStore } from '../session/session-store.js'
import { createMemoryStore } from '../memory/memory-store.js'
import {
  extractFeedbackMemoryCandidates,
  prioritizeFeedbackEntries
} from '../memory/feedback-memory.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import {
  createRemoteServerManagerProfile,
  getAliyunSeedProjects
} from './remote-server-manager-profile.js'
import {
  buildManagerPlanningPrompt,
  buildManagerPlanningSystemPrompt,
  parseManagerPlanningResponse
} from './manager-planner.js'
import { createManagerExecutor } from './manager-executor.js'

function buildOperatorTitle(message) {
  const sender = message.sender_open_id ?? message.sender_user_id ?? 'operator'
  return `Remote manager request from ${sender}`
}

function buildOperatorRequest(message) {
  if (message.text) {
    return message.text
  }

  return JSON.stringify(message.content ?? message.raw_content ?? {})
}

function buildImmediateFeishuAck() {
  return '已读喵，我在看啦。'
}

function buildImmediateFeishuReaction() {
  return 'SMILE'
}

function buildDelayedFeishuProgressAck(message) {
  const request = buildOperatorRequest(message)

  if (request.length <= 12) {
    return '我先理解一下你的意思，马上给你结论。'
  }

  return '我先拆一下你的需求，正在排查，稍后给你结论。'
}

function isLightweightPing(message) {
  const normalized = buildOperatorRequest(message)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')

  return /^(在|在吗|在吗\?|在吗？|在嘛|在嘛\?|在嘛？|在不|在不在|在么|在么\?|在么？|在没|在没\?|在没？|hi|hello|hey|yo|ping|\?|？)$/.test(normalized)
}

function buildLightweightPingReply() {
  return '在，有事直接说。'
}

function summarizeManagerRuns(runs = []) {
  return runs
    .map((run) => run.summary)
    .filter(Boolean)
}

function buildFeedbackLearningAck(learning) {
  if (!learning || learning.count === 0) {
    return null
  }

  if (learning.written_count > 0) {
    return `已记下 ${learning.written_count} 条偏好规则，后续会按这个方式回应。`
  }

  return '这些偏好我记住了，后续会按这个方式回应。'
}

export function createServerManagerRuntime({
  storageRoot,
  feishuGateway = null,
  bailianProvider = null,
  hookBus = null,
  workspaceRoot = process.cwd(),
  fetchFn = globalThis.fetch,
  managerProfile = createRemoteServerManagerProfile(),
  progressReplyDelayMs = 2000,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
}) {
  const sessionStore = createSessionStore({ storageRoot })
  const memoryStore = createMemoryStore({ storageRoot })
  const runtimeHookBus = hookBus ?? createHookBus({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    fetchFn
  })

  async function bootstrapServerBaseline({
    seedAliyun = true
  } = {}) {
    const seededProjects = seedAliyun
      ? await projectRegistry.seedProjects(getAliyunSeedProjects())
      : []

    return {
      manager_profile: managerProfile,
      seeded_project_count: seededProjects.length
    }
  }

  async function emitHook({
    name,
    sessionId,
    channel = null,
    actor = 'manager:runtime',
    payload = {}
  }) {
    return runtimeHookBus.emit({
      name,
      sessionId,
      channel,
      actor,
      payload
    })
  }

  async function ensureServerBaseline({
    seedAliyunIfEmpty = true
  } = {}) {
    const existingProjects = await projectRegistry.listProjects()

    if (existingProjects.length > 0 || !seedAliyunIfEmpty) {
      return {
        seeded: false,
        project_count: existingProjects.length
      }
    }

    const bootstrap = await bootstrapServerBaseline({
      seedAliyun: true
    })

    return {
      seeded: true,
      project_count: bootstrap.seeded_project_count
    }
  }

  async function planSession({
    sessionId,
    message
  }) {
    if (!bailianProvider) {
      return null
    }

    const projects = await projectRegistry.listProjects()
    const operatorRules = prioritizeFeedbackEntries(
      await memoryStore.searchMemoryEntries({
        sessionId,
        scope: 'project',
        tag: 'feedback_rule'
      })
    ).slice(0, 6)
    await emitHook({
      name: 'manager.planning.started',
      sessionId,
      actor: 'manager:planner',
      payload: {
        available_project_count: projects.length,
        operator_rule_count: operatorRules.length
      }
    })
    const providerResult = await bailianProvider.invokeByIntent({
      intent: 'plan',
      systemPrompt: buildManagerPlanningSystemPrompt({
        managerProfile
      }),
      prompt: buildManagerPlanningPrompt({
        message,
        projects,
        operatorRules
      })
    })
    const plan = parseManagerPlanningResponse({
      text: providerResult.response.content ?? '',
      availableProjects: projects
    })

    await sessionStore.createPlan(sessionId, {
      steps: plan.steps
    })
    await sessionStore.updateSessionSummary(sessionId, plan.summary)
    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'manager_plan_generated',
      actor: 'manager:planner',
      payload: {
        project_keys: plan.project_keys,
        step_count: plan.steps.length,
        model: providerResult.route.model,
        provider: providerResult.route.provider ?? providerResult.route.runtime ?? null
      }
    })
    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'assistant_message_added',
      actor: 'assistant:manager',
      payload: {
        content: plan.operator_reply
      }
    })
    await emitHook({
      name: 'manager.planning.completed',
      sessionId,
      actor: 'manager:planner',
      payload: {
        project_keys: plan.project_keys,
        step_count: plan.steps.length,
        model: providerResult.route.model,
        provider: providerResult.route.provider ?? providerResult.route.runtime ?? null
      }
    })

    return {
      plan,
      provider_result: {
        route: providerResult.route,
        request: providerResult.request,
        response: {
          id: providerResult.response.id,
          model: providerResult.response.model,
          finish_reason: providerResult.response.finish_reason,
          usage: providerResult.response.usage
        }
      }
    }
  }

  async function sendImmediateFeishuAck({
    messageId
  }) {
    if (!feishuGateway || !messageId) {
      return null
    }

    const immediateReaction = buildImmediateFeishuReaction()
    const immediateAck = buildImmediateFeishuAck()

    try {
      await feishuGateway.addMessageReaction({
        messageId,
        emojiType: immediateReaction
      })

      return {
        kind: 'reaction',
        ok: true,
        source: 'server_manager_runtime',
        message_id: messageId,
        emoji_type: immediateReaction
      }
    } catch (error) {
      try {
        await feishuGateway.replyTextMessage({
          messageId,
          text: immediateAck
        })

        return {
          kind: 'text',
          ok: true,
          source: 'server_manager_runtime',
          message_id: messageId,
          text: immediateAck,
          reaction_error: error.message
        }
      } catch (replyError) {
        return {
          kind: 'failed',
          ok: false,
          source: 'server_manager_runtime',
          stage: 'immediate_ack',
          message_id: messageId,
          reaction_error: error.message,
          reply_error: replyError.message
        }
      }
    }
  }

  async function appendImmediateAckTimelineEvent(sessionId, immediateAck) {
    if (!immediateAck) {
      return
    }

    if (immediateAck.kind === 'reaction' && immediateAck.ok) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'assistant_reaction_added',
        actor: 'assistant:manager',
        payload: {
          message_id: immediateAck.message_id ?? null,
          emoji_type: immediateAck.emoji_type ?? null,
          source: immediateAck.source ?? null
        }
      })
      await emitHook({
        name: 'channel.ack.sent',
        sessionId,
        channel: 'feishu',
        actor: 'assistant:manager',
        payload: {
          kind: 'reaction',
          message_id: immediateAck.message_id ?? null,
          emoji_type: immediateAck.emoji_type ?? null,
          source: immediateAck.source ?? null
        }
      })
      return
    }

    if (immediateAck.kind === 'text' && immediateAck.ok) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'assistant_message_added',
        actor: 'assistant:manager',
        payload: {
          content: immediateAck.text ?? null,
          stage: 'immediate_ack',
          source: immediateAck.source ?? null
        }
      })
      await emitHook({
        name: 'channel.ack.sent',
        sessionId,
        channel: 'feishu',
        actor: 'assistant:manager',
        payload: {
          kind: 'text',
          message_id: immediateAck.message_id ?? null,
          text: immediateAck.text ?? null,
          source: immediateAck.source ?? null
        }
      })
      return
    }

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'channel_reply_failed',
      actor: 'assistant:manager',
      payload: {
        stage: immediateAck.stage ?? 'immediate_ack',
        source: immediateAck.source ?? null,
        reaction_error: immediateAck.reaction_error ?? null,
        reply_error: immediateAck.reply_error ?? null
      }
    })
    await emitHook({
      name: 'channel.ack.failed',
      sessionId,
      channel: 'feishu',
      actor: 'assistant:manager',
      payload: {
        stage: immediateAck.stage ?? 'immediate_ack',
        source: immediateAck.source ?? null,
        reaction_error: immediateAck.reaction_error ?? null,
        reply_error: immediateAck.reply_error ?? null
      }
    })
  }

  async function sendFeishuText({
    message,
    text
  }) {
    if (!feishuGateway) {
      return {
        ok: false,
        error: 'Missing Feishu gateway'
      }
    }

    if (message?.message_id) {
      try {
        await feishuGateway.replyTextMessage({
          messageId: message.message_id,
          text
        })

        return {
          ok: true,
          transport: 'reply',
          message_id: message.message_id
        }
      } catch (replyError) {
        if (message?.chat_id) {
          try {
            await feishuGateway.sendTextMessage({
              receiveIdType: 'chat_id',
              receiveId: message.chat_id,
              text
            })

            return {
              ok: true,
              transport: 'chat',
              message_id: message.message_id,
              chat_id: message.chat_id,
              reply_error: replyError.message
            }
          } catch (chatError) {
            return {
              ok: false,
              message_id: message.message_id,
              chat_id: message.chat_id,
              reply_error: replyError.message,
              chat_error: chatError.message
            }
          }
        }

        return {
          ok: false,
          message_id: message.message_id,
          reply_error: replyError.message
        }
      }
    }

    if (!message?.chat_id) {
      return {
        ok: false,
        error: 'Missing Feishu message_id and chat_id'
      }
    }

    try {
      await feishuGateway.sendTextMessage({
        receiveIdType: 'chat_id',
        receiveId: message.chat_id,
        text
      })

      return {
        ok: true,
        transport: 'chat',
        chat_id: message.chat_id
      }
    } catch (chatError) {
      return {
        ok: false,
        chat_id: message.chat_id,
        chat_error: chatError.message
      }
    }
  }

  async function deliverFeishuReply({
    sessionId,
    message,
    text,
    stage
  }) {
    const delivery = await sendFeishuText({
      message,
      text
    })

    if (delivery.ok) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'assistant_message_added',
        actor: 'assistant:manager',
        payload: {
          content: text,
          stage,
          transport: delivery.transport ?? null,
          reply_error: delivery.reply_error ?? null
        }
      })
      await emitHook({
        name: 'channel.reply.sent',
        sessionId,
        channel: 'feishu',
        actor: 'assistant:manager',
        payload: {
          stage,
          transport: delivery.transport ?? null,
          message_id: delivery.message_id ?? null,
          chat_id: delivery.chat_id ?? null
        }
      })

      return delivery
    }

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'channel_reply_failed',
      actor: 'assistant:manager',
      payload: {
        stage,
        error: delivery.error ?? null,
        reply_error: delivery.reply_error ?? null,
        chat_error: delivery.chat_error ?? null
      }
    })
    await emitHook({
      name: 'channel.reply.failed',
      sessionId,
      channel: 'feishu',
      actor: 'assistant:manager',
      payload: {
        stage,
        error: delivery.error ?? null,
        reply_error: delivery.reply_error ?? null,
        chat_error: delivery.chat_error ?? null
      }
    })

    return delivery
  }

  async function completePingSession({
    sessionId,
    replyText
  }) {
    const plan = await sessionStore.createPlan(sessionId, {
      steps: [
        {
          title: 'Respond to operator ping',
          kind: 'report',
          notes: 'Quick acknowledgement for a lightweight ping.'
        }
      ]
    })

    await sessionStore.updateSessionSummary(
      sessionId,
      '已响应操作员在线探测，等待下一条明确指令。'
    )
    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'manager_ping_detected',
      actor: 'manager:runtime',
      payload: {
        reply_text: replyText
      }
    })
    await emitHook({
      name: 'manager.ping.detected',
      sessionId,
      actor: 'manager:runtime',
      payload: {
        reply_text: replyText
      }
    })
    await sessionStore.completePlanStep(sessionId, plan.steps[0].id, {
      resultSummary: replyText
    })
  }

  function createDelayedFeishuProgressNotifier({
    sessionId,
    channel,
    message
  }) {
    if (
      channel !== 'feishu' ||
      !feishuGateway ||
      !message?.message_id ||
      progressReplyDelayMs == null ||
      progressReplyDelayMs < 0
    ) {
      return {
        async stop() {},
        wasSent() {
          return false
        }
      }
    }

    const progressText = buildDelayedFeishuProgressAck(message)
    let stopped = false
    let sent = false
    let flushPromise = null
    const timer = setTimeoutFn(() => {
      if (stopped) {
        return
      }

      sent = true
      flushPromise = Promise.resolve()
        .then(async () => {
          await deliverFeishuReply({
            sessionId,
            message,
            text: progressText,
            stage: 'progress_ack'
          })
        })
        .catch(async (error) => {
          await sessionStore.appendTimelineEvent(sessionId, {
            kind: 'channel_reply_failed',
            actor: 'assistant:manager',
            payload: {
              stage: 'progress_ack',
              reply_error: error.message
            }
          })
        })
    }, progressReplyDelayMs)

    return {
      async stop() {
        stopped = true
        clearTimeoutFn(timer)

        if (flushPromise) {
          await flushPromise
        }
      },
      wasSent() {
        return sent
      }
    }
  }

  async function learnOperatorFeedback({
    sessionId,
    channel,
    message
  }) {
    const candidates = extractFeedbackMemoryCandidates({
      channel,
      messageText: buildOperatorRequest(message)
    })

    if (candidates.length === 0) {
      return {
        count: 0,
        written_count: 0,
        existing_count: 0,
        entries: []
      }
    }

    const entries = []
    let writtenCount = 0
    let existingCount = 0

    for (const candidate of candidates) {
      const existingMatches = await memoryStore.searchMemoryEntries({
        sessionId,
        scope: 'project',
        query: candidate.content,
        tag: 'feedback_rule'
      })
      const existing = existingMatches.find(
        (entry) =>
          entry.kind === candidate.kind &&
          entry.content === candidate.content &&
          entry.status === 'active'
      )

      if (existing) {
        existingCount += 1
        entries.push(existing)
        continue
      }

      const createdEntry = await memoryStore.addMemoryEntry({
        sessionId,
        scope: 'project',
        kind: candidate.kind,
        content: candidate.content,
        tags: candidate.tags
      })

      writtenCount += 1
      entries.push(createdEntry)
    }

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'feedback_memory_learned',
      actor: 'manager:runtime',
      payload: {
        count: entries.length,
        written_count: writtenCount,
        existing_count: existingCount,
        memory_ids: entries.map((entry) => entry.id),
        kinds: [...new Set(entries.map((entry) => entry.kind))]
      }
    })
    await emitHook({
      name: 'manager.feedback.learned',
      sessionId,
      actor: 'manager:runtime',
      payload: {
        count: entries.length,
        written_count: writtenCount,
        existing_count: existingCount,
        memory_ids: entries.map((entry) => entry.id),
        kinds: [...new Set(entries.map((entry) => entry.kind))]
      }
    })

    return {
      count: entries.length,
      written_count: writtenCount,
      existing_count: existingCount,
      entries
    }
  }

  async function handleChannelMessage({
    channel,
    message,
    autoReply = true,
    autoPlan = true,
    autoExecuteSafeInspect = true
  }) {
    const shouldReply =
      autoReply || (channel === 'feishu' && Boolean(feishuGateway) && Boolean(message?.message_id || message?.chat_id))

    await ensureServerBaseline()

    const created = await sessionStore.createSession({
      title: buildOperatorTitle(message),
      projectKey: 'remote-server-manager',
      userRequest: buildOperatorRequest(message),
      summary: `Received ${channel} operator request`
    })

    await sessionStore.appendTimelineEvent(created.session.id, {
      kind: 'channel_message_received',
      actor: `channel:${channel}`,
      payload: {
        channel,
        message_id: message.message_id ?? null,
        chat_id: message.chat_id ?? null,
        sender_open_id: message.sender_open_id ?? null
      }
    })
    await emitHook({
      name: 'channel.message.received',
      sessionId: created.session.id,
      channel,
      actor: `channel:${channel}`,
      payload: {
        message_id: message.message_id ?? null,
        chat_id: message.chat_id ?? null,
        sender_open_id: message.sender_open_id ?? null
      }
    })

    let immediateAck = message.immediate_ack ?? null

    if (
      shouldReply &&
      channel === 'feishu' &&
      feishuGateway &&
      message.message_id &&
      !immediateAck
    ) {
      immediateAck = await sendImmediateFeishuAck({
        messageId: message.message_id
      })
    }

    if (
      shouldReply &&
      channel === 'feishu' &&
      immediateAck
    ) {
      await appendImmediateAckTimelineEvent(created.session.id, immediateAck)
    }

    const progressNotifier = shouldReply
      ? createDelayedFeishuProgressNotifier({
          sessionId: created.session.id,
          channel,
          message
        })
      : {
          async stop() {},
          wasSent() {
            return false
          }
        }

    let planning = null
    let execution = null
    let ackText = `已收到，总管会话 ${created.session.id} 已创建。`

    try {
      const feedbackLearning = await learnOperatorFeedback({
        sessionId: created.session.id,
        channel,
        message
      })
      const feedbackAck = buildFeedbackLearningAck(feedbackLearning)

      if (feedbackAck) {
        ackText = `${ackText}\n${feedbackAck}`
      }

      if (isLightweightPing(message)) {
        ackText = buildLightweightPingReply()
        await completePingSession({
          sessionId: created.session.id,
          replyText: ackText
        })
      } else if (autoPlan && bailianProvider) {
        try {
          planning = await planSession({
            sessionId: created.session.id,
            message
          })
          ackText = `已收到，总管会话 ${created.session.id} 已创建。`

          if (feedbackAck) {
            ackText = `${ackText}\n${feedbackAck}`
          }

          ackText = `${ackText}\n${planning.plan.operator_reply}`

          if (autoExecuteSafeInspect) {
            execution = await managerExecutor.runManagerLoop({
              sessionId: created.session.id,
              currentInput: buildOperatorRequest(message),
              maxSteps: 4
            })

            if (execution.runs.length > 0) {
              const completedLabels = summarizeManagerRuns(execution.runs)
              await sessionStore.appendTimelineEvent(created.session.id, {
                kind: 'manager_loop_completed',
                actor: 'manager:executor',
                payload: {
                  step_count: completedLabels.length,
                  labels: completedLabels
                }
              })
              await sessionStore.appendTimelineEvent(created.session.id, {
                kind: 'manager_safe_loop_completed',
                actor: 'manager:executor',
                payload: {
                  step_count: completedLabels.length,
                  labels: completedLabels
                }
              })
              await emitHook({
                name: 'manager.loop.completed',
                sessionId: created.session.id,
                actor: 'manager:executor',
                payload: {
                  step_count: completedLabels.length,
                  labels: completedLabels,
                  mode: 'safe'
                }
              })

              if (completedLabels.length > 0) {
                ackText = `${ackText}\n已自动推进 ${completedLabels.length} 步：${completedLabels.join('\n')}`
              }

              if (execution.report_text) {
                ackText = `${ackText}\n${execution.report_text}`
              }
            }

            if (execution?.status === 'waiting_approval') {
              const pendingApproval = execution.approvals?.find(
                (approval) => approval.status === 'pending'
              ) ?? null

              ackText = pendingApproval
                ? `${ackText}\n下一步涉及高风险操作，当前等待审批：${pendingApproval.tool_name}`
                : `${ackText}\n下一步涉及高风险操作，当前等待审批。`
              await emitHook({
                name: 'manager.approval.waiting',
                sessionId: created.session.id,
                actor: 'manager:executor',
                payload: {
                  tool_name: pendingApproval?.tool_name ?? null
                }
              })
            }
          }
        } catch (error) {
          await sessionStore.appendTimelineEvent(created.session.id, {
            kind: 'manager_plan_failed',
            actor: 'manager:planner',
            payload: {
              message: error.message
            }
          })
          await sessionStore.updateSessionSummary(
            created.session.id,
            `规划器暂时失败：${error.message}`
          )
          await emitHook({
            name: 'manager.planning.failed',
            sessionId: created.session.id,
            actor: 'manager:planner',
            payload: {
              message: error.message
            }
          })
          ackText = `已收到，总管会话 ${created.session.id} 已创建，但首轮规划失败：${error.message}`

          if (feedbackAck) {
            ackText = `${ackText}\n${feedbackAck}`
          }
        }
      }
    } finally {
      await progressNotifier.stop()
    }

    if (
      shouldReply &&
      channel === 'feishu' &&
      feishuGateway &&
      (message.message_id || message.chat_id)
    ) {
      await deliverFeishuReply({
        sessionId: created.session.id,
        message,
        text: ackText,
        stage: 'final_reply'
      })
    }

    return {
      session_id: created.session.id,
      ack_text: ackText,
      planning,
      execution
    }
  }

  async function startFeishuLoop({
    seedAliyun = true,
    autoReply = true,
    autoPlan = true,
    autoExecuteSafeInspect = true
  } = {}) {
    if (!feishuGateway) {
      throw new Error('Feishu gateway is required to start the Feishu loop')
    }

    const bootstrap = await bootstrapServerBaseline({
      seedAliyun
    })
    const state = await feishuGateway.start({
      immediateReactionEmojiType: autoReply ? buildImmediateFeishuReaction() : null,
      immediateReplyText: autoReply ? buildImmediateFeishuAck() : null,
      onMessage: async (message) => {
        await handleChannelMessage({
          channel: 'feishu',
          message,
          autoReply,
          autoPlan,
          autoExecuteSafeInspect
        })
      }
    })

    return {
      bootstrap,
      channel_state: state
    }
  }

  return {
    bootstrapServerBaseline,
    ensureServerBaseline,
    planSession,
    handleChannelMessage,
    startFeishuLoop
  }
}
