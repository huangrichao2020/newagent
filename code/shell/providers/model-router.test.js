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

test('resolveRoute sends review and repair intents to codex tool adapters', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    })
  })
  const review = router.resolveRoute('review')
  const repair = router.resolveRoute('repair')

  assert.equal(review.runtime, 'tool')
  assert.equal(review.tool_name, 'codex_review_workspace')
  assert.equal(repair.runtime, 'tool')
  assert.equal(repair.tool_name, 'codex_repair_workspace')
})

test('resolveRoute disables review and repair when Codex integration is turned off', () => {
  const router = createModelRouter({
    managerProfile: createRemoteServerManagerProfile({
      env: {
        NEWAGENT_DISABLE_CODEX: 'true'
      }
    })
  })
  const review = router.resolveRoute('review')
  const repair = router.resolveRoute('repair')

  assert.equal(review.runtime, 'disabled')
  assert.match(review.reason, /disabled/i)
  assert.equal(repair.runtime, 'disabled')
  assert.match(repair.reason, /disabled/i)
})
