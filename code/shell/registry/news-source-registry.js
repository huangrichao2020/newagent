import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const REGISTRY_VERSION = 1
const SOURCE_CATEGORIES = ['general', 'stock', 'hot']
const SOURCE_TRANSPORTS = ['json', 'rss']

function nowIso() {
  return new Date().toISOString()
}

function registryPath(storageRoot) {
  return join(storageRoot, 'registry', 'news-sources.json')
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeOptionalString(value)?.toLowerCase()
  return allowed.includes(normalized) ? normalized : fallback
}

function requireString(record, key, label) {
  const value = normalizeOptionalString(record[key])

  if (!value) {
    throw new Error(`Missing required ${label} field: ${key}`)
  }

  return value
}

function normalizeParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [String(key), entryValue])
  )
}

export function getDefaultNewsSources() {
  return [
    {
      source_key: 'eastmoney_stock_fastnews',
      category: 'stock',
      name: 'Eastmoney Stock Fast News',
      transport: 'json',
      url: 'https://api.eastmoney.com/news/list',
      method: 'GET',
      default_params: {
        type: 'bg',
        pageIndex: 1
      },
      limit_param: 'pageSize',
      list_path: 'data',
      title_field: 'Title',
      url_field: 'Url',
      published_at_field: 'ShowTime',
      summary_field: null,
      author_field: null,
      status: 'active',
      notes: 'Seeded from the stock system real-time news module.'
    },
    {
      source_key: 'v2ex_hot_topics',
      category: 'hot',
      name: 'V2EX Hot Topics',
      transport: 'json',
      url: 'https://www.v2ex.com/api/topics/hot.json',
      method: 'GET',
      default_params: {},
      limit_param: null,
      list_path: null,
      title_field: 'title',
      url_field: 'url',
      published_at_field: 'created',
      summary_field: 'content',
      author_field: 'member.username',
      status: 'active',
      notes: 'Seeded from the local agent-reach hot-topic reference.'
    }
  ]
}

function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    sources: getDefaultNewsSources().map((source) => ({
      ...source,
      created_at: nowIso(),
      updated_at: nowIso()
    }))
  }
}

function normalizeSource(record, existing = null) {
  return {
    source_key: requireString(record, 'source_key', 'news source'),
    category: normalizeEnum(record.category, SOURCE_CATEGORIES, 'general'),
    name: requireString(record, 'name', 'news source'),
    transport: normalizeEnum(record.transport, SOURCE_TRANSPORTS, 'json'),
    url: requireString(record, 'url', 'news source'),
    method: normalizeEnum(record.method, ['get', 'post'], 'get').toUpperCase(),
    default_params: normalizeParams(record.default_params),
    limit_param: normalizeOptionalString(record.limit_param),
    list_path: normalizeOptionalString(record.list_path),
    title_field: normalizeOptionalString(record.title_field),
    url_field: normalizeOptionalString(record.url_field),
    published_at_field: normalizeOptionalString(record.published_at_field),
    summary_field: normalizeOptionalString(record.summary_field),
    author_field: normalizeOptionalString(record.author_field),
    status: normalizeOptionalString(record.status) ?? 'active',
    notes: normalizeOptionalString(record.notes),
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  }
}

async function loadRegistryFile(storageRoot) {
  try {
    return await readJson(registryPath(storageRoot))
  } catch {
    return defaultRegistry()
  }
}

async function saveRegistryFile(storageRoot, registry) {
  await writeJsonAtomic(registryPath(storageRoot), {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    sources: registry.sources
  })
}

export function createNewsSourceRegistry({ storageRoot }) {
  async function listSources({ category = null, status = null } = {}) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.sources.filter((source) => {
      if (category && source.category !== category) {
        return false
      }

      if (status && source.status !== status) {
        return false
      }

      return true
    })
  }

  async function getSource(sourceKey) {
    const registry = await loadRegistryFile(storageRoot)
    return registry.sources.find((source) => source.source_key === sourceKey) ?? null
  }

  async function registerSource(source) {
    const registry = await loadRegistryFile(storageRoot)
    const index = registry.sources.findIndex((entry) => entry.source_key === source.source_key)
    const normalized = normalizeSource(source, index >= 0 ? registry.sources[index] : null)

    if (index >= 0) {
      registry.sources[index] = normalized
    } else {
      registry.sources.push(normalized)
    }

    registry.sources.sort((left, right) => left.source_key.localeCompare(right.source_key))
    await saveRegistryFile(storageRoot, registry)

    return normalized
  }

  return {
    listSources,
    getSource,
    registerSource
  }
}
