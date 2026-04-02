import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveFeishuConfig } from './feishu-gateway.js'

const DEFAULT_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const DEFAULT_OPEN_BASE_URL = 'https://open.feishu.cn'
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000

function cleanString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => cleanString(item)).filter(Boolean))]
  }

  const normalized = cleanString(value)

  if (!normalized) {
    return []
  }

  return [...new Set(
    normalized
      .split(/[\s,]+/u)
      .map((item) => cleanString(item))
      .filter(Boolean)
  )]
}

function normalizeAuthMode(value) {
  const normalized = cleanString(value)?.toLowerCase()

  if (normalized === 'user_required') {
    return 'user_required'
  }

  if (normalized === 'user_preferred' || normalized === 'user') {
    return 'user_preferred'
  }

  return 'app'
}

function computeExpiresAt(nowMs, payload = {}) {
  const expiresIn = Number.parseInt(payload.expires_in ?? payload.expiresIn ?? payload.expire ?? '', 10)

  if (Number.isInteger(expiresIn) && expiresIn > 0) {
    return nowMs + expiresIn * 1000
  }

  const expiresAt = Number.parseInt(payload.expires_at ?? payload.expiresAt ?? '', 10)

  if (Number.isInteger(expiresAt) && expiresAt > 0) {
    return expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000
  }

  return null
}

function pickResponseData(payload = {}) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data
  }

  return payload ?? {}
}

function buildUserSnapshot(tokenPayload = {}, userInfo = {}) {
  const data = pickResponseData(userInfo)

  return {
    open_id: cleanString(data.open_id ?? tokenPayload.open_id),
    union_id: cleanString(data.union_id ?? tokenPayload.union_id),
    user_id: cleanString(data.user_id ?? tokenPayload.user_id),
    name: cleanString(data.name ?? tokenPayload.name),
    en_name: cleanString(data.en_name ?? tokenPayload.en_name),
    avatar_url: cleanString(data.avatar_url ?? tokenPayload.avatar_url),
    tenant_key: cleanString(data.tenant_key ?? tokenPayload.tenant_key),
    email: cleanString(data.email ?? tokenPayload.email)
  }
}

function sanitizeTokenRecord(record, config) {
  const missingConfiguration = []

  if (!config.appId) {
    missingConfiguration.push('NEWAGENT_FEISHU_APP_ID')
  }

  if (!config.appSecret) {
    missingConfiguration.push('NEWAGENT_FEISHU_APP_SECRET')
  }

  if (config.authMode !== 'app' && !config.redirectUri) {
    missingConfiguration.push('NEWAGENT_FEISHU_OAUTH_REDIRECT_URI')
  }

  if (config.authMode !== 'app' && config.scopes.length === 0) {
    missingConfiguration.push('NEWAGENT_FEISHU_USER_SCOPES')
  }

  function buildRecommendedNextStep({
    refreshNeeded = false,
    hasUserBinding = false
  } = {}) {
    if (config.authMode === 'app') {
      return 'Set NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE=user_preferred or user_required if you want Feishu workspace tools to use a bound user identity.'
    }

    if (missingConfiguration.length > 0) {
      return 'Configure the missing Feishu OAuth settings first, then run `channel feishu-user-auth-url --json` to get the authorize URL.'
    }

    if (!hasUserBinding) {
      return 'Run `channel feishu-user-auth-url --json`, open the authorize_url, then exchange the returned code with `channel feishu-user-auth-exchange --code <code> --json`.'
    }

    if (refreshNeeded) {
      return 'The bound Feishu user token is near expiry. Run `channel feishu-user-auth-refresh --json` or let workspace tools refresh it on demand.'
    }

    return 'The Feishu user binding is ready. Workspace CRUD tools can prefer user identity according to auth_mode.'
  }

  if (!record) {
    return {
      oauth_ready: config.oauthReady,
      auth_mode: config.authMode,
      token_store_path: config.tokenStorePath,
      app_credentials_present: config.ready,
      redirect_uri_present: Boolean(config.redirectUri),
      scopes: config.scopes,
      scopes_configured: config.scopes.length > 0,
      user_identity_requested: config.authMode !== 'app',
      authorize_url_ready: config.authMode !== 'app' && missingConfiguration.length === 0,
      missing_configuration: missingConfiguration,
      user_bound: false,
      access_token_present: false,
      refresh_token_present: false,
      expires_at: null,
      refresh_needed: config.authMode !== 'app',
      active_identity: config.authMode === 'app' ? 'app' : 'app',
      recommended_next_step: buildRecommendedNextStep(),
      user: null
    }
  }

  const now = Date.now()
  const expiresAt = record.expires_at ?? null
  const refreshNeeded = expiresAt != null
    ? expiresAt <= now + DEFAULT_REFRESH_WINDOW_MS
    : true

  return {
    oauth_ready: config.oauthReady,
    auth_mode: config.authMode,
    token_store_path: config.tokenStorePath,
    app_credentials_present: config.ready,
    redirect_uri_present: Boolean(config.redirectUri),
    scopes: config.scopes,
    scopes_configured: config.scopes.length > 0,
    user_identity_requested: config.authMode !== 'app',
    authorize_url_ready: config.authMode !== 'app' && missingConfiguration.length === 0,
    missing_configuration: missingConfiguration,
    user_bound: Boolean(record.refresh_token || record.access_token),
    access_token_present: Boolean(record.access_token),
    refresh_token_present: Boolean(record.refresh_token),
    expires_at: expiresAt,
    refresh_needed: refreshNeeded,
    active_identity: config.authMode === 'app'
      ? 'app'
      : (Boolean(record.access_token) ? 'user' : 'app'),
    recommended_next_step: buildRecommendedNextStep({
      refreshNeeded,
      hasUserBinding: Boolean(record.refresh_token || record.access_token)
    }),
    user: record.user ?? null,
    updated_at: record.updated_at ?? null
  }
}

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function writeJsonFile(path, payload) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function requireFetch(fetchFn) {
  if (typeof fetchFn !== 'function') {
    throw new Error('A fetch implementation is required for Feishu OAuth operations')
  }
}

export function resolveFeishuUserAuthConfig({
  storageRoot = null,
  env = process.env,
  appId = null,
  appSecret = null,
  redirectUri = null,
  scopes = null,
  authMode = null,
  authorizeBaseUrl = null,
  openBaseUrl = null,
  tokenStorePath = null
} = {}) {
  const feishuConfig = resolveFeishuConfig({
    appId:
      appId
      ?? env.NEWAGENT_FEISHU_APP_ID
      ?? env.FEISHU_APP_ID
      ?? null,
    appSecret:
      appSecret
      ?? env.NEWAGENT_FEISHU_APP_SECRET
      ?? env.FEISHU_APP_SECRET
      ?? null
  })
  const resolvedAuthMode = normalizeAuthMode(
    authMode
    ?? env.NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE
    ?? env.FEISHU_WORKSPACE_AUTH_MODE
    ?? 'app'
  )
  const resolvedRedirectUri = cleanString(
    redirectUri
    ?? env.NEWAGENT_FEISHU_OAUTH_REDIRECT_URI
    ?? env.FEISHU_OAUTH_REDIRECT_URI
  )
  const resolvedScopes = normalizeScopes(
    scopes
    ?? env.NEWAGENT_FEISHU_USER_SCOPES
    ?? env.NEWAGENT_FEISHU_USER_SCOPE
    ?? env.FEISHU_USER_SCOPES
    ?? env.FEISHU_USER_SCOPE
  )
  const resolvedTokenStorePath = cleanString(
    tokenStorePath
    ?? env.NEWAGENT_FEISHU_USER_TOKEN_FILE
    ?? env.FEISHU_USER_TOKEN_FILE
    ?? (storageRoot ? join(storageRoot, 'channels', 'feishu-user-auth.json') : null)
  )

  return {
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
    domain: feishuConfig.domain,
    authorizeBaseUrl: cleanString(authorizeBaseUrl ?? env.NEWAGENT_FEISHU_OAUTH_AUTHORIZE_URL) ?? DEFAULT_AUTHORIZE_URL,
    openBaseUrl: cleanString(openBaseUrl ?? env.NEWAGENT_FEISHU_OAUTH_API_BASE_URL) ?? DEFAULT_OPEN_BASE_URL,
    redirectUri: resolvedRedirectUri,
    scopes: resolvedScopes,
    authMode: resolvedAuthMode,
    tokenStorePath: resolvedTokenStorePath,
    ready: Boolean(feishuConfig.appId && feishuConfig.appSecret),
    oauthReady: Boolean(feishuConfig.appId && feishuConfig.appSecret && resolvedRedirectUri)
  }
}

export function buildFeishuUserAuthorizeUrl({
  config,
  state = null,
  scope = null,
  redirectUri = null
}) {
  if (!config.oauthReady) {
    throw new Error('Feishu OAuth is not fully configured. Set app credentials and redirect URI first.')
  }

  const url = new URL(config.authorizeBaseUrl)
  const resolvedState = cleanString(state) ?? randomUUID()
  const resolvedRedirectUri = cleanString(redirectUri) ?? config.redirectUri
  const scopeList = normalizeScopes(scope ?? config.scopes)

  url.searchParams.set('app_id', config.appId)
  url.searchParams.set('redirect_uri', resolvedRedirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', resolvedState)

  if (scopeList.length > 0) {
    url.searchParams.set('scope', scopeList.join(' '))
  }

  return {
    authorize_url: url.toString(),
    state: resolvedState,
    redirect_uri: resolvedRedirectUri,
    scopes: scopeList
  }
}

export function createFeishuUserAuthManager({
  storageRoot = null,
  env = process.env,
  fetchFn = globalThis.fetch,
  nowFn = () => Date.now(),
  config: configOverride = null
} = {}) {
  requireFetch(fetchFn)

  const config = configOverride ?? resolveFeishuUserAuthConfig({
    storageRoot,
    env
  })

  async function loadTokenRecord() {
    if (!config.tokenStorePath) {
      return null
    }

    return readJsonFile(config.tokenStorePath)
  }

  async function saveTokenRecord(record) {
    if (!config.tokenStorePath) {
      throw new Error('Feishu user token store path is not configured')
    }

    await writeJsonFile(config.tokenStorePath, record)
  }

  async function fetchJson(url, {
    method = 'GET',
    headers = {},
    body = null
  } = {}) {
    const response = await fetchFn(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body)
    })

    let payload = null

    if (typeof response.json === 'function') {
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
    }

    if (!response.ok) {
      throw new Error(
        payload?.msg
        ?? payload?.message
        ?? `Feishu OAuth request failed: HTTP ${response.status}`
      )
    }

    return payload ?? {}
  }

  async function fetchAppAccessToken() {
    if (!config.ready) {
      throw new Error('Missing Feishu app credentials')
    }

    const payload = await fetchJson(
      `${config.openBaseUrl}/open-apis/auth/v3/app_access_token/internal`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: {
          app_id: config.appId,
          app_secret: config.appSecret
        }
      }
    )
    const data = pickResponseData(payload)
    const appAccessToken = cleanString(data.app_access_token ?? payload.app_access_token)

    if (!appAccessToken) {
      throw new Error('Feishu app access token response did not include app_access_token')
    }

    return appAccessToken
  }

  async function fetchUserInfo(userAccessToken) {
    const payload = await fetchJson(
      `${config.openBaseUrl}/open-apis/authen/v1/user_info`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${userAccessToken}`
        }
      }
    )

    return pickResponseData(payload)
  }

  async function exchangeCode({
    code,
    redirectUri = null
  }) {
    const normalizedCode = cleanString(code)

    if (!normalizedCode) {
      throw new Error('Missing Feishu authorization code')
    }

    if (!config.oauthReady) {
      throw new Error('Feishu OAuth is not fully configured. Set redirect URI and app credentials first.')
    }

    const appAccessToken = await fetchAppAccessToken()
    const payload = await fetchJson(
      `${config.openBaseUrl}/open-apis/authen/v1/access_token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: {
          grant_type: 'authorization_code',
          code: normalizedCode,
          redirect_uri: cleanString(redirectUri) ?? config.redirectUri
        }
      }
    )
    const data = pickResponseData(payload)
    const nowMs = nowFn()
    const accessToken = cleanString(data.access_token ?? payload.access_token)
    const refreshToken = cleanString(data.refresh_token ?? payload.refresh_token)

    if (!accessToken || !refreshToken) {
      throw new Error('Feishu user access token response did not include access_token and refresh_token')
    }

    const userInfo = await fetchUserInfo(accessToken)
    const record = {
      version: 1,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: cleanString(data.token_type ?? payload.token_type) ?? 'Bearer',
      expires_at: computeExpiresAt(nowMs, data),
      scope: normalizeScopes(data.scope ?? payload.scope ?? config.scopes),
      user: buildUserSnapshot(data, userInfo),
      updated_at: new Date(nowMs).toISOString()
    }

    await saveTokenRecord(record)
    return sanitizeTokenRecord(record, config)
  }

  async function refreshAccessTokenRecord({
    force = false
  } = {}) {
    const existing = await loadTokenRecord()

    if (!existing?.refresh_token) {
      throw new Error('No stored Feishu refresh_token. Run authorization first.')
    }

    const nowMs = nowFn()
    const expiresAt = existing.expires_at ?? null
    const shouldRefresh = force || expiresAt == null || expiresAt <= nowMs + DEFAULT_REFRESH_WINDOW_MS

    if (!shouldRefresh) {
      return existing
    }

    const appAccessToken = await fetchAppAccessToken()
    const payload = await fetchJson(
      `${config.openBaseUrl}/open-apis/authen/v1/refresh_access_token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: {
          grant_type: 'refresh_token',
          refresh_token: existing.refresh_token
        }
      }
    )
    const data = pickResponseData(payload)
    const accessToken = cleanString(data.access_token ?? payload.access_token)
    const refreshToken = cleanString(data.refresh_token ?? payload.refresh_token) ?? existing.refresh_token

    if (!accessToken) {
      throw new Error('Feishu refresh response did not include access_token')
    }

    const userInfo = await fetchUserInfo(accessToken)
    const record = {
      ...existing,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: cleanString(data.token_type ?? payload.token_type) ?? existing.token_type ?? 'Bearer',
      expires_at: computeExpiresAt(nowMs, data),
      scope: normalizeScopes(data.scope ?? payload.scope ?? existing.scope ?? config.scopes),
      user: buildUserSnapshot(existing.user ?? {}, userInfo),
      updated_at: new Date(nowMs).toISOString()
    }

    await saveTokenRecord(record)
    return record
  }

  async function refreshAccessToken({
    force = false
  } = {}) {
    const record = await refreshAccessTokenRecord({
      force
    })

    return sanitizeTokenRecord(record, config)
  }

  async function getValidAccessToken({
    forceRefresh = false
  } = {}) {
    const record = await refreshAccessTokenRecord({
      force: forceRefresh
    })

    return record
  }

  async function resolveRequestOptions(sdk, {
    identity = 'auto'
  } = {}) {
    const mode = identity === 'auto'
      ? config.authMode
      : normalizeAuthMode(identity === 'user' ? 'user_required' : 'app')

    if (mode === 'app') {
      return {
        active_identity: 'app',
        request_options: null,
        user: null
      }
    }

    const record = await getValidAccessToken()

    if (!record?.access_token) {
      if (mode === 'user_required') {
        throw new Error('Feishu user access token is required but no active user binding is available')
      }

      return {
        active_identity: 'app',
        request_options: null,
        user: null
      }
    }

    if (typeof sdk.withUserAccessToken !== 'function') {
      throw new Error('Feishu SDK does not expose withUserAccessToken')
    }

    return {
      active_identity: 'user',
      request_options: sdk.withUserAccessToken(record.access_token),
      user: record.user ?? null
    }
  }

  async function describeStatus() {
    const record = await loadTokenRecord()
    return sanitizeTokenRecord(record, config)
  }

  return {
    config,
    buildAuthorizeUrl(params = {}) {
      return buildFeishuUserAuthorizeUrl({
        config,
        ...params
      })
    },
    loadTokenRecord,
    exchangeCode,
    refreshAccessToken,
    getValidAccessToken,
    resolveRequestOptions,
    describeStatus
  }
}
