function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeForMatch(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\s+/g, '')
}

function includesAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(needle))
}

function uniqueTags(tags = []) {
  return [...new Set(tags.filter(Boolean))]
}

function feedbackPriority(kind) {
  switch (kind) {
    case 'operating_rule':
      return 0
    case 'anti_pattern':
      return 1
    case 'preference':
      return 2
    case 'constraint':
      return 3
    case 'decision':
      return 4
    case 'fact':
      return 5
    default:
      return 10
  }
}

export function prioritizeFeedbackEntries(entries = []) {
  return [...entries].sort((left, right) => {
    const priority = feedbackPriority(left.kind) - feedbackPriority(right.kind)

    if (priority !== 0) {
      return priority
    }

    const leftTime = String(left.updated_at ?? left.created_at ?? '')
    const rightTime = String(right.updated_at ?? right.created_at ?? '')

    return rightTime.localeCompare(leftTime)
  })
}

export function extractFeedbackMemoryCandidates({
  messageText,
  channel = null
}) {
  const normalized = normalizeForMatch(messageText)

  if (!normalized) {
    return []
  }

  const channelTag = String(channel ?? '').toLowerCase()
  const baseTags = uniqueTags([
    'feedback',
    'feedback_rule',
    'operator_experience',
    channelTag || null
  ])
  const candidates = new Map()
  const mentionsFeishu = channelTag === 'feishu' || normalized.includes('飞书')
  const mentionsResponseFlow = includesAny(normalized, [
    '回应',
    '回复',
    '已读',
    'reaction',
    'emoji',
    '表情',
    '消息',
    '响应'
  ])
  const mentionsProgress = includesAny(normalized, [
    '思考',
    '排查',
    '理解',
    '进度',
    '过程输出',
    '流式输出',
    '流失输出',
    '外显'
  ])
  const wantsFastAck = includesAny(normalized, [
    '快速响应',
    '先快速响应',
    '秒回',
    '3秒内',
    '三秒内',
    '先回应',
    '先回复',
    '先给我一个已读',
    '先给我一个表情',
    '先给我表情',
    '第一时间给我一个已读'
  ])
  const wantsReaction = includesAny(normalized, [
    'reaction',
    'emoji',
    '表情',
    '文字评论表情'
  ])

  function addCandidate({
    kind,
    content,
    tags = []
  }) {
    if (candidates.has(content)) {
      return
    }

    candidates.set(content, {
      kind,
      content,
      tags: uniqueTags([...baseTags, ...tags])
    })
  }

  if ((mentionsFeishu || mentionsResponseFlow) && (wantsFastAck || wantsReaction)) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '飞书来消息后先快速确认收到，优先使用表情 reaction；不要等完整规划结束再回应。',
      tags: ['feishu', 'latency', 'ack']
    })
  }

  if (
    mentionsFeishu &&
    includesAny(normalized, [
      '不是已读回执',
      '不是已读',
      '文字评论表情',
      '评论表情'
    ])
  ) {
    addCandidate({
      kind: 'preference',
      content: '飞书已读优先使用原消息 reaction，而不是发送单独的已读文本。',
      tags: ['feishu', 'ack', 'reaction']
    })
  }

  if (
    (mentionsFeishu || mentionsResponseFlow) &&
    includesAny(normalized, [
      '太慢',
      '10秒',
      '十秒',
      '3秒内',
      '三秒内',
      '没响应',
      '一直没回',
      '一直都没回',
      '干等',
      '等10秒',
      '等十秒'
    ])
  ) {
    addCandidate({
      kind: 'anti_pattern',
      content:
        '不要让飞书消息长时间静默；目标是在 3 秒内给出已读、reaction 或进度回复。',
      tags: ['feishu', 'latency']
    })
  }

  if (
    includesAny(normalized, [
      '难题',
      '先弄明白我要干嘛',
      '先弄明白',
      '思考一下',
      '先理解',
      '正在排查',
      '先排查',
      '稍后给你结论'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content: '复杂问题先说明正在理解或排查，再给正式结论。',
      tags: ['progress', 'clarify']
    })
  }

  if (
    mentionsProgress &&
    includesAny(normalized, [
      '思考过程',
      '过程输出',
      '流式输出',
      '流失输出',
      '进度',
      '外显'
    ])
  ) {
    addCandidate({
      kind: 'preference',
      content: '处理过程中持续外显简短进度，让用户知道当前在理解、排查还是等待审批。',
      tags: ['progress', 'visibility']
    })
  }

  if (
    includesAny(normalized, ['在不', '在吗', '在吗?', '在吗？']) &&
    includesAny(normalized, ['没响应', '一直没回', '一直都没回', '也要等'])
  ) {
    addCandidate({
      kind: 'anti_pattern',
      content: '像“在不”“在吗”这种短 ping 直接确认在线，不要进入复杂规划。',
      tags: ['ping', 'latency']
    })
  }

  return [...candidates.values()]
}
