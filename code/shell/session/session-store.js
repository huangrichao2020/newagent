import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { appendJsonLine, readJson, readJsonLines, writeJsonAtomic } from '../../storage/json-files.js'

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(value, length) {
  let remaining = value
  let output = ''

  for (let index = 0; index < length; index += 1) {
    output = `${CROCKFORD_BASE32[remaining % 32]}${output}`
    remaining = Math.floor(remaining / 32)
  }

  return output
}

function encodeRandom(length) {
  const bytes = randomBytes(length)
  let output = ''

  for (let index = 0; index < length; index += 1) {
    output += CROCKFORD_BASE32[bytes[index] % 32]
  }

  return output
}

export function createUlid(now = Date.now()) {
  return `${encodeTime(now, 10)}${encodeRandom(16)}`
}

function nowIso() {
  return new Date().toISOString()
}

function createPaths(storageRoot, sessionId) {
  const sessionRoot = join(storageRoot, 'sessions', sessionId)

  return {
    sessionRoot,
    sessionFile: join(sessionRoot, 'session.json'),
    taskFile: join(sessionRoot, 'task.json'),
    planStepsFile: join(sessionRoot, 'plan_steps.json'),
    approvalsFile: join(sessionRoot, 'approvals.json'),
    timelineFile: join(sessionRoot, 'timeline.jsonl'),
    contextRoot: join(sessionRoot, 'context'),
    locksRoot: join(sessionRoot, 'locks')
  }
}

export function createSessionPaths(storageRoot, sessionId) {
  return createPaths(storageRoot, sessionId)
}

function createTimelineEvent({
  sessionId,
  taskId = null,
  stepId = null,
  kind,
  actor = 'shell',
  payload = {},
  at = nowIso()
}) {
  return {
    id: createUlid(),
    session_id: sessionId,
    task_id: taskId,
    step_id: stepId,
    kind,
    actor,
    at,
    payload,
    version: 1
  }
}

export function createSessionStore({ storageRoot }) {
  async function writeSessionSnapshot(paths, snapshot) {
    await writeJsonAtomic(paths.sessionFile, snapshot.session)
    await writeJsonAtomic(paths.taskFile, snapshot.task)
    await writeJsonAtomic(paths.planStepsFile, snapshot.plan_steps)
    await writeJsonAtomic(paths.approvalsFile, snapshot.approvals)
  }

  async function appendTimelineEvents(paths, events) {
    for (const event of events) {
      await appendJsonLine(paths.timelineFile, event)
    }
  }

  async function createSession({
    title,
    projectKey,
    userRequest,
    summary = null,
    userMessageMeta = null
  }) {
    const sessionId = createUlid()
    const taskId = createUlid()
    const createdAt = nowIso()
    const paths = createPaths(storageRoot, sessionId)

    const session = {
      id: sessionId,
      title,
      status: 'planning',
      project_key: projectKey,
      active_task_id: taskId,
      created_at: createdAt,
      updated_at: createdAt,
      summary: summary ?? `Started session for ${title}`,
      version: 1
    }

    const task = {
      id: taskId,
      session_id: sessionId,
      title,
      user_request: userRequest,
      status: 'draft',
      plan_step_ids: [],
      current_step_id: null,
      created_at: createdAt,
      updated_at: createdAt,
      result: null,
      version: 1
    }

    const planSteps = []
    const approvals = []

    await mkdir(paths.contextRoot, { recursive: true })
    await mkdir(paths.locksRoot, { recursive: true })
    await writeSessionSnapshot(paths, {
      session,
      task,
      plan_steps: planSteps,
      approvals
    })

    const bootstrapEvents = [
      createTimelineEvent({
        sessionId,
        taskId,
        kind: 'session_created',
        payload: {
          title,
          project_key: projectKey
        },
        at: createdAt
      }),
      createTimelineEvent({
        sessionId,
        taskId,
        kind: 'task_created',
        payload: {
          title
        },
        at: createdAt
      }),
      createTimelineEvent({
        sessionId,
        taskId,
        kind: 'user_message_added',
        actor: 'user',
        payload: {
          content: userRequest,
          ...(userMessageMeta ?? {})
        },
        at: createdAt
      })
    ]

    await appendTimelineEvents(paths, bootstrapEvents)

    return {
      session,
      task,
      plan_steps: planSteps,
      approvals,
      timeline: bootstrapEvents
    }
  }

  async function startNextTurn(sessionId, {
    title,
    userRequest,
    summary = undefined,
    startedAt = nowIso(),
    userMessageMeta = null
  }) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const nextTaskId = createUlid()
    const nextSession = {
      ...snapshot.session,
      title,
      status: 'planning',
      active_task_id: nextTaskId,
      updated_at: startedAt,
      summary: summary === undefined ? snapshot.session.summary : summary
    }
    const nextTask = {
      id: nextTaskId,
      session_id: sessionId,
      title,
      user_request: userRequest,
      status: 'draft',
      plan_step_ids: [],
      current_step_id: null,
      created_at: startedAt,
      updated_at: startedAt,
      result: null,
      version: 1
    }
    const nextPlanSteps = []
    const nextApprovals = []

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: nextApprovals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: startedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: nextTaskId,
        kind: 'session_turn_started',
        payload: {
          previous_task_id: snapshot.task.id,
          next_task_id: nextTaskId,
          title
        },
        at: startedAt
      })
    )
    events.push(
      createTimelineEvent({
        sessionId,
        taskId: nextTaskId,
        kind: 'task_created',
        payload: {
          title
        },
        at: startedAt
      })
    )
    events.push(
      createTimelineEvent({
        sessionId,
        taskId: nextTaskId,
        kind: 'user_message_added',
        actor: 'user',
        payload: {
          content: userRequest,
          ...(userMessageMeta ?? {})
        },
        at: startedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: nextApprovals,
      timeline_events: events
    }
  }

  async function loadSession(sessionId) {
    const paths = createPaths(storageRoot, sessionId)

    return {
      session: await readJson(paths.sessionFile),
      task: await readJson(paths.taskFile),
      plan_steps: await readJson(paths.planStepsFile),
      approvals: await readJson(paths.approvalsFile),
      timeline: await readJsonLines(paths.timelineFile)
    }
  }

  async function appendTimelineEvent(sessionId, eventInput) {
    const { session, task } = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const event = createTimelineEvent({
      sessionId: session.id,
      taskId: eventInput.taskId ?? task.id,
      stepId: eventInput.stepId ?? null,
      kind: eventInput.kind,
      actor: eventInput.actor ?? 'shell',
      payload: eventInput.payload ?? {},
      at: eventInput.at ?? nowIso()
    })

    await appendJsonLine(paths.timelineFile, event)

    return event
  }

  async function createPlan(sessionId, planInput) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const updatedAt = planInput.updatedAt ?? nowIso()
    const rawSteps = planInput.steps ?? []
    const nextPlanSteps = rawSteps.map((stepInput, index) => ({
      id: createUlid(),
      task_id: snapshot.task.id,
      index: index + 1,
      title: stepInput.title,
      kind: stepInput.kind ?? 'general',
      status: index === 0 ? 'ready' : 'pending',
      depends_on: [],
      notes: stepInput.notes ?? null,
      attempt_count: 0,
      started_at: null,
      finished_at: null,
      version: 1
    }))

    for (let index = 0; index < rawSteps.length; index += 1) {
      const rawDependsOn = rawSteps[index].dependsOn ?? []
      nextPlanSteps[index].depends_on = rawDependsOn
        .map((dependency) => {
          if (typeof dependency === 'number') {
            return nextPlanSteps[dependency]?.id ?? null
          }

          return dependency
        })
        .filter(Boolean)
    }

    const nextTask = {
      ...snapshot.task,
      status: 'planned',
      plan_step_ids: nextPlanSteps.map((step) => step.id),
      current_step_id: nextPlanSteps[0]?.id ?? null,
      updated_at: updatedAt
    }

    const nextSession = {
      ...snapshot.session,
      updated_at: updatedAt
    }

    const nextSnapshot = {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals
    }

    await writeSessionSnapshot(paths, nextSnapshot)

    const event = createTimelineEvent({
      sessionId,
      taskId: snapshot.task.id,
      kind: 'plan_created',
      payload: {
        step_count: nextPlanSteps.length,
        step_ids: nextPlanSteps.map((step) => step.id)
      },
      at: updatedAt
    })

    await appendTimelineEvents(paths, [event])

    return {
      ...nextSnapshot,
      timeline_event: event,
      steps: nextPlanSteps
    }
  }

  async function startPlanStep(sessionId, stepId, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const startedAt = options.startedAt ?? nowIso()
    const step = snapshot.plan_steps.find((item) => item.id === stepId)

    if (!step) {
      throw new Error(`Unknown plan step: ${stepId}`)
    }

    const nextSession = {
      ...snapshot.session,
      status: 'running',
      updated_at: startedAt
    }
    const nextTask = {
      ...snapshot.task,
      status: 'running',
      current_step_id: stepId,
      updated_at: startedAt
    }
    const nextPlanSteps = snapshot.plan_steps.map((item) => {
      if (item.id !== stepId) {
        return item
      }

      return {
        ...item,
        status: 'running',
        started_at: item.started_at ?? startedAt,
        attempt_count: item.attempt_count + 1
      }
    })

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: startedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: startedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        stepId,
        kind: 'plan_step_started',
        payload: {
          step_title: step.title
        },
        at: startedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals,
      events
    }
  }

  async function updateSessionStatus(sessionId, nextStatus, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const updatedAt = options.updatedAt ?? nowIso()
    const previousStatus = snapshot.session.status

    const nextSession = {
      ...snapshot.session,
      status: nextStatus,
      updated_at: updatedAt,
      summary: options.summary ?? snapshot.session.summary
    }

    await writeJsonAtomic(paths.sessionFile, nextSession)

    const event = createTimelineEvent({
      sessionId,
      taskId: snapshot.task.id,
      kind: 'state_changed',
      payload: {
        entity: 'session',
        from: previousStatus,
        to: nextStatus
      },
      at: updatedAt
    })

    await appendJsonLine(paths.timelineFile, event)

    return {
      session: nextSession,
      event
    }
  }

  async function updateSessionSummary(sessionId, summary, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const updatedAt = options.updatedAt ?? nowIso()
    const nextSession = {
      ...snapshot.session,
      summary,
      updated_at: updatedAt
    }

    await writeJsonAtomic(paths.sessionFile, nextSession)

    const event = createTimelineEvent({
      sessionId,
      taskId: snapshot.task.id,
      kind: 'session_summary_updated',
      payload: {
        summary
      },
      at: updatedAt
    })

    await appendJsonLine(paths.timelineFile, event)

    return {
      session: nextSession,
      event
    }
  }

  async function requestApproval(sessionId, requestInput) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const requestedAt = requestInput.requestedAt ?? nowIso()
    const approval = {
      id: createUlid(),
      session_id: sessionId,
      task_id: snapshot.task.id,
      step_id: requestInput.stepId ?? null,
      tool_name: requestInput.toolName,
      permission_class: requestInput.permissionClass,
      reason: requestInput.reason,
      requested_input: requestInput.requestedInput ?? {},
      status: 'pending',
      requested_at: requestedAt,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      version: 1
    }

    const nextSession = {
      ...snapshot.session,
      status: 'waiting_approval',
      updated_at: requestedAt
    }

    const nextTask = {
      ...snapshot.task,
      status: 'waiting_approval',
      updated_at: requestedAt
    }

    const nextPlanSteps = snapshot.plan_steps.map((step) => {
      if (step.id !== requestInput.stepId) {
        return step
      }

      return {
        ...step,
        status: 'waiting_approval'
      }
    })

    const nextApprovals = [...snapshot.approvals, approval]

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: nextApprovals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: requestedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId: requestInput.stepId ?? null,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: requestedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        stepId: requestInput.stepId ?? null,
        kind: 'approval_requested',
        payload: {
          approval_id: approval.id,
          tool_name: approval.tool_name,
          permission_class: approval.permission_class,
          reason: approval.reason
        },
        at: requestedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return approval
  }

  async function resolveApproval(sessionId, approvalId, decision, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const resolvedAt = options.resolvedAt ?? nowIso()
    const approval = snapshot.approvals.find((item) => item.id === approvalId)

    if (!approval) {
      throw new Error(`Unknown approval: ${approvalId}`)
    }

    if (approval.status !== 'pending') {
      throw new Error(`Approval is not pending: ${approvalId}`)
    }

    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error(`Unsupported approval decision: ${decision}`)
    }

    const nextApprovalStatus = decision
    const resolvedApproval = {
      ...approval,
      status: nextApprovalStatus,
      resolved_at: resolvedAt,
      resolved_by: options.resolvedBy ?? 'user',
      resolution_note: options.resolutionNote ?? null
    }
    const nextApprovals = snapshot.approvals.map((item) =>
      item.id === approvalId ? resolvedApproval : item
    )
    const nextSessionStatus = decision === 'approved' ? 'planning' : 'blocked'
    const nextTaskStatus = decision === 'approved' ? 'planned' : 'blocked'
    const nextStepStatus = decision === 'approved' ? 'ready' : 'blocked'
    const nextSession = {
      ...snapshot.session,
      status: nextSessionStatus,
      updated_at: resolvedAt
    }
    const nextTask = {
      ...snapshot.task,
      status: nextTaskStatus,
      updated_at: resolvedAt
    }
    const nextPlanSteps = snapshot.plan_steps.map((step) => {
      if (step.id !== approval.step_id) {
        return step
      }

      return {
        ...step,
        status: nextStepStatus
      }
    })

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: nextApprovals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: resolvedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId: approval.step_id,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: resolvedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        stepId: approval.step_id,
        kind: 'approval_resolved',
        payload: {
          approval_id: approvalId,
          decision,
          resolved_by: resolvedApproval.resolved_by,
          resolution_note: resolvedApproval.resolution_note
        },
        at: resolvedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      approval: resolvedApproval,
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: nextApprovals,
      events
    }
  }

  async function abortSession(sessionId, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const abortedAt = options.abortedAt ?? nowIso()
    const nextSession = {
      ...snapshot.session,
      status: 'aborted',
      updated_at: abortedAt
    }
    const nextTask = {
      ...snapshot.task,
      status: 'aborted',
      updated_at: abortedAt
    }
    const nextPlanSteps = snapshot.plan_steps.map((step) => {
      if (['completed', 'failed', 'skipped', 'canceled'].includes(step.status)) {
        return step
      }

      return {
        ...step,
        status: 'canceled'
      }
    })

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: abortedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: abortedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        kind: 'task_aborted',
        payload: {
          reason: options.reason ?? 'user_aborted'
        },
        at: abortedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals,
      events
    }
  }

  async function completePlanStep(sessionId, stepId, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const finishedAt = options.finishedAt ?? nowIso()
    const targetStep = snapshot.plan_steps.find((item) => item.id === stepId)

    if (!targetStep) {
      throw new Error(`Unknown plan step: ${stepId}`)
    }

    const completedPlanSteps = snapshot.plan_steps.map((item) => {
      if (item.id !== stepId) {
        return item
      }

      return {
        ...item,
        status: 'completed',
        finished_at: finishedAt,
        notes: options.resultSummary ?? item.notes
      }
    })
    const nextPendingStep = completedPlanSteps.find((item) => item.status === 'pending')
    const nextPlanSteps = completedPlanSteps.map((item) => {
      if (nextPendingStep && item.id === nextPendingStep.id) {
        return {
          ...item,
          status: 'ready'
        }
      }

      return item
    })
    const allStepsCompleted = nextPlanSteps.every((item) => item.status === 'completed')
    const nextSession = {
      ...snapshot.session,
      status: allStepsCompleted ? 'completed' : 'planning',
      updated_at: finishedAt
    }
    const nextTask = {
      ...snapshot.task,
      status: allStepsCompleted ? 'completed' : 'planned',
      current_step_id: allStepsCompleted ? null : nextPlanSteps.find((item) => item.status === 'ready')?.id ?? null,
      updated_at: finishedAt,
      result: allStepsCompleted ? options.resultSummary ?? snapshot.task.result : snapshot.task.result
    }

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: finishedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: finishedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        stepId,
        kind: 'plan_step_completed',
        payload: {
          step_title: targetStep.title
        },
        at: finishedAt
      })
    )

    if (allStepsCompleted) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'task_completed',
          payload: {
            result: nextTask.result
          },
          at: finishedAt
        })
      )
    }

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals,
      events
    }
  }

  async function failPlanStep(sessionId, stepId, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const failedAt = options.failedAt ?? nowIso()
    const targetStep = snapshot.plan_steps.find((item) => item.id === stepId)

    if (!targetStep) {
      throw new Error(`Unknown plan step: ${stepId}`)
    }

    const nextPlanSteps = snapshot.plan_steps.map((item) => {
      if (item.id !== stepId) {
        return item
      }

      return {
        ...item,
        status: 'failed',
        finished_at: failedAt,
        notes: options.errorMessage ?? item.notes
      }
    })
    const nextSession = {
      ...snapshot.session,
      status: 'blocked',
      updated_at: failedAt
    }
    const nextTask = {
      ...snapshot.task,
      status: 'failed',
      updated_at: failedAt,
      result: options.errorMessage ?? snapshot.task.result
    }

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: failedAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          stepId,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: failedAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        stepId,
        kind: 'plan_step_failed',
        payload: {
          step_title: targetStep.title,
          message: options.errorMessage ?? null
        },
        at: failedAt
      })
    )
    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        kind: 'task_failed',
        payload: {
          message: options.errorMessage ?? null
        },
        at: failedAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: nextPlanSteps,
      approvals: snapshot.approvals,
      events
    }
  }

  async function recoverInterruptedSession(sessionId, options = {}) {
    const snapshot = await loadSession(sessionId)
    const paths = createPaths(storageRoot, sessionId)
    const recoveredAt = options.recoveredAt ?? nowIso()
    const nextSessionStatus = ['planning', 'running'].includes(snapshot.session.status)
      ? 'blocked'
      : snapshot.session.status
    const nextTaskStatus = ['draft', 'planned', 'running'].includes(snapshot.task.status)
      ? 'blocked'
      : snapshot.task.status
    const nextSession = {
      ...snapshot.session,
      status: nextSessionStatus,
      updated_at: recoveredAt
    }
    const nextTask = {
      ...snapshot.task,
      status: nextTaskStatus,
      updated_at: recoveredAt
    }

    await writeSessionSnapshot(paths, {
      session: nextSession,
      task: nextTask,
      plan_steps: snapshot.plan_steps,
      approvals: snapshot.approvals
    })

    const events = []

    if (snapshot.session.status !== nextSession.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'session',
            from: snapshot.session.status,
            to: nextSession.status
          },
          at: recoveredAt
        })
      )
    }

    if (snapshot.task.status !== nextTask.status) {
      events.push(
        createTimelineEvent({
          sessionId,
          taskId: snapshot.task.id,
          kind: 'state_changed',
          payload: {
            entity: 'task',
            from: snapshot.task.status,
            to: nextTask.status
          },
          at: recoveredAt
        })
      )
    }

    events.push(
      createTimelineEvent({
        sessionId,
        taskId: snapshot.task.id,
        kind: 'session_recovered',
        payload: {
          reason: options.reason ?? 'process_interrupted',
          previous_session_status: snapshot.session.status,
          previous_task_status: snapshot.task.status
        },
        at: recoveredAt
      })
    )

    await appendTimelineEvents(paths, events)

    return {
      session: nextSession,
      task: nextTask,
      plan_steps: snapshot.plan_steps,
      approvals: snapshot.approvals,
      events
    }
  }

  return {
    createSession,
    startNextTurn,
    createPlan,
    loadSession,
    appendTimelineEvent,
    updateSessionSummary,
    updateSessionStatus,
    startPlanStep,
    completePlanStep,
    failPlanStep,
    requestApproval,
    resolveApproval,
    abortSession,
    recoverInterruptedSession
  }
}
