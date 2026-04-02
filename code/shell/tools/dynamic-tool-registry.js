import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const REGISTRY_VERSION = 1
const TOOL_CATEGORIES = [
  'core',
  'project',
  'infrastructure',
  'server_ops',
  'news',
  'channel',
  'coworker',
  'dynamic_tool',
  'internal',
  'web',
  'codex',
  'debug'
]

function nowIso() {
  return new Date().toISOString()
}

function registryPath(storageRoot) {
  return join(storageRoot, 'tools', 'dynamic-tools.json')
}

function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    tools: []
  }
}

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeString(value)?.toLowerCase()
  return allowed.includes(normalized) ? normalized : fallback
}

function normalizeInputSchema(value) {
  if (!value || typeof value !== 'object') {
    return {
      type: 'object'
    }
  }

  return {
    type: normalizeString(value.type) ?? 'object',
    required: Array.isArray(value.required)
      ? [...new Set(value.required.map((item) => normalizeString(item)).filter(Boolean))]
      : []
  }
}

function normalizeToolCategory(value) {
  return normalizeEnum(value, TOOL_CATEGORIES, 'internal')
}

function requireString(value, label) {
  const normalized = normalizeString(value)

  if (!normalized) {
    throw new Error(`Missing required ${label}`)
  }

  return normalized
}

function normalizeToolRecord(record, existing = null) {
  return {
    tool_name: requireString(record.tool_name, 'tool_name'),
    description: requireString(record.description, 'description'),
    category: normalizeToolCategory(record.category ?? existing?.category),
    command: requireString(record.command, 'command'),
    cwd: normalizeString(record.cwd),
    permission_class: normalizeEnum(
      record.permission_class,
      ['safe', 'dangerous'],
      'safe'
    ),
    side_effects: record.side_effects === true,
    input_schema: normalizeInputSchema(record.input_schema),
    lifecycle: normalizeEnum(
      record.lifecycle,
      ['temporary', 'permanent'],
      'temporary'
    ),
    review_status: normalizeEnum(
      record.review_status,
      ['pending_review', 'approved', 'rejected', 'retired'],
      'pending_review'
    ),
    review_notes: normalizeString(record.review_notes),
    restart_required: record.restart_required === true,
    restart_strategy: normalizeEnum(
      record.restart_strategy,
      ['notify_unless_blocked', 'manual'],
      'notify_unless_blocked'
    ),
    restart_time_hint: normalizeString(record.restart_time_hint),
    created_by: normalizeString(record.created_by),
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso(),
    last_used_at: existing?.last_used_at ?? null,
    usage_count: Number.isInteger(existing?.usage_count) ? existing.usage_count : 0
  }
}

async function loadRegistry(storageRoot) {
  try {
    return await readJson(registryPath(storageRoot))
  } catch {
    return defaultRegistry()
  }
}

async function saveRegistry(storageRoot, registry) {
  await writeJsonAtomic(registryPath(storageRoot), {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    tools: registry.tools
  })
}

export function createDynamicToolRegistry({ storageRoot }) {
  async function listTools({
    lifecycle = null,
    reviewStatus = null,
    category = null
  } = {}) {
    const registry = await loadRegistry(storageRoot)

    return registry.tools.filter((tool) => {
      if (category && tool.category !== category) {
        return false
      }

      if (lifecycle && tool.lifecycle !== lifecycle) {
        return false
      }

      if (reviewStatus && tool.review_status !== reviewStatus) {
        return false
      }

      return true
    })
  }

  async function getTool(toolName) {
    const registry = await loadRegistry(storageRoot)
    const normalizedToolName = normalizeString(toolName)

    if (!normalizedToolName) {
      return null
    }

    return registry.tools.find((tool) => tool.tool_name === normalizedToolName) ?? null
  }

  async function registerTool(record) {
    const registry = await loadRegistry(storageRoot)
    const normalizedToolName = normalizeString(record?.tool_name)
    const index = registry.tools.findIndex((tool) => tool.tool_name === normalizedToolName)
    const normalized = normalizeToolRecord(record, index >= 0 ? registry.tools[index] : null)

    if (index >= 0) {
      registry.tools[index] = normalized
    } else {
      registry.tools.push(normalized)
    }

    registry.tools.sort((left, right) => left.tool_name.localeCompare(right.tool_name))
    await saveRegistry(storageRoot, registry)

    return normalized
  }

  async function recordToolUsage(toolName) {
    const registry = await loadRegistry(storageRoot)
    const normalizedToolName = normalizeString(toolName)
    const index = registry.tools.findIndex((tool) => tool.tool_name === normalizedToolName)

    if (index < 0) {
      throw new Error(`Unknown dynamic tool: ${toolName}`)
    }

    const updated = {
      ...registry.tools[index],
      usage_count: (registry.tools[index].usage_count ?? 0) + 1,
      last_used_at: nowIso(),
      updated_at: nowIso()
    }
    registry.tools[index] = updated
    await saveRegistry(storageRoot, registry)

    return updated
  }

  async function markToolReviewed(toolName, {
    lifecycle = null,
    reviewStatus = null,
    reviewNotes = null
  } = {}) {
    const registry = await loadRegistry(storageRoot)
    const normalizedToolName = normalizeString(toolName)
    const index = registry.tools.findIndex((tool) => tool.tool_name === normalizedToolName)

    if (index < 0) {
      throw new Error(`Unknown dynamic tool: ${toolName}`)
    }

    const updated = {
      ...registry.tools[index],
      lifecycle: normalizeEnum(
        lifecycle,
        ['temporary', 'permanent'],
        registry.tools[index].lifecycle
      ),
      review_status: normalizeEnum(
        reviewStatus,
        ['pending_review', 'approved', 'rejected', 'retired'],
        registry.tools[index].review_status
      ),
      review_notes: normalizeString(reviewNotes) ?? registry.tools[index].review_notes,
      updated_at: nowIso()
    }
    registry.tools[index] = updated
    await saveRegistry(storageRoot, registry)

    return updated
  }

  async function listReviewQueue() {
    return listTools({
      reviewStatus: 'pending_review'
    })
  }

  return {
    getTool,
    listReviewQueue,
    listTools,
    markToolReviewed,
    recordToolUsage,
    registerTool
  }
}
