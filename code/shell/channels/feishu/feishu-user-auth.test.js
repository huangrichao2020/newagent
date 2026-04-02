import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildFeishuUserAuthorizeUrl,
  createFeishuUserAuthManager,
  resolveFeishuUserAuthConfig
} from './feishu-user-auth.js'

test('resolveFeishuUserAuthConfig normalizes redirect URI, scopes, and auth mode', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'newagent-feishu-user-auth-config-'))
  const config = resolveFeishuUserAuthConfig({
    storageRoot,
    env: {
      NEWAGENT_FEISHU_APP_ID: 'cli_123',
      NEWAGENT_FEISHU_APP_SECRET: 'secret_123',
      NEWAGENT_FEISHU_OAUTH_REDIRECT_URI: 'https://example.com/feishu/callback',
      NEWAGENT_FEISHU_USER_SCOPES: 'docx:document, bitable:app  wiki:space',
      NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE: 'user_preferred'
    }
  })

  assert.equal(config.ready, true)
  assert.equal(config.oauthReady, true)
  assert.equal(config.redirectUri, 'https://example.com/feishu/callback')
  assert.deepEqual(config.scopes, ['docx:document', 'bitable:app', 'wiki:space'])
  assert.equal(config.authMode, 'user_preferred')
  assert.match(config.tokenStorePath, /channels\/feishu-user-auth\.json$/)
})

test('buildFeishuUserAuthorizeUrl renders one reusable OAuth URL', () => {
  const result = buildFeishuUserAuthorizeUrl({
    config: {
      oauthReady: true,
      authorizeBaseUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      appId: 'cli_test_123',
      redirectUri: 'https://example.com/feishu/callback',
      scopes: ['docx:document', 'bitable:app']
    },
    state: 'state_123'
  })

  const url = new URL(result.authorize_url)
  assert.equal(url.searchParams.get('app_id'), 'cli_test_123')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/feishu/callback')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('state'), 'state_123')
  assert.equal(url.searchParams.get('scope'), 'docx:document bitable:app')
})

test('createFeishuUserAuthManager exchanges one code, stores token, and returns sanitized status', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'newagent-feishu-user-auth-exchange-'))
  const calls = []
  const manager = createFeishuUserAuthManager({
    storageRoot,
    env: {
      NEWAGENT_FEISHU_APP_ID: 'cli_123',
      NEWAGENT_FEISHU_APP_SECRET: 'secret_123',
      NEWAGENT_FEISHU_OAUTH_REDIRECT_URI: 'https://example.com/feishu/callback',
      NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE: 'user_preferred'
    },
    nowFn: () => 1_700_000_000_000,
    fetchFn: async (url, options = {}) => {
      calls.push({
        url,
        options
      })

      if (url.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
        return {
          ok: true,
          async json() {
            return {
              app_access_token: 'app_token_123',
              expire: 7200
            }
          }
        }
      }

      if (url.endsWith('/open-apis/authen/v1/access_token')) {
        return {
          ok: true,
          async json() {
            return {
              data: {
                access_token: 'user_access_123',
                refresh_token: 'refresh_123',
                expires_in: 7200,
                scope: 'docx:document'
              }
            }
          }
        }
      }

      if (url.endsWith('/open-apis/authen/v1/user_info')) {
        return {
          ok: true,
          async json() {
            return {
              data: {
                open_id: 'ou_123',
                name: 'Tingchi',
                email: 'tingchi@example.com'
              }
            }
          }
        }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }
  })

  const result = await manager.exchangeCode({
    code: 'code_123'
  })

  assert.equal(result.user_bound, true)
  assert.equal(result.active_identity, 'user')
  assert.equal(result.user.name, 'Tingchi')
  assert.equal(result.access_token_present, true)
  assert.equal(result.refresh_token_present, true)

  const stored = JSON.parse(await readFile(manager.config.tokenStorePath, 'utf8'))
  assert.equal(stored.access_token, 'user_access_123')
  assert.equal(stored.refresh_token, 'refresh_123')
  assert.equal(stored.user.open_id, 'ou_123')
  assert.equal(calls[1].options.headers.Authorization, 'Bearer app_token_123')
})

test('createFeishuUserAuthManager refreshes one stored token when it is near expiry', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'newagent-feishu-user-auth-refresh-'))
  let nowMs = 1_700_000_000_000
  const manager = createFeishuUserAuthManager({
    storageRoot,
    env: {
      NEWAGENT_FEISHU_APP_ID: 'cli_123',
      NEWAGENT_FEISHU_APP_SECRET: 'secret_123',
      NEWAGENT_FEISHU_OAUTH_REDIRECT_URI: 'https://example.com/feishu/callback',
      NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE: 'user_required'
    },
    nowFn: () => nowMs,
    fetchFn: async (url) => {
      if (url.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
        return {
          ok: true,
          async json() {
            return {
              app_access_token: 'app_token_123'
            }
          }
        }
      }

      if (url.endsWith('/open-apis/authen/v1/access_token')) {
        return {
          ok: true,
          async json() {
            return {
              data: {
                access_token: 'user_access_123',
                refresh_token: 'refresh_123',
                expires_in: 7200
              }
            }
          }
        }
      }

      if (url.endsWith('/open-apis/authen/v1/refresh_access_token')) {
        return {
          ok: true,
          async json() {
            return {
              data: {
                access_token: 'user_access_456',
                refresh_token: 'refresh_456',
                expires_in: 7200
              }
            }
          }
        }
      }

      if (url.endsWith('/open-apis/authen/v1/user_info')) {
        return {
          ok: true,
          async json() {
            return {
              data: {
                open_id: 'ou_123',
                name: 'Tingchi'
              }
            }
          }
        }
      }

      throw new Error(`Unexpected URL: ${url}`)
    }
  })

  await manager.exchangeCode({
    code: 'code_123'
  })

  nowMs += 7_150 * 1000
  const refreshStatus = await manager.refreshAccessToken({
    force: true
  })
  const refreshed = await manager.getValidAccessToken()

  assert.equal(refreshStatus.access_token, undefined)
  assert.equal(refreshStatus.refresh_token, undefined)
  assert.equal(refreshStatus.access_token_present, true)
  assert.equal(refreshStatus.refresh_token_present, true)
  assert.equal(refreshed.access_token, 'user_access_456')
  assert.equal(refreshed.refresh_token, 'refresh_456')

  const requestOptions = await manager.resolveRequestOptions({
    withUserAccessToken(token) {
      return {
        auth: token
      }
    }
  }, {
    identity: 'user'
  })

  assert.equal(requestOptions.active_identity, 'user')
  assert.deepEqual(requestOptions.request_options, {
    auth: 'user_access_456'
  })
})

test('describeStatus highlights missing OAuth configuration for user identity mode', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'newagent-feishu-user-auth-status-missing-'))
  const manager = createFeishuUserAuthManager({
    storageRoot,
    env: {
      NEWAGENT_FEISHU_APP_ID: 'cli_123',
      NEWAGENT_FEISHU_APP_SECRET: 'secret_123',
      NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE: 'user_preferred'
    },
    fetchFn: async () => {
      throw new Error('fetch should not run while only describing status')
    }
  })

  const status = await manager.describeStatus()

  assert.equal(status.app_credentials_present, true)
  assert.equal(status.user_identity_requested, true)
  assert.equal(status.authorize_url_ready, false)
  assert.deepEqual(status.missing_configuration, [
    'NEWAGENT_FEISHU_OAUTH_REDIRECT_URI',
    'NEWAGENT_FEISHU_USER_SCOPES'
  ])
  assert.match(status.recommended_next_step, /channel feishu-user-auth-url --json/)
})

test('describeStatus explains the authorize and exchange flow when OAuth is ready but no user is bound', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'newagent-feishu-user-auth-status-ready-'))
  const manager = createFeishuUserAuthManager({
    storageRoot,
    env: {
      NEWAGENT_FEISHU_APP_ID: 'cli_123',
      NEWAGENT_FEISHU_APP_SECRET: 'secret_123',
      NEWAGENT_FEISHU_OAUTH_REDIRECT_URI: 'https://example.com/feishu/callback',
      NEWAGENT_FEISHU_USER_SCOPES: 'docx:document wiki:space',
      NEWAGENT_FEISHU_WORKSPACE_AUTH_MODE: 'user_preferred'
    },
    fetchFn: async () => {
      throw new Error('fetch should not run while only describing status')
    }
  })

  const status = await manager.describeStatus()

  assert.equal(status.oauth_ready, true)
  assert.equal(status.authorize_url_ready, true)
  assert.deepEqual(status.missing_configuration, [])
  assert.match(status.recommended_next_step, /channel feishu-user-auth-url --json/)
  assert.match(status.recommended_next_step, /channel feishu-user-auth-exchange --code <code> --json/)
})
