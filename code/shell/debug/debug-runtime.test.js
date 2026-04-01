import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContextRouter } from '../context/context-router.js'
import { createDebugRuntime } from './debug-runtime.js'
import { createSessionStore } from '../session/session-store.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-debug-runtime-'))
  const storageRoot = join(root, 'storage')
  const sessionStore = createSessionStore({ storageRoot })
  const debugRuntime = createDebugRuntime({ storageRoot })

  return {
    root,
    storageRoot,
    sessionStore,
    debugRuntime
  }
}

test('debug runtime reads current session, task, and plan step state', async () => {
  const { sessionStore, debugRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Debug runtime reads state',
    projectKey: 'newagent',
    userRequest: 'Inspect runtime objects'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      { title: 'Inspect one step', kind: 'inspection' }
    ]
  })

  const session = await debugRuntime.getSession(created.session.id)
  const task = await debugRuntime.getTask(created.session.id)
  const step = await debugRuntime.getPlanStep(created.session.id)

  assert.equal(session.id, created.session.id)
  assert.equal(task.session_id, created.session.id)
  assert.equal(step.title, 'Inspect one step')
})

test('debug runtime inspects persisted context artifacts', async () => {
  const { storageRoot, sessionStore, debugRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Debug runtime inspects context',
    projectKey: 'newagent',
    userRequest: 'Inspect context artifacts'
  })
  const contextRouter = createContextRouter({ storageRoot })

  await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Build context for debug inspection'
  })

  const context = await debugRuntime.inspectContext(created.session.id)

  assert.equal(Array.isArray(context.latest_selection.sources), true)
  assert.equal(Array.isArray(context.latest_merged_context.sections), true)
  assert.match(
    context.latest_merged_context.sections[0].content,
    /Build context for debug inspection/
  )
})

test('debug runtime patches task state and records a debug timeline event', async () => {
  const { sessionStore, debugRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Debug runtime patches task',
    projectKey: 'newagent',
    userRequest: 'Patch task result during debug'
  })

  const patched = await debugRuntime.patchTask(created.session.id, {
    patch: {
      status: 'blocked',
      result: 'Patched by debug runtime'
    },
    reason: 'manual_debug_override'
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(patched.value.status, 'blocked')
  assert.equal(loaded.task.result, 'Patched by debug runtime')
  assert.equal(loaded.timeline.at(-1).kind, 'debug_state_patched')
  assert.equal(loaded.timeline.at(-1).payload.entity, 'task')
})

test('debug runtime rejects patches without allowed keys', async () => {
  const { sessionStore, debugRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Debug runtime rejects bad patch',
    projectKey: 'newagent',
    userRequest: 'Reject an invalid patch'
  })

  await assert.rejects(
    () => debugRuntime.patchSession(created.session.id, {
      patch: {
        id: 'forbidden'
      }
    }),
    /Patch contains no allowed keys/
  )
})
