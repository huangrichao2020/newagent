/**
 * 记忆存储 - 双轨制设计
 * 1. 主 Agent 主动保存 (feedback_rule)
 * 2. 后台 Agent 自动提取 (confirmation_signal)
 * 互斥机制：主 Agent 写了，后台就不写
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic, appendJsonLine } from '../../storage/json-files.js'
import { createUlid } from '../session/session-store.js'

function nowIso() {
  return new Date().toISOString()
}

function cleanText(value) {
  return String(value ?? '').trim()
}

function normalizeForSignalMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[,.!?;:，。！？；：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const CONFIRMATION_SIGNALS = [
  '好的',
  '好的',
  '收到',
  '明白',
  '没问题',
  '可以',
  '行',
  '行的',
  '就这样',
  '就这样吧',
  '按这个来',
  '按这个做',
  '继续',
  '继续吧',
  'yes',
  'perfect',
  'exactly',
  'keep doing that',
  'keep it up',
  'good',
  'great',
  'excellent',
  '正确',
  '对的',
  '没错',
  '是这个意思',
  '理解了',
  '知道了'
]

const NEGATIVE_CONFIRMATION_SIGNALS = [
  '不',
  '不用',
  '先别',
  '别继续',
  '暂停',
  '先暂停',
  '停',
  '停止',
  'stop',
  'no',
  '不用继续',
  '先停下',
  '先别继续',
  '不要继续',
  '不对',
  '错了',
  '不是这个意思',
  '重新来'
]

export function createMemoryStore({ storageRoot }) {
  const memoryRoot = join(storageRoot, 'memory')
  const entriesRoot = join(memoryRoot, 'entries')

  function getMemoryFilePath(sessionId) {
    return join(entriesRoot, `${sessionId}.jsonl`)
  }

  async function ensureMemoryFile(sessionId) {
    await mkdir(entriesRoot, { recursive: true })
    const filePath = getMemoryFilePath(sessionId)
    try {
      await readJson(filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await writeJsonAtomic(filePath, [])
      } else {
        throw error
      }
    }
    return filePath
  }

  async function createMemoryEntry(sessionId, entryInput) {
    const filePath = await ensureMemoryFile(sessionId)
    const entry = {
      id: createUlid(),
      session_id: sessionId,
      content: cleanText(entryInput.content),
      kind: entryInput.kind || 'general',
      tag: entryInput.tag || null,
      scope: entryInput.scope || 'session',
      priority: entryInput.priority || 'normal',
      confirmed_at: entryInput.confirmed_at || null,
      created_at: nowIso(),
      version: 1
    }

    await appendJsonLine(filePath, entry)
    return entry
  }

  async function searchMemoryEntries({
    sessionId,
    scope = null,
    tag = null,
    kind = null,
    limit = 50
  } = {}) {
    const filePath = getMemoryFilePath(sessionId)
    try {
      const content = await readJson(filePath)
      const entries = Array.isArray(content) ? content : []

      return entries
        .filter((entry) => !scope || entry.scope === scope)
        .filter((entry) => !tag || entry.tag === tag)
        .filter((entry) => !kind || entry.kind === kind)
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
        .slice(0, limit)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  async function hasMemoryWritesSince(sessionId, sinceTimestamp) {
    const filePath = getMemoryFilePath(sessionId)
    try {
      const content = await readJson(filePath)
      const entries = Array.isArray(content) ? content : []

      return entries.some((entry) => {
        const entryTime = new Date(entry.created_at).getTime()
        return entryTime > sinceTimestamp
      })
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return false
      }
      throw error
    }
  }

  async function isConfirmationSignal(text) {
    const normalized = normalizeForSignalMatch(text)

    for (const signal of CONFIRMATION_SIGNALS) {
      if (normalized.includes(signal.toLowerCase())) {
        return {
          isConfirmation: true,
          isNegative: false,
          signal
        }
      }
    }

    for (const signal of NEGATIVE_CONFIRMATION_SIGNALS) {
      if (normalized.includes(signal.toLowerCase())) {
        return {
          isConfirmation: true,
          isNegative: true,
          signal
        }
      }
    }

    return {
      isConfirmation: false,
      isNegative: false,
      signal: null
    }
  }

  async function extractConfirmationSignal(message, context = {}) {
    const text = cleanText(message?.text || '')
    const analysis = await isConfirmationSignal(text)

    if (!analysis.isConfirmation) {
      return null
    }

    return {
      type: analysis.isNegative ? 'negative_confirmation' : 'positive_confirmation',
      signal: analysis.signal,
      original_text: text,
      extracted_at: nowIso(),
      context: {
        session_id: context.sessionId || null,
        task_id: context.taskId || null,
        last_action: context.lastAction || null
      }
    }
  }

  return {
    createMemoryEntry,
    searchMemoryEntries,
    hasMemoryWritesSince,
    isConfirmationSignal,
    extractConfirmationSignal,
    getMemoryFile: getMemoryFilePath,
    clearMemories: async (sessionId) => {
      const filePath = getMemoryFilePath(sessionId)
      try {
        await rm(filePath, { force: true })
        return { success: true }
      } catch (error) {
        return { success: false, error: error.message }
      }
    }
  }
}
