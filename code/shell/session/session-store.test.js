import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from './session-store.js'

async function createTestStore() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-session-store-'))

  return {
    root,
    store: createSessionStore({
      storageRoot: join(root, 'storage')
    })
  }
}

test('createSession creates canonical files and bootstrap timeline', async () => {
  const { root, store } = await createTestStore()
  const created = await store.createSession({
    title: 'Freeze storage layout',
    projectKey: 'newagent',
    userRequest: 'Write storage layout before session kernel implementation'
  })

  const sessionRoot = join(root, 'storage', 'sessions', created.session.id)
  const files = [
    'session.json',
    'task.json',
    'plan_steps.json',
    'approvals.json',
    'timeline.jsonl'
  ]

  for (const fileName of files) {
    const content = await readFile(join(sessionRoot, fileName), 'utf8')
    assert.ok(content.length > 0, `${fileName} should be non-empty`)
  }

  assert.equal(created.session.status, 'planning')
  assert.equal(created.task.status, 'draft')
  assert.deepEqual(
    created.timeline.map((event) => event.kind),
    ['session_created', 'task_created', 'user_message_added']
  )
})

test('loadSession returns persisted current state and timeline', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Resume kernel task',
    projectKey: 'newagent',
    userRequest: 'Prove that session state survives reload'
  })

  const loaded = await store.loadSession(created.session.id)

  assert.equal(loaded.session.id, created.session.id)
  assert.equal(loaded.task.id, created.task.id)
  assert.equal(loaded.session.project_key, 'newagent')
  assert.equal(loaded.timeline.length, 3)
})

test('updateSessionStatus rewrites current state and emits a timeline event', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Move session to running',
    projectKey: 'newagent',
    userRequest: 'Advance session state and keep audit trail'
  })

  await store.updateSessionStatus(created.session.id, 'running', {
    summary: 'Session kernel is executing'
  })

  const loaded = await store.loadSession(created.session.id)

  assert.equal(loaded.session.status, 'running')
  assert.equal(loaded.session.summary, 'Session kernel is executing')
  assert.equal(loaded.timeline.at(-1).kind, 'state_changed')
  assert.deepEqual(loaded.timeline.at(-1).payload, {
    entity: 'session',
    from: 'planning',
    to: 'running'
  })
})

test('updateSessionSummary persists the session summary and emits a timeline event', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Update summary',
    projectKey: 'newagent',
    userRequest: 'Store the manager summary'
  })

  await store.updateSessionSummary(
    created.session.id,
    'The manager generated the first actionable plan.'
  )

  const loaded = await store.loadSession(created.session.id)

  assert.equal(loaded.session.summary, 'The manager generated the first actionable plan.')
  assert.equal(loaded.timeline.at(-1).kind, 'session_summary_updated')
})

test('appendTimelineEvent adds a later audit event without mutating current state files', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Append audit event',
    projectKey: 'newagent',
    userRequest: 'Record later tool execution'
  })

  const event = await store.appendTimelineEvent(created.session.id, {
    kind: 'tool_completed',
    payload: {
      tool_name: 'read_file',
      status: 'ok'
    }
  })

  const loaded = await store.loadSession(created.session.id)

  assert.equal(event.kind, 'tool_completed')
  assert.equal(loaded.timeline.at(-1).kind, 'tool_completed')
  assert.equal(loaded.timeline.at(-1).payload.tool_name, 'read_file')
  assert.equal(loaded.session.status, 'planning')
})

test('createPlan persists ordered plan steps and updates the active task snapshot', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Plan the next kernel slice',
    projectKey: 'newagent',
    userRequest: 'Break session kernel work into explicit steps'
  })

  const plan = await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Read current docs and tests',
        kind: 'research'
      },
      {
        title: 'Implement approval waiting flow',
        kind: 'implementation',
        dependsOn: [0]
      }
    ]
  })

  const loaded = await store.loadSession(created.session.id)

  assert.equal(plan.steps.length, 2)
  assert.equal(loaded.task.status, 'planned')
  assert.equal(loaded.task.plan_step_ids.length, 2)
  assert.equal(loaded.task.current_step_id, loaded.plan_steps[0].id)
  assert.equal(loaded.plan_steps[0].status, 'ready')
  assert.equal(loaded.plan_steps[1].status, 'pending')
  assert.equal(loaded.timeline.at(-1).kind, 'plan_created')
})

test('requestApproval records a pending approval and moves session state to waiting_approval', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Need approval before writing',
    projectKey: 'newagent',
    userRequest: 'Pause before mutating tracked files'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write the next spec file',
        kind: 'implementation'
      }
    ]
  })

  const approval = await store.requestApproval(created.session.id, {
    stepId: (await store.loadSession(created.session.id)).plan_steps[0].id,
    toolName: 'write_file',
    permissionClass: 'dangerous',
    reason: 'Will modify a tracked source file',
    requestedInput: {
      path: 'docs/m1-permissions.md'
    }
  })

  const loaded = await store.loadSession(created.session.id)

  assert.equal(approval.status, 'pending')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.approvals[0].tool_name, 'write_file')
  assert.equal(loaded.session.status, 'waiting_approval')
  assert.equal(loaded.task.status, 'waiting_approval')
  assert.equal(loaded.plan_steps[0].status, 'waiting_approval')
  assert.equal(loaded.timeline.at(-1).kind, 'approval_requested')
})

test('recoverInterruptedSession blocks an active session and appends recovery events', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Recover after interruption',
    projectKey: 'newagent',
    userRequest: 'Resume interrupted shell execution'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Build recovery path',
        kind: 'implementation'
      }
    ]
  })

  const recovered = await store.recoverInterruptedSession(created.session.id, {
    reason: 'process terminated during planning'
  })
  const loaded = await store.loadSession(created.session.id)

  assert.equal(recovered.session.status, 'blocked')
  assert.equal(recovered.task.status, 'blocked')
  assert.equal(loaded.session.status, 'blocked')
  assert.equal(loaded.task.status, 'blocked')
  assert.equal(loaded.timeline.at(-3).kind, 'state_changed')
  assert.equal(loaded.timeline.at(-2).kind, 'state_changed')
  assert.equal(loaded.timeline.at(-1).kind, 'session_recovered')
  assert.equal(loaded.timeline.at(-1).payload.reason, 'process terminated during planning')
})

test('resolveApproval approves a pending request and returns the session to planned state', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Approve pending action',
    projectKey: 'newagent',
    userRequest: 'Resume after explicit approval'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write the next file',
        kind: 'implementation'
      }
    ]
  })

  const snapshotAfterPlan = await store.loadSession(created.session.id)
  const approval = await store.requestApproval(created.session.id, {
    stepId: snapshotAfterPlan.plan_steps[0].id,
    toolName: 'write_file',
    permissionClass: 'dangerous',
    reason: 'Needs explicit file mutation approval',
    requestedInput: {
      path: 'docs/next.md'
    }
  })

  const resolved = await store.resolveApproval(created.session.id, approval.id, 'approved', {
    resolvedBy: 'user'
  })
  const loaded = await store.loadSession(created.session.id)

  assert.equal(resolved.approval.status, 'approved')
  assert.equal(loaded.approvals[0].status, 'approved')
  assert.equal(loaded.session.status, 'planning')
  assert.equal(loaded.task.status, 'planned')
  assert.equal(loaded.plan_steps[0].status, 'ready')
  assert.equal(loaded.timeline.at(-1).kind, 'approval_resolved')
  assert.equal(loaded.timeline.at(-1).payload.decision, 'approved')
})

test('resolveApproval rejects a pending request and blocks the session', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Reject pending action',
    projectKey: 'newagent',
    userRequest: 'Stop after explicit rejection'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Run dangerous change',
        kind: 'implementation'
      }
    ]
  })

  const snapshotAfterPlan = await store.loadSession(created.session.id)
  const approval = await store.requestApproval(created.session.id, {
    stepId: snapshotAfterPlan.plan_steps[0].id,
    toolName: 'write_file',
    permissionClass: 'dangerous',
    reason: 'Needs explicit file mutation approval',
    requestedInput: {
      path: 'docs/blocked.md'
    }
  })

  await store.resolveApproval(created.session.id, approval.id, 'rejected', {
    resolvedBy: 'user',
    resolutionNote: 'Do not change that file'
  })
  const loaded = await store.loadSession(created.session.id)

  assert.equal(loaded.approvals[0].status, 'rejected')
  assert.equal(loaded.session.status, 'blocked')
  assert.equal(loaded.task.status, 'blocked')
  assert.equal(loaded.plan_steps[0].status, 'blocked')
  assert.equal(loaded.timeline.at(-1).kind, 'approval_resolved')
  assert.equal(loaded.timeline.at(-1).payload.decision, 'rejected')
})

test('abortSession marks the active session and task as aborted', async () => {
  const { store } = await createTestStore()
  const created = await store.createSession({
    title: 'Abort current work',
    projectKey: 'newagent',
    userRequest: 'Cancel the current session'
  })

  const aborted = await store.abortSession(created.session.id, {
    reason: 'user_cancelled'
  })
  const loaded = await store.loadSession(created.session.id)

  assert.equal(aborted.session.status, 'aborted')
  assert.equal(loaded.session.status, 'aborted')
  assert.equal(loaded.task.status, 'aborted')
  assert.equal(loaded.timeline.at(-1).kind, 'task_aborted')
  assert.equal(loaded.timeline.at(-1).payload.reason, 'user_cancelled')
})
