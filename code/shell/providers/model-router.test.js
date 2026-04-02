import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelRouter } from './model-router.js'
import { createRemoteServerManagerProfile } from '../manager/remote-server-manager-profile.js'

test('resolveRoute sends planning intents to Bailian codingplan', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const route = router.resolveRoute('plan')

  assert.equal(route.runtime, 'llm')
  assert.equal(route.provider, 'bailian')
  assert.equal(route.model, 'codingplan')
})

test('resolveRoute sends execution intents to Bailian qwen3.5-plus', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const route = router.resolveRoute('execute')

  assert.equal(route.runtime, 'llm')
  assert.equal(route.provider, 'bailian')
  assert.equal(route.model, 'qwen3.5-plus')
})

test('resolveRoute keeps dedicated review and repair intents disabled by default', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const review = router.resolveRoute('review')
  const repair = router.resolveRoute('repair')

  assert.equal(review.runtime, 'disabled')
  assert.match(review.reason, /disabled/i)
  assert.equal(repair.runtime, 'disabled')
  assert.match(repair.reason, /disabled/i)
})

test('resolveRoute sends evaluation intents to OpenRouter when external review is enabled', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {
        NEWAGENT_ENABLE_EXTERNAL_REVIEW: 'true',
        NEWAGENT_EXTERNAL_REVIEW_MODEL: 'stepfun/step-3.5-flash:free'
      }
    })
  })
  const route = router.resolveRoute('evaluate')

  assert.equal(route.runtime, 'llm')
  assert.equal(route.provider, 'openrouter')
  assert.equal(route.model, 'stepfun/step-3.5-flash:free')
})

test('resolveRoute sends background intents to OpenRouter when background precompute is enabled', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {
        NEWAGENT_ENABLE_EXTERNAL_REVIEW: 'true',
        NEWAGENT_ENABLE_BACKGROUND_PRECOMPUTE: 'true',
        NEWAGENT_BACKGROUND_PRECOMPUTE_MODEL: 'stepfun/step-3.5-flash:free'
      }
    })
  })
  const route = router.resolveRoute('background')

  assert.equal(route.runtime, 'llm')
  assert.equal(route.provider, 'openrouter')
  assert.equal(route.model, 'stepfun/step-3.5-flash:free')
})

test('resolveRoute can enable dedicated review and repair intents when requested explicitly', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {
        NEWAGENT_ENABLE_CODEX_REVIEW: 'true',
        NEWAGENT_ENABLE_CODEX_REPAIR: 'true'
      }
    })
  })
  const review = router.resolveRoute('review')
  const repair = router.resolveRoute('repair')

  assert.equal(review.runtime, 'tool')
  assert.equal(review.tool_name, 'codex_review_workspace')
  assert.equal(repair.runtime, 'tool')
  assert.equal(repair.tool_name, 'codex_repair_workspace')
})

test('resolveRoute disables evaluation when external review is turned off', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const route = router.resolveRoute('evaluate')

  assert.equal(route.runtime, 'disabled')
  assert.match(route.reason, /external evaluation is disabled/i)
})

test('resolveRoute disables background precompute when it is turned off', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const route = router.resolveRoute('background')

  assert.equal(route.runtime, 'disabled')
  assert.match(route.reason, /background precompute is disabled/i)
})
