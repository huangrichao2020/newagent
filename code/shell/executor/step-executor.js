import { createContextRouter } from '../context/context-router.js'
import { createSessionStore } from '../session/session-store.js'
import { createToolRuntime } from '../tools/tool-runtime.js'

function cleanText(value) {
  return String(value ?? '').trim()
}

function summarizeShellFailureOutput(output = {}) {
  return [
    cleanText(output.stdout),
    cleanText(output.stderr)
  ].filter(Boolean).join('\n').slice(0, 500)
}

function detectImplicitToolFailure(toolName, toolResult) {
  if (toolName !== 'run_shell_command' || toolResult?.status !== 'ok') {
    return null
  }

  const output = toolResult.output ?? {}
  const combinedText = summarizeShellFailureOutput(output)

  if (!combinedText) {
    return null
  }

  const failurePatterns = [
    /\b404\b[\s\S]{0,80}\bnot found\b/iu,
    /\bpage not found\b/iu,
    /\bcurl:\s*\(\d+\)/iu,
    /\bcommand not found\b/iu,
    /\bno such file or directory\b/iu,
    /\bpermission denied\b/iu,
    /\bfetch failed\b/iu,
    /\bECONN(?:REFUSED|RESET)\b/u,
    /\btimed out\b/iu,
    /\btraceback \(most recent call last\)\b/iu
  ]

  if (!failurePatterns.some((pattern) => pattern.test(combinedText))) {
    return null
  }

  return {
    message: combinedText,
    code: 'implicit_shell_failure'
  }
}

export function createStepExecutor({
  storageRoot,
  workspaceRoot,
  codexCommand = 'codex',
  fetchFn = globalThis.fetch
}) {
  const contextRouter = createContextRouter({ storageRoot })
  const sessionStore = createSessionStore({ storageRoot })
  const toolRuntime = createToolRuntime({
    storageRoot,
    workspaceRoot,
    codexCommand,
    fetchFn
  })

  async function executeCurrentStep({
    sessionId,
    currentInput,
    toolName,
    toolInput = {},
    skillRefs = [],
    abortSignal = null
  }) {
    const snapshot = await sessionStore.loadSession(sessionId)
    const stepId = snapshot.task.current_step_id

    if (!stepId) {
      return {
        status: 'error',
        error: {
          message: 'No current plan step is ready to execute'
        }
      }
    }

    await sessionStore.startPlanStep(sessionId, stepId)

    const context = await contextRouter.buildExecutionContext({
      sessionId,
      currentInput,
      skillRefs
    })
    const toolResult = await toolRuntime.executeTool({
      sessionId,
      stepId,
      toolName,
      input: toolInput,
      abortSignal
    })
    const implicitFailure = detectImplicitToolFailure(toolName, toolResult)

    if (toolResult.status === 'ok' && !implicitFailure) {
      const completion = await sessionStore.completePlanStep(sessionId, stepId, {
        resultSummary: `Tool ${toolName} completed successfully`
      })

      return {
        status: completion.task.status === 'completed' ? 'completed' : 'planned',
        context,
        tool_result: toolResult,
        session: completion.session,
        task: completion.task,
        plan_steps: completion.plan_steps
      }
    }

    if (toolResult.status === 'ok' && implicitFailure) {
      const failed = await sessionStore.failPlanStep(sessionId, stepId, {
        errorMessage: implicitFailure.message
      })

      return {
        status: 'failed',
        context,
        tool_result: {
          ...toolResult,
          status: 'error',
          error: implicitFailure
        },
        session: failed.session,
        task: failed.task,
        plan_steps: failed.plan_steps
      }
    }

    if (toolResult.status === 'waiting_approval') {
      const updatedSnapshot = await sessionStore.loadSession(sessionId)

      return {
        status: 'waiting_approval',
        context,
        tool_result: toolResult,
        session: updatedSnapshot.session,
        task: updatedSnapshot.task,
        plan_steps: updatedSnapshot.plan_steps,
        approvals: updatedSnapshot.approvals
      }
    }

    if (toolResult.status === 'aborted') {
      const aborted = await sessionStore.abortSession(sessionId, {
        reason: toolResult.error?.message ?? `Tool ${toolName} was aborted`
      })

      return {
        status: 'stopped',
        context,
        tool_result: toolResult,
        session: aborted.session,
        task: aborted.task,
        plan_steps: aborted.plan_steps,
        approvals: aborted.approvals
      }
    }

    const failed = await sessionStore.failPlanStep(sessionId, stepId, {
      errorMessage: toolResult.error?.message ?? `Tool ${toolName} failed`
    })

    return {
      status: 'failed',
      context,
      tool_result: toolResult,
      session: failed.session,
      task: failed.task,
      plan_steps: failed.plan_steps
    }
  }

  async function continueApprovedStep({
    sessionId,
    approvalId,
    currentInput,
    resolvedBy = 'user',
    resolutionNote = null,
    skillRefs = [],
    abortSignal = null
  }) {
    const resolved = await sessionStore.resolveApproval(sessionId, approvalId, 'approved', {
      resolvedBy,
      resolutionNote
    })

    const execution = await executeCurrentStep({
      sessionId,
      currentInput,
      toolName: resolved.approval.tool_name,
      toolInput: resolved.approval.requested_input,
      skillRefs,
      abortSignal
    })

    return {
      status: execution.status,
      approval: resolved.approval,
      execution
    }
  }

  return {
    executeCurrentStep,
    continueApprovedStep
  }
}
