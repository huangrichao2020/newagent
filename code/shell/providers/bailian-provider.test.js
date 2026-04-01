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
    /not routed to a Bailian model/
  )
})
