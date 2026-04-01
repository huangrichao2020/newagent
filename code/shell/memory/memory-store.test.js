import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from '../session/session-store.js'
import { createMemoryStore } from './memory-store.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-memory-store-'))
  const storageRoot = join(root, 'storage')
  const sessionStore = createSessionStore({ storageRoot })
  const memoryStore = createMemoryStore({ storageRoot })

  return {
    storageRoot,
    sessionStore,
    memoryStore
  }
}

test('addMemoryEntry writes session-scoped memory and appends a timeline event', async () => {
  const { sessionStore, memoryStore } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Remember one session fact',
    projectKey: 'newagent',
    userRequest: 'Persist one session-scoped fact'
  })

  const entry = await memoryStore.addMemoryEntry({
    sessionId: created.session.id,
    scope: 'session',
    kind: 'fact',
    content: 'The current focus is M1 memory design.',
    tags: ['memory', 'm1']
  })
  const matches = await memoryStore.searchMemoryEntries({
    sessionId: created.session.id,
    scope: 'session',
    query: 'memory design'
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(entry.scope, 'session')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].id, entry.id)
  assert.equal(loaded.timeline.at(-1).kind, 'memory_written')
})

test('addMemoryEntry writes project-scoped memory and project search can retrieve it', async () => {
  const { sessionStore, memoryStore } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Remember one project constraint',
    projectKey: 'newagent',
    userRequest: 'Persist one durable project constraint'
  })

  const entry = await memoryStore.addMemoryEntry({
    sessionId: created.session.id,
    scope: 'project',
    kind: 'constraint',
    content: 'Feishu must use a local long-lived connection.',
    tags: ['feishu', 'constraint']
  })
  const matches = await memoryStore.searchMemoryEntries({
    sessionId: created.session.id,
    scope: 'project',
    query: 'long-lived'
  })

  assert.equal(entry.scope, 'project')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].content, 'Feishu must use a local long-lived connection.')
})

test('searchMemoryEntries supports tag filtering and active-only behavior', async () => {
  const { sessionStore, memoryStore } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Filter memory search',
    projectKey: 'newagent',
    userRequest: 'Search memory by tag'
  })

  await memoryStore.addMemoryEntry({
    sessionId: created.session.id,
    scope: 'project',
    kind: 'decision',
    content: 'Use JSONL for append-only memory.',
    tags: ['memory', 'storage']
  })
  await memoryStore.addMemoryEntry({
    sessionId: created.session.id,
    scope: 'project',
    kind: 'decision',
    content: 'Do not add remote relay for Feishu.',
    tags: ['feishu'],
    status: 'superseded'
  })

  const matches = await memoryStore.searchMemoryEntries({
    sessionId: created.session.id,
    scope: 'project',
    tag: 'memory'
  })

  assert.equal(matches.length, 1)
  assert.equal(matches[0].tags.includes('memory'), true)
  assert.equal(matches[0].status, 'active')
})
