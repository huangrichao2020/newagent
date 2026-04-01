import { join } from 'node:path'
import { appendJsonLine, readJsonLines } from '../../storage/json-files.js'
import { createUlid } from '../session/session-store.js'

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

export function createHookBus({
  storageRoot,
  strictHandlers = false
}) {
  const hookFile = join(storageRoot, 'hooks', 'events.jsonl')
  const namedHandlers = new Map()
  const anyHandlers = new Set()

  function on(name, handler) {
    if (typeof handler !== 'function') {
      throw new Error('Hook handler must be a function')
    }

    if (name === '*') {
      anyHandlers.add(handler)

      return () => {
        anyHandlers.delete(handler)
      }
    }

    if (!name) {
      throw new Error('Hook name is required')
    }

    const handlers = namedHandlers.get(name) ?? new Set()
    handlers.add(handler)
    namedHandlers.set(name, handlers)

    return () => {
      handlers.delete(handler)

      if (handlers.size === 0) {
        namedHandlers.delete(name)
      }
    }
  }

  async function emit({
    name,
    sessionId = null,
    channel = null,
    actor = 'system',
    payload = {}
  }) {
    if (!name) {
      throw new Error('Missing required hook name')
    }

    const event = {
      id: createUlid(),
      name,
      session_id: sessionId,
      channel,
      actor,
      payload,
      at: nowIso(),
      version: 1
    }

    await appendJsonLine(hookFile, event)

    const handlers = [
      ...anyHandlers,
      ...(namedHandlers.get(name) ?? [])
    ]
    const handlerErrors = []

    for (const handler of handlers) {
      try {
        await handler(event)
      } catch (error) {
        const normalized = {
          name,
          message: error?.message ?? String(error)
        }

        if (strictHandlers) {
          throw error
        }

        handlerErrors.push(normalized)
      }
    }

    return {
      event,
      handler_errors: handlerErrors
    }
  }

  async function listEvents({
    sessionId = null,
    name = null,
    channel = null,
    limit = null
  } = {}) {
    const events = await safeReadJsonLines(hookFile)
    const filtered = events.filter((event) => {
      if (sessionId && event.session_id !== sessionId) {
        return false
      }

      if (name && event.name !== name) {
        return false
      }

      if (channel && event.channel !== channel) {
        return false
      }

      return true
    })

    if (!limit) {
      return filtered
    }

    return filtered.slice(-limit)
  }

  return {
    emit,
    listEvents,
    on
  }
}
