import { readJson, writeJsonAtomic } from '../../storage/json-files.js'
import { createSessionPaths, createSessionStore } from '../session/session-store.js'

function nowIso() {
  return new Date().toISOString()
}

async function safeReadJson(filePath) {
  try {
    return await readJson(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function assertPatchObject(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Patch must be a plain object')
  }
}

function pickAllowedPatch(patch, allowedKeys) {
  const entries = Object.entries(patch).filter(([key]) => allowedKeys.includes(key))

  if (entries.length === 0) {
    throw new Error(`Patch contains no allowed keys: ${allowedKeys.join(', ')}`)
  }

  return Object.fromEntries(entries)
}

function selectPlanStep(snapshot, stepId = null) {
  if (stepId) {
    const step = snapshot.plan_steps.find((item) => item.id === stepId)

    if (!step) {
      throw new Error(`Unknown plan step: ${stepId}`)
    }

    return step
  }

  if (!snapshot.task.current_step_id) {
    throw new Error('No current plan step is available')
  }

  const current = snapshot.plan_steps.find((item) => item.id === snapshot.task.current_step_id)

  if (!current) {
    throw new Error(`Unknown current plan step: ${snapshot.task.current_step_id}`)
  }

  return current
}

export function createDebugRuntime({ storageRoot }) {
  const sessionStore = createSessionStore({ storageRoot })

  async function getSession(sessionId) {
    const snapshot = await sessionStore.loadSession(sessionId)
    return snapshot.session
  }

  async function getTask(sessionId) {
    const snapshot = await sessionStore.loadSession(sessionId)
    return snapshot.task
  }

  async function getPlanStep(sessionId, { stepId = null } = {}) {
    const snapshot = await sessionStore.loadSession(sessionId)
    return selectPlanStep(snapshot, stepId)
  }

  async function listApprovals(sessionId, { status = null } = {}) {
    const snapshot = await sessionStore.loadSession(sessionId)

    return snapshot.approvals.filter((approval) => {
      if (!status) {
        return true
      }

      return approval.status === status
    })
  }

  async function inspectContext(sessionId) {
    const paths = createSessionPaths(storageRoot, sessionId)

    return {
      latest_selection: await safeReadJson(`${paths.contextRoot}/latest-selection.json`),
      latest_merged_context: await safeReadJson(`${paths.contextRoot}/latest-merged-context.json`)
    }
  }

  async function replayTimeline(sessionId, { limit = null } = {}) {
    const snapshot = await sessionStore.loadSession(sessionId)

    if (!limit) {
      return snapshot.timeline
    }

    return snapshot.timeline.slice(-limit)
  }

  async function patchSession(sessionId, { patch, reason = 'debug_patch' }) {
    assertPatchObject(patch)

    const snapshot = await sessionStore.loadSession(sessionId)
    const paths = createSessionPaths(storageRoot, sessionId)
    const appliedPatch = pickAllowedPatch(patch, ['status', 'summary', 'title'])
    const nextSession = {
      ...snapshot.session,
      ...appliedPatch,
      updated_at: nowIso()
    }

    await writeJsonAtomic(paths.sessionFile, nextSession)
    const event = await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'debug_state_patched',
      payload: {
        entity: 'session',
        target_id: nextSession.id,
        patched_keys: Object.keys(appliedPatch),
        reason
      }
    })

    return {
      entity: 'session',
      value: nextSession,
      event
    }
  }

  async function patchTask(sessionId, { patch, reason = 'debug_patch' }) {
    assertPatchObject(patch)

    const snapshot = await sessionStore.loadSession(sessionId)
    const paths = createSessionPaths(storageRoot, sessionId)
    const appliedPatch = pickAllowedPatch(patch, [
      'status',
      'title',
      'user_request',
      'current_step_id',
      'result'
    ])
    const nextTask = {
      ...snapshot.task,
      ...appliedPatch,
      updated_at: nowIso()
    }

    await writeJsonAtomic(paths.taskFile, nextTask)
    const event = await sessionStore.appendTimelineEvent(sessionId, {
      kind: 'debug_state_patched',
      payload: {
        entity: 'task',
        target_id: nextTask.id,
        patched_keys: Object.keys(appliedPatch),
        reason
      }
    })

    return {
      entity: 'task',
      value: nextTask,
      event
    }
  }

  async function patchPlanStep(sessionId, { stepId, patch, reason = 'debug_patch' }) {
    assertPatchObject(patch)

    const snapshot = await sessionStore.loadSession(sessionId)
    const paths = createSessionPaths(storageRoot, sessionId)
    const targetStep = selectPlanStep(snapshot, stepId)
    const appliedPatch = pickAllowedPatch(patch, [
      'status',
      'title',
      'kind',
      'notes',
      'attempt_count',
      'started_at',
      'finished_at'
    ])
    const nextPlanSteps = snapshot.plan_steps.map((step) => {
      if (step.id !== targetStep.id) {
        return step
      }

      return {
        ...step,
        ...appliedPatch
      }
    })
    const nextStep = nextPlanSteps.find((step) => step.id === targetStep.id)

    await writeJsonAtomic(paths.planStepsFile, nextPlanSteps)
    const event = await sessionStore.appendTimelineEvent(sessionId, {
      stepId: targetStep.id,
      kind: 'debug_state_patched',
      payload: {
        entity: 'plan_step',
        target_id: targetStep.id,
        patched_keys: Object.keys(appliedPatch),
        reason
      }
    })

    return {
      entity: 'plan_step',
      value: nextStep,
      event
    }
  }

  return {
    getSession,
    getTask,
    getPlanStep,
    listApprovals,
    inspectContext,
    replayTimeline,
    patchSession,
    patchTask,
    patchPlanStep
  }
}
