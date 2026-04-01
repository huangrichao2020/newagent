import { createStepExecutor } from '../executor/step-executor.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { buildPromptContract } from '../prompts/prompt-contract.js'
import { createSessionStore } from '../session/session-store.js'
import { createRemoteServerManagerProfile } from './remote-server-manager-profile.js'

function cleanString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function stripCodeFence(text) {
  const fencedMatch = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/iu)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  return String(text ?? '').trim()
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text)

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped
  }

  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Execution response did not contain a JSON object')
  }

  return stripped.slice(firstBrace, lastBrace + 1)
}

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

function buildManagerExecutionSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: ['Convert one remote server manager operate or deploy step into one executable shell command.']
      },
      {
        title: 'TASK',
        lines: [
          'Generate the smallest command that safely advances the requested manager step.',
          'Stay within the provided project paths and operating context.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "cwd": "/absolute/path/for/execution",',
          '  "command": "single shell command to run",',
          '  "summary": "short Chinese summary of what this command will do",',
          '  "timeout_ms": 120000',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: [
          'command must be explicit and directly executable.',
          'cwd must be one provided project path when relevant.',
          'prefer the smallest command that advances the requested step.',
          'do not wrap the command in markdown fences.',
          'do not include destructive cleanup unless the step explicitly requires it.',
          'do not use interactive commands.'
        ]
      }
    ]
  })
}

function buildManagerExecutionPrompt({
  step,
  project,
  operatorRequest,
  sessionSummary
}) {
  const sections = [
    {
      title: 'MANAGER STEP',
      bullet: false,
      lines: [
        `title: ${step.title}`,
        step.notes ? `notes: ${step.notes}` : null
      ]
    }
  ]

  if (operatorRequest) {
    sections.push({
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (project) {
    sections.push({
      title: 'TARGET PROJECT CONTEXT',
      bullet: false,
      lines: [
        `name: ${project.name} (${project.project_key})`,
        buildProjectSummary(project)
      ]
    })
  }

  return buildPromptContract({
    sections
  })
}

function parseManagerExecutionResponse({
  text,
  defaultCwd
}) {
  const parsed = JSON.parse(extractJsonObject(text))
  const command = cleanString(parsed.command ?? parsed.shell_command)

  if (!command) {
    throw new Error('Execution response did not include a command')
  }

  const cwd = cleanString(parsed.cwd) ?? defaultCwd
  const summary = cleanString(parsed.summary) ?? `已生成执行命令：${command}`
  const timeoutMs = Number.isInteger(parsed.timeout_ms) && parsed.timeout_ms > 0
    ? parsed.timeout_ms
    : 120000

  return {
    cwd,
    command,
    summary,
    timeout_ms: timeoutMs
  }
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
  const protocolLines = []
  const responseRules = []

  if (mode === 'review') {
    protocolLines.push('Review the target workspace for this remote server manager task.')
    protocolLines.push('Focus on correctness, regressions, deployment risk, path drift, service health, and missing verification.')
    responseRules.push('Report actionable findings first, ordered by severity.')
  } else {
    protocolLines.push('Repair the target workspace for this remote server manager task.')
    protocolLines.push('Apply the minimal safe fix that resolves the requested issue.')
    protocolLines.push('Preserve unrelated files and keep edits scoped.')
    responseRules.push('Leave a concise explanation of what changed and why.')
  }

  const sections = [
    {
      title: 'ROLE',
      lines: [
        mode === 'review'
          ? 'Act as a review specialist for remote server manager tasks.'
          : 'Act as a repair specialist for remote server manager tasks.'
      ]
    },
    {
      title: 'TASK',
      bullet: false,
      lines: [
        `Manager step title: ${step.title}`,
        step.notes ? `Manager step notes: ${step.notes}` : null
      ]
    }
  ]

  if (operatorRequest) {
    sections.push({
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (project) {
    sections.push({
      title: 'TARGET PROJECT CONTEXT',
      bullet: false,
      lines: [
        `Target project: ${project.name} (${project.project_key})`,
        buildProjectSummary(project)
      ]
    })
  }

  sections.push({
    title: 'EXECUTION PROTOCOL',
    lines: protocolLines
  })
  sections.push({
    title: 'RESPONSE RULES',
    lines: responseRules
  })

  return buildPromptContract({
    sections
  })
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

  if (toolName === 'run_shell_command') {
    return [
      `已在 ${output.cwd ?? 'default'} 执行 shell 命令`,
      output.command ?? '',
      output.stdout?.trim() ?? '',
      output.stderr?.trim() ?? ''
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
  sessionSummary = null,
  managerProfile = createRemoteServerManagerProfile()
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
    if (!managerProfile.codex_integration.allow_review) {
      return {
        supported: false,
        reason: 'Codex review is disabled for this environment'
      }
    }

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: managerProfile.codex_integration.review_tool_name,
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
    if (!managerProfile.codex_integration.allow_repair) {
      return {
        supported: false,
        reason: 'Codex repair is disabled for this environment'
      }
    }

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: managerProfile.codex_integration.repair_tool_name,
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

  if (normalizedKind === 'operate' || normalizedKind === 'deploy') {
    return {
      supported: true,
      action: 'execution',
      project,
      execution_kind: normalizedKind
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
  fetchFn = globalThis.fetch,
  executionProvider = null,
  managerProfile = createRemoteServerManagerProfile()
}) {
  const sessionStore = createSessionStore({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })
  const stepExecutor = createStepExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand,
      fetchFn
  })

  async function buildExecutionSelection({
    step,
    project,
    operatorRequest,
    sessionSummary
  }) {
    if (!project) {
      return {
        supported: false,
        reason: 'Operate/deploy steps require a resolved target project'
      }
    }

    if (!executionProvider || typeof executionProvider.invokeByIntent !== 'function') {
      return {
        supported: false,
        reason: 'Operate/deploy steps require an execution provider'
      }
    }

    const defaultCwd = resolveProjectWorkspace(project, workspaceRoot)
    const providerResult = await executionProvider.invokeByIntent({
      intent: 'operate',
      systemPrompt: buildManagerExecutionSystemPrompt(),
      prompt: buildManagerExecutionPrompt({
        step,
        project,
        operatorRequest,
        sessionSummary
      })
    })
    const executionPlan = parseManagerExecutionResponse({
      text: providerResult.response.content ?? '',
      defaultCwd
    })

    return {
      supported: true,
      action: 'tool',
      project,
      tool_name: 'run_shell_command',
      tool_input: {
        cwd: executionPlan.cwd,
        command: executionPlan.command,
        timeout_ms: executionPlan.timeout_ms
      },
      summary: executionPlan.summary,
      provider_result: {
        route: providerResult.route,
        request: providerResult.request,
        response: {
          id: providerResult.response.id,
          model: providerResult.response.model,
          finish_reason: providerResult.response.finish_reason,
          usage: providerResult.response.usage
        }
      }
    }
  }

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
    const initialSelection = selectManagerToolForStep({
      step,
      projects,
      managerProjectKeys,
      workspaceRoot,
      operatorRequest: currentInput ?? snapshot.task.user_request,
      sessionSummary: snapshot.session.summary,
      managerProfile
    })
    let selection = initialSelection

    if (selection.action === 'execution') {
      selection = await buildExecutionSelection({
        step,
        project: selection.project,
        operatorRequest: currentInput ?? snapshot.task.user_request,
        sessionSummary: snapshot.session.summary
      })
    }

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
        selection,
        summary: selection.reason
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
        tool_name: selection.tool_name,
        command: selection.tool_input?.command ?? null,
        cwd: selection.tool_input?.cwd ?? null
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
          ? [
              `当前步骤等待审批：${approval.tool_name}`,
              selection.tool_input?.command ?? null
            ].filter(Boolean).join('\n')
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
