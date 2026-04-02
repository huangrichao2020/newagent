import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'
import { createUlid } from '../session/session-store.js'

function nowIso() {
  return new Date().toISOString()
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

function normalizeTags(tags = []) {
  return [...new Set(
    (Array.isArray(tags) ? tags : [])
      .map((tag) => cleanText(tag))
      .filter(Boolean)
  )]
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

function sortRequests(requests = []) {
  return [...requests].sort((left, right) => {
    const leftKey = `${left.created_at ?? ''}:${left.id ?? ''}`
    const rightKey = `${right.created_at ?? ''}:${right.id ?? ''}`
    return leftKey.localeCompare(rightKey)
  })
}

export function createCoworkerStore({ storageRoot }) {
  const requestsRoot = join(storageRoot, 'coworkers', 'requests')

  function getRequestPath(requestId) {
    return join(requestsRoot, `${requestId}.json`)
  }

  async function listRequestFiles() {
    try {
      const names = await readdir(requestsRoot)

      return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(requestsRoot, name))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return []
      }

      throw error
    }
  }

  async function createRequest({
    sessionId = null,
    source = 'newagent-manager',
    target,
    channel = 'ssh-channel',
    transport = 'ssh_long_poll',
    authority = 'advisory_only',
    title,
    question,
    context = null,
    urgency = 'normal',
    tags = [],
    location = null
  }) {
    const normalizedTarget = cleanText(target)
    const normalizedSource = cleanText(source)
    const normalizedTitle = cleanText(title)
    const normalizedQuestion = cleanMultilineText(question)

    if (!normalizedTarget) {
      throw new Error('Missing required field: target')
    }

    if (!normalizedSource) {
      throw new Error('Missing required field: source')
    }

    if (!normalizedTitle) {
      throw new Error('Missing required field: title')
    }

    if (!normalizedQuestion) {
      throw new Error('Missing required field: question')
    }

    const createdAt = nowIso()
    const request = {
      id: createUlid(),
      session_id: sessionId ?? null,
      source: normalizedSource,
      target: normalizedTarget,
      channel: cleanText(channel) || 'ssh-channel',
      transport: cleanText(transport) || 'ssh_long_poll',
      authority: cleanText(authority) || 'advisory_only',
      title: normalizedTitle,
      question: normalizedQuestion,
      context: cleanMultilineText(context) || null,
      urgency: cleanText(urgency) || 'normal',
      location: cleanText(location) || null,
      tags: normalizeTags(tags),
      status: 'pending',
      answer: null,
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      claimed_by: null,
      claimed_at: null,
      created_at: createdAt,
      updated_at: createdAt,
      version: 1
    }

    await mkdir(requestsRoot, { recursive: true })
    await writeJsonAtomic(getRequestPath(request.id), request)

    return request
  }

  async function getRequest(requestId) {
    const normalizedRequestId = cleanText(requestId)

    if (!normalizedRequestId) {
      throw new Error('Missing required field: requestId')
    }

    return safeReadJson(getRequestPath(normalizedRequestId))
  }

  async function listRequests({
    sessionId = null,
    source = null,
    target = null,
    status = null,
    afterId = null,
    limit = null
  } = {}) {
    const requestFiles = await listRequestFiles()
    const requests = sortRequests(
      (await Promise.all(requestFiles.map((filePath) => safeReadJson(filePath))))
        .filter(Boolean)
        .filter((request) => {
          if (sessionId && request.session_id !== sessionId) {
            return false
          }

          if (source && request.source !== source) {
            return false
          }

          if (target && request.target !== target) {
            return false
          }

          if (status && request.status !== status) {
            return false
          }

          if (afterId && request.id.localeCompare(afterId) <= 0) {
            return false
          }

          return true
        })
    )

    if (!limit) {
      return requests
    }

    return requests.slice(0, limit)
  }

  async function updateRequest(requestId, updater) {
    const existing = await getRequest(requestId)

    if (!existing) {
      throw new Error(`Unknown coworker request: ${requestId}`)
    }

    const updated = updater(existing)
    await writeJsonAtomic(getRequestPath(existing.id), updated)
    return updated
  }

  async function claimRequest(requestId, {
    claimedBy,
    location = null
  }) {
    const normalizedClaimedBy = cleanText(claimedBy)

    if (!normalizedClaimedBy) {
      throw new Error('Missing required field: claimedBy')
    }

    return updateRequest(requestId, (existing) => {
      const claimedAt = nowIso()

      return {
        ...existing,
        status: existing.status === 'resolved' ? 'resolved' : 'claimed',
        claimed_by: normalizedClaimedBy,
        claimed_at: existing.claimed_at ?? claimedAt,
        location: cleanText(location) || existing.location,
        updated_at: claimedAt
      }
    })
  }

  async function resolveRequest(requestId, {
    answer,
    resolvedBy,
    resolution = 'answered',
    location = null
  }) {
    const normalizedAnswer = cleanMultilineText(answer)
    const normalizedResolvedBy = cleanText(resolvedBy)

    if (!normalizedAnswer) {
      throw new Error('Missing required field: answer')
    }

    if (!normalizedResolvedBy) {
      throw new Error('Missing required field: resolvedBy')
    }

    return updateRequest(requestId, (existing) => {
      const resolvedAt = nowIso()

      return {
        ...existing,
        status: 'resolved',
        answer: normalizedAnswer,
        resolution: cleanText(resolution) || 'answered',
        resolved_by: normalizedResolvedBy,
        resolved_at: resolvedAt,
        location: cleanText(location) || existing.location,
        updated_at: resolvedAt
      }
    })
  }

  return {
    createRequest,
    getRequest,
    listRequests,
    claimRequest,
    resolveRequest
  }
}
