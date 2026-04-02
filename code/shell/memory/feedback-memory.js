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

  if (
    mentionsFeishu &&
    includesAny(normalized, [
      '引用消息',
      '引用并回复',
      '回复或引用',
      '严格遵照引用消息',
      '盖楼式讨论',
      '盖楼',
      '回复它的消息',
      '引用它的消息',
      'thread',
      '线程'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '飞书里如果 operator 明确回复或引用某条消息，优先沿着该引用线程继续回答，把这条线程当作最高连续上下文。',
      tags: ['feishu', 'thread', 'attention']
    })
  }

  if (
    includesAny(normalized, [
      '我的消息是最应该被关注',
      '当前消息最重要',
      '先回答当前问题',
      '不要自以为是',
      '不是它自以为是',
      'newagent的历史答复靠后一点',
      '历史答复靠后一点'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '先直接回答当前这条 operator 消息；被引用线程次之，旧 assistant 回复和历史上下文再次之。',
      tags: ['attention', 'priority']
    })
  }

  if (
    includesAny(normalized, [
      '不用一直说',
      '不用再提',
      '别一直说',
      '不要一直说',
      '别老说',
      '反复提',
      '这些不用一直说',
      '当前模式',
      '可继续补充',
      '需要停止'
    ])
  ) {
    addCandidate({
      kind: 'anti_pattern',
      content:
        '不要在普通回复里反复重复当前模式、可继续补充、停止说明或命令提示；除非用户主动询问。',
      tags: ['reply_style', 'boilerplate']
    })
  }

  if (
    includesAny(normalized, [
      '简单的事简短',
      '简单的事简短得回',
      '简单的事简短回复',
      '复杂的事要持续回馈',
      '复杂的事持续回馈',
      'markdown',
      '卡片',
      '有条有理'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '简单问题直接短答；复杂问题持续反馈关键进展，最后用清晰 markdown 结构收口。',
      tags: ['reply_style', 'markdown']
    })
  }

  if (
    includesAny(normalized, [
      '三句',
      '三段',
      '三段论',
      '第一句',
      '第二句',
      '第三句',
      '理解和情况调查',
      '什么要做什么不用做',
      '开始执行并和我互动'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '新的独立任务默认按三段式回复：先说理解与情况调查，再说准备怎么做和什么不用做，最后说开始执行并给出互动入口。',
      tags: ['reply_style', 'task_brief', 'triad']
    })
  }

  if (
    includesAny(normalized, [
      '连发好几条',
      '都讲同一件事',
      '同一件执行中的事',
      '同一件正在执行的任务',
      '直接并进当前任务',
      '别每次都重来一遍',
      '智能判断',
      '同一件事'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '如果连续多条消息仍在推进同一件执行中的事，优先并入当前任务并反馈最新进度，不要每次都重开完整三段式回复。',
      tags: ['continuity', 'task_merge', 'reply_style']
    })
  }

  if (
    includesAny(normalized, [
      '高自主权限',
      '我授权了',
      '自己决定',
      '别反复审批',
      '不用审批',
      '自动决定'
    ])
  ) {
    addCandidate({
      kind: 'constraint',
      content:
        '默认自行决定执行路径和内部工具选择；只有缺少关键参数、需要用户身份、或确实需要外部授权时再追问。',
      tags: ['autonomy', 'approval']
    })
  }

  if (
    includesAny(normalized, [
      '预制菜',
      '预案',
      '猜我关注',
      '猜我想问',
      '后台24小时整理',
      '免费ai',
      '不要闲着',
      '提前搞',
      '持续处理',
      '平时轻量'
    ])
  ) {
    addCandidate({
      kind: 'operating_rule',
      content:
        '空闲时持续用低成本模型预判下一问、预生成快答和预案，前台优先复用这些准备结果。',
      tags: ['background', 'latency', 'precompute']
    })
  }

  return [...candidates.values()]
}
