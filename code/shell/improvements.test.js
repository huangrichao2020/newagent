/**
 * 改进功能测试 - 基于 Claude Code 源码学习
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './memory/memory-store.js'
import { createBackgroundPrecompute } from './background/precompute.js'
import { createAgentProfile } from './agent/agent-profile.js'

test('MemoryStore - 应该识别确认信号', async () => {
  const memoryStore = createMemoryStore({ storageRoot: '/tmp/test-memory' })

  const positiveTests = [
    '好的',
    '收到',
    '没问题',
    'perfect',
    'yes exactly'
  ]

  for (const text of positiveTests) {
    const result = await memoryStore.isConfirmationSignal(text)
    assert.equal(result.isConfirmation, true)
    assert.equal(result.isNegative, false)
  }

  const negativeTests = [
    '不',
    '不用',
    '暂停',
    '停止',
    'no'
  ]

  for (const text of negativeTests) {
    const result = await memoryStore.isConfirmationSignal(text)
    assert.equal(result.isConfirmation, true)
    assert.equal(result.isNegative, true)
  }
})

test('MemoryStore - 应该提取确认信号', async () => {
  const memoryStore = createMemoryStore({ storageRoot: '/tmp/test-memory' })

  const message = { text: '好的，就这样吧' }
  const context = { sessionId: 'test_123', taskId: 'task_456' }

  const signal = await memoryStore.extractConfirmationSignal(message, context)

  assert.ok(signal)
  assert.equal(signal.type, 'positive_confirmation')
  assert.ok(signal.signal)
})

test('MemoryStore - 双轨制互斥检查', async () => {
  const memoryStore = createMemoryStore({ storageRoot: '/tmp/test-memory' })

  const sessionId = 'test_session_' + Date.now()
  const now = Date.now()

  const hasWrites = await memoryStore.hasMemoryWritesSince(sessionId, now - 60000)
  assert.equal(hasWrites, false)
})

test('BackgroundPrecompute - Gate 1 时间检查应该拦截 99% 请求', async () => {
  const agentProfile = createAgentProfile()
  const precompute = createBackgroundPrecompute({
    storageRoot: '/tmp/test-precompute',
    agentProfile
  })

  const state = {
    last_run_at: new Date(Date.now() - 60000).toISOString(),
    last_scan_at: null,
    consecutive_failures: 0
  }

  const result = await precompute.runCheapestFirstGates(state)

  assert.equal(result.shouldRun, false)
  assert.equal(result.stoppedAt, 'gate1')
  assert.equal(result.gates.gate1.cost, 'nanosecond')
})

test('BackgroundPrecompute - 应该用自然语言表示时间', () => {
  const precompute = createBackgroundPrecompute({
    storageRoot: '/tmp/test-precompute'
  })

  const now = Date.now()
  const oneDayAgo = now - 24 * 60 * 60 * 1000
  const oneHourAgo = now - 60 * 60 * 1000
  const oneMinuteAgo = now - 60 * 1000

  assert.ok(precompute.formatRelativeTime(oneDayAgo).includes('days'))
  assert.ok(precompute.formatRelativeTime(oneHourAgo).includes('hours'))
  assert.ok(precompute.formatRelativeTime(oneMinuteAgo).includes('minutes'))
})

test('AgentProfile - 应该包含 cheapest first 门控配置', () => {
  const profile = createAgentProfile()

  assert.ok(profile.background_precompute)
  assert.ok(profile.background_precompute.cheapest_first_gates)
  assert.ok(profile.background_precompute.cheapest_first_gates.gate1_time_check)
  assert.ok(profile.background_precompute.cheapest_first_gates.gate1_5_scan_throttle)
  assert.ok(profile.background_precompute.cheapest_first_gates.gate2_session_count)
  assert.ok(profile.background_precompute.cheapest_first_gates.gate3_concurrency_lock)
})

test('AgentProfile - 应该包含熔断器配置', () => {
  const profile = createAgentProfile()

  assert.ok(profile.circuit_breaker)
  assert.equal(profile.circuit_breaker.enabled, true)
  assert.equal(profile.circuit_breaker.max_consecutive_failures, 3)
})

test('AgentProfile - 应该包含行动时刻触发器', () => {
  const profile = createAgentProfile()

  assert.ok(profile.prompt_contracts)
  assert.ok(Array.isArray(profile.prompt_contracts.action_moment_triggers))

  const triggers = profile.prompt_contracts.action_moment_triggers
  assert.ok(triggers.some(t => t.trigger.includes('Before')))
  assert.ok(triggers.some(t => t.trigger.includes('When')))
  assert.ok(triggers.some(t => t.trigger.includes('After')))
})

test('AgentProfile - 应该包含双轨记忆配置', () => {
  const profile = createAgentProfile()

  assert.ok(profile.memory)
  assert.ok(profile.memory.dual_track)
  assert.equal(profile.memory.dual_track.primary.kind, 'feedback_rule')
  assert.equal(profile.memory.dual_track.secondary.kind, 'confirmation_signal')
  assert.ok(profile.memory.dual_track.secondary.mutual_exclusion)
})
