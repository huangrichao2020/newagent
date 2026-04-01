import { createStepExecutor } from '../executor/step-executor.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createSessionStore } from '../session/session-store.js'

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase()
}

function latestManagerProjectKeys(snapshot) {
  for (let index = snapshot.timeline.length - 1; index >= 0; index -= 1) {
    const event = snapshot.timeline[index]

    if (event.kind === 'manager_plan_generated') {
      return Array.isArray(event.payload?.project_keys)
        ? event.payload.project_keys
        : []
    }
  }

  return []
}

function resolveProjectForStep({ step, projects, managerProjectKeys }) {
  const haystack = `${step.title ?? ''} ${step.notes ?? ''}`.toLowerCase()
  const byExplicitMention = projects.find((project) => {
    return haystack.includes(project.project_key.toLowerCase())
      || haystack.includes(project.name.toLowerCase())
  })

  if (byExplicitMention) {
    return byExplicitMention
  }

  if (managerProjectKeys.length === 1) {
    return projects.find((project) => project.project_key === managerProjectKeys[0]) ?? null
  }

  return null
}

function buildProjectSummary(project) {
  return [
    `project_key=${project.project_key}`,
    `role=${project.role}`,
    `source_root=${project.source_root}`,
    `runtime_root=${project.runtime_root ?? 'null'}`,
    `publish_root=${project.publish_root ?? 'null'}`,
    `pm2_name=${project.pm2_name ?? 'null'}`,
    `service_endpoint=${project.service_endpoint ?? 'null'}`,
    `status=${project.status}`
  ].join('\n')
}

function resolveProjectWorkspace(project, workspaceRoot) {
  return project?.source_root
    ?? project?.runtime_root
    ?? workspaceRoot
}

function buildCodexInstruction({
  mode,
  step,
  project,
  operatorRequest,
  sessionSummary
}) {
  const lines = []

  if (mode === 'review') {
    lines.push('Review the target workspace for this remote server manager task.')
    lines.push('Report actionable findings first, ordered by severity.')
  } else {
    lines.push('Repair the target workspace for this remote server manager task.')
    lines.push('Apply the minimal safe fix that resolves the requested issue.')
  }

  lines.push(`Manager step title: ${step.title}`)

  if (step.notes) {
    lines.push(`Manager step notes: ${step.notes}`)
  }

  if (operatorRequest) {
    lines.push(`Operator request: ${operatorRequest}`)
  }

  if (sessionSummary) {
    lines.push(`Session summary: ${sessionSummary}`)
  }

  if (project) {
    lines.push(`Target project: ${project.name} (${project.project_key})`)
    lines.push(buildProjectSummary(project))
  }

  if (mode === 'review') {
    lines.push('Focus on correctness, regressions, deployment risk, path drift, service health, and missing verification.')
  } else {
    lines.push('Preserve unrelated files, keep edits scoped, and leave a concise explanation in the output.')
  }

  return lines.join('\n')
}

function summarizePathCheck(output) {
  const lines = []

  for (const key of ['source_root', 'runtime_root', 'publish_root']) {
    const entry = output[key]

    if (!entry) {
      continue
    }

    lines.push(`${key}=${entry.exists ? entry.type : 'missing'}:${entry.path}`)
  }

  return lines.join('\n')
}

function summarizeSelectionOutput({ toolName, output }) {
  if (toolName === 'project_list_registry') {
    const projectKeys = (output.projects ?? []).map((project) => project.project_key)
    return `已读取 ${projectKeys.length} 个注册项目：${projectKeys.join('、')}`
  }

  if (toolName === 'project_get_registry') {
    return `已读取项目 ${output.project.project_key} 配置\n${buildProjectSummary(output.project)}`
  }

  if (toolName === 'project_probe_endpoint') {
    return [
      `已探活 ${output.project_key ?? output.url}`,
      `status=${output.status}`,
      `ok=${output.ok}`,
      `url=${output.url}`,
      `error=${output.error_message ?? 'null'}`,
      `body_preview=${output.body_preview ?? ''}`
    ].join('\n')
  }

  if (toolName === 'project_check_paths') {
    return `已检查 ${output.project_key} 路径\n${summarizePathCheck(output)}`
  }

  if (toolName === 'project_pm2_status') {
    return [
      `已检查 ${output.project_key} 的 PM2 状态`,
      `pm2_name=${output.pm2_name}`,
      `found=${output.found}`,
      `status=${output.status ?? 'null'}`,
      `pid=${output.pid ?? 'null'}`
    ].join('\n')
  }

  if (toolName === 'codex_review_workspace') {
    return [
      `已在 ${output.cwd} 执行 Codex review`,
      output.stdout?.trim() ?? ''
    ].filter(Boolean).join('\n')
  }

  if (toolName === 'codex_repair_workspace') {
    return [
      `已在 ${output.cwd} 执行 Codex repair`,
      output.stdout?.trim() ?? ''
    ].filter(Boolean).join('\n')
  }

  return `已执行 ${toolName}`
}

export function selectManagerToolForStep({
  step,
  projects,
  managerProjectKeys,
  workspaceRoot = process.cwd(),
  operatorRequest = null,
  sessionSummary = null
}) {
  const normalizedKind = normalizeText(step.kind)
  const normalizedTitle = normalizeText(step.title)
  const normalizedNotes = normalizeText(step.notes)
  const haystack = `${normalizedTitle} ${normalizedNotes}`
  const project = resolveProjectForStep({
    step,
    projects,
    managerProjectKeys
  })

  if (normalizedKind === 'report') {
    return {
      supported: true,
      action: 'report',
      project
    }
  }

  if (normalizedKind === 'review') {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'codex_review_workspace',
      tool_input: {
        cwd: resolveProjectWorkspace(project, workspaceRoot),
        json: true,
        instruction: buildCodexInstruction({
          mode: 'review',
          step,
          project,
          operatorRequest,
          sessionSummary
        })
      }
    }
  }

  if (normalizedKind === 'repair') {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'codex_repair_workspace',
      tool_input: {
        cwd: resolveProjectWorkspace(project, workspaceRoot),
        full_auto: true,
        instruction: buildCodexInstruction({
          mode: 'repair',
          step,
          project,
          operatorRequest,
          sessionSummary
        })
      }
    }
  }

  if (normalizedKind !== 'inspect') {
    return {
      supported: false,
      reason: `Unsupported manager step kind: ${step.kind}`
    }
  }

  if (
    /列表|list|inventory|registry|有哪些项目|盘一下|基线/.test(haystack)
    && !project
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_list_registry',
      tool_input: {}
    }
  }

  if (
    /pm2|进程|process|daemon/.test(haystack)
    && project?.pm2_name
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_pm2_status',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (
    /health|endpoint|api|在线|探活|状态|服务/.test(haystack)
    && project?.service_endpoint
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_probe_endpoint',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (
    /目录|路径|path|runtime|publish|source|release|发布目录/.test(haystack)
    && project
  ) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_check_paths',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  if (project) {
    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'project_get_registry',
      tool_input: {
        project_key: project.project_key
      }
    }
  }

  return {
    supported: true,
    action: 'tool',
    project: null,
    tool_name: 'project_list_registry',
    tool_input: {}
  }
}

function summarizeCompletedManagerSteps(snapshot) {
  return snapshot.plan_steps
    .filter((step) => step.status === 'completed')
    .map((step) => `- ${step.title}`)
}

function summarizeRecentManagerExecution(snapshot) {
  return snapshot.timeline
    .filter((event) => event.kind === 'manager_step_executed')
    .slice(-4)
    .map((event) => event.payload?.summary)
    .filter(Boolean)
}

function buildManagerReportText(snapshot) {
  const lines = []
  const completedSteps = summarizeCompletedManagerSteps(snapshot)
  const executionHighlights = summarizeRecentManagerExecution(snapshot)
  const pendingApprovals = snapshot.approvals.filter(
    (approval) => approval.status === 'pending'
  )
  const nextStep = snapshot.plan_steps.find((step) => step.status === 'ready')

  lines.push('总管阶段汇报：')

  if (snapshot.session.summary) {
    lines.push(`当前摘要：${snapshot.session.summary}`)
  }

  if (completedSteps.length > 0) {
    lines.push(`已完成步骤：${completedSteps.join('；')}`)
  }

  if (executionHighlights.length > 0) {
    lines.push(`执行结论：${executionHighlights.join('；')}`)
  }

  if (pendingApprovals.length > 0) {
    lines.push(`当前等待审批：${pendingApprovals.map((approval) => approval.tool_name).join('、')}`)
  } else if (nextStep) {
    lines.push(`下一步：${nextStep.title}`)
  } else {
    lines.push('当前计划已执行完成。')
  }

  return lines.join('\n')
}

export function createManagerExecutor({
  storageRoot,
  workspaceRoot,
  codexCommand = 'codex',
  fetchFn = globalThis.fetch
}) {
  const sessionStore = createSessionStore({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })
  const stepExecutor = createStepExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand,
    fetchFn
  })

  async function executeManagerReportStep({
    sessionId,
    step
  }) {
    await sessionStore.startPlanStep(sessionId, step.id)

    const runningSnapshot = await sessionStore.loadSession(sessionId)
    const reportText = buildManagerReportText(runningSnapshot)

    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'assistant_message_added',
      actor: 'assistant:manager',
      payload: {
        content: reportText
      }
    })
    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'manager_report_generated',
      actor: 'manager:executor',
      payload: {
        content: reportText
      }
    })
    await sessionStore.updateSessionSummary(sessionId, reportText)

    const completion = await sessionStore.completePlanStep(sessionId, step.id, {
      resultSummary: reportText
    })

    return {
      status: completion.task.status === 'completed' ? 'completed' : 'planned',
      summary: reportText,
      report_text: reportText,
      session: completion.session,
      task: completion.task,
      plan_steps: completion.plan_steps
    }
  }

  async function executeCurrentManagerStep({
    sessionId,
    currentInput = null,
    skillRefs = []
  }) {
    const snapshot = await sessionStore.loadSession(sessionId)
    const step = snapshot.plan_steps.find(
      (item) => item.id === snapshot.task.current_step_id
    ) ?? null

    if (!step) {
      return {
        status: 'error',
        error: {
          message: 'No current manager step is ready to execute'
        }
      }
    }

    const projects = await projectRegistry.listProjects()
    const managerProjectKeys = latestManagerProjectKeys(snapshot)
    const selection = selectManagerToolForStep({
      step,
      projects,
      managerProjectKeys,
      workspaceRoot,
      operatorRequest: currentInput ?? snapshot.task.user_request,
      sessionSummary: snapshot.session.summary
    })

    if (!selection.supported) {
      await sessionStore.appendTimelineEvent(sessionId, {
        stepId: step.id,
        kind: 'manager_step_deferred',
        actor: 'manager:executor',
        payload: {
          reason: selection.reason
        }
      })

      return {
        status: 'deferred',
        selection
      }
    }

    if (selection.action === 'report') {
      const execution = await executeManagerReportStep({
        sessionId,
        step
      })

      return {
        status: execution.status,
        selection,
        summary: execution.summary,
        report_text: execution.report_text,
        execution
      }
    }

    await sessionStore.appendTimelineEvent(sessionId, {
      stepId: step.id,
      kind: 'manager_tool_selected',
      actor: 'manager:executor',
      payload: {
        tool_name: selection.tool_name
      }
    })

    const execution = await stepExecutor.executeCurrentStep({
      sessionId,
      currentInput: currentInput ?? snapshot.task.user_request,
      toolName: selection.tool_name,
      toolInput: selection.tool_input,
      skillRefs
    })

    if (execution.status === 'planned' || execution.status === 'completed') {
      const summary = summarizeSelectionOutput({
        toolName: selection.tool_name,
        output: execution.tool_result.output
      })

      await sessionStore.appendTimelineEvent(sessionId, {
        kind: 'manager_step_executed',
        actor: 'manager:executor',
        payload: {
          tool_name: selection.tool_name,
          summary
        }
      })

      return {
        status: execution.status,
        selection,
        summary,
        execution
      }
    }

    if (execution.status === 'waiting_approval') {
      const approval = execution.approvals?.find((item) => item.status === 'pending') ?? null

      return {
        status: execution.status,
        selection,
        summary: approval
          ? `当前步骤等待审批：${approval.tool_name}`
          : '当前步骤等待审批',
        execution
      }
    }

    return {
      status: execution.status,
      selection,
      execution
    }
  }

  async function runManagerLoop({
    sessionId,
    currentInput = null,
    maxSteps = 4,
    skillRefs = []
  }) {
    const runs = []

    for (let index = 0; index < maxSteps; index += 1) {
      const result = await executeCurrentManagerStep({
        sessionId,
        currentInput,
        skillRefs
      })

      runs.push(result)

      if (!['planned', 'completed'].includes(result.status)) {
        break
      }

      if (result.status === 'completed') {
        break
      }
    }

    const finalSnapshot = await sessionStore.loadSession(sessionId)
    const latestReport = [...runs]
      .reverse()
      .find((run) => run.report_text)?.report_text ?? null

    return {
      status: runs.at(-1)?.status ?? 'error',
      runs,
      report_text: latestReport,
      session: finalSnapshot.session,
      task: finalSnapshot.task,
      plan_steps: finalSnapshot.plan_steps,
      approvals: finalSnapshot.approvals
    }
  }

  async function runSafeInspectLoop({
    sessionId,
    currentInput = null,
    maxSteps = 3,
    skillRefs = []
  }) {
    return runManagerLoop({
      sessionId,
      currentInput,
      maxSteps,
      skillRefs
    })
  }

  return {
    executeCurrentManagerStep,
    runManagerLoop,
    runSafeInspectLoop
  }
}
