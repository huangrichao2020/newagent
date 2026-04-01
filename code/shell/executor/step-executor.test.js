import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from '../session/session-store.js'
import { createStepExecutor } from './step-executor.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-step-executor-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const sessionStore = createSessionStore({ storageRoot })
  const stepExecutor = createStepExecutor({
    storageRoot,
    workspaceRoot
  })

  return {
    storageRoot,
    workspaceRoot,
    sessionStore,
    stepExecutor
  }
}

test('executeCurrentStep builds context, runs a safe tool, and completes the only plan step', async () => {
  const { workspaceRoot, sessionStore, stepExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Execute one safe step',
    projectKey: 'newagent',
    userRequest: 'Read one file through the executor loop'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Read the workspace note',
        kind: 'implementation'
      }
    ]
  })
  const filePath = join(workspaceRoot, 'note.txt')
  await writeFile(filePath, 'executor safe path\n', 'utf8')

  const result = await stepExecutor.executeCurrentStep({
    sessionId: created.session.id,
    currentInput: 'Use the current step to read the workspace note.',
    toolName: 'read_file',
    toolInput: {
      path: filePath
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'completed')
  assert.equal(result.tool_result.status, 'ok')
  assert.equal(result.context.merged_context.sections[0].kind, 'current_input')
  assert.equal(loaded.session.status, 'completed')
  assert.equal(loaded.task.status, 'completed')
  assert.equal(loaded.plan_steps[0].status, 'completed')
  assert.equal(loaded.timeline.some((event) => event.kind === 'plan_step_started'), true)
  assert.equal(loaded.timeline.some((event) => event.kind === 'plan_step_completed'), true)
  assert.equal(loaded.timeline.at(-1).kind, 'task_completed')
})

test('executeCurrentStep pauses on dangerous tools and leaves the step waiting for approval', async () => {
  const { sessionStore, stepExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Execute one dangerous step',
    projectKey: 'newagent',
    userRequest: 'Pause before writing a file'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write a file after approval',
        kind: 'implementation'
      }
    ]
  })

  const result = await stepExecutor.executeCurrentStep({
    sessionId: created.session.id,
    currentInput: 'Try the write tool and pause for approval.',
    toolName: 'write_file',
    toolInput: {
      path: join('/tmp', 'newagent-danger.txt'),
      content: 'dangerous write'
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.tool_result.status, 'waiting_approval')
  assert.equal(loaded.session.status, 'waiting_approval')
  assert.equal(loaded.task.status, 'waiting_approval')
  assert.equal(loaded.plan_steps[0].status, 'waiting_approval')
  assert.equal(loaded.approvals.length, 1)
})

test('executeCurrentStep can resume and complete a dangerous step after approval', async () => {
  const { workspaceRoot, sessionStore, stepExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Resume approved dangerous step',
    projectKey: 'newagent',
    userRequest: 'Continue the same dangerous step after approval'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write one approved file',
        kind: 'implementation'
      }
    ]
  })

  const targetPath = join(workspaceRoot, 'danger-approved.txt')
  const firstAttempt = await stepExecutor.executeCurrentStep({
    sessionId: created.session.id,
    currentInput: 'Try the dangerous write and pause for approval.',
    toolName: 'write_file',
    toolInput: {
      path: targetPath,
      content: 'approved dangerous path\n'
    }
  })

  await sessionStore.resolveApproval(
    created.session.id,
    firstAttempt.tool_result.approval.id,
    'approved',
    {
      resolvedBy: 'user'
    }
  )

  const secondAttempt = await stepExecutor.executeCurrentStep({
    sessionId: created.session.id,
    currentInput: 'Now continue the approved write.',
    toolName: 'write_file',
    toolInput: {
      path: targetPath,
      content: 'approved dangerous path\n'
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(secondAttempt.status, 'completed')
  assert.equal(secondAttempt.tool_result.status, 'ok')
  assert.equal(loaded.session.status, 'completed')
  assert.equal(loaded.task.status, 'completed')
  assert.equal(loaded.plan_steps[0].status, 'completed')
})

test('continueApprovedStep resolves approval and completes the stored dangerous step', async () => {
  const { workspaceRoot, sessionStore, stepExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Continue approved step',
    projectKey: 'newagent',
    userRequest: 'Approve and continue in one executor call'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write an approved file',
        kind: 'implementation'
      }
    ]
  })

  const targetPath = join(workspaceRoot, 'continue-approved.txt')
  const firstAttempt = await stepExecutor.executeCurrentStep({
    sessionId: created.session.id,
    currentInput: 'Pause the dangerous write.',
    toolName: 'write_file',
    toolInput: {
      path: targetPath,
      content: 'continue approval path\n'
    }
  })

  const resumed = await stepExecutor.continueApprovedStep({
    sessionId: created.session.id,
    approvalId: firstAttempt.tool_result.approval.id,
    currentInput: 'Now continue the approved write.',
    resolvedBy: 'user'
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.approval.status, 'approved')
  assert.equal(resumed.execution.tool_result.status, 'ok')
  assert.equal(loaded.session.status, 'completed')
})
