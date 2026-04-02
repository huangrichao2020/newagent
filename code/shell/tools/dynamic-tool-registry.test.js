import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDynamicToolRegistry } from './dynamic-tool-registry.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-dynamic-tool-registry-'))
  const storageRoot = join(root, 'storage')
  const registry = createDynamicToolRegistry({
    storageRoot
  })

  return {
    storageRoot,
    registry
  }
}

test('registerTool stores one temporary dynamic tool with restart metadata', async () => {
  const { registry } = await createHarness()

  const tool = await registry.registerTool({
    tool_name: 'temp_lookup',
    description: 'Temporary lookup helper',
    category: 'server_ops',
    command: 'node ./scripts/temp-lookup.js',
    cwd: '/root/newagent/code',
    lifecycle: 'temporary',
    review_status: 'pending_review',
    restart_required: true,
    restart_time_hint: '03:30'
  })

  assert.equal(tool.tool_name, 'temp_lookup')
  assert.equal(tool.category, 'server_ops')
  assert.equal(tool.lifecycle, 'temporary')
  assert.equal(tool.review_status, 'pending_review')
  assert.equal(tool.restart_required, true)
  assert.equal(tool.restart_strategy, 'notify_unless_blocked')
})

test('recordToolUsage updates usage counters and markToolReviewed can promote one tool', async () => {
  const { registry } = await createHarness()
  await registry.registerTool({
    tool_name: 'temp_lookup',
    description: 'Temporary lookup helper',
    category: 'project',
    command: 'node ./scripts/temp-lookup.js'
  })

  const used = await registry.recordToolUsage('temp_lookup')
  const reviewed = await registry.markToolReviewed('temp_lookup', {
    lifecycle: 'permanent',
    reviewStatus: 'approved',
    reviewNotes: 'Used often enough to keep.'
  })

  assert.equal(used.usage_count, 1)
  assert.ok(used.last_used_at)
  assert.equal(reviewed.lifecycle, 'permanent')
  assert.equal(reviewed.review_status, 'approved')
  assert.equal(reviewed.review_notes, 'Used often enough to keep.')
})

test('listReviewQueue returns pending review tools only', async () => {
  const { registry } = await createHarness()
  await registry.registerTool({
    tool_name: 'temp_a',
    description: 'Temporary A',
    category: 'server_ops',
    command: 'node ./scripts/a.js',
    review_status: 'pending_review'
  })
  await registry.registerTool({
    tool_name: 'temp_b',
    description: 'Temporary B',
    category: 'project',
    command: 'node ./scripts/b.js',
    review_status: 'approved'
  })

  const queue = await registry.listReviewQueue()
  const filtered = await registry.listTools({
    category: 'server_ops'
  })

  assert.equal(queue.length, 1)
  assert.equal(queue[0].tool_name, 'temp_a')
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].tool_name, 'temp_a')
})
