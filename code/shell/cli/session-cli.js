import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionStore } from '../session/session-store.js'
import { createContextRouter } from '../context/context-router.js'
import { createMemoryStore } from '../memory/memory-store.js'
import { createCoworkerStore } from '../coworkers/coworker-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createStepExecutor } from '../executor/step-executor.js'
import { createDebugRuntime } from '../debug/debug-runtime.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import {
  createAgentProfile,
  getAliyunSeedProjects
} from '../agent/agent-profile.js'
import { createModelRouter } from '../providers/model-router.js'
import { createBailianProvider } from '../providers/bailian-provider.js'
import {
  createFeishuGateway,
  describeFeishuChannelConfig
} from '../channels/feishu/feishu-gateway.js'
import { createFeishuUserAuthManager } from '../channels/feishu/feishu-user-auth.js'
import { createMultiAgentRuntime } from '../agents/multi-agent-runtime.js'
import { createAgentExecutor } from '../agent/agent-executor.js'

const DEFAULT_STORAGE_ROOT = resolve(
  fileURLToPath(new URL('../../../storage', import.meta.url))
)

function parseArgs(argv) {
  const args = [...argv]
  const commandTokens = []
  const booleanOptions = new Set(['json', 'continue', 'once'])

  while (args[0] && !args[0].startsWith('--')) {
    commandTokens.push(args.shift())
  }

  const command = commandTokens.length > 0 ? commandTokens.join(' ') : null

  const options = {}

  while (args.length > 0) {
    const token = args.shift()

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`)
    }

    const key = token.slice(2)

    if (booleanOptions.has(key)) {
      options[key] = true
      continue
    }

    const value = args.shift()

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for option: --${key}`)
    }

    options[key] = value
  }

  return {
    command,
    options
  }
}

function requireOption(options, name) {
  const value = options[name]

  if (!value) {
    throw new Error(`Missing required option: --${name}`)
  }

  return value
}

function toStatusPayload(snapshot) {
  const currentStep = snapshot.plan_steps.find(
    (step) => step.id === snapshot.task.current_step_id
  ) ?? null
  const pendingApprovals = snapshot.approvals.filter(
    (approval) => approval.status === 'pending'
  ).length

  return {
    session_id: snapshot.session.id,
    session_status: snapshot.session.status,
    task_id: snapshot.task.id,
    task_status: snapshot.task.status,
    current_step_id: snapshot.task.current_step_id,
    current_step_title: currentStep?.title ?? null,
    pending_approvals: pendingApprovals,
    timeline_count: snapshot.timeline.length,
    summary: snapshot.session.summary
  }
}

function toResumePayload(snapshot) {
  return {
    session: snapshot.session,
    task: snapshot.task,
    plan_steps: snapshot.plan_steps,
    approvals: snapshot.approvals,
    timeline_count: snapshot.timeline.length
  }
}

function formatOutput(command, payload, asJson) {
  const content = asJson
    ? JSON.stringify({ command, ...payload }, null, 2)
    : formatText(command, payload)

  return `${content}\n`
}

function sanitizeFeishuUserAuthResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return result
  }

  const sanitized = {
    ...result
  }

  delete sanitized.access_token
  delete sanitized.refresh_token
  return sanitized
}

function formatError(error, asJson) {
  const content = asJson
    ? JSON.stringify({ error: error.message }, null, 2)
    : `Error: ${error.message}`

  return `${content}\n`
}

function formatText(command, payload) {
  if (command === 'start') {
    return [
      `session_id: ${payload.session.id}`,
      `session_status: ${payload.session.status}`,
      `task_id: ${payload.task.id}`,
      `project_key: ${payload.session.project_key}`
    ].join('\n')
  }

  if (command === 'resume') {
    return [
      `session_id: ${payload.session.id}`,
      `session_status: ${payload.session.status}`,
      `task_status: ${payload.task.status}`,
      `timeline_count: ${payload.timeline_count}`
    ].join('\n')
  }

  if (command === 'status') {
    return [
      `session_id: ${payload.session_id}`,
      `session_status: ${payload.session_status}`,
      `task_status: ${payload.task_status}`,
      `current_step_id: ${payload.current_step_id ?? 'null'}`,
      `pending_approvals: ${payload.pending_approvals}`,
      `timeline_count: ${payload.timeline_count}`
    ].join('\n')
  }

  if (command === 'timeline') {
    return payload.events
      .map((event) => `${event.at} ${event.kind}`)
      .join('\n')
  }

  return JSON.stringify(payload, null, 2)
}

function waitForMs(durationMs) {
  if (durationMs == null || durationMs <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}

export async function executeCli({
  argv,
  stdout = '',
  stderr = '',
  dependencies = {}
}) {
  try {
    const { command, options } = parseArgs(argv)
    const asJson = options.json === true
    const storageRoot = options['storage-root'] ?? DEFAULT_STORAGE_ROOT
    const store = createSessionStore({ storageRoot })
    const contextRouter = createContextRouter({ storageRoot })
    const memoryStore = createMemoryStore({ storageRoot })
    const coworkerStore = createCoworkerStore({ storageRoot })
    const hookBus = createHookBus({ storageRoot })
    const debugRuntime = createDebugRuntime({ storageRoot })
    const projectRegistry = createProjectRegistry({ storageRoot })
    const agentProfile =
      dependencies.agentProfile ?? createAgentProfile()
    const modelRouter =
      dependencies.modelRouter ?? createModelRouter({ agentProfile })
    const bailianProvider =
      dependencies.bailianProvider ?? createBailianProvider({ agentProfile, modelRouter })
    const feishuGatewayFactory =
      dependencies.feishuGatewayFactory ?? (() => createFeishuGateway())
    const sharedFetchFn = dependencies.fetchFn ?? globalThis.fetch
    const feishuUserAuthManager =
      dependencies.feishuUserAuthManager
      ?? createFeishuUserAuthManager({
        storageRoot,
        fetchFn: sharedFetchFn
      })
    const managerFetchFn = dependencies.fetchFn ?? globalThis.fetch

    if (!command) {
      throw new Error('Missing command')
    }

    if (command === 'profile show') {
      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          profile: agentProfile
        }, asJson),
        stderr
      }
    }

    if (command === 'project seed-aliyun') {
      const projects = await projectRegistry.seedProjects(getAliyunSeedProjects())

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          projects
        }, asJson),
        stderr
      }
    }

    if (command === 'project list') {
      const projects = await projectRegistry.listProjects({
        tier: options.tier ?? null,
        status: options.status ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          projects
        }, asJson),
        stderr
      }
    }

    if (command === 'project get') {
      const projectKey = requireOption(options, 'project-key')
      const project = await projectRegistry.getProject(projectKey)

      if (!project) {
        throw new Error(`Unknown project: ${projectKey}`)
      }

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          project
        }, asJson),
        stderr
      }
    }

    if (command === 'project register') {
      const project = await projectRegistry.registerProject({
        project_key: requireOption(options, 'project-key'),
        name: requireOption(options, 'name'),
        tier: requireOption(options, 'tier'),
        role: requireOption(options, 'role'),
        source_root: requireOption(options, 'source-root'),
        runtime_root: options['runtime-root'] ?? null,
        publish_root: options['publish-root'] ?? null,
        public_base_path: options['public-base-path'] ?? null,
        pm2_name: options['pm2-name'] ?? null,
        service_endpoint: options['service-endpoint'] ?? null,
        repo_remote: options['repo-remote'] ?? null,
        branch: options.branch ?? null,
        status: options.status ?? 'active',
        notes: options.notes ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          project
        }, asJson),
        stderr
      }
    }

    if (command === 'route resolve') {
      const intent = requireOption(options, 'intent')
      const route = modelRouter.resolveRoute(intent)

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          route
        }, asJson),
        stderr
      }
    }

    if (command === 'provider invoke') {
      const intent = requireOption(options, 'intent')
      const prompt = requireOption(options, 'prompt')
      const result = await bailianProvider.invokeByIntent({
        intent,
        prompt,
        systemPrompt: options['system-prompt'] ?? null,
        apiKey: options['api-key'] ?? null,
        baseUrl: options['base-url'] ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-profile') {
      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          profile: describeFeishuChannelConfig()
        }, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-send') {
      const receiveId = requireOption(options, 'receive-id')
      const text = requireOption(options, 'text')
      const feishuGateway =
        dependencies.feishuGateway ?? feishuGatewayFactory()
      const result = await feishuGateway.sendTextMessage({
        receiveIdType: options['receive-id-type'] ?? 'chat_id',
        receiveId,
        text
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          result
        }, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-user-auth-status') {
      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          status: await feishuUserAuthManager.describeStatus()
        }, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-user-auth-url') {
      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          oauth: feishuUserAuthManager.buildAuthorizeUrl({
            state: options.state ?? null
          })
        }, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-user-auth-exchange') {
      const result = sanitizeFeishuUserAuthResult(
        await feishuUserAuthManager.exchangeCode({
          code: requireOption(options, 'code')
        })
      )

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          result
        }, asJson),
        stderr
      }
    }

    if (command === 'channel feishu-user-auth-refresh') {
      const result = sanitizeFeishuUserAuthResult(
        await feishuUserAuthManager.refreshAccessToken({
          force: true
        })
      )

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          result
        }, asJson),
        stderr
      }
    }

    if (command === 'agent bootstrap') {
      const runtime = createMultiAgentRuntime({
        storageRoot,
        feishuGateway: dependencies.feishuGateway ?? null,
        bailianProvider,
        agentProfile
      })
      const result = await runtime.bootstrapServerBaseline()

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'agent feishu-serve') {
      const feishuGateway =
        dependencies.feishuGateway ?? feishuGatewayFactory()
      const runtime = createMultiAgentRuntime({
        storageRoot,
        feishuGateway,
        bailianProvider,
        agentProfile
      })
      const started = await runtime.startFeishuLoop()

      if (options.once === true) {
        if (typeof feishuGateway.close === 'function') {
          feishuGateway.close({
            force: true
          })
        }

        return {
          exitCode: 0,
          stdout: formatOutput(command, started, asJson),
          stderr
        }
      }

      if (asJson) {
        process.stdout.write(formatOutput(command, started, true))
      } else {
        process.stdout.write('newagent manager is serving via Feishu long connection\n')
      }

      await new Promise(() => {})
    }

    if (command === 'agent intake-message') {
      const runtime = createMultiAgentRuntime({
        storageRoot,
        feishuGateway: dependencies.feishuGateway ?? null,
        bailianProvider,
        agentProfile
      })
      const result = await runtime.handleChannelMessage({
        channel: options.channel ?? 'manual',
        autoReply: false,
        autoPlan: options['auto-plan'] !== 'false',
        autoExecuteSafeInspect: options['auto-execute'] === 'true',
        message: {
          message_id: options['message-id'] ?? null,
          chat_id: options['chat-id'] ?? null,
          sender_open_id: options['sender-open-id'] ?? 'manual_operator',
          sender_user_id: options['sender-user-id'] ?? null,
          text: requireOption(options, 'text')
        }
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'agent step-run') {
      const sessionId = requireOption(options, 'session-id')
      const managerExecutor = createAgentExecutor({
        storageRoot,
        workspaceRoot: options['workspace-root'] ?? process.cwd(),
        fetchFn: managerFetchFn,
        executionProvider: bailianProvider,
        agentProfile
      })
      const result = await managerExecutor.executeCurrentManagerStep({
        sessionId,
        currentInput: options.input ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'agent loop-run') {
      const sessionId = requireOption(options, 'session-id')
      const maxSteps = options['max-steps']
        ? Number.parseInt(options['max-steps'], 10)
        : 3

      if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
        throw new Error('Invalid --max-steps value')
      }

      const managerExecutor = createAgentExecutor({
        storageRoot,
        workspaceRoot: options['workspace-root'] ?? process.cwd(),
        fetchFn: managerFetchFn,
        executionProvider: bailianProvider,
        agentProfile
      })
      const result = await managerExecutor.runManagerLoop({
        sessionId,
        currentInput: options.input ?? null,
        maxSteps
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'start') {
      const title = requireOption(options, 'title')
      const projectKey = requireOption(options, 'project-key')
      const userRequest = requireOption(options, 'request')
      const created = await store.createSession({
        title,
        projectKey,
        userRequest
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, created, asJson),
        stderr
      }
    }

    if (command === 'resume') {
      const sessionId = requireOption(options, 'session-id')
      const snapshot = await store.loadSession(sessionId)

      return {
        exitCode: 0,
        stdout: formatOutput(command, toResumePayload(snapshot), asJson),
        stderr
      }
    }

    if (command === 'plan-create') {
      const sessionId = requireOption(options, 'session-id')
      const stepsJson = requireOption(options, 'steps-json')
      let steps

      try {
        steps = JSON.parse(stepsJson)
      } catch {
        throw new Error('Invalid --steps-json value')
      }

      if (!Array.isArray(steps)) {
        throw new Error('Invalid --steps-json value')
      }

      const result = await store.createPlan(sessionId, {
        steps
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session: result.session,
          task: result.task,
          steps: result.steps
        }, asJson),
        stderr
      }
    }

    if (command === 'status') {
      const sessionId = requireOption(options, 'session-id')
      const snapshot = await store.loadSession(sessionId)

      return {
        exitCode: 0,
        stdout: formatOutput(command, toStatusPayload(snapshot), asJson),
        stderr
      }
    }

    if (command === 'timeline') {
      const sessionId = requireOption(options, 'session-id')
      const snapshot = await store.loadSession(sessionId)
      const limit = options.limit ? Number.parseInt(options.limit, 10) : null

      if (options.limit && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('Invalid --limit value')
      }

      const events = limit
        ? snapshot.timeline.slice(-limit)
        : snapshot.timeline

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session_id: sessionId,
          events
        }, asJson),
        stderr
      }
    }

    if (command === 'hooks list') {
      const limit = options.limit ? Number.parseInt(options.limit, 10) : null

      if (options.limit && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('Invalid --limit value')
      }

      const events = await hookBus.listEvents({
        sessionId: options['session-id'] ?? null,
        name: options.name ?? null,
        channel: options.channel ?? null,
        limit
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session_id: options['session-id'] ?? null,
          name: options.name ?? null,
          channel: options.channel ?? null,
          events
        }, asJson),
        stderr
      }
    }

    if (command === 'coworker ask') {
      const sessionId = requireOption(options, 'session-id')
      const runtime = createMultiAgentRuntime({
        storageRoot,
        feishuGateway: dependencies.feishuGateway ?? null,
        bailianProvider,
        agentProfile
      })
      const request = await runtime.requestCoworkerHelp({
        sessionId,
        source: options.source ?? 'newagent-manager',
        target: options.target ?? 'codex_mac_local',
        title: options.title ?? null,
        question: requireOption(options, 'question'),
        context: options.context ?? null,
        urgency: options.urgency ?? 'normal',
        tags: options.tags ? options.tags.split(',').filter(Boolean) : [],
        location: options.location ?? 'mac_local_codex'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          request
        }, asJson),
        stderr
      }
    }

    if (command === 'coworker list') {
      const limit = options.limit ? Number.parseInt(options.limit, 10) : null

      if (options.limit && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('Invalid --limit value')
      }

      const requests = await coworkerStore.listRequests({
        sessionId: options['session-id'] ?? null,
        source: options.source ?? null,
        target: options.target ?? null,
        status: options.status ?? null,
        afterId: options['after-id'] ?? null,
        limit
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          requests
        }, asJson),
        stderr
      }
    }

    if (command === 'coworker get') {
      const request = await coworkerStore.getRequest(
        requireOption(options, 'request-id')
      )

      if (!request) {
        throw new Error(`Unknown coworker request: ${options['request-id']}`)
      }

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          request
        }, asJson),
        stderr
      }
    }

    if (command === 'coworker wait') {
      const target = requireOption(options, 'target')
      const timeoutMs = options['timeout-ms']
        ? Number.parseInt(options['timeout-ms'], 10)
        : 30 * 1000
      const pollIntervalMs = options['poll-interval-ms']
        ? Number.parseInt(options['poll-interval-ms'], 10)
        : 1000

      if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
        throw new Error('Invalid --timeout-ms value')
      }

      if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error('Invalid --poll-interval-ms value')
      }

      const startedAt = Date.now()
      let request = null

      while (!request && Date.now() - startedAt <= timeoutMs) {
        const requests = await coworkerStore.listRequests({
          sessionId: options['session-id'] ?? null,
          source: options.source ?? null,
          target,
          status: options.status ?? 'pending',
          afterId: options['after-id'] ?? null,
          limit: 1
        })
        const candidate = requests[0] ?? null

        if (!candidate) {
          await waitForMs(pollIntervalMs)
          continue
        }

        if (!options['claim-by']) {
          request = candidate
          continue
        }

        try {
          request = await coworkerStore.claimRequest(candidate.id, {
            claimedBy: options['claim-by'],
            location: options.location ?? null
          })
        } catch (error) {
          if (error?.code === 'COWORKER_REQUEST_NOT_PENDING') {
            request = null
            continue
          }

          throw error
        }
      }

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          request,
          timed_out: request == null
        }, asJson),
        stderr
      }
    }

    if (command === 'coworker reply') {
      const runtime = createMultiAgentRuntime({
        storageRoot,
        feishuGateway: dependencies.feishuGateway ?? null,
        bailianProvider,
        agentProfile
      })
      const request = await runtime.resolveCoworkerRequest({
        requestId: requireOption(options, 'request-id'),
        answer: requireOption(options, 'answer'),
        resolvedBy: options['resolved-by'] ?? 'codex_mac_local',
        resolution: options.resolution ?? 'answered',
        location: options.location ?? 'mac_local_codex',
        writeMemory: options['write-memory'] !== 'false'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          request
        }, asJson),
        stderr
      }
    }

    if (command === 'context-build') {
      const sessionId = requireOption(options, 'session-id')
      const currentInput = requireOption(options, 'input')
      const maxSections = options['max-sections']
        ? Number.parseInt(options['max-sections'], 10)
        : 8
      const maxCharacters = options['max-characters']
        ? Number.parseInt(options['max-characters'], 10)
        : 4000

      if (!Number.isInteger(maxSections) || maxSections <= 0) {
        throw new Error('Invalid --max-sections value')
      }

      if (!Number.isInteger(maxCharacters) || maxCharacters <= 0) {
        throw new Error('Invalid --max-characters value')
      }

      const result = await contextRouter.buildExecutionContext({
        sessionId,
        currentInput,
        maxSections,
        maxCharacters
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'memory add') {
      const sessionId = requireOption(options, 'session-id')
      const scope = requireOption(options, 'scope')
      const kind = requireOption(options, 'kind')
      const content = requireOption(options, 'content')
      const entry = await memoryStore.addMemoryEntry({
        sessionId,
        scope,
        kind,
        content,
        tags: options.tags ? options.tags.split(',').filter(Boolean) : []
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          entry
        }, asJson),
        stderr
      }
    }

    if (command === 'memory search') {
      const sessionId = requireOption(options, 'session-id')
      const scope = requireOption(options, 'scope')
      const matches = await memoryStore.searchMemoryEntries({
        sessionId,
        scope,
        query: options.query ?? '',
        tag: options.tag ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session_id: sessionId,
          scope,
          matches
        }, asJson),
        stderr
      }
    }

    if (command === 'debug session-get') {
      const sessionId = requireOption(options, 'session-id')
      const session = await debugRuntime.getSession(sessionId)

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session
        }, asJson),
        stderr
      }
    }

    if (command === 'debug task-get') {
      const sessionId = requireOption(options, 'session-id')
      const task = await debugRuntime.getTask(sessionId)

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          task
        }, asJson),
        stderr
      }
    }

    if (command === 'debug plan-step-get') {
      const sessionId = requireOption(options, 'session-id')
      const step = await debugRuntime.getPlanStep(sessionId, {
        stepId: options['step-id'] ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          plan_step: step
        }, asJson),
        stderr
      }
    }

    if (command === 'debug approval-list') {
      const sessionId = requireOption(options, 'session-id')
      const approvals = await debugRuntime.listApprovals(sessionId, {
        status: options.status ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          approvals
        }, asJson),
        stderr
      }
    }

    if (command === 'debug context-inspect') {
      const sessionId = requireOption(options, 'session-id')
      const context = await debugRuntime.inspectContext(sessionId)

      return {
        exitCode: 0,
        stdout: formatOutput(command, context, asJson),
        stderr
      }
    }

    if (command === 'debug timeline-replay') {
      const sessionId = requireOption(options, 'session-id')
      const limit = options.limit ? Number.parseInt(options.limit, 10) : null

      if (options.limit && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error('Invalid --limit value')
      }

      const events = await debugRuntime.replayTimeline(sessionId, {
        limit
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          events
        }, asJson),
        stderr
      }
    }

    if (command === 'debug session-patch') {
      const sessionId = requireOption(options, 'session-id')
      const patchJson = requireOption(options, 'patch-json')
      let patch

      try {
        patch = JSON.parse(patchJson)
      } catch {
        throw new Error('Invalid --patch-json value')
      }

      const result = await debugRuntime.patchSession(sessionId, {
        patch,
        reason: options.reason ?? 'cli_debug_patch'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'debug task-patch') {
      const sessionId = requireOption(options, 'session-id')
      const patchJson = requireOption(options, 'patch-json')
      let patch

      try {
        patch = JSON.parse(patchJson)
      } catch {
        throw new Error('Invalid --patch-json value')
      }

      const result = await debugRuntime.patchTask(sessionId, {
        patch,
        reason: options.reason ?? 'cli_debug_patch'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'debug plan-step-patch') {
      const sessionId = requireOption(options, 'session-id')
      const patchJson = requireOption(options, 'patch-json')
      let patch

      try {
        patch = JSON.parse(patchJson)
      } catch {
        throw new Error('Invalid --patch-json value')
      }

      const result = await debugRuntime.patchPlanStep(sessionId, {
        stepId: options['step-id'] ?? null,
        patch,
        reason: options.reason ?? 'cli_debug_patch'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'step-run') {
      const sessionId = requireOption(options, 'session-id')
      const currentInput = requireOption(options, 'input')
      const toolName = requireOption(options, 'tool-name')
      const workspaceRoot = requireOption(options, 'workspace-root')
      const toolInputJson = options['tool-input-json'] ?? '{}'
      let toolInput

      try {
        toolInput = JSON.parse(toolInputJson)
      } catch {
        throw new Error('Invalid --tool-input-json value')
      }

      const stepExecutor = createStepExecutor({
        storageRoot,
        workspaceRoot
      })
      const result = await stepExecutor.executeCurrentStep({
        sessionId,
        currentInput,
        toolName,
        toolInput
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, result, asJson),
        stderr
      }
    }

    if (command === 'approve' || command === 'reject') {
      const sessionId = requireOption(options, 'session-id')
      const approvalId = requireOption(options, 'approval-id')
      const decision = command === 'approve' ? 'approved' : 'rejected'

      if (command === 'approve' && options.continue === true) {
        const workspaceRoot = requireOption(options, 'workspace-root')
        const currentInput = requireOption(options, 'input')
        const stepExecutor = createStepExecutor({
          storageRoot,
          workspaceRoot
        })
        const continued = await stepExecutor.continueApprovedStep({
          sessionId,
          approvalId,
          currentInput,
          resolvedBy: options['resolved-by'] ?? 'user',
          resolutionNote: options.note ?? null
        })

        return {
          exitCode: 0,
          stdout: formatOutput(command, continued, asJson),
          stderr
        }
      }

      const resolved = await store.resolveApproval(sessionId, approvalId, decision, {
        resolvedBy: options['resolved-by'] ?? 'user',
        resolutionNote: options.note ?? null
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          approval: resolved.approval,
          session_status: resolved.session.status,
          task_status: resolved.task.status
        }, asJson),
        stderr
      }
    }

    if (command === 'abort') {
      const sessionId = requireOption(options, 'session-id')
      const aborted = await store.abortSession(sessionId, {
        reason: options.reason ?? 'user_aborted'
      })

      return {
        exitCode: 0,
        stdout: formatOutput(command, {
          session_id: sessionId,
          session_status: aborted.session.status,
          task_status: aborted.task.status
        }, asJson),
        stderr
      }
    }

    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const asJson = argv.includes('--json')

    return {
      exitCode: 1,
      stdout,
      stderr: formatError(error, asJson)
    }
  }
}
