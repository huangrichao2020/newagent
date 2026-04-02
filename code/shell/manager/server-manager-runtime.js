import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { createSessionStore } from '../session/session-store.js'
import { createMemoryStore } from '../memory/memory-store.js'
import {
  extractFeedbackMemoryCandidates,
  prioritizeFeedbackEntries
} from '../memory/feedback-memory.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { buildPromptContract } from '../prompts/prompt-contract.js'
import {
  createRemoteServerManagerProfile,
  getAliyunSeedProjects
} from './remote-server-manager-profile.js'
import {
  buildManagerPlanningPrompt,
  buildManagerPlanningSystemPrompt,
  parseManagerPlanningResponse
} from './manager-planner.js'
import {
  buildManagerQualityReviewPrompt,
  buildManagerQualityReviewSystemPrompt,
  parseManagerQualityReviewResponse
} from './quality-review.js'
import { createManagerExecutor } from './manager-executor.js'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const FEISHU_UNIFIED_CHANNEL_KEY = 'feishu-primary'
const DEFAULT_CONTEXT_COMPACTION_INTERVAL_MS = 5 * 60 * 60 * 1000
const DEFAULT_MAINTENANCE_POLL_INTERVAL_MS = 5 * 60 * 1000
const DEFAULT_FEISHU_APPEND_MERGE_WINDOW_MS = 800
const FEISHU_COMPACTION_LOCK_SUFFIX = '.compaction.lock'
const BACKGROUND_COMPACTION_RECENT_ACTIVITY_MS = 60 * 1000
const MAX_TRANSCRIPT_LINES = 10
const CONFIRMATION_SIGNAL_PATTERN = /^(好|好的|好啊|收到|明白|没问题|可以|行|行的|就这样|就这样吧|按这个来|按这个做|继续|继续吧|yes|perfect|exactly|keepdoingthat)$/u

function listOperatorMessages(message) {
  if (Array.isArray(message?.batch_messages) && message.batch_messages.length > 0) {
    return message.batch_messages
  }

  return message ? [message] : []
}

function buildSingleOperatorRequest(message) {
  if (message?.text) {
    return message.text
  }

  return JSON.stringify(message?.content ?? message?.raw_content ?? {})
}

function buildOperatorTitle(message) {
  const sender = message.sender_open_id ?? message.sender_user_id ?? 'operator'
  return `Remote manager request from ${sender}`
}

function buildOperatorRequest(message) {
  const requests = listOperatorMessages(message)
    .map((item) => buildSingleOperatorRequest(item))
    .filter((item) => String(item ?? '').length > 0)

  if (requests.length > 0) {
    return requests.join('\n')
  }

  return buildSingleOperatorRequest(message)
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

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseIsoTimestamp(value) {
  const parsed = Date.parse(String(value ?? ''))

  return Number.isNaN(parsed) ? null : parsed
}

async function safeReadJson(filePath) {
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function shouldIncludeTranscriptEvent(event, excludeTaskId) {
  if (!event || event.task_id === excludeTaskId) {
    return false
  }

  if (event.kind === 'user_message_added') {
    return Boolean(cleanText(event.payload?.content))
  }

  if (event.kind !== 'assistant_message_added') {
    return false
  }

  return event.payload?.stage === 'final_reply' && Boolean(cleanText(event.payload?.content))
}

function buildTranscriptLines(timeline = [], {
  excludeTaskId = null,
  sinceAt = null,
  maxMessages = MAX_TRANSCRIPT_LINES
} = {}) {
  const sinceTimestamp = sinceAt ? parseIsoTimestamp(sinceAt) : null

  return timeline
    .filter((event) => {
      if (!shouldIncludeTranscriptEvent(event, excludeTaskId)) {
        return false
      }

      if (sinceTimestamp == null) {
        return true
      }

      const eventTimestamp = parseIsoTimestamp(event.at)

      return eventTimestamp == null || eventTimestamp >= sinceTimestamp
    })
    .map((event) => {
      const content = cleanText(event.payload?.content)

      if (!content) {
        return null
      }

      return event.kind === 'user_message_added'
        ? `operator: ${content}`
        : `assistant: ${content}`
    })
    .filter(Boolean)
    .slice(-maxMessages)
}

function normalizeForSignalMatch(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。,.!！?？:：;；'"“”‘’、\-]/gu, '')
}

function isPositiveConfirmationMessage(message) {
  return CONFIRMATION_SIGNAL_PATTERN.test(
    normalizeForSignalMatch(buildOperatorRequest(message))
  )
}

function summarizeConfirmedAssistantReply(content) {
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean)
  const preferred = lines.find((line) =>
    !line.startsWith('已收到')
    && !line.startsWith('我先理解一下')
    && !line.startsWith('我先拆一下')
  )

  return cleanText(preferred ?? lines[0] ?? '').slice(0, 160)
}

function findLatestAssistantFinalReply(timeline = [], excludeTaskId = null) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]

    if (event.task_id === excludeTaskId) {
      continue
    }

    if (
      event.kind === 'assistant_message_added'
      && event.payload?.stage === 'final_reply'
    ) {
      const summary = summarizeConfirmedAssistantReply(event.payload?.content)

      if (summary) {
        return summary
      }
    }
  }

  return null
}

function hasForegroundMemoryWrite(snapshot, {
  taskId = null,
  sinceAt = null
} = {}) {
  const sinceTimestamp = parseIsoTimestamp(sinceAt)

  return snapshot.timeline.some((event) =>
    event.kind === 'memory_written'
    && (taskId == null || event.task_id === taskId)
    && (
      sinceTimestamp == null
      || parseIsoTimestamp(event.at) == null
      || parseIsoTimestamp(event.at) >= sinceTimestamp
    )
  )
}

function isRecentFeishuActivity(channelState, nowTimestamp) {
  const lastMessageTimestamp = parseIsoTimestamp(channelState?.last_message_at)

  if (lastMessageTimestamp == null) {
    return false
  }

  return nowTimestamp - lastMessageTimestamp < BACKGROUND_COMPACTION_RECENT_ACTIVITY_MS
}

function computeMaintenancePollInterval(contextCompactionIntervalMs) {
  if (contextCompactionIntervalMs == null || contextCompactionIntervalMs <= 0) {
    return null
  }

  return Math.max(
    1000,
    Math.min(contextCompactionIntervalMs, DEFAULT_MAINTENANCE_POLL_INTERVAL_MS)
  )
}

function createRecurringTask({
  setTimeoutFn,
  clearTimeoutFn,
  intervalMs,
  runOnce
}) {
  let stopped = false
  let timer = null
  let inFlight = Promise.resolve()

  function scheduleNext() {
    if (stopped) {
      return
    }

    timer = setTimeoutFn(() => {
      if (stopped) {
        return
      }

      inFlight = Promise.resolve()
        .then(() => runOnce())
        .catch(() => {})
        .finally(() => {
          scheduleNext()
        })
    }, intervalMs)

    timer?.unref?.()
  }

  scheduleNext()

  return {
    async stop() {
      stopped = true

      if (timer) {
        clearTimeoutFn(timer)
      }

      await inFlight
    }
  }
}

function buildManagerCompactionSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [
          'You compress persistent Feishu operator conversations into durable long-term memory.'
        ]
      },
      {
        title: 'TASK',
        lines: [
          'Preserve operational continuity for a single long-running manager session.',
          'Carry forward durable facts, open loops, preferences, and the latest working state.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "summary": "one short cumulative memory summary",',
          '  "facts": ["durable fact"],',
          '  "open_loops": ["unfinished follow-up"],',
          '  "preferences": ["operator preference or rule"]',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: [
          'Keep only durable context that should survive future turns.',
          'Prefer operational facts and unfinished work over conversational filler.',
          'If stored memory already exists, update it cumulatively instead of starting over.',
          'Do not invent projects, incidents, or approvals.'
        ]
      }
    ]
  })
}

function buildManagerCompactionPrompt({
  sessionSummary = null,
  storedMemory = null,
  transcriptLines = []
}) {
  const sections = []

  if (sessionSummary) {
    sections.push({
      title: 'CURRENT SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (storedMemory) {
    sections.push({
      title: 'CURRENT STORED MEMORY',
      bullet: false,
      lines: [storedMemory]
    })
  }

  sections.push({
    title: 'NEW TRANSCRIPT TO MERGE',
    lines: transcriptLines.length > 0
      ? transcriptLines
      : ['No new transcript was captured. Preserve the existing durable memory if it is still valid.']
  })

  return buildPromptContract({
    sections
  })
}

function stripCodeFence(text) {
  const fencedMatch = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/i)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  return String(text ?? '').trim()
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text)

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped
  }

  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Compaction response did not contain a JSON object')
  }

  return stripped.slice(firstBrace, lastBrace + 1)
}

function normalizeCompactionItems(items) {
  if (!Array.isArray(items)) {
    return []
  }

  return [...new Set(
    items
      .map((item) => cleanText(item))
      .filter(Boolean)
  )].slice(0, 8)
}

function parseManagerCompactionResponse({ text }) {
  const parsed = JSON.parse(extractJsonObject(text))
  const summary = cleanText(parsed.summary)

  if (!summary) {
    throw new Error('Compaction response did not include a durable summary')
  }

  return {
    summary,
    facts: normalizeCompactionItems(parsed.facts),
    open_loops: normalizeCompactionItems(parsed.open_loops ?? parsed.openLoops),
    preferences: normalizeCompactionItems(parsed.preferences)
  }
}

function formatCompactionMemory(compaction) {
  const lines = [`摘要：${compaction.summary}`]

  if (compaction.facts.length > 0) {
    lines.push('事实：')
    for (const fact of compaction.facts) {
      lines.push(`- ${fact}`)
    }
  }

  if (compaction.open_loops.length > 0) {
    lines.push('待继续：')
    for (const item of compaction.open_loops) {
      lines.push(`- ${item}`)
    }
  }

  if (compaction.preferences.length > 0) {
    lines.push('偏好：')
    for (const item of compaction.preferences) {
      lines.push(`- ${item}`)
    }
  }

  return lines.join('\n')
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
  contextCompactionIntervalMs = DEFAULT_CONTEXT_COMPACTION_INTERVAL_MS,
  feishuAppendMergeWindowMs = DEFAULT_FEISHU_APPEND_MERGE_WINDOW_MS,
  nowFn = Date.now,
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
    fetchFn,
    executionProvider: bailianProvider,
    managerProfile
  })
  const feishuInboundQueue = {
    pending: [],
    lastEnqueuedAtMs: null,
    drainPromise: null
  }

  function nowIso() {
    return new Date(nowFn()).toISOString()
  }

  function waitForMs(durationMs) {
    if (durationMs == null || durationMs <= 0) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const timer = setTimeoutFn(resolve, durationMs)
      timer?.unref?.()
    })
  }

  function buildFeishuMergeKey(message) {
    return [
      message?.chat_id ?? '',
      message?.sender_open_id ?? message?.sender_user_id ?? ''
    ].join(':')
  }

  function findLatestImmediateAck(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const immediateAck = messages[index]?.immediate_ack

      if (immediateAck) {
        return immediateAck
      }
    }

    return null
  }

  function buildMergedFeishuMessage(messages = []) {
    const normalizedMessages = messages.filter(Boolean)
    const lastMessage = normalizedMessages.at(-1) ?? {}

    return {
      ...lastMessage,
      immediate_ack: findLatestImmediateAck(normalizedMessages),
      batch_messages: normalizedMessages
    }
  }

  async function waitForFeishuQuietWindow(queueState) {
    if (feishuAppendMergeWindowMs == null || feishuAppendMergeWindowMs <= 0) {
      return
    }

    while (queueState.pending.length > 0) {
      const lastEnqueuedAtMs = queueState.lastEnqueuedAtMs

      if (lastEnqueuedAtMs == null) {
        return
      }

      const remainingMs = feishuAppendMergeWindowMs - (Date.now() - lastEnqueuedAtMs)

      if (remainingMs <= 0) {
        return
      }

      await waitForMs(remainingMs)
    }
  }

  function takeNextFeishuBatch(queueState) {
    if (queueState.pending.length === 0) {
      return []
    }

    const nextMergeKey = buildFeishuMergeKey(queueState.pending[0].message)
    let batchLength = 1

    while (
      batchLength < queueState.pending.length
      && buildFeishuMergeKey(queueState.pending[batchLength].message) === nextMergeKey
    ) {
      batchLength += 1
    }

    return queueState.pending.splice(0, batchLength)
  }

  async function drainFeishuInboundQueue() {
    while (feishuInboundQueue.pending.length > 0) {
      await waitForFeishuQuietWindow(feishuInboundQueue)

      const batchEntries = takeNextFeishuBatch(feishuInboundQueue)

      if (batchEntries.length === 0) {
        continue
      }

      const lastEntry = batchEntries.at(-1)

      try {
        const result = await handleChannelMessage({
          channel: 'feishu',
          message: buildMergedFeishuMessage(batchEntries.map((entry) => entry.message)),
          autoReply: lastEntry.options.autoReply,
          autoPlan: lastEntry.options.autoPlan,
          autoExecuteSafeInspect: lastEntry.options.autoExecuteSafeInspect
        })

        for (const entry of batchEntries) {
          entry.resolve(result)
        }
      } catch (error) {
        for (const entry of batchEntries) {
          entry.reject(error)
        }
      }
    }
  }

  function ensureFeishuInboundQueueDrain() {
    if (feishuInboundQueue.drainPromise) {
      return feishuInboundQueue.drainPromise
    }

    feishuInboundQueue.drainPromise = Promise.resolve()
      .then(() => drainFeishuInboundQueue())
      .finally(() => {
        feishuInboundQueue.drainPromise = null

        if (feishuInboundQueue.pending.length > 0) {
          ensureFeishuInboundQueueDrain()
        }
      })

    return feishuInboundQueue.drainPromise
  }

  function enqueueFeishuMessage(entry) {
    feishuInboundQueue.pending.push(entry)
    feishuInboundQueue.lastEnqueuedAtMs = Date.now()
    ensureFeishuInboundQueueDrain()
  }

  function getChannelStateFile(channelKey) {
    return join(storageRoot, 'channels', `${channelKey}.json`)
  }

  async function loadChannelState(channelKey) {
    return safeReadJson(getChannelStateFile(channelKey))
  }

  async function writeChannelState(channelKey, state) {
    await writeJsonAtomic(getChannelStateFile(channelKey), state)
    return state
  }

  function getCompactionLockPath(channelKey) {
    return join(storageRoot, 'channels', `${channelKey}${FEISHU_COMPACTION_LOCK_SUFFIX}`)
  }

  async function tryAcquireCompactionLock(channelKey) {
    try {
      await mkdir(getCompactionLockPath(channelKey))
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') {
        return false
      }

      throw error
    }
  }

  async function releaseCompactionLock(channelKey) {
    await rm(getCompactionLockPath(channelKey), {
      recursive: true,
      force: true
    })
  }

  async function reviewWithExternalModel({
    sessionId,
    mode,
    operatorRequest = null,
    sessionSummary = null,
    recentTranscript = [],
    plan = null,
    compaction = null
  }) {
    if (!managerProfile.external_review?.enabled || !bailianProvider) {
      return null
    }

    try {
      const providerResult = await bailianProvider.invokeByIntent({
        intent: 'evaluate',
        systemPrompt: buildManagerQualityReviewSystemPrompt(),
        prompt: buildManagerQualityReviewPrompt({
          mode,
          operatorRequest,
          sessionSummary,
          recentTranscript,
          plan,
          compaction
        })
      })
      const review = parseManagerQualityReviewResponse({
        text: providerResult.response.content ?? ''
      })

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'external_quality_review_completed',
        actor: 'manager:reviewer',
        payload: {
          mode,
          verdict: review.verdict,
          issue_count: review.issues.length,
          constraint_count: review.constraints.length,
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null
        },
        at: nowIso()
      })
      await emitHook({
        name: 'manager.quality_review.completed',
        sessionId,
        actor: 'manager:reviewer',
        payload: {
          mode,
          verdict: review.verdict,
          issue_count: review.issues.length,
          constraint_count: review.constraints.length,
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null
        }
      })

      for (const constraint of review.constraints) {
        await memoryStore.addMemoryEntry({
          sessionId,
          scope: 'session',
          kind: 'constraint',
          content: constraint,
          tags: ['external_review', 'quality_constraint', mode]
        })
      }

      return {
        ...review,
        provider_result: {
          route: providerResult.route,
          request: providerResult.request
        }
      }
    } catch (error) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'external_quality_review_failed',
        actor: 'manager:reviewer',
        payload: {
          mode,
          message: error.message
        },
        at: nowIso()
      })
      await emitHook({
        name: 'manager.quality_review.failed',
        sessionId,
        actor: 'manager:reviewer',
        payload: {
          mode,
          message: error.message
        }
      })

      return {
        verdict: 'warn',
        summary: `外部复核未完成：${error.message}`,
        issues: [error.message],
        constraints: [],
        failed: true
      }
    }
  }

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

  async function ensureFeishuUnifiedSessionTurn(message) {
    const currentAt = nowIso()
    const existingState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    const title = buildOperatorTitle(message)
    const userRequest = buildOperatorRequest(message)

    if (existingState?.session_id) {
      try {
        const continued = await sessionStore.startNextTurn(existingState.session_id, {
          title,
          userRequest,
          startedAt: currentAt
        })
        const nextState = await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...existingState,
          channel: 'feishu',
          session_id: continued.session.id,
          updated_at: currentAt,
          last_message_at: currentAt,
          version: 1
        })

        return {
          kind: 'continued',
          snapshot: continued,
          channel_state: nextState
        }
      } catch (error) {
        await emitHook({
          name: 'channel.session.recovered',
          sessionId: existingState.session_id,
          channel: 'feishu',
          actor: 'manager:runtime',
          payload: {
            channel_key: FEISHU_UNIFIED_CHANNEL_KEY,
            message: error.message
          }
        })
      }
    }

    const created = await sessionStore.createSession({
      title,
      projectKey: 'remote-server-manager',
      userRequest,
      summary: 'Received feishu operator request'
    })
    const nextState = await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
      channel: 'feishu',
      session_id: created.session.id,
      created_at: currentAt,
      updated_at: currentAt,
      last_message_at: currentAt,
      last_compacted_at: currentAt,
      version: 1
    })

    return {
      kind: 'created',
      snapshot: created,
      channel_state: nextState
    }
  }

  async function maybeCompactFeishuContext({
    sessionId,
    currentTaskId = null
  }) {
    if (!bailianProvider || contextCompactionIntervalMs == null || contextCompactionIntervalMs <= 0) {
      return null
    }

    const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)

    if (!channelState?.session_id || channelState.session_id !== sessionId) {
      return null
    }

    const lastCompactedAt = channelState.last_compacted_at ?? channelState.created_at ?? null
    const lastCompactedMs = parseIsoTimestamp(lastCompactedAt)

    if (lastCompactedMs != null && nowFn() - lastCompactedMs < contextCompactionIntervalMs) {
      return null
    }

    const acquired = await tryAcquireCompactionLock(FEISHU_UNIFIED_CHANNEL_KEY)

    if (!acquired) {
      const currentAt = nowIso()

      await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
        ...channelState,
        updated_at: currentAt,
        pending_compaction: true,
        pending_compaction_at: currentAt,
        version: 1
      })
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'conversation_compaction_deferred',
        actor: 'manager:memory',
        payload: {
          reason: 'compaction_already_running'
        },
        at: currentAt
      })

      return {
        status: 'deferred',
        reason: 'compaction_already_running'
      }
    }

    async function compactOnce({ force = false } = {}) {
      const latestChannelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
      const latestCompactedAt = latestChannelState?.last_compacted_at ?? lastCompactedAt
      const snapshot = await sessionStore.loadSession(sessionId)

      const skipForForegroundMemory = currentTaskId
        ? hasForegroundMemoryWrite(snapshot, {
            taskId: currentTaskId
          })
        : hasForegroundMemoryWrite(snapshot, {
            sinceAt: latestCompactedAt
          })

      if (!force && skipForForegroundMemory) {
        const currentAt = nowIso()
        const reason = currentTaskId
          ? 'foreground_memory_written'
          : 'foreground_memory_written_since_last_compaction'

        await sessionStore.appendTimelineEvent(sessionId, {
          kind: 'conversation_compaction_skipped',
          actor: 'manager:memory',
          payload: {
            reason
          },
          at: currentAt
        })
        await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...latestChannelState,
          updated_at: currentAt,
          last_compacted_at: currentAt,
          pending_compaction: false,
          pending_compaction_at: null,
          version: 1
        })

        return {
          status: 'skipped',
          reason
        }
      }

      const transcriptLines = buildTranscriptLines(snapshot.timeline, {
        excludeTaskId: currentTaskId,
        sinceAt: latestCompactedAt,
        maxMessages: 24
      })
      const storedCompactions = await memoryStore.searchMemoryEntries({
        sessionId,
        scope: 'session',
        tag: 'context_compaction'
      })
      const latestStoredMemory = storedCompactions.at(-1)?.content ?? null

      if (transcriptLines.length === 0 && latestStoredMemory) {
        const currentAt = nowIso()

        await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...latestChannelState,
          updated_at: currentAt,
          last_compacted_at: currentAt,
          pending_compaction: false,
          pending_compaction_at: null,
          version: 1
        })

        return {
          status: 'noop',
          reason: 'no_new_transcript'
        }
      }

      const providerResult = await bailianProvider.invokeByIntent({
        intent: 'summarize',
        systemPrompt: buildManagerCompactionSystemPrompt(),
        prompt: buildManagerCompactionPrompt({
          sessionSummary: snapshot.session.summary ?? null,
          storedMemory: latestStoredMemory,
          transcriptLines
        })
      })
      const compaction = parseManagerCompactionResponse({
        text: providerResult.response.content ?? ''
      })
      const review = await reviewWithExternalModel({
        sessionId,
        mode: 'compaction_review',
        operatorRequest: transcriptLines
          .filter((line) => line.startsWith('operator: '))
          .map((line) => line.slice('operator: '.length))
          .join('\n') || null,
        sessionSummary: snapshot.session.summary ?? null,
        recentTranscript: transcriptLines.slice(-MAX_TRANSCRIPT_LINES),
        compaction
      })
      const shouldKeepCompaction =
        !review || review.verdict !== 'block' || !managerProfile.external_review?.enforcing

      if (!shouldKeepCompaction) {
        const currentAt = nowIso()

        await sessionStore.appendTimelineEvent(sessionId, {
          kind: 'conversation_compaction_blocked',
          actor: 'manager:reviewer',
          payload: {
            summary: review.summary,
            issues: review.issues
          },
          at: currentAt
        })
        await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...latestChannelState,
          updated_at: currentAt,
          last_compacted_at: currentAt,
          pending_compaction: false,
          pending_compaction_at: null,
          version: 1
        })

        return {
          status: 'blocked',
          review
        }
      }

      const memoryEntry = await memoryStore.addMemoryEntry({
        sessionId,
        scope: 'session',
        kind: 'conversation_summary',
        content: formatCompactionMemory(compaction),
        tags: ['context_compaction', 'long_term_memory', 'feishu']
      })
      const currentAt = nowIso()

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'conversation_compacted',
        actor: 'manager:memory',
        payload: {
          memory_id: memoryEntry.id,
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
          review_verdict: review?.verdict ?? null
        },
        at: currentAt
      })
      await emitHook({
        name: 'manager.context.compacted',
        sessionId,
        channel: 'feishu',
        actor: 'manager:memory',
        payload: {
          memory_id: memoryEntry.id,
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
          review_verdict: review?.verdict ?? null
        }
      })
      await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
        ...latestChannelState,
        updated_at: currentAt,
        last_compacted_at: currentAt,
        pending_compaction: false,
        pending_compaction_at: null,
        version: 1
      })

      return {
        status: 'compacted',
        memory_entry_id: memoryEntry.id,
        review,
        provider_result: {
          route: providerResult.route,
          request: providerResult.request
        }
      }
    }

    try {
      const result = await compactOnce()
      const stateAfter = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)

      if (stateAfter?.pending_compaction) {
        await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...stateAfter,
          pending_compaction: false,
          pending_compaction_at: null,
          updated_at: nowIso(),
          version: 1
        })
        const trailing = await compactOnce({
          force: true
        })

        return {
          ...result,
          trailing
        }
      }

      return result
    } catch (error) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'conversation_compaction_failed',
        actor: 'manager:memory',
        payload: {
          message: error.message
        },
        at: nowIso()
      })
      await emitHook({
        name: 'manager.context.compaction_failed',
        sessionId,
        channel: 'feishu',
        actor: 'manager:memory',
        payload: {
          message: error.message
        }
      })

      return {
        status: 'failed',
        error: error.message
      }
    } finally {
      await releaseCompactionLock(FEISHU_UNIFIED_CHANNEL_KEY)
    }
  }

  async function runFeishuMaintenanceOnce() {
    const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    const nowTimestamp = nowFn()

    if (!channelState?.session_id) {
      return {
        status: 'idle'
      }
    }

    if (isRecentFeishuActivity(channelState, nowTimestamp)) {
      return {
        status: 'recent_activity'
      }
    }

    const lastCompactedAt = channelState.last_compacted_at ?? channelState.created_at ?? null
    const lastCompactedMs = parseIsoTimestamp(lastCompactedAt)
    const isDue = lastCompactedMs == null
      || nowTimestamp - lastCompactedMs >= contextCompactionIntervalMs

    if (!isDue && !channelState.pending_compaction) {
      return {
        status: 'not_due'
      }
    }

    return maybeCompactFeishuContext({
      sessionId: channelState.session_id
    })
  }

  function startFeishuMaintenanceLoop() {
    const pollIntervalMs = computeMaintenancePollInterval(contextCompactionIntervalMs)

    if (pollIntervalMs == null) {
      return {
        started: false,
        poll_interval_ms: null,
        async stop() {}
      }
    }

    const recurringTask = createRecurringTask({
      setTimeoutFn,
      clearTimeoutFn,
      intervalMs: pollIntervalMs,
      runOnce: runFeishuMaintenanceOnce
    })

    return {
      started: true,
      poll_interval_ms: pollIntervalMs,
      stop: recurringTask.stop
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
    const snapshot = await sessionStore.loadSession(sessionId)
    const feedbackRules = await memoryStore.searchMemoryEntries({
      sessionId,
      scope: 'project',
      tag: 'feedback_rule'
    })
    const confirmationSignals = await memoryStore.searchMemoryEntries({
      sessionId,
      scope: 'project',
      tag: 'confirmation_signal'
    })
    const operatorRules = prioritizeFeedbackEntries([
      ...feedbackRules,
      ...confirmationSignals
    ]).slice(0, 6)
    const longTermMemory = (
      await memoryStore.searchMemoryEntries({
        sessionId,
        scope: 'session',
        tag: 'context_compaction'
      })
    )
      .slice(-1)
      .map((entry) => entry.content)
    const recentTranscript = buildTranscriptLines(snapshot.timeline, {
      excludeTaskId: snapshot.task.id,
      maxMessages: 10
    })
    await emitHook({
      name: 'manager.planning.started',
      sessionId,
      actor: 'manager:planner',
      payload: {
        available_project_count: projects.length,
        operator_rule_count: operatorRules.length,
        long_term_memory_count: longTermMemory.length,
        transcript_line_count: recentTranscript.length
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
        operatorRules,
        sessionSummary: snapshot.session.summary ?? null,
        longTermMemory,
        recentTranscript
      })
    })
    const plan = parseManagerPlanningResponse({
      text: providerResult.response.content ?? '',
      availableProjects: projects
    })
    const review = await reviewWithExternalModel({
      sessionId,
      mode: 'plan_review',
      operatorRequest: buildOperatorRequest(message),
      sessionSummary: snapshot.session.summary ?? null,
      recentTranscript,
      plan
    })

    if (review?.issues?.length > 0) {
      plan.operator_reply = `${plan.operator_reply}\n外部复核提示：${review.issues.join('；')}`
    }

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
        provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
        review_verdict: review?.verdict ?? null
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
        provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
        review_verdict: review?.verdict ?? null
      }
    })

    return {
      plan,
      review,
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
    const snapshot = await sessionStore.loadSession(sessionId)
    const candidates = extractFeedbackMemoryCandidates({
      channel,
      messageText: buildOperatorRequest(message)
    })
    const confirmedReply = isPositiveConfirmationMessage(message)
      ? findLatestAssistantFinalReply(snapshot.timeline, snapshot.task.id)
      : null

    if (confirmedReply) {
      candidates.push({
        kind: 'decision',
        content: `用户确认上一轮有效做法可继续沿用：${confirmedReply}`,
        tags: ['feedback', 'feedback_rule', 'confirmation_signal', channel]
      })
    }

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
      const existingTags = [...new Set(candidate.tags ?? [])]
      const matchedEntries = []

      for (const tag of existingTags) {
        const matches = await memoryStore.searchMemoryEntries({
          sessionId,
          scope: 'project',
          query: candidate.content,
          tag
        })

        matchedEntries.push(...matches)
      }

      const existingMatches = matchedEntries.length > 0
        ? matchedEntries
        : await memoryStore.searchMemoryEntries({
            sessionId,
            scope: 'project',
            query: candidate.content
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

    const activeTurn = channel === 'feishu'
      ? await ensureFeishuUnifiedSessionTurn(message)
      : {
          kind: 'created',
          snapshot: await sessionStore.createSession({
            title: buildOperatorTitle(message),
            projectKey: 'remote-server-manager',
            userRequest: buildOperatorRequest(message),
            summary: `Received ${channel} operator request`
          }),
          channel_state: null
        }
    const sessionId = activeTurn.snapshot.session.id
    const channelMessages = listOperatorMessages(message)

    for (const [index, channelMessage] of channelMessages.entries()) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'channel_message_received',
        actor: `channel:${channel}`,
        payload: {
          channel,
          message_id: channelMessage.message_id ?? null,
          chat_id: channelMessage.chat_id ?? null,
          sender_open_id: channelMessage.sender_open_id ?? null,
          batch_index: index + 1,
          batch_size: channelMessages.length
        }
      })
    }
    await emitHook({
      name: 'channel.message.received',
      sessionId,
      channel,
      actor: `channel:${channel}`,
      payload: {
        message_id: message.message_id ?? null,
        chat_id: message.chat_id ?? null,
        sender_open_id: message.sender_open_id ?? null,
        batch_size: channelMessages.length
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
      await appendImmediateAckTimelineEvent(sessionId, immediateAck)
    }

    const progressNotifier = shouldReply
      ? createDelayedFeishuProgressNotifier({
          sessionId,
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
    let ackText = activeTurn.kind === 'continued'
      ? `已收到，继续沿用总管会话 ${sessionId}。`
      : `已收到，总管会话 ${sessionId} 已创建。`

    try {
      const feedbackLearning = await learnOperatorFeedback({
        sessionId,
        channel,
        message
      })
      const feedbackAck = buildFeedbackLearningAck(feedbackLearning)

      if (feedbackAck) {
        ackText = `${ackText}\n${feedbackAck}`
      }

      if (channel === 'feishu') {
        await maybeCompactFeishuContext({
          sessionId,
          currentTaskId: activeTurn.snapshot.task.id
        })
      }

      if (isLightweightPing(message)) {
        ackText = buildLightweightPingReply()
        await completePingSession({
          sessionId,
          replyText: ackText
        })
      } else if (autoPlan && bailianProvider) {
        try {
          planning = await planSession({
            sessionId,
            message
          })
          ackText = activeTurn.kind === 'continued'
            ? `已收到，继续沿用总管会话 ${sessionId}。`
            : `已收到，总管会话 ${sessionId} 已创建。`

          if (feedbackAck) {
            ackText = `${ackText}\n${feedbackAck}`
          }

          ackText = `${ackText}\n${planning.plan.operator_reply}`

          const allowAutoExecute = autoExecuteSafeInspect && planning.review?.verdict !== 'block'

          if (!allowAutoExecute && planning.review?.verdict === 'block') {
            ackText = `${ackText}\n外部复核要求先人工确认，本轮暂不自动推进。`
          }

          if (allowAutoExecute) {
            execution = await managerExecutor.runManagerLoop({
              sessionId,
              currentInput: buildOperatorRequest(message),
              maxSteps: 4
            })

            if (execution.runs.length > 0) {
              const completedLabels = summarizeManagerRuns(execution.runs)
              await sessionStore.appendTimelineEvent(sessionId, {
                kind: 'manager_loop_completed',
                actor: 'manager:executor',
                payload: {
                  step_count: completedLabels.length,
                  labels: completedLabels
                }
              })
              await sessionStore.appendTimelineEvent(sessionId, {
                kind: 'manager_safe_loop_completed',
                actor: 'manager:executor',
                payload: {
                  step_count: completedLabels.length,
                  labels: completedLabels
                }
              })
              await emitHook({
                name: 'manager.loop.completed',
                sessionId,
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
                sessionId,
                actor: 'manager:executor',
                payload: {
                  tool_name: pendingApproval?.tool_name ?? null
                }
              })
            }

            if (execution?.status === 'deferred') {
              const deferredSummary = execution.runs
                .map((run) => run.summary ?? run.selection?.reason ?? null)
                .filter(Boolean)
                .at(-1)

              if (deferredSummary) {
                ackText = `${ackText}\n已暂缓：${deferredSummary}`
              }
            }
          }
        } catch (error) {
          await sessionStore.appendTimelineEvent(sessionId, {
            kind: 'manager_plan_failed',
            actor: 'manager:planner',
            payload: {
              message: error.message
            }
          })
          await sessionStore.updateSessionSummary(
            sessionId,
            `规划器暂时失败：${error.message}`
          )
          await emitHook({
            name: 'manager.planning.failed',
            sessionId,
            actor: 'manager:planner',
            payload: {
              message: error.message
            }
          })
          ackText = activeTurn.kind === 'continued'
            ? `已收到，继续沿用总管会话 ${sessionId}，但本轮规划失败：${error.message}`
            : `已收到，总管会话 ${sessionId} 已创建，但首轮规划失败：${error.message}`

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
        sessionId,
        message,
        text: ackText,
        stage: 'final_reply'
      })
    }

    return {
      session_id: sessionId,
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
        return new Promise((resolve, reject) => {
          enqueueFeishuMessage({
            message,
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
      bootstrap,
      channel_state: state,
      maintenance_state: {
        started: maintenance.started,
        poll_interval_ms: maintenance.poll_interval_ms
      }
    }
  }

  return {
    bootstrapServerBaseline,
    ensureServerBaseline,
    planSession,
    handleChannelMessage,
    runFeishuMaintenanceOnce,
    startFeishuLoop
  }
}
