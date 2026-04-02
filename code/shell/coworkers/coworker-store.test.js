import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoworkerStore } from './coworker-store.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-coworker-store-'))
  const storageRoot = join(root, 'storage')
  const coworkerStore = createCoworkerStore({ storageRoot })

  return {
    storageRoot,
    coworkerStore
  }
}

test('createRequest persists one pending coworker request and listRequests can filter it', async () => {
  const { coworkerStore } = await createHarness()

  const created = await coworkerStore.createRequest({
    sessionId: 'session-1',
    source: 'newagent-manager',
    target: 'codex_mac_local',
    title: 'Need one Codex confirmation',
    question: '这个变更会不会影响 Feishu 线程回复？',
    context: '当前正在收紧引用消息优先级。',
    tags: ['codex', 'feishu']
  })
  const listed = await coworkerStore.listRequests({
    target: 'codex_mac_local',
    status: 'pending'
  })

  assert.equal(created.status, 'pending')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.id)
  assert.equal(listed[0].context, '当前正在收紧引用消息优先级。')
})

test('claimRequest marks one request as claimed by the Mac-local Codex listener', async () => {
  const { coworkerStore } = await createHarness()
  const created = await coworkerStore.createRequest({
    target: 'codex_mac_local',
    title: 'Need one queueing review',
    question: '看一下这轮追加消息排队设计。'
  })

  const claimed = await coworkerStore.claimRequest(created.id, {
    claimedBy: 'codex_mac_local',
    location: 'mac_local_codex'
  })

  assert.equal(claimed.status, 'claimed')
  assert.equal(claimed.claimed_by, 'codex_mac_local')
  assert.equal(claimed.location, 'mac_local_codex')
})

test('resolveRequest writes the coworker answer back onto the request record', async () => {
  const { coworkerStore } = await createHarness()
  const created = await coworkerStore.createRequest({
    sessionId: 'session-2',
    target: 'codex_mac_local',
    title: 'Need one final check',
    question: '请确认本机 Codex 通道的最小实现是否合理。'
  })

  const resolved = await coworkerStore.resolveRequest(created.id, {
    answer: '合理，先用远端存储 + 本机长轮询就够了。',
    resolvedBy: 'codex_mac_local',
    location: 'mac_local_codex'
  })
  const stored = await coworkerStore.getRequest(created.id)

  assert.equal(resolved.status, 'resolved')
  assert.equal(resolved.answer, '合理，先用远端存储 + 本机长轮询就够了。')
  assert.equal(stored.resolved_by, 'codex_mac_local')
  assert.equal(stored.location, 'mac_local_codex')
})
