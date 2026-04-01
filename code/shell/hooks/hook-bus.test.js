import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHookBus } from './hook-bus.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-hook-bus-'))
  const storageRoot = join(root, 'storage')
  const hookBus = createHookBus({ storageRoot })

  return {
    storageRoot,
    hookBus
  }
}

test('emit persists one hook event and notifies subscribers', async () => {
  const { hookBus } = await createHarness()
  const received = []

  hookBus.on('*', async (event) => {
    received.push(event)
  })

  const emitted = await hookBus.emit({
    name: 'channel.message.received',
    sessionId: 'session-1',
    channel: 'feishu',
    actor: 'channel:feishu',
    payload: {
      message_id: 'om_hook_1'
    }
  })
  const stored = await hookBus.listEvents({
    sessionId: 'session-1'
  })

  assert.equal(emitted.event.name, 'channel.message.received')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].payload.message_id, 'om_hook_1')
  assert.equal(received.length, 1)
  assert.equal(received[0].name, 'channel.message.received')
})

test('listEvents filters by name and limit', async () => {
  const { hookBus } = await createHarness()

  await hookBus.emit({
    name: 'manager.planning.started',
    sessionId: 'session-2',
    payload: {
      step_count: 2
    }
  })
  await hookBus.emit({
    name: 'manager.planning.completed',
    sessionId: 'session-2',
    payload: {
      step_count: 2
    }
  })
  await hookBus.emit({
    name: 'channel.reply.sent',
    sessionId: 'session-2',
    channel: 'feishu',
    payload: {
      stage: 'final_reply'
    }
  })

  const planningEvents = await hookBus.listEvents({
    sessionId: 'session-2',
    name: 'manager.planning.completed'
  })
  const limited = await hookBus.listEvents({
    sessionId: 'session-2',
    limit: 2
  })

  assert.equal(planningEvents.length, 1)
  assert.equal(planningEvents[0].name, 'manager.planning.completed')
  assert.equal(limited.length, 2)
  assert.equal(limited[0].name, 'manager.planning.completed')
  assert.equal(limited[1].name, 'channel.reply.sent')
})
