import { join } from 'node:path'
import { appendJsonLine, readJsonLines } from '../../storage/json-files.js'
import { createSessionStore, createUlid } from '../session/session-store.js'

function nowIso() {
  return new Date().toISOString()
}

async function safeReadJsonLines(filePath) {
  try {
    return await readJsonLines(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function matchesSearch(entry, { query, tag, activeOnly }) {
  if (activeOnly && entry.status !== 'active') {
    return false
  }

  if (tag && !Array.isArray(entry.tags)) {
    return false
  }

  if (tag && !entry.tags.includes(tag)) {
    return false
  }

  if (!query) {
    return true
  }

  const haystack = [
    entry.content,
    ...(entry.tags ?? []),
    entry.kind
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return haystack.includes(query.toLowerCase())
}

export function createMemoryStore({ storageRoot }) {
  const sessionStore = createSessionStore({ storageRoot })

  async function resolveScopePath({ sessionId, scope }) {
    const snapshot = await sessionStore.loadSession(sessionId)

    if (scope === 'session') {
      return {
        filePath: join(storageRoot, 'memory', 'session', `${sessionId}.jsonl`),
        projectKey: snapshot.session.project_key
      }
    }

    if (scope === 'project') {
      return {
        filePath: join(
          storageRoot,
          'memory',
          'project',
          `${snapshot.session.project_key}.jsonl`
        ),
        projectKey: snapshot.session.project_key
      }
    }

    throw new Error(`Unsupported memory scope: ${scope}`)
  }

  async function addMemoryEntry({
    sessionId,
    scope,
    kind,
    content,
    tags = [],
    status = 'active',
    supersedesId = null
  }) {
    if (!sessionId) {
      throw new Error('Missing required field: sessionId')
    }

    if (!scope) {
      throw new Error('Missing required field: scope')
    }

    if (!kind) {
      throw new Error('Missing required field: kind')
    }

    if (!content) {
      throw new Error('Missing required field: content')
    }

    const createdAt = nowIso()
    const { filePath, projectKey } = await resolveScopePath({
      sessionId,
      scope
    })
    const entry = {
      id: createUlid(),
      scope,
      session_id: scope === 'session' ? sessionId : null,
      project_key: projectKey,
      kind,
      status,
      content,
      tags,
      source_event_id: null,
      supersedes_id: supersedesId,
      created_at: createdAt,
      updated_at: createdAt,
      version: 1
    }

    await appendJsonLine(filePath, entry)
    const event = await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'memory_written',
      payload: {
        memory_id: entry.id,
        scope: entry.scope,
        kind: entry.kind
      }
    })

    return {
      ...entry,
      source_event_id: event.id
    }
  }

  async function searchMemoryEntries({
    sessionId,
    scope,
    query = '',
    tag = null,
    activeOnly = true
  }) {
    if (!sessionId) {
      throw new Error('Missing required field: sessionId')
    }

    if (!scope) {
      throw new Error('Missing required field: scope')
    }

    const { filePath } = await resolveScopePath({
      sessionId,
      scope
    })
    const entries = await safeReadJsonLines(filePath)

    return entries.filter((entry) =>
      matchesSearch(entry, {
        query,
        tag,
        activeOnly
      })
    )
  }

  return {
    addMemoryEntry,
    searchMemoryEntries
  }
}
