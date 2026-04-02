import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNotificationScript,
  createCoworkerNotifier,
  escapeAppleScriptString
} from './coworker-notifier.js'

test('escapeAppleScriptString escapes quotes and backslashes', () => {
  assert.equal(
    escapeAppleScriptString('say "hi" \\ ok'),
    'say \\"hi\\" \\\\ ok'
  )
})

test('buildNotificationScript includes one subtitle when provided', () => {
  const script = buildNotificationScript({
    title: 'newagent',
    subtitle: 'Need review',
    body: 'Check this request.'
  })

  assert.equal(
    script,
    'display notification "Check this request." with title "newagent" subtitle "Need review"'
  )
})

test('notifyRequest runs osascript with one summarized notification payload', async () => {
  const calls = []
  const notifier = createCoworkerNotifier({
    execFileFn: async (...args) => {
      calls.push(args)
      return {
        stdout: '',
        stderr: ''
      }
    }
  })

  const result = await notifier.notifyRequest({
    id: 'req-1',
    title: 'Codex 同事需要看看这个长期协作请求',
    question: '如果你收到这条消息，请先记录下来，然后再决定是否需要人工继续处理。'
  })

  assert.equal(result.delivered, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'osascript')
  assert.equal(calls[0][1][0], '-e')
  assert.match(calls[0][1][1], /display notification/)
  assert.match(calls[0][1][1], /with title "newagent 有新协作消息"/)
})

test('notifyRequest can be disabled without shelling out', async () => {
  let called = false
  const notifier = createCoworkerNotifier({
    enabled: false,
    execFileFn: async () => {
      called = true
    }
  })

  const result = await notifier.notifyRequest({
    id: 'req-2'
  })

  assert.equal(result.skipped, true)
  assert.equal(called, false)
})
