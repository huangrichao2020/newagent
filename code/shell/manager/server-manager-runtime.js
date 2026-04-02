import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { createSessionStore, createUlid } from '../session/session-store.js'
import { createMemoryStore } from '../memory/memory-store.js'
import {
  extractFeedbackMemoryCandidates,
  prioritizeFeedbackEntries
} from '../memory/feedback-memory.js'
import { createCoworkerStore } from '../coworkers/coworker-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createInfrastructureRegistry } from '../registry/infrastructure-registry.js'
import { buildPromptContract } from '../prompts/prompt-contract.js'
import {
  createRemoteServerManagerProfile,
  getAliyunInfrastructureRegistry,
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
const DEFAULT_FEISHU_RESPONSE_MODE = 'balanced'
const DEFAULT_FEISHU_LONG_RUNNING_FEEDBACK_MS = 30 * 1000
const DEFAULT_FEISHU_TIMEOUT_CHECKPOINT_MS = 3 * 60 * 1000
const DEFAULT_FEISHU_EXTENSION_RESPONSE_TIMEOUT_MS = 10 * 1000
const DEFAULT_FEISHU_FINAL_TIMEOUT_MS = 6 * 60 * 1000
const DEFAULT_BACKGROUND_PRECOMPUTE_INTERVAL_MS = 3 * 60 * 1000
const DEFAULT_BACKGROUND_PRECOMPUTE_TRIGGER_DELAY_MS = 150
const DEFAULT_CODEX_COWORKER_TARGET = 'codex_mac_local'
const DEFAULT_CODEX_COWORKER_LOCATION = 'mac_local_codex'
const FEISHU_COMPACTION_LOCK_SUFFIX = '.compaction.lock'
const BACKGROUND_COMPACTION_RECENT_ACTIVITY_MS = 60 * 1000
const MAX_TRANSCRIPT_LINES = 10
const CONFIRMATION_SIGNAL_PATTERN = /^(好|好的|好啊|收到|明白|没问题|可以|行|行的|就这样|就这样吧|按这个来|按这个做|继续|继续吧|yes|perfect|exactly|keepdoingthat)$/u
const NEGATIVE_CONFIRMATION_SIGNAL_PATTERN = /^(不|不用|先别|别继续|暂停|先暂停|停|停止|stop|no|不用继续|先停下|先别继续|不要继续)$/u

const DEFAULT_FEISHU_OPERATOR_PROFILE = Object.freeze({
  response_mode: DEFAULT_FEISHU_RESPONSE_MODE,
  enable_markdown: true,
  show_command_hints: true
})

const FEISHU_STATUS_REACTIONS = Object.freeze({
  received: 'SMILE',
  queued: 'SMILE',
  processing: 'SMILE',
  completed: 'SMILE',
  failed: 'SMILE',
  stopped: 'SMILE'
})

class FeishuRunStoppedError extends Error {
  constructor(stage = 'operator_stop_requested') {
    super(`Feishu run stopped: ${stage}`)
    this.name = 'FeishuRunStoppedError'
    this.stage = stage
  }
}

function listOperatorMessages(message) {
  if (Array.isArray(message?.batch_messages) && message.batch_messages.length > 0) {
    return message.batch_messages
  }

  return message ? [message] : []
}

function uniqueStringValues(values = []) {
  return [...new Set(
    values
      .map((value) => (value == null ? null : String(value).trim()))
      .filter(Boolean)
  )]
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

function collectReferencedMessageIds(message) {
  return uniqueStringValues(
    listOperatorMessages(message).flatMap((item) => [
      item?.parent_message_id,
      item?.root_message_id,
      ...(Array.isArray(item?.referenced_message_ids) ? item.referenced_message_ids : [])
    ])
  )
}

function buildFeishuUserMessageMeta(message) {
  const messages = listOperatorMessages(message)
  const lastMessage = messages.at(-1) ?? {}

  return {
    channel: 'feishu',
    message_id: lastMessage.message_id ?? null,
    message_ids: uniqueStringValues(messages.map((item) => item?.message_id)),
    chat_id: lastMessage.chat_id ?? null,
    sender_open_id: lastMessage.sender_open_id ?? lastMessage.sender_user_id ?? null,
    referenced_message_ids: collectReferencedMessageIds(message),
    parent_message_id: lastMessage.parent_message_id ?? null,
    root_message_id: lastMessage.root_message_id ?? null,
    batch_size: messages.length
  }
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

function cleanMultilineText(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function normalizeFeishuResponseMode(value) {
  const normalized = cleanText(value).toLowerCase()

  if (normalized === 'fast' || normalized === 'thinking' || normalized === 'balanced') {
    return normalized
  }

  return DEFAULT_FEISHU_RESPONSE_MODE
}

function normalizeFeishuOperatorProfile(value = {}) {
  return {
    response_mode: normalizeFeishuResponseMode(value.response_mode),
    enable_markdown: value.enable_markdown !== false,
    show_command_hints: value.show_command_hints !== false
  }
}

function buildFeishuCommandHintText() {
  return '/fast 简短回复 | /thinking 持续反馈 | /appendmsg 内容 追加建议 | /stop 安全停止 | /stopnow 立即终止命令 | /status 当前状态'
}

function buildFeishuCommandHintMarkdown() {
  return '`/fast` 简短回复  `/thinking` 持续反馈  `/appendmsg 内容` 追加建议  `/stop` 安全停止  `/stopnow` 立即终止命令  `/status` 当前状态'
}

function buildFeishuResponseModeLabel(mode) {
  if (mode === 'fast') {
    return 'fast / 快回'
  }

  if (mode === 'thinking') {
    return 'thinking / 持续反馈'
  }

  return 'balanced / 常规'
}

function compactMultilineText(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join('；')
}

function findTimelineMessageById(timeline = [], messageId, {
  excludeTaskId = null
} = {}) {
  const normalizedMessageId = cleanText(messageId)

  if (!normalizedMessageId) {
    return null
  }

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const event = timeline[index]

    if (!event || event.task_id === excludeTaskId) {
      continue
    }

    if (!['assistant_message_added', 'assistant_message_updated', 'user_message_added'].includes(event.kind)) {
      continue
    }

    const payload = event.payload ?? {}
    const messageIds = uniqueStringValues([
      payload.message_id,
      ...(Array.isArray(payload.message_ids) ? payload.message_ids : [])
    ])

    if (!messageIds.includes(normalizedMessageId)) {
      continue
    }

    const content = cleanMultilineText(payload.content)

    if (!content) {
      continue
    }

    return {
      message_id: normalizedMessageId,
      role: event.kind === 'user_message_added' ? 'operator' : 'assistant',
      content,
      stage: payload.stage ?? null,
      at: event.at ?? null,
      task_id: event.task_id ?? null
    }
  }

  return null
}

function buildFeishuAttentionContext({
  message,
  snapshot
}) {
  const currentMessage = buildOperatorRequest(message)
  const referencedMessageIds = collectReferencedMessageIds(message)
  const referencedMessages = referencedMessageIds
    .map((messageId) => findTimelineMessageById(snapshot.timeline, messageId, {
      excludeTaskId: snapshot.task.id
    }))
    .filter(Boolean)
  const primaryReference = referencedMessages.find((entry) => entry.role === 'assistant')
    ?? referencedMessages[0]
    ?? null

  return {
    current_message: currentMessage,
    relation: primaryReference ? `reply_to_${primaryReference.role}` : 'new_message',
    referenced_message_ids: referencedMessageIds,
    referenced_messages: referencedMessages,
    primary_reference: primaryReference
  }
}

function buildAttentionStackLines(attentionContext) {
  const lines = [
    'highest_priority: 当前这条 operator 消息',
    attentionContext.primary_reference
      ? `secondary_priority: 正在回复的既有消息 [${attentionContext.primary_reference.role}] ${compactMultilineText(attentionContext.primary_reference.content)}`
      : 'secondary_priority: 无显式引用消息，本轮按当前消息单独理解',
    'lower_priority: 旧的 assistant 回复、最近转录、长期记忆都只是辅助，不要盖过当前消息'
  ]

  if (attentionContext.referenced_message_ids.length > 0) {
    lines.push(`referenced_message_ids: ${attentionContext.referenced_message_ids.join('、')}`)
  }

  return lines
}

function normalizeWorkingNoteList(values = []) {
  return uniqueStringValues(
    Array.isArray(values)
      ? values.map((value) => cleanMultilineText(value))
      : []
  ).slice(-6)
}

function normalizeFeishuWorkingNote(value = {}) {
  return {
    primary_request: cleanMultilineText(value?.primary_request),
    current_focus: cleanMultilineText(value?.current_focus),
    appended_requests: normalizeWorkingNoteList(value?.appended_requests),
    follow_up_questions: normalizeWorkingNoteList(value?.follow_up_questions),
    latest_message: cleanMultilineText(value?.latest_message),
    updated_at: cleanString(value?.updated_at)
  }
}

function classifyFeishuWorkingNoteMessage(message) {
  const request = cleanText(buildOperatorRequest(message))

  if (!request) {
    return 'empty'
  }

  if (request.startsWith('补充建议：') || message?.continuation_hint === 'auto_append') {
    return 'append'
  }

  if (
    collectReferencedMessageIds(message).length > 0
    || looksLikeFeishuSelfReflectionQuestion(request)
    || looksLikeFeishuMetaFollowUp(request)
    || /[?？]$/.test(request)
  ) {
    return 'follow_up'
  }

  return 'fresh'
}

function mergeFeishuWorkingNote(existingNote, message, nowAt) {
  const request = cleanMultilineText(buildOperatorRequest(message))

  if (!request) {
    return normalizeFeishuWorkingNote(existingNote)
  }

  const base = normalizeFeishuWorkingNote(existingNote)
  const classification = classifyFeishuWorkingNoteMessage(message)

  if (classification === 'append') {
    return {
      primary_request: base.primary_request || base.current_focus || request,
      current_focus: request,
      appended_requests: normalizeWorkingNoteList([
        ...base.appended_requests,
        request
      ]),
      follow_up_questions: base.follow_up_questions,
      latest_message: request,
      updated_at: nowAt
    }
  }

  if (classification === 'follow_up') {
    return {
      primary_request: base.primary_request || request,
      current_focus: request,
      appended_requests: base.appended_requests,
      follow_up_questions: normalizeWorkingNoteList([
        ...base.follow_up_questions,
        request
      ]),
      latest_message: request,
      updated_at: nowAt
    }
  }

  return {
    primary_request: request,
    current_focus: request,
    appended_requests: [],
    follow_up_questions: [],
    latest_message: request,
    updated_at: nowAt
  }
}

function summarizePlanStepsForReply(steps = []) {
  return steps
    .map((step, index) => `${index + 1}. ${compactMultilineText(step.title)}`)
    .filter(Boolean)
}

function summarizeExecutionRunsForReply(runs = []) {
  return runs
    .map((run, index) => {
      const summary = compactMultilineText(run.summary ?? run.report_text ?? run.selection?.reason ?? '')

      if (!summary) {
        return null
      }

      return `${index + 1}. ${summary}`
    })
    .filter(Boolean)
}

function formatElapsedDuration(durationMs) {
  const totalSeconds = Math.max(1, Math.ceil((durationMs ?? 0) / 1000))

  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (seconds === 0) {
    return `${minutes} 分钟`
  }

  return `${minutes} 分 ${seconds} 秒`
}

function isComplexFeishuReply({
  operatorProfile,
  message,
  planning,
  execution
}) {
  if (operatorProfile.response_mode === 'thinking') {
    return true
  }

  if (operatorProfile.response_mode === 'fast') {
    return false
  }

  if ((planning?.plan?.steps?.length ?? 0) >= 2) {
    return true
  }

  if ((execution?.runs?.length ?? 0) >= 2) {
    return true
  }

  return buildOperatorRequest(message).length >= 24
}

function parseFeishuControlCommand(message) {
  const text = cleanText(message?.text)

  if (!text.startsWith('/')) {
    return null
  }

  const [, commandToken = '', rawArgument = ''] = text.match(/^\/([a-zA-Z]+)([\s\S]*)$/u) ?? []
  const command = cleanText(commandToken).toLowerCase()
  const argument = cleanText(rawArgument)

  if (!command) {
    return null
  }

  return {
    command,
    argument
  }
}

function buildFeishuAppendSuggestion(argument) {
  return `补充建议：${argument}`
}

function getFeishuStatusReaction(stage) {
  return FEISHU_STATUS_REACTIONS[stage] ?? null
}

function looksLikeFeishuMetaFollowUp(request) {
  return /^(是不是|有没有|为啥|为什么|怎么回事|什么情况|改了哪里|哪里改了|做到哪了|现在呢|上面那个)/u.test(request)
    || /(是不是|有没有|为啥|为什么|怎么回事|什么情况|改了哪里|做到哪了|你刚刚|你上面|这个意思|这次改动|大改|进展|当前状态|现在状态|处理状态)/u.test(request)
}

function looksLikeFeishuNewTaskRequest(request) {
  return /(帮我|麻烦|看下|看一下|看看|确认|确认下|确认一下|核对|顺手看|查下|查一下|查查|排查|继续|接着|修复|改一下|改成|部署|上线|运行|执行|测试|停掉|启动|清理|新增|加个|做个)/u.test(request)
}

function shouldAutoAppendFeishuFollowUp(message) {
  const request = cleanText(buildOperatorRequest(message))

  if (!request) {
    return false
  }

  if (parseFeishuControlCommand(message)) {
    return false
  }

  if (collectReferencedMessageIds(message).length > 0) {
    return false
  }

  if (looksLikeFeishuSelfReflectionQuestion(request) || looksLikeFeishuMetaFollowUp(request)) {
    return false
  }

  const looksLikeAppendCue = /^(再|顺便|另外|同时|然后|还有|补充|对了|顺手|别忘了|也|以及|顺带|一并|连同)/u.test(request)
    || /(顺便|另外|补充|别忘了|也看看|也查查|也查一下|也看下|一起|一并|再把|再顺手)/u.test(request)

  if (looksLikeAppendCue) {
    return true
  }

  return request.length <= 24 && !looksLikeFeishuNewTaskRequest(request)
}

function buildAutoAppendedFeishuMessage(message) {
  const originalText = cleanText(message?.text)

  return {
    ...message,
    text: buildFeishuAppendSuggestion(originalText),
    continuation_hint: 'auto_append',
    original_text: originalText
  }
}

function assertFeishuRunActive(runState, stage) {
  if (runState?.stop_requested) {
    throw new FeishuRunStoppedError(stage)
  }
}

function buildFeishuProgressText({
  operatorProfile,
  stage,
  planning = null,
  latestRun = null,
  totalRuns = 0
}) {
  const lines = []
  const isThinking = operatorProfile.response_mode === 'thinking'

  if (stage === 'planning') {
    if (isThinking) {
      lines.push('🤔 思考中：正在理解你的需求，整理计划...')
    } else {
      lines.push('正在理解你的需求并整理计划。')
    }
  } else if (stage === 'planned' && planning?.plan) {
    if (isThinking) {
      lines.push(`📋 计划拆解（共 ${planning.plan.steps.length} 步）：`)
      planning.plan.steps.slice(0, 4).forEach((step, i) => {
        lines.push(`  ${i + 1}. ${step.title}`)
      })
    } else {
      lines.push(`已拆成 ${planning.plan.steps.length} 步，开始推进。`)
      lines.push(...summarizePlanStepsForReply(planning.plan.steps).slice(0, 4))
    }
  } else if (stage === 'executing' && latestRun) {
    if (isThinking) {
      lines.push(`🔧 执行第 ${totalRuns} 步：`)
      lines.push(`  工具：${latestRun.tool_name ?? '未知'}`)
      if (latestRun.summary) {
        lines.push(`  进展：${compactMultilineText(latestRun.summary)}`)
      }
    } else {
      lines.push(`正在推进第 ${totalRuns} 步。`)
      lines.push(compactMultilineText(latestRun.summary ?? latestRun.report_text ?? ''))
    }
  }

  return lines
    .filter(Boolean)
    .join('\n')
}

function buildFeishuFinalReplyText({
  operatorProfile,
  planning,
  execution,
  feedbackAck = null,
  error = null
}) {
  if (error) {
    return `这轮先停在这里：${error}`
  }

  const lines = []
  const isThinking = operatorProfile.response_mode === 'thinking'

  if (isThinking && planning?.plan?.steps?.length) {
    lines.push('📋 思考过程：')
    lines.push(`  计划拆解：${planning.plan.steps.length} 步`)
    planning.plan.steps.slice(0, 5).forEach((step, i) => {
      lines.push(`    ${i + 1}. ${step.title}${step.kind ? ` (${step.kind})` : ''}`)
    })
    lines.push('')
  }

  if (planning?.plan?.operator_reply) {
    if (isThinking) {
      lines.push('💡 结论：')
      lines.push(compactMultilineText(planning.plan.operator_reply))
    } else {
      lines.push(compactMultilineText(planning.plan.operator_reply))
    }
  }

  if (execution?.runs?.length && isThinking) {
    lines.push('')
    lines.push('🔧 执行过程：')
    execution.runs.forEach((run, i) => {
      lines.push(`  ${i + 1}. ${run.tool_name ?? '步骤'}: ${compactMultilineText(run.summary ?? run.report_text ?? '已完成')}`)
    })
  } else if (execution?.report_text) {
    lines.push(compactMultilineText(execution.report_text))
  }

  if (feedbackAck && operatorProfile.response_mode !== 'fast') {
    lines.push(feedbackAck)
  }

  return lines.filter(Boolean).join('\n')
}

function buildFeishuReplyCard({
  operatorProfile,
  planning = null,
  execution = null,
  feedbackAck = null,
  error = null
}) {
  const planSteps = summarizePlanStepsForReply(planning?.plan?.steps ?? [])
  const executionRuns = summarizeExecutionRunsForReply(execution?.runs ?? [])
  const title = error ? '处理受阻' : '已完成'
  const template = error ? 'red' : 'green'
  const sections = []

  if (planning?.plan?.operator_reply) {
    sections.push(`**当前结论**\n${planning.plan.operator_reply}`)
  }

  if (planSteps.length > 0) {
    sections.push(`**本轮计划**\n- ${planSteps.join('\n- ')}`)
  }

  if (executionRuns.length > 0) {
    sections.push(`**本轮处理**\n- ${executionRuns.join('\n- ')}`)
  }

  if (execution?.report_text) {
    sections.push(`**阶段汇报**\n${execution.report_text}`)
  }

  if (feedbackAck && operatorProfile.response_mode !== 'fast') {
    sections.push(`**已记录偏好**\n${feedbackAck}`)
  }

  if (error) {
    sections.push(`**错误信息**\n${error}`)
  }

  return {
    template,
    title,
    content: sections.join('\n\n')
  }
}

function buildFeishuReplyCardElement(sections, template, title) {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    elements: [
      {
        tag: 'markdown',
        content: sections.join('\n\n')
      }
    ]
  }
}

function buildFeishuAutoExecuteReportText(approval) {
  const lines = [
    '下一步是高风险执行，我按报备机制直接推进。'
  ]

  if (approval?.tool_name) {
    lines.push(`工具：${approval.tool_name}`)
  }

  if (approval?.requested_input?.cwd) {
    lines.push(`目录：${approval.requested_input.cwd}`)
  }

  if (approval?.requested_input?.command) {
    lines.push(`命令：${approval.requested_input.command}`)
  }

  lines.push('如需停止，立即发送 `/stop` 或直接回复“停止”。')

  return lines.join('\n')
}

function buildFeishuConversationCard({
  title = '当前情况',
  template = 'blue',
  content
}) {
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title
      }
    },
    elements: [
      {
        tag: 'markdown',
        content
      }
    ]
  }
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

function compactPreparedReplyIntent(value) {
  return normalizeForSignalMatch(value)
    .replace(/(是不是|有没有|这次|到底|现在|刚刚|刚才|一下子|一下|请问|麻烦|帮我|直接|算)/gu, '')
    .replace(/[吗呢呀啊吧了]/gu, '')
}

function buildCharacterUnits(value, unitSize = 2) {
  const normalized = cleanText(value)

  if (!normalized) {
    return new Set()
  }

  if (normalized.length <= unitSize) {
    return new Set([normalized])
  }

  const units = new Set()

  for (let index = 0; index <= normalized.length - unitSize; index += 1) {
    units.add(normalized.slice(index, index + unitSize))
  }

  return units
}

function computeOverlapRatio(leftUnits, rightUnits) {
  if (leftUnits.size === 0 || rightUnits.size === 0) {
    return 0
  }

  let overlap = 0

  for (const unit of leftUnits) {
    if (rightUnits.has(unit)) {
      overlap += 1
    }
  }

  return overlap / Math.max(1, Math.min(leftUnits.size, rightUnits.size))
}

function computePreparedReplyMatchScore(request, candidate) {
  const normalizedRequest = normalizeForSignalMatch(request)
  const normalizedCandidate = normalizeForSignalMatch(candidate)

  if (!normalizedRequest || !normalizedCandidate) {
    return 0
  }

  if (normalizedRequest === normalizedCandidate) {
    return 1
  }

  const compactRequest = compactPreparedReplyIntent(request)
  const compactCandidate = compactPreparedReplyIntent(candidate)

  if (compactRequest && compactCandidate && compactRequest === compactCandidate) {
    return 0.96
  }

  if (
    normalizedRequest.includes(normalizedCandidate)
    || normalizedCandidate.includes(normalizedRequest)
  ) {
    return 0.92
  }

  if (
    compactRequest
    && compactCandidate
    && (
      compactRequest.includes(compactCandidate)
      || compactCandidate.includes(compactRequest)
    )
  ) {
    return 0.86
  }

  const bigramOverlap = computeOverlapRatio(
    buildCharacterUnits(compactRequest || normalizedRequest, 2),
    buildCharacterUnits(compactCandidate || normalizedCandidate, 2)
  )
  const charOverlap = computeOverlapRatio(
    buildCharacterUnits(compactRequest || normalizedRequest, 1),
    buildCharacterUnits(compactCandidate || normalizedCandidate, 1)
  )

  return Math.max(
    (bigramOverlap * 0.7) + (charOverlap * 0.3),
    compactRequest && compactCandidate
      ? charOverlap * 0.82
      : 0
  )
}

function isPositiveConfirmationMessage(message) {
  return CONFIRMATION_SIGNAL_PATTERN.test(
    normalizeForSignalMatch(buildOperatorRequest(message))
  )
}

function isNegativeConfirmationMessage(message) {
  return NEGATIVE_CONFIRMATION_SIGNAL_PATTERN.test(
    normalizeForSignalMatch(buildOperatorRequest(message))
  )
}

function buildFeishuLongRunningFeedbackText(runState, nowTimestamp) {
  const lines = [
    `这轮已经处理了 ${formatElapsedDuration(nowTimestamp - runState.started_at_ms)}，我还在继续推进。`
  ]

  if (runState.phase === 'planning') {
    lines.push('当前卡在整理计划和确认下一步。')
  } else if (runState.phase === 'executing' && runState.latest_run?.summary) {
    lines.push(`当前进度：${compactMultilineText(runState.latest_run.summary)}`)
  } else if (runState.phase === 'planned' && runState.planning?.plan?.steps?.length) {
    lines.push(`计划已拆成 ${runState.planning.plan.steps.length} 步，正在进入执行。`)
  } else {
    lines.push('当前还没收口，但没有卡死。')
  }

  return lines.join('\n')
}

function buildFeishuTimeoutReviewText(runState, nowTimestamp, {
  askForExtension = false,
  finalStop = false
} = {}) {
  const lines = [
    finalStop
      ? `这轮已经到 ${formatElapsedDuration(nowTimestamp - runState.started_at_ms)} 的硬上限，我先停在这里。`
      : `这轮已经处理了 ${formatElapsedDuration(nowTimestamp - runState.started_at_ms)}，我先停一下做个复盘。`
  ]

  if (runState.planning?.plan?.operator_reply) {
    lines.push(`当前判断：${compactMultilineText(runState.planning.plan.operator_reply)}`)
  }

  const completedRuns = summarizeExecutionRunsForReply(runState.execution_runs ?? [])

  if (completedRuns.length > 0) {
    lines.push(`已推进：${completedRuns.join('；')}`)
  } else if (runState.phase === 'planning') {
    lines.push('当前主要耗时还在计划阶段。')
  }

  if (runState.latest_run?.summary) {
    lines.push(`最近进度：${compactMultilineText(runState.latest_run.summary)}`)
  }

  if (askForExtension) {
    lines.push('如果你同意我继续推进，直接回复“继续”或“可以”。')
    lines.push('10 秒内没有新指示，我会按默认同意继续。')
  }

  return lines.join('\n')
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

function normalizePreparedReplyItems(items) {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item) => {
      const trigger = cleanText(item?.trigger ?? item?.question)
      const question = cleanText(item?.question ?? item?.trigger)
      const reply = cleanMultilineText(item?.reply)

      if (!trigger || !reply) {
        return null
      }

      return {
        trigger,
        question,
        reply
      }
    })
    .filter(Boolean)
    .slice(0, 6)
}

function collectPreparedReplyCandidatePhrases(item, preparedContext) {
  const phrases = [
    item?.trigger,
    item?.question
  ]

  if ((preparedContext?.ready_replies?.length ?? 0) === 1) {
    phrases.push(
      ...(Array.isArray(preparedContext?.likely_followups) ? preparedContext.likely_followups : []),
      ...(Array.isArray(preparedContext?.operator_focuses) ? preparedContext.operator_focuses : [])
    )
  }

  return uniqueStringValues(phrases)
}

function buildFeishuBackgroundPrecomputeSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [
          'You are the background preparation daemon for a long-running Feishu operator assistant.'
        ]
      },
      {
        title: 'TASK',
        lines: [
          'Use idle time to precompute likely operator focus, likely follow-up questions, fast direct replies, and low-risk next checks.',
          'Optimize for future response speed and attention alignment.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "summary": "short Chinese background summary",',
          '  "operator_focuses": ["what the operator likely cares about now"],',
          '  "likely_followups": ["likely next short question"],',
          '  "ready_replies": [',
          '    {',
          '      "trigger": "short Chinese trigger fragment",',
          '      "question": "likely operator wording",',
          '      "reply": "short Chinese answer ready to send directly"',
          '    }',
          '  ],',
          '  "next_checks": ["safe next check that could be prepared mentally"],',
          '  "attention_rules": ["how foreground attention should prioritize context"]',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: [
          'Current operator message and quoted thread are always higher priority than older assistant replies.',
          'Prepare fast answers, but do not invent facts, paths, ports, or completion states.',
          'Do not dump internal command details unless the operator explicitly asks.',
          'Triggers must be short and easy to match against future operator messages.',
          'When operator rules emphasize short direct answers or markdown structure, encode that style bias into the ready replies.'
        ]
      }
    ]
  })
}

function buildFeishuBackgroundPrecomputePrompt({
  sessionSummary = null,
  recentTranscript = [],
  longTermMemory = [],
  operatorRules = [],
  preparedContext = null
}) {
  const sections = []

  if (preparedContext?.summary) {
    sections.push({
      title: 'PREVIOUS PREPARED CONTEXT',
      bullet: false,
      lines: [
        `summary: ${preparedContext.summary}`,
        preparedContext.operator_focuses?.length
          ? `operator_focuses: ${preparedContext.operator_focuses.join('；')}`
          : null,
        preparedContext.likely_followups?.length
          ? `likely_followups: ${preparedContext.likely_followups.join('；')}`
          : null
      ]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'CURRENT SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (recentTranscript.length > 0) {
    sections.push({
      title: 'RECENT TRANSCRIPT',
      lines: recentTranscript
    })
  }

  if (operatorRules.length > 0) {
    sections.push({
      title: 'OPERATOR RULES',
      lines: operatorRules.map((rule) => `[${rule.kind}] ${rule.content}`)
    })
  }

  if (longTermMemory.length > 0) {
    sections.push({
      title: 'LONG-TERM MEMORY',
      lines: longTermMemory
    })
  }

  return buildPromptContract({
    sections
  })
}

function parseFeishuBackgroundPrecomputeResponse({ text }) {
  const parsed = JSON.parse(extractJsonObject(text))
  const summary = cleanText(parsed.summary)

  if (!summary) {
    throw new Error('Background precompute response did not include a summary')
  }

  return {
    summary,
    operator_focuses: normalizeCompactionItems(parsed.operator_focuses ?? parsed.operatorFocuses),
    likely_followups: normalizeCompactionItems(parsed.likely_followups ?? parsed.likelyFollowups),
    ready_replies: normalizePreparedReplyItems(parsed.ready_replies ?? parsed.readyReplies),
    next_checks: normalizeCompactionItems(parsed.next_checks ?? parsed.nextChecks),
    attention_rules: normalizeCompactionItems(parsed.attention_rules ?? parsed.attentionRules)
  }
}

function buildFeishuConversationSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [
          'You answer the operator directly inside an ongoing Feishu thread.'
        ]
      },
      {
        title: 'TASK',
        lines: [
          'Answer the current operator message naturally in Chinese.',
          'Prioritize the current message first, then any explicitly quoted thread, then the older session context.'
        ]
      },
      {
        title: 'RESPONSE RULES',
        lines: [
          'Simple follow-up questions should be answered in 1 to 3 short sentences.',
          'If the operator asks for structured detail, use light markdown with short sections.',
          'Do not dump shell commands, curl snippets, raw paths, ports, or inventory unless explicitly asked.',
          'Sound like a sharp human operator, not like a planning engine.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return Chinese reply text only.',
          'Do not wrap the answer in JSON or markdown fences.'
        ]
      }
    ]
  })
}

function buildFeishuConversationPrompt({
  message,
  attentionContext,
  sessionSummary = null,
  longTermMemory = [],
  recentTranscript = [],
  operatorRules = [],
  preparedContext = null,
  continuity = null
}) {
  const sections = [
    {
      title: 'ATTENTION STACK',
      lines: buildAttentionStackLines(attentionContext)
    },
    {
      title: 'CURRENT OPERATOR MESSAGE',
      bullet: false,
      lines: [buildOperatorRequest(message)]
    }
  ]

  if (attentionContext.primary_reference) {
    sections.push({
      title: 'REFERENCED MESSAGE',
      bullet: false,
      lines: [
        `[${attentionContext.primary_reference.role}] ${attentionContext.primary_reference.content}`
      ]
    })
  }

  // 只在同任务续接时使用 prepared_context，新任务默认不吃旧上下文
  if (preparedContext?.summary && (continuity?.kind === 'same_task' || continuity?.score >= 0.6)) {
    sections.push({
      title: 'PREPARED CONTEXT',
      bullet: false,
      lines: [
        `summary: ${preparedContext.summary}`,
        preparedContext.operator_focuses?.length
          ? `operator_focuses: ${preparedContext.operator_focuses.join('；')}`
          : null,
        preparedContext.likely_followups?.length
          ? `likely_followups: ${preparedContext.likely_followups.join('；')}`
          : null,
        preparedContext.ready_replies?.length
          ? `ready_replies: ${preparedContext.ready_replies
            .map((item) => `${item.question ?? item.trigger} -> ${item.reply}`)
            .join('；')}`
          : null,
        preparedContext.next_checks?.length
          ? `next_checks: ${preparedContext.next_checks.join('；')}`
          : null,
        preparedContext.attention_rules?.length
          ? `attention_rules: ${preparedContext.attention_rules.join('；')}`
          : null
      ]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'CURRENT SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (recentTranscript.length > 0) {
    sections.push({
      title: 'RECENT TRANSCRIPT',
      lines: recentTranscript
    })
  }

  if (operatorRules.length > 0) {
    sections.push({
      title: 'OPERATOR RULES',
      lines: operatorRules.map((rule) => `[${rule.kind}] ${rule.content}`)
    })
  }

  if (longTermMemory.length > 0) {
    sections.push({
      title: 'LONG-TERM MEMORY',
      lines: longTermMemory
    })
  }

  return buildPromptContract({
    sections
  })
}

function shouldUseFeishuConversationReply({
  message,
  attentionContext
}) {
  const request = cleanText(buildOperatorRequest(message))

  if (!request) {
    return false
  }

  if (request.startsWith('补充建议：') || message?.continuation_hint === 'auto_append') {
    return false
  }

  if (looksLikeFeishuSelfReflectionQuestion(request)) {
    return true
  }

  const looksLikeQuestion = /[?？]$/.test(request)
  const looksLikeMetaFollowUp = looksLikeFeishuMetaFollowUp(request)
  const looksLikeNewTask = looksLikeFeishuNewTaskRequest(request)

  if (attentionContext.primary_reference) {
    return !looksLikeNewTask || looksLikeQuestion || looksLikeMetaFollowUp
  }

  return (looksLikeQuestion || looksLikeMetaFollowUp) && !looksLikeNewTask && request.length <= 48
}

function looksLikeFeishuSelfReflectionQuestion(request) {
  const normalized = cleanText(request)

  if (!normalized) {
    return false
  }

  const mentionsAgent = /(你|小云|你的|你现在|你刚刚|你自己)/u.test(normalized)
  const selfTopics = /(阿里云|服务器|跑在|跑在哪|部署位置|创建过程|codex|mac|电脑|同事|改造|赋能|新特性|升级|增强|改了什么|做了什么|变得更好|现在会什么|能力|想想是哪些|知道的吧)/iu.test(normalized)

  return mentionsAgent && selfTopics
}

function collectFeishuSelfReflectionHighlights(managerProfile) {
  const highlights = [
    '飞书回复更重排版：简单问题短回，复杂任务会持续反馈，最终结果优先 Markdown / 卡片。',
    '连续消息更自然：短时间内连续几句会先合并，处理中追加的话会顺序排队。',
    '时限机制更明确：30 秒先反馈，3 分钟申请更多时间，10 秒默认继续，6 分钟最终停下。',
    '注意力机制更严格：当前消息最高优先，引用楼层次优先，旧 assistant 回复和历史噪音靠后。',
    '基础设施 registry 已接进规划链，项目 / 服务 / 路由不再全靠猜。'
  ]

  if (managerProfile.background_precompute?.enabled) {
    highlights.push('空闲时会用免费模型做轻量预制，提前准备关注点、可能追问和 ready replies。')
  }

  if (managerProfile.external_review?.enabled) {
    highlights.push(`外部第二裁判已接入，evaluation 会走 ${managerProfile.external_review.model} 做复核。`)
  }

  return highlights
}

function buildFeishuSelfReflectionReply({
  request,
  managerProfile,
  preparedContext = null
}) {
  const askAboutLocation = /(阿里云|服务器|跑在|跑在哪|部署位置)/u.test(request)
  const askAboutCodex = /(codex|mac|电脑|同事)/iu.test(request)
  const askAboutChanges = /(改造|赋能|新特性|升级|增强|改了什么|做了什么|哪些|变得更好|现在会什么|能力)/u.test(request)
  const lines = ['记得。']

  if (askAboutLocation) {
    lines.push('你一直把我放在阿里云服务器上跑，主交互通道是飞书长连接。')
  }

  if (askAboutCodex) {
    lines.push('你这台 Mac 上的 Codex 一直在帮我做设计、修正和加能力，它就是我最特殊的外部同事。')
  }

  if (askAboutChanges || (!askAboutLocation && !askAboutCodex)) {
    lines.push('')
    lines.push('### 我现在能明确确认的升级')

    for (const highlight of collectFeishuSelfReflectionHighlights(managerProfile)) {
      lines.push(`- ${highlight}`)
    }
  }

  if (preparedContext?.summary) {
    lines.push('')
    lines.push(`当前我对自己这轮变化的核心理解是：${preparedContext.summary}`)
  }

  lines.push('')
  lines.push('如果你现在要我只用一句话复述，我会说：回复更像人、上下文更会接、后台也开始提前准备了。')

  return lines.join('\n')
}

function shouldUseConversationCard(replyText) {
  const text = cleanMultilineText(replyText)

  return text.includes('\n\n') || text.split('\n').length >= 4 || text.length >= 180
}

function matchPreparedReply(message, preparedContext) {
  if (!preparedContext || !Array.isArray(preparedContext.ready_replies)) {
    return null
  }

  const request = buildOperatorRequest(message)

  if (!request) {
    return null
  }

  let bestMatch = null

  for (const item of preparedContext.ready_replies) {
    const score = Math.max(
      ...collectPreparedReplyCandidatePhrases(item, preparedContext)
        .map((candidate) => computePreparedReplyMatchScore(request, candidate))
    )

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        item,
        score
      }
    }
  }

  if (!bestMatch || bestMatch.score < 0.58) {
    return null
  }

  return bestMatch.item
}

export function createServerManagerRuntime({
  storageRoot,
  feishuGateway = null,
  bailianProvider = null,
  hookBus = null,
  workspaceRoot = process.cwd(),
  fetchFn = globalThis.fetch,
  managerProfile = createRemoteServerManagerProfile(),
  managerExecutor: injectedManagerExecutor = null,
  progressReplyDelayMs = 2000,
  longRunningFeedbackMs = DEFAULT_FEISHU_LONG_RUNNING_FEEDBACK_MS,
  longRunningCheckpointMs = DEFAULT_FEISHU_TIMEOUT_CHECKPOINT_MS,
  longRunningExtensionApprovalMs = DEFAULT_FEISHU_EXTENSION_RESPONSE_TIMEOUT_MS,
  longRunningFinalStopMs = DEFAULT_FEISHU_FINAL_TIMEOUT_MS,
  backgroundPrecomputeIntervalMs = DEFAULT_BACKGROUND_PRECOMPUTE_INTERVAL_MS,
  contextCompactionIntervalMs = DEFAULT_CONTEXT_COMPACTION_INTERVAL_MS,
  feishuAppendMergeWindowMs = DEFAULT_FEISHU_APPEND_MERGE_WINDOW_MS,
  nowFn = Date.now,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout
}) {
  const sessionStore = createSessionStore({ storageRoot })
  const memoryStore = createMemoryStore({ storageRoot })
  const coworkerStore = createCoworkerStore({ storageRoot })
  const runtimeHookBus = hookBus ?? createHookBus({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })
  const infrastructureRegistry = createInfrastructureRegistry({ storageRoot })
  const managerExecutor = injectedManagerExecutor ?? createManagerExecutor({
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
  const feishuBackgroundState = {
    scheduled_timer: null
  }
  const feishuRuntimeState = {
    active_run: null
  }
  const feishuReactionStateByMessageId = new Map()

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

  function rememberFeishuImmediateAckReactions(messages = []) {
    for (const item of messages) {
      if (
        item?.message_id
        && item?.immediate_ack?.kind === 'reaction'
        && item.immediate_ack.ok
      ) {
        feishuReactionStateByMessageId.set(item.message_id, {
          stage: 'received',
          emoji_type: item.immediate_ack.emoji_type ?? null,
          reaction_id: item.immediate_ack.reaction_id ?? null
        })
      }
    }
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

  async function loadFeishuOperatorProfile() {
    const state = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    return normalizeFeishuOperatorProfile(state?.operator_profile)
  }

  async function loadPreparedFeishuContext(sessionId = null) {
    const state = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)

    if (!state?.prepared_context) {
      return null
    }

    if (sessionId && state.session_id && state.session_id !== sessionId) {
      return null
    }

    return state.prepared_context
  }

  async function writeFeishuOperatorProfile(partialProfile) {
    const currentAt = nowIso()
    const state = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    const nextProfile = normalizeFeishuOperatorProfile({
      ...(state?.operator_profile ?? {}),
      ...(partialProfile ?? {})
    })

    await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
      ...(state ?? {}),
      channel: 'feishu',
      updated_at: currentAt,
      operator_profile: nextProfile,
      version: 1
    })

    return nextProfile
  }

  function scheduleFeishuBackgroundPrecomputeSoon(
    delayMs = DEFAULT_BACKGROUND_PRECOMPUTE_TRIGGER_DELAY_MS
  ) {
    if (!bailianProvider || !managerProfile.background_precompute?.enabled) {
      return false
    }

    if (feishuBackgroundState.scheduled_timer) {
      return true
    }

    const timer = setTimeoutFn(() => {
      if (feishuBackgroundState.scheduled_timer === timer) {
        feishuBackgroundState.scheduled_timer = null
      }

      Promise.resolve()
        .then(() => runFeishuBackgroundPrecomputeOnce())
        .catch(() => {})
    }, delayMs)

    timer?.unref?.()
    feishuBackgroundState.scheduled_timer = timer
    return true
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
    seedAliyun = true,
    preserveExisting = false
  } = {}) {
    let seededProjects = []
    let seededInfrastructure = { projects: [], services: [], routes: [] }

    if (seedAliyun) {
      let baselineProjects = getAliyunSeedProjects()
      let baselineInfrastructure = getAliyunInfrastructureRegistry()

      if (preserveExisting) {
        const existingProjects = await projectRegistry.listProjects()
        const existingInfrastructureProjects = await infrastructureRegistry.listProjects()
        const existingServices = await infrastructureRegistry.listServices()
        const existingRoutes = await infrastructureRegistry.listRoutes()

        const existingProjectKeys = new Set(existingProjects.map((project) => project.project_key))
        const existingInfrastructureProjectKeys = new Set(
          existingInfrastructureProjects.map((project) => project.project_key)
        )
        const existingServiceKeys = new Set(existingServices.map((service) => service.service_key))
        const existingRouteKeys = new Set(existingRoutes.map((route) => route.route_key))

        baselineProjects = baselineProjects.filter(
          (project) => !existingProjectKeys.has(project.project_key)
        )
        baselineInfrastructure = {
          projects: baselineInfrastructure.projects.filter(
            (project) => !existingInfrastructureProjectKeys.has(project.project_key)
          ),
          services: baselineInfrastructure.services.filter(
            (service) => !existingServiceKeys.has(service.service_key)
          ),
          routes: baselineInfrastructure.routes.filter(
            (route) => !existingRouteKeys.has(route.route_key)
          )
        }
      }

      seededProjects = await projectRegistry.seedProjects(baselineProjects)
      seededInfrastructure = await infrastructureRegistry.seedRegistry(baselineInfrastructure)
    }

    return {
      manager_profile: managerProfile,
      seeded_project_count: seededProjects.length,
      seeded_infra_project_count: seededInfrastructure.projects.length,
      seeded_service_count: seededInfrastructure.services.length,
      seeded_route_count: seededInfrastructure.routes.length
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
    const existingInfrastructureProjects = await infrastructureRegistry.listProjects()

    if (
      (existingProjects.length > 0 && existingInfrastructureProjects.length > 0)
      || !seedAliyunIfEmpty
    ) {
      return {
        seeded: false,
        project_count: existingProjects.length,
        infra_project_count: existingInfrastructureProjects.length
      }
    }

    const bootstrap = await bootstrapServerBaseline({
      seedAliyun: true
    })

    return {
      seeded: true,
      project_count: bootstrap.seeded_project_count,
      infra_project_count: bootstrap.seeded_infra_project_count
    }
  }

  async function requestCoworkerHelp({
    sessionId,
    source = 'newagent-manager',
    target = DEFAULT_CODEX_COWORKER_TARGET,
    title = null,
    question,
    context = null,
    urgency = 'normal',
    tags = [],
    location = DEFAULT_CODEX_COWORKER_LOCATION
  }) {
    if (!sessionId) {
      throw new Error('Missing required field: sessionId')
    }

    const snapshot = await sessionStore.loadSession(sessionId)
    const request = await coworkerStore.createRequest({
      sessionId,
      source,
      target,
      authority: managerProfile.channels?.coworker?.authority ?? 'advisory_only',
      title: cleanText(title) || `Need Codex help for ${snapshot.task.title}`,
      question,
      context,
      urgency,
      tags: uniqueStringValues([
        'coworker',
        'ssh-channel',
        'codex',
        ...tags
      ]),
      location
    })

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'coworker_request_created',
      actor: 'manager:runtime',
      payload: {
        request_id: request.id,
        source: request.source,
        target: request.target,
        authority: request.authority,
        title: request.title,
        urgency: request.urgency,
        location: request.location,
        status: request.status
      }
    })
    await emitHook({
      name: 'coworker.request.created',
      sessionId,
      channel: request.channel,
      actor: 'manager:runtime',
      payload: {
        request_id: request.id,
        source: request.source,
        target: request.target,
        authority: request.authority,
        title: request.title,
        urgency: request.urgency,
        location: request.location,
        session_summary: snapshot.session.summary ?? null
      }
    })

    return request
  }

  async function resolveCoworkerRequest({
    requestId,
    answer,
    resolvedBy = DEFAULT_CODEX_COWORKER_TARGET,
    resolution = 'answered',
    location = DEFAULT_CODEX_COWORKER_LOCATION,
    writeMemory = true
  }) {
    if (!requestId) {
      throw new Error('Missing required field: requestId')
    }

    const resolved = await coworkerStore.resolveRequest(requestId, {
      answer,
      resolvedBy,
      resolution,
      location
    })

    if (resolved.session_id) {
      await sessionStore.appendTimelineEvent(resolved.session_id, {
        kind: 'coworker_request_resolved',
        actor: 'coworker:codex',
        payload: {
          request_id: resolved.id,
          target: resolved.target,
          resolved_by: resolved.resolved_by,
          resolution: resolved.resolution,
          location: resolved.location
        }
      })

      if (writeMemory) {
        await memoryStore.addMemoryEntry({
          sessionId: resolved.session_id,
          scope: 'session',
          kind: 'decision',
          content: `Mac-local Codex replied: ${resolved.answer}`,
          tags: ['coworker_reply', 'codex', 'ssh-channel']
        })
      }

      await emitHook({
        name: 'coworker.request.resolved',
        sessionId: resolved.session_id,
        channel: resolved.channel,
        actor: 'coworker:codex',
        payload: {
          request_id: resolved.id,
          target: resolved.target,
          resolved_by: resolved.resolved_by,
          resolution: resolved.resolution,
          location: resolved.location
        }
      })
    }

    return resolved
  }

  async function ensureFeishuUnifiedSessionTurn(message) {
    const currentAt = nowIso()
    const existingState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    const title = buildOperatorTitle(message)
    const userRequest = buildOperatorRequest(message)
    const userMessageMeta = buildFeishuUserMessageMeta(message)

    if (existingState?.session_id) {
      try {
        const currentSnapshot = await sessionStore.loadSession(existingState.session_id)

        const continued = await sessionStore.startNextTurn(existingState.session_id, {
          title,
          userRequest,
          startedAt: currentAt,
          userMessageMeta
        })
        const nextState = await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
          ...existingState,
          channel: 'feishu',
          session_id: continued.session.id,
          updated_at: currentAt,
          last_message_at: currentAt,
          operator_profile: normalizeFeishuOperatorProfile(existingState?.operator_profile),
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
      summary: 'Received feishu operator request',
      userMessageMeta
    })
    const nextState = await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
      channel: 'feishu',
      session_id: created.session.id,
      created_at: currentAt,
      updated_at: currentAt,
      last_message_at: currentAt,
      last_compacted_at: currentAt,
      last_background_precompute_at: null,
      prepared_context: null,
      operator_profile: normalizeFeishuOperatorProfile(existingState?.operator_profile),
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

  async function runFeishuBackgroundPrecomputeOnce() {
    if (!bailianProvider || !managerProfile.background_precompute?.enabled) {
      return {
        status: 'disabled'
      }
    }

    const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)

    if (!channelState?.session_id) {
      return {
        status: 'idle'
      }
    }

    if (feishuRuntimeState.active_run) {
      return {
        status: 'busy'
      }
    }

    const lastPreparedAtMs = parseIsoTimestamp(channelState.last_background_precompute_at)

    if (
      lastPreparedAtMs != null
      && nowFn() - lastPreparedAtMs < backgroundPrecomputeIntervalMs
    ) {
      return {
        status: 'not_due'
      }
    }

    const sessionId = channelState.session_id

    try {
      const snapshot = await sessionStore.loadSession(sessionId)

      // 只在任务完成后才生成 prepared_context，进行中任务不干扰
      if (snapshot.task.status !== 'completed') {
        return {
          status: 'skipped',
          reason: 'task_not_completed'
        }
      }

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
        maxMessages: 12
      })

      // 简化背景预计算：不吃旧 prepared_context，避免污染
      const providerResult = await bailianProvider.invokeByIntent({
        intent: 'background',
        systemPrompt: buildFeishuBackgroundPrecomputeSystemPrompt(),
        prompt: buildFeishuBackgroundPrecomputePrompt({
          sessionSummary: snapshot.session.summary ?? null,
          recentTranscript,
          longTermMemory,
          operatorRules,
          preparedContext: null
        })
      })
      const preparedContext = parseFeishuBackgroundPrecomputeResponse({
        text: providerResult.response.content ?? ''
      })
      const currentAt = nowIso()

      // 只保留 ready_replies，丢弃可能导致污染的 operator_focuses/next_checks
      const sanitizedPreparedContext = {
        ready_replies: preparedContext.ready_replies ?? [],
        summary: preparedContext.summary ?? null,
        generated_at: currentAt,
        provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
        model: providerResult.route.model
      }

      await writeChannelState(FEISHU_UNIFIED_CHANNEL_KEY, {
        ...channelState,
        updated_at: currentAt,
        last_background_precompute_at: currentAt,
        prepared_context: sanitizedPreparedContext,
        version: 1
      })
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'background_precompute_completed',
        actor: 'manager:background',
        payload: {
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
          ready_reply_count: sanitizedPreparedContext.ready_replies.length,
          focus_count: 0
        },
        at: currentAt
      })
      await emitHook({
        name: 'manager.background_precompute.completed',
        sessionId,
        channel: 'feishu',
        actor: 'manager:background',
        payload: {
          model: providerResult.route.model,
          provider: providerResult.route.provider ?? providerResult.route.runtime ?? null,
          ready_reply_count: sanitizedPreparedContext.ready_replies.length,
          focus_count: 0
        }
      })

      return {
        status: 'prepared',
        prepared_context: sanitizedPreparedContext
      }
    } catch (error) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'background_precompute_failed',
        actor: 'manager:background',
        payload: {
          message: error.message
        },
        at: nowIso()
      })

      return {
        status: 'failed',
        error: error.message
      }
    }
  }

  async function answerFeishuConversationQuestion({
    sessionId,
    message,
    snapshot,
    attentionContext,
    continuity = null
  }) {
    const request = cleanText(buildOperatorRequest(message))
    const preparedContext = await loadPreparedFeishuContext(sessionId)
    const preparedReply = matchPreparedReply(message, preparedContext)

    if (looksLikeFeishuSelfReflectionQuestion(request)) {
      return {
        text: buildFeishuSelfReflectionReply({
          request,
          managerProfile,
          preparedContext
        }),
        source: 'self_reflection',
        prepared_context: preparedContext
      }
    }

    if (preparedReply) {
      return {
        text: preparedReply.reply,
        source: 'prepared_context',
        prepared_context: preparedContext
      }
    }

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
      maxMessages: 8
    })

    if (!bailianProvider) {
      return {
        text: attentionContext.primary_reference?.content
          ? `我先接你现在这句。你现在问的是「${compactMultilineText(buildOperatorRequest(message))}」，上一条相关内容是「${compactMultilineText(attentionContext.primary_reference.content)}」。`
          : snapshot.session.summary ?? '我先按你当前这句来理解，继续说。'
      }
    }

    const providerResult = await bailianProvider.invokeByIntent({
      intent: 'summary',
      systemPrompt: buildFeishuConversationSystemPrompt(),
      prompt: buildFeishuConversationPrompt({
        message,
        attentionContext,
        sessionSummary: snapshot.session.summary ?? null,
        longTermMemory,
        recentTranscript,
        operatorRules,
        preparedContext,
        continuity
      })
    })

    return {
      text: cleanMultilineText(providerResult.response.content ?? ''),
      source: 'llm',
      provider_result: {
        route: providerResult.route,
        request: providerResult.request
      },
      prepared_context: preparedContext
    }
  }

  async function completeConversationReplySession({
    sessionId,
    replyText,
    relation
  }) {
    const plan = await sessionStore.createPlan(sessionId, {
      steps: [
        {
          title: 'Answer operator follow-up',
          kind: 'report',
          notes: 'Direct conversational reply without starting a new execution plan.'
        }
      ]
    })

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'manager_follow_up_answered',
      actor: 'manager:runtime',
      payload: {
        relation,
        reply_text: replyText
      }
    })
    await emitHook({
      name: 'manager.follow_up.answered',
      sessionId,
      channel: 'feishu',
      actor: 'manager:runtime',
      payload: {
        relation
      }
    })
    await sessionStore.completePlanStep(sessionId, plan.steps[0].id, {
      resultSummary: replyText
    })
  }

  async function runFeishuHousekeepingOnce() {
    const compaction = await runFeishuMaintenanceOnce()
    const background = await runFeishuBackgroundPrecomputeOnce()

    return {
      status: 'ok',
      compaction,
      background
    }
  }

  function startFeishuMaintenanceLoop() {
    const pollIntervalMs = Math.max(
      1000,
      Math.min(
        computeMaintenancePollInterval(contextCompactionIntervalMs)
          ?? DEFAULT_MAINTENANCE_POLL_INTERVAL_MS,
        backgroundPrecomputeIntervalMs
      )
    )

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
      runOnce: runFeishuHousekeepingOnce
    })

    return {
      started: true,
      poll_interval_ms: pollIntervalMs,
      stop: recurringTask.stop
    }
  }

  async function planSession({
    sessionId,
    message,
    attentionContext = null,
    shouldStop = null
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
    const preparedContext = await loadPreparedFeishuContext(sessionId)
    const serviceInventory = await infrastructureRegistry.listServices()
    const routeInventory = await infrastructureRegistry.listRoutes()
    await emitHook({
      name: 'manager.planning.started',
      sessionId,
      actor: 'manager:planner',
      payload: {
        available_project_count: projects.length,
        operator_rule_count: operatorRules.length,
        long_term_memory_count: longTermMemory.length,
        transcript_line_count: recentTranscript.length,
        prepared_context_present: Boolean(preparedContext?.summary),
        service_inventory_count: serviceInventory.length,
        route_inventory_count: routeInventory.length
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
        recentTranscript,
        attentionContext,
        preparedContext,
        serviceInventory,
        routeInventory
      })
    })
    assertFeishuRunActive(
      typeof shouldStop === 'function'
        ? { stop_requested: shouldStop() }
        : null,
      'after_planning_provider'
    )
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
    assertFeishuRunActive(
      typeof shouldStop === 'function'
        ? { stop_requested: shouldStop() }
        : null,
      'after_plan_review'
    )

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
      const response = await feishuGateway.addMessageReaction({
        messageId,
        emojiType: immediateReaction
      })

      return {
        kind: 'reaction',
        ok: true,
        source: 'server_manager_runtime',
        message_id: messageId,
        emoji_type: immediateReaction,
        reaction_id: response?.data?.reaction_id ?? null
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

  async function addFeishuStatusReaction({
    sessionId = null,
    messageId,
    stage,
    source = 'server_manager_runtime'
  }) {
    const emojiType = getFeishuStatusReaction(stage)
    const existing = messageId
      ? feishuReactionStateByMessageId.get(messageId) ?? null
      : null

    if (!feishuGateway || !messageId || !emojiType) {
      return {
        ok: false,
        skipped: true,
        message_id: messageId ?? null,
        stage
      }
    }

    if (existing?.stage === stage && existing?.emoji_type === emojiType) {
      return {
        ok: true,
        skipped: true,
        message_id: messageId,
        emoji_type: emojiType,
        reaction_id: existing.reaction_id ?? null,
        stage
      }
    }

    try {
      if (
        existing?.reaction_id
        && typeof feishuGateway.deleteMessageReaction === 'function'
      ) {
        try {
          await feishuGateway.deleteMessageReaction({
            messageId,
            reactionId: existing.reaction_id
          })
        } catch {}
      }

      const response = await feishuGateway.addMessageReaction({
        messageId,
        emojiType
      })
      const reactionId = response?.data?.reaction_id ?? null
      feishuReactionStateByMessageId.set(messageId, {
        stage,
        emoji_type: emojiType,
        reaction_id: reactionId
      })

      if (sessionId) {
        await sessionStore.appendTimelineEvent(sessionId, {
          kind: 'assistant_reaction_added',
          actor: 'assistant:manager',
          payload: {
            message_id: messageId,
            emoji_type: emojiType,
            reaction_id: reactionId,
            stage,
            source
          }
        })
      }

      return {
        ok: true,
        message_id: messageId,
        emoji_type: emojiType,
        reaction_id: reactionId,
        stage
      }
    } catch (error) {
      if (sessionId) {
        await sessionStore.appendTimelineEvent(sessionId, {
          kind: 'channel_reply_failed',
          actor: 'assistant:manager',
          payload: {
            stage: `reaction_${stage}`,
            message_id: messageId,
            reaction_error: error.message,
            source
          }
        })
      }

      return {
        ok: false,
        message_id: messageId,
        emoji_type: emojiType,
        stage,
        reaction_error: error.message
      }
    }
  }

  async function addFeishuStatusReactionToMessages({
    sessionId = null,
    messages = [],
    stage,
    source = 'server_manager_runtime'
  }) {
    const messageIds = uniqueStringValues(messages.map((item) => item?.message_id))

    for (const messageId of messageIds) {
      await addFeishuStatusReaction({
        sessionId,
        messageId,
        stage,
        source
      })
    }
  }

  async function appendImmediateAckTimelineEvent(sessionId, immediateAck) {
    if (!immediateAck) {
      return
    }

    if (immediateAck.kind === 'reaction' && immediateAck.ok) {
      if (immediateAck.message_id) {
        feishuReactionStateByMessageId.set(immediateAck.message_id, {
          stage: 'received',
          emoji_type: immediateAck.emoji_type ?? null,
          reaction_id: immediateAck.reaction_id ?? null
        })
      }

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'assistant_reaction_added',
        actor: 'assistant:manager',
        payload: {
          message_id: immediateAck.message_id ?? null,
          emoji_type: immediateAck.emoji_type ?? null,
          reaction_id: immediateAck.reaction_id ?? null,
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
          reaction_id: immediateAck.reaction_id ?? null,
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

  function extractFeishuMessageId(response, fallback = null) {
    return response?.data?.message_id
      ?? response?.payload?.data?.message_id
      ?? fallback
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
        const response = await feishuGateway.replyTextMessage({
          messageId: message.message_id,
          text
        })

        return {
          ok: true,
          transport: 'reply',
          message_id: extractFeishuMessageId(response, message.message_id)
        }
      } catch (replyError) {
        if (message?.chat_id) {
          try {
            const response = await feishuGateway.sendTextMessage({
              receiveIdType: 'chat_id',
              receiveId: message.chat_id,
              text
            })

            return {
              ok: true,
              transport: 'chat',
              message_id: extractFeishuMessageId(response, message.message_id),
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
      const response = await feishuGateway.sendTextMessage({
        receiveIdType: 'chat_id',
        receiveId: message.chat_id,
        text
      })

      return {
        ok: true,
        transport: 'chat',
        message_id: extractFeishuMessageId(response),
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

  async function updateFeishuText({
    messageId,
    text
  }) {
    if (!feishuGateway || !messageId || typeof feishuGateway.updateTextMessage !== 'function') {
      return {
        ok: false,
        error: 'Missing Feishu message update support'
      }
    }

    try {
      const response = await feishuGateway.updateTextMessage({
        messageId,
        text
      })

      return {
        ok: true,
        transport: 'update',
        message_id: extractFeishuMessageId(response, messageId)
      }
    } catch (error) {
      return {
        ok: false,
        message_id: messageId,
        reply_error: error.message
      }
    }
  }

  async function sendFeishuInteractiveCard({
    message,
    card
  }) {
    if (!feishuGateway) {
      return {
        ok: false,
        error: 'Missing Feishu gateway'
      }
    }

    if (message?.message_id && typeof feishuGateway.replyInteractiveCard === 'function') {
      try {
        const response = await feishuGateway.replyInteractiveCard({
          messageId: message.message_id,
          card
        })

        return {
          ok: true,
          transport: 'reply',
          message_id: extractFeishuMessageId(response, message.message_id)
        }
      } catch (replyError) {
        if (message?.chat_id && typeof feishuGateway.sendInteractiveCard === 'function') {
          try {
            const response = await feishuGateway.sendInteractiveCard({
              receiveIdType: 'chat_id',
              receiveId: message.chat_id,
              card
            })

            return {
              ok: true,
              transport: 'chat',
              message_id: extractFeishuMessageId(response, message.message_id),
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

    if (!message?.chat_id || typeof feishuGateway.sendInteractiveCard !== 'function') {
      return {
        ok: false,
        error: 'Missing Feishu interactive card support'
      }
    }

    try {
      const response = await feishuGateway.sendInteractiveCard({
        receiveIdType: 'chat_id',
        receiveId: message.chat_id,
        card
      })

      return {
        ok: true,
        transport: 'chat',
        message_id: extractFeishuMessageId(response),
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

  async function appendFeishuReplyTimeline({
    sessionId = null,
    stage,
    delivery,
    content,
    format = 'text',
    action = 'send'
  }) {
    if (!sessionId) {
      return
    }

    const eventKind = action === 'update'
      ? 'assistant_message_updated'
      : 'assistant_message_added'

    await sessionStore.appendTimelineEvent(sessionId, {
      kind: eventKind,
      actor: 'assistant:manager',
      payload: {
        content,
        stage,
        format,
        action,
        transport: delivery.transport ?? null,
        message_id: delivery.message_id ?? null,
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
        format,
        action,
        transport: delivery.transport ?? null,
        message_id: delivery.message_id ?? null,
        chat_id: delivery.chat_id ?? null
      }
    })
  }

  async function deliverFeishuReply({
    sessionId = null,
    message,
    text = null,
    stage,
    format = 'text',
    card = null,
    timelineContent = null
  }) {
    const delivery = format === 'interactive'
      ? await sendFeishuInteractiveCard({
          message,
          card
        })
      : await sendFeishuText({
          message,
          text
        })

    if (delivery.ok) {
      await appendFeishuReplyTimeline({
        sessionId,
        stage,
        delivery,
        content: timelineContent ?? text ?? null,
        format,
        action: 'send'
      })

      return delivery
    }

    if (sessionId) {
      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'channel_reply_failed',
        actor: 'assistant:manager',
        payload: {
          stage,
          format,
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
          format,
          error: delivery.error ?? null,
          reply_error: delivery.reply_error ?? null,
          chat_error: delivery.chat_error ?? null
        }
      })
    }

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
    message,
    operatorProfile
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
        async update() {},
        wasSent() {
          return false
        }
      }
    }

    let stopped = false
    let sent = false
    let lastText = null
    let flushPromise = null

    async function publish(text, stage) {
      if (stopped || !text || text === lastText) {
        return null
      }

      lastText = text
      sent = true
      flushPromise = Promise.resolve()
        .then(async () => {
          return deliverFeishuReply({
            sessionId,
            message,
            text,
            stage,
            format: 'text',
            timelineContent: text
          })
        })
        .catch(async (error) => {
          await sessionStore.appendTimelineEvent(sessionId, {
            kind: 'channel_reply_failed',
            actor: 'assistant:manager',
            payload: {
              stage,
              reply_error: error.message
            }
          })
        })

      return flushPromise
    }

    const initialStage = buildFeishuProgressText({
      operatorProfile,
      stage: 'planning'
    })
    const timer = operatorProfile.response_mode === 'fast'
      ? null
      : setTimeoutFn(() => {
          if (stopped) {
            return
          }

          publish(initialStage, 'progress_ack')
        }, progressReplyDelayMs)

    return {
      async stop() {
        stopped = true
        if (timer) {
          clearTimeoutFn(timer)
        }

        if (flushPromise) {
          await flushPromise
        }
      },
      async update({ stage = 'progress_update', text = null, planning = null, latestRun = null, totalRuns = 0 } = {}) {
        const nextText = text ?? buildFeishuProgressText({
          operatorProfile,
          stage,
          planning,
          latestRun,
          totalRuns
        })

        await publish(nextText, stage)
      },
      wasSent() {
        return sent
      }
    }
  }

  function updateFeishuRunProgressState(runState, updates = {}) {
    if (!runState) {
      return
    }

    if (updates.phase) {
      runState.phase = updates.phase
    }

    if (updates.planning !== undefined) {
      runState.planning = updates.planning
    }

    if (updates.latestRun !== undefined) {
      runState.latest_run = updates.latestRun
    }

    if (updates.executionRuns !== undefined) {
      runState.execution_runs = updates.executionRuns
    }
  }

  function isMatchingFeishuExtensionMessage(message, request) {
    if (!request) {
      return false
    }

    if (request.chat_id && message?.chat_id && request.chat_id !== message.chat_id) {
      return false
    }

    if (
      request.sender_open_id
      && (message?.sender_open_id ?? message?.sender_user_id)
      && request.sender_open_id !== (message.sender_open_id ?? message.sender_user_id)
    ) {
      return false
    }

    return true
  }

  async function maybeResolveFeishuTimeExtensionDecision(message) {
    const activeRun = feishuRuntimeState.active_run
    const request = activeRun?.extension_request ?? null

    if (!request || !isMatchingFeishuExtensionMessage(message, request)) {
      return null
    }

    const parsedCommand = parseFeishuControlCommand(message)
    let approved = null

    if (parsedCommand?.command === 'stop' || isNegativeConfirmationMessage(message)) {
      approved = false
    } else if (isPositiveConfirmationMessage(message)) {
      approved = true
    }

    if (approved == null) {
      return null
    }

    request.resolveDecision({
      approved,
      decision: approved ? 'operator_approved' : 'operator_denied'
    })

    const ackText = approved ? '收到，我继续推进。' : '收到，这轮先停在这里。'

    await deliverFeishuReply({
      sessionId: request.session_id,
      message,
      text: ackText,
      stage: 'timeout_extension_reply',
      format: 'text',
      timelineContent: ackText
    })

    return {
      session_id: request.session_id,
      ack_text: ackText,
      planning: null,
      execution: null,
      command_name: 'timeout_extension'
    }
  }

  function createFeishuRunTimeboxController({
    sessionId,
    channel,
    message,
    runState,
    progressNotifier,
    shouldReply
  }) {
    if (
      channel !== 'feishu'
      || !runState
      || !shouldReply
    ) {
      return {
        async flush() {
          return {
            stop: false
          }
        },
        async stop() {}
      }
    }

    let stopped = false
    const timers = []

    function schedule(delayMs, callback) {
      if (delayMs == null || delayMs < 0) {
        return
      }

      const timer = setTimeoutFn(() => {
        Promise.resolve()
          .then(() => callback())
          .catch(() => {})
      }, delayMs)

      timer?.unref?.()
      timers.push(timer)
    }

    schedule(longRunningFeedbackMs, async () => {
      if (stopped || runState.warning_sent) {
        return
      }

      runState.warning_sent = true
      const text = buildFeishuLongRunningFeedbackText(runState, nowFn())

      await progressNotifier.update({
        stage: 'timeout_warning',
        text
      })
    })

    schedule(longRunningCheckpointMs, async () => {
      if (stopped || runState.extension_handled) {
        return
      }

      runState.extension_due = true
    })

    schedule(longRunningFinalStopMs, async () => {
      if (stopped || runState.final_timeout_handled) {
        return
      }

      runState.final_timeout_due = true
    })

    async function requestMoreTime() {
      const reviewText = buildFeishuTimeoutReviewText(runState, nowFn(), {
        askForExtension: true
      })

      await deliverFeishuReply({
        sessionId,
        message,
        text: reviewText,
        stage: 'timeout_extension_request',
        format: 'text',
        timelineContent: reviewText
      })

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'manager_timeout_extension_requested',
        actor: 'manager:runtime',
        payload: {
          timeout_ms: longRunningCheckpointMs,
          extension_timeout_ms: longRunningExtensionApprovalMs
        }
      })

      return new Promise((resolve) => {
        let resolved = false
        const timer = setTimeoutFn(() => {
          resolveDecision({
            approved: true,
            decision: 'default_approved'
          })
        }, longRunningExtensionApprovalMs)

        timer?.unref?.()

        function resolveDecision(decision) {
          if (resolved) {
            return
          }

          resolved = true
          clearTimeoutFn(timer)

          if (runState.extension_request?.id === request.id) {
            runState.extension_request = null
          }

          resolve(decision)
        }

        const request = {
          id: createUlid(nowFn()),
          session_id: sessionId,
          chat_id: message?.chat_id ?? null,
          sender_open_id: message?.sender_open_id ?? message?.sender_user_id ?? null,
          resolveDecision
        }

        runState.extension_request = request
      })
    }

    async function flush({
      allowContinue = true
    } = {}) {
      if (stopped) {
        return {
          stop: false
        }
      }

      if (runState.final_timeout_due && !runState.final_timeout_handled) {
        runState.final_timeout_handled = true
        const reviewText = buildFeishuTimeoutReviewText(runState, nowFn(), {
          finalStop: true
        })

        await deliverFeishuReply({
          sessionId,
          message,
          text: reviewText,
          stage: 'timeout_final_stop',
          format: 'text',
          timelineContent: reviewText
        })

        runState.stop_requested = true
        runState.stop_stage = 'timeout_final_stop'

        return {
          stop: true,
          stage: 'timeout_final_stop'
        }
      }

      if (allowContinue && runState.extension_due && !runState.extension_handled) {
        runState.extension_due = false
        runState.extension_handled = true
        const decision = await requestMoreTime()

        await sessionStore.appendTimelineEvent(sessionId, {
          kind: 'manager_timeout_extension_resolved',
          actor: 'manager:runtime',
          payload: {
            decision: decision.decision
          }
        })

        if (!decision.approved) {
          runState.stop_requested = true
          runState.stop_stage = 'timeout_extension_denied'

          return {
            stop: true,
            stage: 'timeout_extension_denied'
          }
        }

        runState.extension_granted = true
      }

      return {
        stop: false
      }
    }

    return {
      async flush(options = {}) {
        return flush(options)
      },
      async stop() {
        stopped = true

        for (const timer of timers) {
          clearTimeoutFn(timer)
        }

        if (runState.extension_request) {
          runState.extension_request.resolveDecision({
            approved: true,
            decision: 'runtime_stopped'
          })
        }
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

  function clearQueuedFeishuEntries(reason = 'operator_cleared_queue') {
    const pendingEntries = feishuInboundQueue.pending.splice(0)

    for (const entry of pendingEntries) {
      entry.resolve?.({
        session_id: null,
        ack_text: reason,
        planning: null,
        execution: null,
        canceled: true
      })
    }

    return pendingEntries.length
  }

  async function abortFeishuSessionAtSafePoint(sessionId, reason = 'operator_stop_command') {
    if (!sessionId) {
      return null
    }

    let snapshot = null

    try {
      snapshot = await sessionStore.loadSession(sessionId)
    } catch {
      return null
    }

    if (['completed', 'aborted', 'failed'].includes(snapshot.session.status)) {
      return snapshot
    }

    return sessionStore.abortSession(sessionId, {
      reason
    })
  }

  async function buildFeishuStatusReply() {
    const operatorProfile = await loadFeishuOperatorProfile()
    const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
    const sessionId = feishuRuntimeState.active_run?.session_id ?? channelState?.session_id ?? null
    const lines = [
      `当前模式：${buildFeishuResponseModeLabel(operatorProfile.response_mode)}`,
      `排队消息：${feishuInboundQueue.pending.length}`
    ]

    if (feishuRuntimeState.active_run?.stop_stage === 'operator_stopnow_command') {
      lines.push('当前状态：已收到 /stopnow，正在立即终止当前命令。')
    } else if (feishuRuntimeState.active_run?.stop_requested) {
      lines.push('当前状态：已收到停止请求，正在最近的安全点停下。')
    } else if (feishuRuntimeState.active_run) {
      lines.push('当前状态：正在处理。')
    } else {
      lines.push('当前状态：空闲。')
    }

    if (sessionId) {
      try {
        const snapshot = await sessionStore.loadSession(sessionId)
        const currentStep = snapshot.plan_steps.find(
          (step) => step.id === snapshot.task.current_step_id
        ) ?? null

        lines.push(`会话：${sessionId}`)
        lines.push(`会话状态：${snapshot.session.status}`)

        if (currentStep?.title) {
          lines.push(`当前步骤：${currentStep.title}`)
        }
      } catch {}
    }

    lines.push(buildFeishuCommandHintText())

    return {
      session_id: sessionId,
      text: lines.join('\n')
    }
  }

  async function maybeHandleFeishuControlCommand({
    message,
    autoReply = true,
    autoPlan = true,
    autoExecuteSafeInspect = true
  }) {
    const parsed = parseFeishuControlCommand(message)

    if (!parsed) {
      return null
    }

    if (parsed.command === 'help') {
      const ackText = `可用命令：\n${buildFeishuCommandHintText()}`

      await deliverFeishuReply({
        message,
        text: ackText,
        stage: 'command_reply'
      })

      return {
        session_id: null,
        ack_text: ackText,
        planning: null,
        execution: null,
        command_name: 'help'
      }
    }

    if (parsed.command === 'status') {
      const status = await buildFeishuStatusReply()

      await deliverFeishuReply({
        sessionId: status.session_id,
        message,
        text: status.text,
        stage: 'command_reply'
      })

      return {
        session_id: status.session_id,
        ack_text: status.text,
        planning: null,
        execution: null,
        command_name: 'status'
      }
    }

    if (parsed.command === 'fast' || parsed.command === 'thinking') {
      const operatorProfile = await writeFeishuOperatorProfile({
        response_mode: parsed.command
      })
      const ackText = parsed.argument
        ? `已切到 ${parsed.command === 'fast' ? '快回' : '思考'}模式，继续处理你刚补的请求。思考模式下我会展示推理过程和中间步骤。`
        : `已切到 ${parsed.command === 'fast' ? '快回' : '思考'}模式。思考模式下我会展示推理过程和中间步骤。`

      await deliverFeishuReply({
        message,
        text: ackText,
        stage: 'command_reply'
      })

      if (parsed.argument) {
        enqueueFeishuMessage({
          message: {
            ...message,
            text: parsed.argument
          },
          options: {
            autoReply,
            autoPlan,
            autoExecuteSafeInspect
          },
          resolve() {},
          reject() {}
        })
      }

      return {
        session_id: null,
        ack_text: ackText,
        planning: null,
        execution: null,
        command_name: parsed.command
      }
    }

    if (parsed.command === 'appendmsg') {
      if (!parsed.argument) {
        const ackText = '用法：/appendmsg 你的补充建议'

        await deliverFeishuReply({
          message,
          text: ackText,
          stage: 'command_reply'
        })

        return {
          session_id: null,
          ack_text: ackText,
          planning: null,
          execution: null,
          command_name: 'appendmsg'
        }
      }

      enqueueFeishuMessage({
        message: {
          ...message,
          text: buildFeishuAppendSuggestion(parsed.argument)
        },
        options: {
          autoReply,
          autoPlan,
          autoExecuteSafeInspect
        },
        resolve() {},
        reject() {}
      })

      const ackText = '已追加到当前任务，当前轮结束后会自动接上。'

      await deliverFeishuReply({
        sessionId: feishuRuntimeState.active_run?.session_id ?? null,
        message,
        text: ackText,
        stage: 'command_reply'
      })

      return {
        session_id: feishuRuntimeState.active_run?.session_id ?? null,
        ack_text: ackText,
        planning: null,
        execution: null,
        command_name: 'appendmsg',
        queued: true
      }
    }

    if (parsed.command === 'stop') {
      const activeRun = feishuRuntimeState.active_run
      const clearedCount = clearQueuedFeishuEntries('stopped_by_operator')

      if (activeRun) {
        activeRun.stop_requested = true
        activeRun.stop_stage = 'operator_stop_command'
      } else {
        const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
        await abortFeishuSessionAtSafePoint(channelState?.session_id ?? null)
      }

      const ackText = activeRun
        ? `已收到 /stop，当前轮会在最近的安全点停下，排队消息已清空 ${clearedCount} 条。`
        : `已停止当前轮，排队消息已清空 ${clearedCount} 条。`

      await deliverFeishuReply({
        sessionId: activeRun?.session_id ?? null,
        message,
        text: ackText,
        stage: 'command_reply'
      })

      return {
        session_id: activeRun?.session_id ?? null,
        ack_text: ackText,
        planning: null,
        execution: null,
        command_name: 'stop',
        stopped: true
      }
    }

    if (parsed.command === 'stopnow') {
      const activeRun = feishuRuntimeState.active_run
      const clearedCount = clearQueuedFeishuEntries('stopped_now_by_operator')

      if (activeRun) {
        activeRun.stop_requested = true
        activeRun.stop_stage = 'operator_stopnow_command'
        activeRun.abort_controller?.abort(new Error('operator_stopnow_command'))
      } else {
        const channelState = await loadChannelState(FEISHU_UNIFIED_CHANNEL_KEY)
        await abortFeishuSessionAtSafePoint(channelState?.session_id ?? null, 'operator_stopnow_command')
      }

      const ackText = activeRun
        ? `已收到 /stopnow，正在立即终止当前命令，排队消息已清空 ${clearedCount} 条。`
        : `当前没有正在执行的命令，已清空排队消息 ${clearedCount} 条。`

      await deliverFeishuReply({
        sessionId: activeRun?.session_id ?? null,
        message,
        text: ackText,
        stage: 'command_reply'
      })

      return {
        session_id: activeRun?.session_id ?? null,
        ack_text: ackText,
        planning: null,
        execution: null,
        command_name: 'stopnow',
        stopped: true
      }
    }

    return null
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
    const feishuRunState = channel === 'feishu'
      ? {
          id: createUlid(nowFn()),
          stop_requested: false,
          stop_stage: null,
          abort_controller: typeof AbortController === 'function' ? new AbortController() : null,
          session_id: null,
          started_at_ms: nowFn(),
          phase: 'received',
          planning: null,
          latest_run: null,
          execution_runs: [],
          warning_sent: false,
          extension_due: false,
          extension_handled: false,
          extension_granted: false,
          extension_request: null,
          final_timeout_due: false,
          final_timeout_handled: false
        }
      : null
    let sessionId = null
    let planning = null
    let execution = null
    let directReply = null
    let ackText = null
    let feedbackAck = null
    let finalReplyError = null
    let suppressFinalReply = false
    let operatorProfile = normalizeFeishuOperatorProfile()
    let progressNotifier = {
      async stop() {},
      async update() {},
      wasSent() {
        return false
      }
    }
    let timeboxController = {
      async flush() {
        return {
          stop: false
        }
      },
      async stop() {}
    }

    if (feishuRunState) {
      feishuRuntimeState.active_run = feishuRunState
    }

    try {
      await ensureServerBaseline()
      if (channel === 'feishu') {
        operatorProfile = await loadFeishuOperatorProfile()
      }

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
      sessionId = activeTurn.snapshot.session.id

      if (feishuRunState) {
        feishuRunState.session_id = sessionId
      }

      const channelMessages = listOperatorMessages(message)
      if (channel === 'feishu') {
        rememberFeishuImmediateAckReactions(channelMessages)
      }

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

      if (shouldReply && channel === 'feishu') {
        await addFeishuStatusReactionToMessages({
          sessionId,
          messages: channelMessages,
          stage: 'processing'
        })
      }

      progressNotifier = shouldReply
        ? createDelayedFeishuProgressNotifier({
            sessionId,
            channel,
            message,
            operatorProfile
          })
        : progressNotifier
      timeboxController = createFeishuRunTimeboxController({
        sessionId,
        channel,
        message,
        runState: feishuRunState,
        progressNotifier,
        shouldReply
      })

      ackText = activeTurn.kind === 'continued'
        ? `已收到，继续沿用总管会话 ${sessionId}。`
        : `已收到，总管会话 ${sessionId} 已创建。`

      try {
        updateFeishuRunProgressState(feishuRunState, {
          phase: 'preparing'
        })
        assertFeishuRunActive(feishuRunState, 'before_feedback_learning')
        const feedbackLearning = await learnOperatorFeedback({
          sessionId,
          channel,
          message
        })
        feedbackAck = buildFeedbackLearningAck(feedbackLearning)

        if (feedbackAck) {
          ackText = `${ackText}\n${feedbackAck}`
        }

        if (channel === 'feishu') {
          await maybeCompactFeishuContext({
            sessionId,
            currentTaskId: activeTurn.snapshot.task.id
          })
        }

        assertFeishuRunActive(feishuRunState, 'after_compaction')

        const currentSnapshot = await sessionStore.loadSession(sessionId)
        const attentionContext = channel === 'feishu'
          ? buildFeishuAttentionContext({
              message,
              snapshot: currentSnapshot
            })
          : null

        if (isLightweightPing(message)) {
          updateFeishuRunProgressState(feishuRunState, {
            phase: 'completed'
          })
          ackText = buildLightweightPingReply()
          await completePingSession({
            sessionId,
            replyText: ackText
          })
        } else if (
          channel === 'feishu'
          && shouldUseFeishuConversationReply({
            message,
            attentionContext
          })
        ) {
          updateFeishuRunProgressState(feishuRunState, {
            phase: 'completed'
          })
          directReply = await answerFeishuConversationQuestion({
            sessionId,
            message,
            snapshot: currentSnapshot,
            attentionContext,
            continuity: activeTurn.continuity
          })
          ackText = directReply.text
          await completeConversationReplySession({
            sessionId,
            replyText: directReply.text,
            relation: attentionContext.relation
          })
        } else if (autoPlan && bailianProvider) {
          updateFeishuRunProgressState(feishuRunState, {
            phase: 'planning'
          })
          planning = await planSession({
            sessionId,
            message,
            attentionContext,
            shouldStop: () => feishuRunState?.stop_requested === true
          })
          updateFeishuRunProgressState(feishuRunState, {
            phase: 'planned',
            planning
          })
          const shouldStreamProgress = channel === 'feishu'
            && isComplexFeishuReply({
              operatorProfile,
              message,
              planning,
              execution
            })

          if (shouldStreamProgress) {
            await progressNotifier.update({
              stage: 'planned',
              planning
            })
          }

          ackText = activeTurn.kind === 'continued'
            ? `已收到，继续沿用总管会话 ${sessionId}。`
            : `已收到，总管会话 ${sessionId} 已创建。`

          if (feedbackAck) {
            ackText = `${ackText}\n${feedbackAck}`
          }

          ackText = `${ackText}\n${planning.plan.operator_reply}`

          const allowAutoExecute = autoExecuteSafeInspect && planning.review?.verdict !== 'block'

          const checkpointAfterPlanning = await timeboxController.flush({
            allowContinue: allowAutoExecute
          })

          if (checkpointAfterPlanning.stop) {
            throw new FeishuRunStoppedError(checkpointAfterPlanning.stage)
          }

          if (!allowAutoExecute && planning.review?.verdict === 'block') {
            ackText = `${ackText}\n外部复核要求先人工确认，本轮暂不自动推进。`
          }

          assertFeishuRunActive(feishuRunState, 'after_planning')

          if (allowAutoExecute) {
            updateFeishuRunProgressState(feishuRunState, {
              phase: 'executing'
            })
            execution = await managerExecutor.runManagerLoop({
              sessionId,
              currentInput: buildOperatorRequest(message),
              maxSteps: 4,
              abortSignal: feishuRunState?.abort_controller?.signal ?? null,
              onProgress: async ({ result, runs }) => {
                updateFeishuRunProgressState(feishuRunState, {
                  phase: result.status === 'waiting_approval' ? 'waiting_approval' : 'executing',
                  latestRun: result,
                  executionRuns: runs
                })

                if (!shouldStreamProgress) {
                  const checkpoint = await timeboxController.flush({
                    allowContinue: result.status === 'planned'
                  })

                  if (checkpoint.stop) {
                    throw new FeishuRunStoppedError(checkpoint.stage)
                  }

                  return
                }

                await progressNotifier.update({
                  stage: result.status === 'waiting_approval' ? 'waiting_approval' : 'executing',
                  planning,
                  latestRun: result,
                  totalRuns: runs.length
                })

                const checkpoint = await timeboxController.flush({
                  allowContinue: result.status === 'planned'
                })

                if (checkpoint.stop) {
                  throw new FeishuRunStoppedError(checkpoint.stage)
                }
              },
              shouldStop: () => feishuRunState?.stop_requested === true
            })

            if (execution?.status === 'stopped') {
              throw new FeishuRunStoppedError(
                feishuRunState?.stop_stage ?? 'manager_loop_stopped'
              )
            }

            if (execution?.status === 'waiting_approval') {
              const pendingApproval = execution.approvals?.find(
                (approval) => approval.status === 'pending'
              ) ?? null

              if (channel === 'feishu' && pendingApproval?.tool_name === 'run_shell_command') {
                const autoExecuteReport = buildFeishuAutoExecuteReportText(pendingApproval)
                const continued = await managerExecutor.continueApprovedManagerStep({
                  sessionId,
                  approvalId: pendingApproval.id,
                  currentInput: buildOperatorRequest(message),
                  resolvedBy: 'manager:auto_report',
                  resolutionNote: 'auto_execute_after_report',
                  abortSignal: feishuRunState?.abort_controller?.signal ?? null
                })
                let continuedRuns = [...execution.runs, continued]

                ackText = `${ackText}\n${autoExecuteReport}`

                if (continued.status === 'planned') {
                  const tail = await managerExecutor.runManagerLoop({
                    sessionId,
                    currentInput: buildOperatorRequest(message),
                    maxSteps: 4,
                    abortSignal: feishuRunState?.abort_controller?.signal ?? null,
                    onProgress: async ({ result, runs }) => {
                      updateFeishuRunProgressState(feishuRunState, {
                        phase: result.status === 'waiting_approval' ? 'waiting_approval' : 'executing',
                        latestRun: result,
                        executionRuns: [...continuedRuns, ...runs]
                      })
                    },
                    shouldStop: () => feishuRunState?.stop_requested === true
                  })
                  execution = {
                    ...tail,
                    runs: [...continuedRuns, ...tail.runs]
                  }
                } else {
                  const latestSnapshot = await sessionStore.loadSession(sessionId)
                  execution = {
                    status: continued.status,
                    runs: continuedRuns,
                    report_text: continued.report_text ?? execution.report_text ?? null,
                    session: latestSnapshot.session,
                    task: latestSnapshot.task,
                    plan_steps: latestSnapshot.plan_steps,
                    approvals: latestSnapshot.approvals
                  }
                }

                await emitHook({
                  name: 'manager.approval.auto_execute_reported',
                  sessionId,
                  actor: 'manager:executor',
                  payload: {
                    tool_name: pendingApproval.tool_name
                  }
                })
              }
            }

            if (execution?.status === 'stopped') {
              throw new FeishuRunStoppedError(
                feishuRunState?.stop_stage ?? 'manager_loop_stopped'
              )
            }

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
        }
      } catch (error) {
        if (error instanceof FeishuRunStoppedError) {
          suppressFinalReply = true
          ackText = '已停止当前轮。'
          await abortFeishuSessionAtSafePoint(sessionId)
          await sessionStore.appendTimelineEvent(sessionId, {
            kind: 'manager_run_stopped',
            actor: 'manager:runtime',
            payload: {
              stage: error.stage
            }
          })
        } else {
          finalReplyError = error.message
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
      } finally {
        await timeboxController.stop()
        await progressNotifier.stop()
      }

      if (
        shouldReply &&
        channel === 'feishu' &&
        feishuGateway &&
        (message.message_id || message.chat_id) &&
        !suppressFinalReply
      ) {
        const finalReactionStage = finalReplyError
          ? 'failed'
          : execution?.status === 'waiting_approval'
            ? 'waiting_approval'
            : 'completed'

        await addFeishuStatusReactionToMessages({
          sessionId,
          messages: channelMessages,
          stage: finalReactionStage
        })

        const finalText = buildFeishuFinalReplyText({
          operatorProfile,
          planning,
          execution,
          feedbackAck,
          error: finalReplyError
        }) || ackText
        const resolvedFinalText = directReply?.text ?? finalText
        const useInteractiveReply = directReply
          ? operatorProfile.enable_markdown && shouldUseConversationCard(directReply.text)
          : operatorProfile.enable_markdown
            && isComplexFeishuReply({
              operatorProfile,
              message,
              planning,
              execution
            })

        if (useInteractiveReply) {
          await deliverFeishuReply({
            sessionId,
            message,
            stage: 'final_reply',
            format: 'interactive',
            card: directReply
              ? buildFeishuConversationCard({
                  title: '当前情况',
                  content: directReply.text
                })
              : buildFeishuReplyCard({
                  operatorProfile,
                  planning,
                  execution,
                  feedbackAck,
                  error: finalReplyError
                }),
            timelineContent: resolvedFinalText
          })
        } else {
          await deliverFeishuReply({
            sessionId,
            message,
            text: resolvedFinalText,
            stage: 'final_reply',
            format: 'text',
            timelineContent: resolvedFinalText
          })
        }
      }

      return {
        session_id: sessionId,
        ack_text: ackText,
        planning,
        execution,
        direct_reply: directReply,
        stopped: suppressFinalReply
      }
    } finally {
      if (suppressFinalReply && sessionId && channel === 'feishu') {
        await addFeishuStatusReactionToMessages({
          sessionId,
          messages: listOperatorMessages(message),
          stage: 'stopped'
        })
      }

      if (feishuRuntimeState.active_run === feishuRunState) {
        feishuRuntimeState.active_run = null
      }

      if (channel === 'feishu' && !suppressFinalReply && !finalReplyError) {
        scheduleFeishuBackgroundPrecomputeSoon()
      }
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
      seedAliyun,
      preserveExisting: true
    })
    const state = await feishuGateway.start({
      immediateReactionEmojiType: autoReply ? buildImmediateFeishuReaction() : null,
      immediateReplyText: autoReply ? buildImmediateFeishuAck() : null,
      onMessage: async (message) => {
        const extensionDecision = await maybeResolveFeishuTimeExtensionDecision(message)

        if (extensionDecision) {
          return extensionDecision
        }

        const commandResult = await maybeHandleFeishuControlCommand({
          message,
          autoReply,
          autoPlan,
          autoExecuteSafeInspect
        })

        if (commandResult) {
          return commandResult
        }

        const normalizedMessage = feishuRuntimeState.active_run && shouldAutoAppendFeishuFollowUp(message)
          ? buildAutoAppendedFeishuMessage(message)
          : message
        rememberFeishuImmediateAckReactions([normalizedMessage])

        if (feishuRuntimeState.active_run?.session_id && normalizedMessage.message_id) {
          await addFeishuStatusReaction({
            sessionId: feishuRuntimeState.active_run.session_id,
            messageId: normalizedMessage.message_id,
            stage: 'queued',
            source: 'feishu_inbound_queue'
          })
        }

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
      bootstrap,
      channel_state: state,
      maintenance_state: {
        started: maintenance.started,
        poll_interval_ms: maintenance.poll_interval_ms,
        background_precompute_enabled: managerProfile.background_precompute?.enabled === true
      }
    }
  }

  return {
    bootstrapServerBaseline,
    ensureServerBaseline,
    planSession,
    handleChannelMessage,
    requestCoworkerHelp,
    resolveCoworkerRequest,
    runFeishuMaintenanceOnce,
    runFeishuBackgroundPrecomputeOnce,
    startFeishuLoop
  }
}
