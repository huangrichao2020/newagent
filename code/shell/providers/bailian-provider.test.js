import test from 'node:test'
import assert from 'node:assert/strict'
import { createBailianProvider } from './bailian-provider.js'

function createFakeFetch({ expectedUrl, responsePayload, ok = true, status = 200 }) {
  return async (url, options) => {
    assert.equal(url, expectedUrl)
    return {
      ok,
      status,
      headers: {
        get(name) {
          return name.toLowerCase() === 'content-type'
            ? 'application/json'
            : ''
        }
      },
      async json() {
        return responsePayload(options)
      }
    }
  }
}

test('invokeByIntent routes planning prompts to Bailian codingplan semantics over qwen3.5-plus with thinking enabled', async () => {
  const provider = createBailianProvider({
    fetchFn: createFakeFetch({
      expectedUrl: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
      responsePayload(options) {
        const body = JSON.parse(options.body)
        assert.equal(body.model, 'qwen3.5-plus')
        assert.deepEqual(body.extra_body, {
          enable_thinking: true
        })
        assert.equal(body.messages[0].role, 'system')
        assert.equal(body.messages[1].role, 'user')

        return {
          id: 'chatcmpl-plan',
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Plan accepted.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: {
            total_tokens: 12
          }
        }
      }
    })
  })

  const result = await provider.invokeByIntent({
    intent: 'plan',
    apiKey: 'test-key',
    prompt: 'Make a work plan.',
    systemPrompt: 'You are the planner.'
  })

  assert.equal(result.route.model, 'codingplan')
  assert.equal(result.request.model, 'qwen3.5-plus')
  assert.deepEqual(result.request.extra_body, {
    enable_thinking: true
  })
  assert.equal(result.response.content, 'Plan accepted.')
  assert.equal(result.request.base_url, 'https://coding.dashscope.aliyuncs.com/v1')
})

test('invokeByIntent routes execution prompts to Bailian qwen3.5-plus', async () => {
  const provider = createBailianProvider({
    fetchFn: createFakeFetch({
      expectedUrl: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
      responsePayload(options) {
        const body = JSON.parse(options.body)
        assert.equal(body.model, 'qwen3.5-plus')

        return {
          id: 'chatcmpl-execute',
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Execution answer.'
              },
              finish_reason: 'stop'
            }
          ]
        }
      }
    })
  })

  const result = await provider.invokeByIntent({
    intent: 'execute',
    apiKey: 'test-key',
    prompt: 'Do the current task.'
  })

  assert.equal(result.route.model, 'qwen3.5-plus')
  assert.equal(result.response.content, 'Execution answer.')
})

test('invokeByIntent rejects tool-routed intents such as repair', async () => {
  const provider = createBailianProvider({
    fetchFn: async () => {
      throw new Error('Should not reach network')
    }
  })

  await assert.rejects(
    () => provider.invokeByIntent({
      intent: 'repair',
      apiKey: 'test-key',
      prompt: 'Fix it.'
    }),
    /not routed to an LLM provider/
  )
})

test('invokeByIntent routes evaluation prompts to OpenRouter when enabled', async () => {
  const provider = createBailianProvider({
    managerProfile: {
      model_routing: {
        evaluation: {
          provider: 'openrouter',
          model: 'stepfun/step-3.5-flash:free',
          api_key_env: 'OPENROUTER_API_KEY',
          fallback_api_key_envs: [],
          base_url_env: 'NEWAGENT_OPENROUTER_BASE_URL',
          base_url_default: 'https://openrouter.ai/api/v1',
          extra_headers: {
            'HTTP-Referer': 'https://newagent.local',
            'X-OpenRouter-Title': 'newagent'
          }
        }
      },
      external_review: {
        enabled: true
      },
      codex_integration: {
        allow_review: false,
        allow_repair: false
      }
    },
    modelRouter: {
      resolveRoute() {
        return {
          intent: 'evaluate',
          route_key: 'evaluation',
          runtime: 'llm',
          provider: 'openrouter',
          model: 'stepfun/step-3.5-flash:free',
          api_key_env: 'OPENROUTER_API_KEY',
          fallback_api_key_envs: [],
          base_url_env: 'NEWAGENT_OPENROUTER_BASE_URL',
          base_url_default: 'https://openrouter.ai/api/v1',
          extra_headers: {
            'HTTP-Referer': 'https://newagent.local',
            'X-OpenRouter-Title': 'newagent'
          }
        }
      }
    },
    fetchFn: createFakeFetch({
      expectedUrl: 'https://openrouter.ai/api/v1/chat/completions',
      responsePayload(options) {
        const body = JSON.parse(options.body)

        assert.equal(body.model, 'stepfun/step-3.5-flash:free')
        assert.equal(options.headers.Authorization, 'Bearer openrouter-test-key')
        assert.equal(options.headers['HTTP-Referer'], 'https://newagent.local')
        assert.equal(options.headers['X-OpenRouter-Title'], 'newagent')

        return {
          id: 'chatcmpl-evaluate',
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'External review ok.'
              },
              finish_reason: 'stop'
            }
          ]
        }
      }
    })
  })

  const result = await provider.invokeByIntent({
    intent: 'evaluate',
    apiKey: 'openrouter-test-key',
    prompt: 'Review this plan.'
  })

  assert.equal(result.route.provider, 'openrouter')
  assert.equal(result.request.provider, 'openrouter')
  assert.equal(result.response.content, 'External review ok.')
})
