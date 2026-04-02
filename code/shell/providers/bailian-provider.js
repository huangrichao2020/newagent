import { createAgentProfile } from '../manager/agent-profile.js'
import { createModelRouter } from './model-router.js'

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '')
}

function buildMessages({ prompt, systemPrompt = null, messages = null }) {
  if (Array.isArray(messages) && messages.length > 0) {
    return messages
  }

  if (!prompt) {
    throw new Error('Missing required prompt or messages')
  }

  const builtMessages = []

  if (systemPrompt) {
    builtMessages.push({
      role: 'system',
      content: String(systemPrompt)
    })
  }

  builtMessages.push({
    role: 'user',
    content: String(prompt)
  })

  return builtMessages
}

function resolveRouteApiKey(route, explicitApiKey) {
  if (explicitApiKey) {
    return explicitApiKey
  }

  if (route.api_key_env && process.env[route.api_key_env]) {
    return process.env[route.api_key_env]
  }

  for (const envName of route.fallback_api_key_envs ?? []) {
    if (process.env[envName]) {
      return process.env[envName]
    }
  }

  return null
}

function resolveRouteBaseUrl(route, explicitBaseUrl) {
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl)
  }

  if (route.base_url_env && process.env[route.base_url_env]) {
    return normalizeBaseUrl(process.env[route.base_url_env])
  }

  return normalizeBaseUrl(route.base_url_default)
}

function resolveProviderModel(route) {
  return route.provider_model ?? route.model
}

function resolveExtraBody(route) {
  if (route.extra_body && typeof route.extra_body === 'object') {
    return route.extra_body
  }

  if (route.generation_config?.extra_body && typeof route.generation_config.extra_body === 'object') {
    return route.generation_config.extra_body
  }

  return null
}

function resolveExtraHeaders(route) {
  if (!route.extra_headers || typeof route.extra_headers !== 'object') {
    return null
  }

  const entries = Object.entries(route.extra_headers)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')

  return entries.length > 0
    ? Object.fromEntries(entries)
    : null
}

async function parseJsonResponse(response) {
  const contentType = response.headers?.get?.('content-type') ?? ''

  if (contentType.includes('application/json')) {
    return response.json()
  }

  const rawText = await response.text()

  try {
    return JSON.parse(rawText)
  } catch {
    return {
      raw_text: rawText
    }
  }
}

export function createBailianProvider({
  fetchFn = globalThis.fetch,
  managerProfile = createAgentProfile(),
  modelRouter = createModelRouter({ managerProfile })
} = {}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('A fetch implementation is required')
  }

  async function invokeByIntent({
    intent,
    prompt = null,
    systemPrompt = null,
    messages = null,
    apiKey = null,
    baseUrl = null,
    temperature = 0.2,
    maxTokens = 4096,
    signal = undefined
  }) {
    const route = modelRouter.resolveRoute(intent)

    if (route.runtime !== 'llm') {
      throw new Error(`Intent ${intent} is not routed to an LLM provider`)
    }

    const resolvedApiKey = resolveRouteApiKey(route, apiKey)

    if (!resolvedApiKey) {
      if (route.provider === 'openrouter') {
        throw new Error('Missing OpenRouter API key. Set OPENROUTER_API_KEY or NEWAGENT_OPENROUTER_API_KEY.')
      }

      throw new Error('Missing Bailian API key. Set NEWAGENT_BAILIAN_API_KEY or DASHSCOPE_API_KEY.')
    }

    const resolvedBaseUrl = resolveRouteBaseUrl(route, baseUrl)
    const providerModel = resolveProviderModel(route)
    const extraBody = resolveExtraBody(route)
    const extraHeaders = resolveExtraHeaders(route)
    const requestBody = {
      model: providerModel,
      messages: buildMessages({
        prompt,
        systemPrompt,
        messages
      }),
      stream: false,
      temperature,
      max_tokens: maxTokens
    }

    if (extraBody) {
      requestBody.extra_body = extraBody
    }

    const response = await fetchFn(`${resolvedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolvedApiKey}`,
        ...(extraHeaders ?? {})
      },
      body: JSON.stringify(requestBody),
      signal
    })

    const parsed = await parseJsonResponse(response)

    if (!response.ok) {
      throw new Error(`Bailian API error: ${response.status} ${JSON.stringify(parsed)}`)
    }

    const choice = parsed.choices?.[0]

    return {
      route,
      request: {
        provider: route.provider,
        base_url: resolvedBaseUrl,
        model: providerModel,
        route_model: route.model,
        extra_body: extraBody,
        extra_headers: extraHeaders,
        message_count: requestBody.messages.length
      },
      response: {
        id: parsed.id ?? null,
        model: parsed.model ?? providerModel,
        content: choice?.message?.content ?? null,
        message: choice?.message ?? null,
        finish_reason: choice?.finish_reason ?? null,
        usage: parsed.usage ?? null,
        raw: parsed
      }
    }
  }

  return {
    invokeByIntent
  }
}
