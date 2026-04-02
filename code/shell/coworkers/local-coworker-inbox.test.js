import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalCoworkerInbox } from './local-coworker-inbox.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-local-coworker-inbox-'))
  const inboxRoot = join(root, 'inbox')
  const inbox = createLocalCoworkerInbox({
    inboxRoot
  })

  return {
    inbox
  }
}

test('recordRequest stores one received coworker request locally', async () => {
  const { inbox } = await createHarness()

  const record = await inbox.recordRequest({
    id: 'request-1',
    target: 'codex_mac_local',
    question: '请看一下这轮规划。',
    status: 'claimed'
  })

  assert.equal(record.id, 'request-1')
  assert.equal(record.local_status, 'received')
})

test('markReplied updates one local inbox record after a remote reply is sent', async () => {
  const { inbox } = await createHarness()

  await inbox.recordRequest({
    id: 'request-2',
    target: 'codex_mac_local',
    question: '请确认权限边界。'
  })
  const updated = await inbox.markReplied('request-2', {
    answer: '先保持 advisory_only。'
  })

  assert.equal(updated.local_status, 'replied')
  assert.equal(updated.local_answer, '先保持 advisory_only。')
})

test('listRecords can filter local inbox records by status', async () => {
  const { inbox } = await createHarness()

  await inbox.recordRequest({
    id: 'request-3',
    target: 'codex_mac_local',
    question: '第一条'
  })
  await inbox.recordRequest({
    id: 'request-4',
    target: 'codex_mac_local',
    question: '第二条'
  })
  await inbox.markReplied('request-4', {
    answer: '已回。'
  })

  const received = await inbox.listRecords({
    localStatus: 'received'
  })
  const replied = await inbox.listRecords({
    localStatus: 'replied'
  })

  assert.equal(received.length, 1)
  assert.equal(received[0].id, 'request-3')
  assert.equal(replied.length, 1)
  assert.equal(replied[0].id, 'request-4')
})
