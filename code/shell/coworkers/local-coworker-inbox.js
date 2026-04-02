import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

function nowIso() {
  return new Date().toISOString()
}

function cleanText(value) {
  return String(value ?? '').trim()
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

export function createLocalCoworkerInbox({
  inboxRoot
}) {
  const requestsRoot = join(inboxRoot, 'requests')

  function getRecordPath(requestId) {
    return join(requestsRoot, `${requestId}.json`)
  }

  async function listRecordPaths() {
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

  async function recordRequest(request) {
    const requestId = cleanText(request?.id)

    if (!requestId) {
      throw new Error('Missing required request id')
    }

    const existing = await safeReadJson(getRecordPath(requestId))
    const record = {
      ...(existing ?? {}),
      ...request,
      local_status: existing?.local_status ?? 'received',
      synced_at: nowIso(),
      version: 1
    }

    await mkdir(requestsRoot, { recursive: true })
    await writeJsonAtomic(getRecordPath(requestId), record)
    return record
  }

  async function getRecord(requestId) {
    const normalizedRequestId = cleanText(requestId)

    if (!normalizedRequestId) {
      throw new Error('Missing required request id')
    }

    return safeReadJson(getRecordPath(normalizedRequestId))
  }

  async function getLatestRecord({
    localStatus = null
  } = {}) {
    const records = await listRecords({
      localStatus,
      limit: 1
    })

    return records.at(-1) ?? null
  }

  async function markReplied(requestId, {
    answer
  }) {
    const normalizedRequestId = cleanText(requestId)

    if (!normalizedRequestId) {
      throw new Error('Missing required request id')
    }

    const existing = await safeReadJson(getRecordPath(normalizedRequestId))

    if (!existing) {
      throw new Error(`Unknown local coworker inbox record: ${normalizedRequestId}`)
    }

    const record = {
      ...existing,
      local_status: 'replied',
      local_answer: cleanText(answer) || null,
      local_replied_at: nowIso(),
      synced_at: nowIso(),
      version: 1
    }

    await writeJsonAtomic(getRecordPath(normalizedRequestId), record)
    return record
  }

  async function markNotified(requestId, {
    delivered = true,
    error = null
  } = {}) {
    const normalizedRequestId = cleanText(requestId)

    if (!normalizedRequestId) {
      throw new Error('Missing required request id')
    }

    const existing = await safeReadJson(getRecordPath(normalizedRequestId))

    if (!existing) {
      throw new Error(`Unknown local coworker inbox record: ${normalizedRequestId}`)
    }

    const record = {
      ...existing,
      local_notified_at: nowIso(),
      local_notification_status: delivered ? 'delivered' : 'failed',
      local_notification_error: cleanText(error) || null,
      synced_at: nowIso(),
      version: 1
    }

    await writeJsonAtomic(getRecordPath(normalizedRequestId), record)
    return record
  }

  async function listRecords({
    localStatus = null,
    limit = null
  } = {}) {
    const records = (await Promise.all(
      (await listRecordPaths()).map((filePath) => safeReadJson(filePath))
    ))
      .filter(Boolean)
      .filter((record) => !localStatus || record.local_status === localStatus)
      .sort((left, right) => `${left.synced_at ?? ''}:${left.id ?? ''}`.localeCompare(
        `${right.synced_at ?? ''}:${right.id ?? ''}`
      ))

    if (!limit) {
      return records
    }

    return records.slice(-limit)
  }

  return {
    getLatestRecord,
    getRecord,
    listRecords,
    markNotified,
    markReplied,
    recordRequest
  }
}
