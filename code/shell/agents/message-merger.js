/**
 * 多轮消息合并判断
 * 判断飞书多轮消息是否属于"同一件事"
 */

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

const SAME_TASK_PATTERNS = [
  /顺便/,
  /还有/,
  /另外/,
  /对了/,
  /补充/,
  /修改/,
  /改成/,
  /不要/,
  /还是/,
  /同上/,
  /和上面/,
  /刚才那个/
]

const NEW_TASK_PATTERNS = [
  /^(帮我 | 麻烦 | 请 | 我想 | 我要 | 需要)/,
  /(新的 | 另一个 | 换个 | 重新来 | 重新开始)/,
  /^(好 | 好的 | 收到 | 谢谢 | 辛苦了)/,
  /(能不能 | 可以吗 | 行不行)/
]

function normalizeMessage(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[,.!?;:，。！？；：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractKeywords(text) {
  const normalized = normalizeMessage(text)
  const words = normalized.split(' ').filter(w => w.length >= 2)
  return words.slice(0, 5)
}

function jaccardSimilarity(setA, setB) {
  if (!setA || !setB || setA.length === 0 || setB.length === 0) {
    return 0
  }

  const a = new Set(setA)
  const b = new Set(setB)
  const intersection = new Set([...a].filter(x => b.has(x)))
  const union = new Set([...a, ...b])

  return intersection.size / union.size
}

function hasContinuationMarker(text) {
  const normalized = normalizeMessage(text)
  return SAME_TASK_PATTERNS.some(pattern => pattern.test(normalized))
}

function hasNewTaskMarker(text) {
  const normalized = normalizeMessage(text)
  return NEW_TASK_PATTERNS.some(pattern => pattern.test(normalized))
}

function isQuestionReply(currentText, previousText) {
  const current = normalizeMessage(currentText)
  const previous = normalizeMessage(previousText)

  const questionMarkers = ['吗', '呢', '吧', '何', '啥', '谁', '哪', '怎么', '为什么', '多少']
  const hasQuestion = questionMarkers.some(m => previous.includes(m))

  if (!hasQuestion) {
    return false
  }

  const answerMarkers = ['是', '对', '好', '可以', '行', '嗯', '哦', '对']
  return answerMarkers.some(m => current.startsWith(m))
}

function computeTimeWeight(timeGapMs, windowMs = 5 * 60 * 1000) {
  if (timeGapMs <= 0) return 1
  if (timeGapMs >= windowMs) return 0
  return 1 - (timeGapMs / windowMs)
}

export function shouldMergeMessages({
  currentMessage,
  previousMessage,
  timeGapMs,
  conversationHistory = []
}) {
  const currentText = cleanText(currentMessage?.text || '')
  const previousText = cleanText(previousMessage?.text || '')

  if (!currentText || !previousText) {
    return {
      shouldMerge: false,
      reason: 'empty_message',
      confidence: 0
    }
  }

  if (hasNewTaskMarker(currentText)) {
    return {
      shouldMerge: false,
      reason: 'new_task_marker',
      confidence: 0.9
    }
  }

  if (hasContinuationMarker(currentText)) {
    return {
      shouldMerge: true,
      reason: 'continuation_marker',
      confidence: 0.85
    }
  }

  if (isQuestionReply(currentText, previousText)) {
    return {
      shouldMerge: true,
      reason: 'question_reply',
      confidence: 0.8
    }
  }

  const currentKeywords = extractKeywords(currentText)
  const previousKeywords = extractKeywords(previousText)
  const keywordSimilarity = jaccardSimilarity(currentKeywords, previousKeywords)

  if (keywordSimilarity >= 0.4) {
    return {
      shouldMerge: true,
      reason: 'high_keyword_similarity',
      confidence: 0.7 + (keywordSimilarity * 0.3)
    }
  }

  const timeWeight = computeTimeWeight(timeGapMs)

  if (timeWeight >= 0.8 && keywordSimilarity >= 0.2) {
    return {
      shouldMerge: true,
      reason: 'time_proximity_with_context',
      confidence: 0.5 + (timeWeight * 0.3) + (keywordSimilarity * 0.2)
    }
  }

  if (conversationHistory.length > 0) {
    const recentTopics = conversationHistory
      .slice(-3)
      .flatMap(msg => extractKeywords(cleanText(msg.text || '')))

    const topicSimilarity = jaccardSimilarity(currentKeywords, recentTopics)

    if (topicSimilarity >= 0.3) {
      return {
        shouldMerge: true,
        reason: 'topic_continuity',
        confidence: 0.5 + (topicSimilarity * 0.4)
      }
    }
  }

  return {
    shouldMerge: false,
    reason: 'no_strong_signal',
    confidence: 1 - Math.max(keywordSimilarity, timeWeight)
  }
}

export function createMessageMerger({
  mergeWindowMs = 5 * 60 * 1000,
  maxConversationHistory = 10
} = {}) {
  const conversationHistory = []

  return {
    shouldMerge(currentMessage, previousMessage, timeGapMs) {
      return shouldMergeMessages({
        currentMessage,
        previousMessage,
        timeGapMs,
        conversationHistory: conversationHistory.slice(-maxConversationHistory)
      })
    },

    addToHistory(message) {
      conversationHistory.push({
        text: cleanText(message?.text || ''),
        timestamp: message?.timestamp || Date.now()
      })

      while (conversationHistory.length > maxConversationHistory) {
        conversationHistory.shift()
      }
    },

    clearHistory() {
      conversationHistory.length = 0
    },

    getHistory() {
      return [...conversationHistory]
    }
  }
}
