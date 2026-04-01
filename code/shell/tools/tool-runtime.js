import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHookBus } from '../hooks/hook-bus.js'
import { createSessionStore } from '../session/session-store.js'
import { createDebugRuntime } from '../debug/debug-runtime.js'
import { createProjectRegistry } from '../projects/project-registry.js'

const execFileAsync = promisify(execFile)

function normalizePath(workspaceRoot, targetPath) {
  if (!targetPath) {
    throw new Error('Missing required tool input: path')
  }

  if (targetPath.startsWith('/')) {
    return targetPath
  }

  return resolve(workspaceRoot, targetPath)
}

function hasApprovedDangerousExecution(snapshot, { stepId, toolName, input }) {
  return snapshot.approvals.some((approval) => {
    if (approval.status !== 'approved') {
      return false
    }

    if (approval.step_id !== stepId) {
      return false
    }

    if (approval.tool_name !== toolName) {
      return false
    }

    return JSON.stringify(approval.requested_input ?? {}) === JSON.stringify(input ?? {})
  })
}

async function searchTextInPath(targetPath, pattern, maxResults) {
  const entries = await readdir(targetPath, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    if (results.length >= maxResults) {
      break
    }

    const nextPath = resolve(targetPath, entry.name)

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue
      }

      const nested = await searchTextInPath(nextPath, pattern, maxResults - results.length)
      results.push(...nested)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    try {
      const content = await readFile(nextPath, 'utf8')

      if (content.includes(pattern)) {
        results.push({
          path: nextPath
        })
      }
    } catch {
      // Ignore unreadable and binary-ish files in M1.
    }
  }

  return results
}

function createDefaultSpecs(workspaceRoot) {
  return [
    {
      name: 'read_file',
      description: 'Read one local text file',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['path']
      },
      side_effects: false,
      async handler(input) {
        const path = normalizePath(workspaceRoot, input.path)
        const content = await readFile(path, 'utf8')

        return {
          path,
          content
        }
      }
    },
    {
      name: 'list_files',
      description: 'List one local directory',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const path = normalizePath(workspaceRoot, input.path ?? '.')
        const entries = await readdir(path, { withFileTypes: true })

        return {
          path,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
          }))
        }
      }
    },
    {
      name: 'search_text',
      description: 'Search text within local files',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['pattern']
      },
      side_effects: false,
      async handler(input) {
        if (!input.pattern) {
          throw new Error('Missing required tool input: pattern')
        }

        const path = normalizePath(workspaceRoot, input.path ?? '.')
        const maxResults = Number.isInteger(input.max_results)
          ? input.max_results
          : 20
        const results = await searchTextInPath(path, input.pattern, maxResults)

        return {
          path,
          pattern: input.pattern,
          results
        }
      }
    },
    {
      name: 'write_file',
      description: 'Write one local file',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['path', 'content']
      },
      side_effects: true,
      async handler(input) {
        const path = normalizePath(workspaceRoot, input.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, String(input.content ?? ''), 'utf8')

        return {
          path,
          bytes_written: Buffer.byteLength(String(input.content ?? ''), 'utf8')
        }
      }
    },
    {
      name: 'run_shell_command',
      description: 'Run one local shell command',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['command']
      },
      side_effects: true,
      async handler(input) {
        if (!input.command) {
          throw new Error('Missing required tool input: command')
        }

        const shell = String(
          input.shell
          ?? process.env.NEWAGENT_SHELL
          ?? process.env.SHELL
          ?? '/bin/sh'
        ).trim() || '/bin/sh'
        const cwd = input.cwd ? normalizePath(workspaceRoot, input.cwd) : workspaceRoot
        const { stdout, stderr } = await execFileAsync(shell, ['-c', input.command], {
          cwd,
          timeout: Number.isInteger(input.timeout_ms) ? input.timeout_ms : 10000,
          maxBuffer: 1024 * 1024
        })

        return {
          shell,
          command: String(input.command),
          cwd,
          stdout,
          stderr
        }
      }
    }
  ]
}

function normalizeToolCwd(workspaceRoot, cwd) {
  if (!cwd) {
    return workspaceRoot
  }

  return normalizePath(workspaceRoot, cwd)
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    return null
  }

  return String(baseUrl).replace(/\/+$/u, '')
}

function normalizeScraplingMode(mode) {
  const normalized = String(mode ?? 'static').trim().toLowerCase()

  if (['static', 'dynamic', 'stealth'].includes(normalized)) {
    return normalized
  }

  throw new Error(`Unsupported Scrapling mode: ${mode}`)
}

function normalizeScraplingOutput(output) {
  const normalized = String(output ?? 'text').trim().toLowerCase()

  if (['text', 'html', 'markdown'].includes(normalized)) {
    return normalized
  }

  throw new Error(`Unsupported Scrapling output: ${output}`)
}

function normalizePositiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return value
  }

  return fallback
}

async function safeReadJsonResponse(response) {
  if (typeof response?.json === 'function') {
    return response.json()
  }

  if (typeof response?.text === 'function') {
    const raw = await response.text()

    return JSON.parse(raw)
  }

  return {}
}

function createCodexSpecs(workspaceRoot, codexCommand) {
  return [
    {
      name: 'codex_review_workspace',
      description: 'Run Codex review against a workspace repository',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const cwd = normalizeToolCwd(workspaceRoot, input.cwd)
        const args = ['exec', 'review']

        if (input.uncommitted !== false) {
          args.push('--uncommitted')
        }

        if (input.base) {
          args.push('--base', String(input.base))
        }

        if (input.model) {
          args.push('--model', String(input.model))
        }

        if (input.json === true) {
          args.push('--json')
        }

        if (input.instruction) {
          args.push(String(input.instruction))
        }

        const { stdout, stderr } = await execFileAsync(codexCommand, args, {
          cwd,
          timeout: Number.isInteger(input.timeout_ms) ? input.timeout_ms : 60000,
          maxBuffer: 1024 * 1024 * 4
        })

        return {
          cwd,
          invocation: {
            command: codexCommand,
            args
          },
          stdout,
          stderr
        }
      }
    },
    {
      name: 'codex_repair_workspace',
      description: 'Run Codex to patch or repair a workspace task',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['instruction']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.instruction) {
          throw new Error('Missing required tool input: instruction')
        }

        const cwd = normalizeToolCwd(workspaceRoot, input.cwd)
        const args = ['exec']

        if (input.model) {
          args.push('--model', String(input.model))
        }

        if (input.full_auto === true) {
          args.push('--full-auto')
        }

        if (input.skip_git_repo_check === true) {
          args.push('--skip-git-repo-check')
        }

        if (Array.isArray(input.add_dirs)) {
          for (const dir of input.add_dirs) {
            args.push('--add-dir', normalizePath(workspaceRoot, dir))
          }
        }

        args.push(String(input.instruction))

        const { stdout, stderr } = await execFileAsync(codexCommand, args, {
          cwd,
          timeout: Number.isInteger(input.timeout_ms) ? input.timeout_ms : 120000,
          maxBuffer: 1024 * 1024 * 4
        })

        return {
          cwd,
          invocation: {
            command: codexCommand,
            args
          },
          stdout,
          stderr
        }
      }
    }
  ]
}

function createProjectSpecs(storageRoot, fetchFn, pm2Command) {
  const projectRegistry = createProjectRegistry({ storageRoot })

  async function readPathStatus(path) {
    if (!path) {
      return null
    }

    try {
      const stats = await stat(path)

      return {
        path,
        exists: true,
        type: stats.isDirectory()
          ? 'directory'
          : stats.isFile()
            ? 'file'
            : 'other'
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          path,
          exists: false,
          type: null
        }
      }

      throw error
    }
  }

  return [
    {
      name: 'project_list_registry',
      description: 'List registered remote server projects',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const projects = await projectRegistry.listProjects({
          tier: input.tier ?? null,
          status: input.status ?? null
        })

        return {
          projects
        }
      }
    },
    {
      name: 'project_get_registry',
      description: 'Read one registered remote server project',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['project_key']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.project_key) {
          throw new Error('Missing required tool input: project_key')
        }

        const project = await projectRegistry.getProject(input.project_key)

        if (!project) {
          throw new Error(`Unknown project: ${input.project_key}`)
        }

        return {
          project
        }
      }
    },
    {
      name: 'project_pm2_status',
      description: 'Inspect PM2 runtime status for one registered project',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['project_key']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.project_key) {
          throw new Error('Missing required tool input: project_key')
        }

        const project = await projectRegistry.getProject(input.project_key)

        if (!project) {
          throw new Error(`Unknown project: ${input.project_key}`)
        }

        if (!project.pm2_name) {
          throw new Error(`Project does not define a pm2 process: ${input.project_key}`)
        }

        const { stdout } = await execFileAsync(pm2Command, ['jlist'], {
          timeout: Number.isInteger(input.timeout_ms) ? input.timeout_ms : 10000,
          maxBuffer: 1024 * 1024 * 4
        })
        const processes = JSON.parse(stdout)
        const match = processes.find((entry) => entry.name === project.pm2_name) ?? null

        return {
          project_key: project.project_key,
          pm2_name: project.pm2_name,
          found: Boolean(match),
          status: match?.pm2_env?.status ?? null,
          pid: match?.pid ?? null,
          restarts: match?.pm2_env?.restart_time ?? null
        }
      }
    },
    {
      name: 'project_probe_endpoint',
      description: 'Probe one project service endpoint or explicit URL',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const project = input.project_key
          ? await projectRegistry.getProject(input.project_key)
          : null

        if (input.project_key && !project) {
          throw new Error(`Unknown project: ${input.project_key}`)
        }

        const url = input.url ?? project?.service_endpoint ?? null

        if (!url) {
          throw new Error('Missing required tool input: url or project_key with service_endpoint')
        }

        try {
          const response = await fetchFn(url, {
            method: input.method ?? 'GET',
            headers: {
              Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
            }
          })
          const body = await response.text()

          return {
            project_key: project?.project_key ?? input.project_key ?? null,
            url,
            ok: response.ok,
            status: response.status,
            status_text: response.statusText,
            body_preview: body.slice(0, 500),
            error_message: null
          }
        } catch (error) {
          return {
            project_key: project?.project_key ?? input.project_key ?? null,
            url,
            ok: false,
            status: null,
            status_text: null,
            body_preview: null,
            error_message: error.message
          }
        }
      }
    },
    {
      name: 'project_check_paths',
      description: 'Inspect source, runtime, and publish paths for one registered project',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['project_key']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.project_key) {
          throw new Error('Missing required tool input: project_key')
        }

        const project = await projectRegistry.getProject(input.project_key)

        if (!project) {
          throw new Error(`Unknown project: ${input.project_key}`)
        }

        return {
          project_key: project.project_key,
          source_root: await readPathStatus(project.source_root),
          runtime_root: await readPathStatus(project.runtime_root),
          publish_root: await readPathStatus(project.publish_root)
        }
      }
    }
  ]
}

function createWebSpecs(fetchFn) {
  return [
    {
      name: 'web_extract_scrapling',
      description: 'Extract one web page through a configured Scrapling worker',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['url']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.url) {
          throw new Error('Missing required tool input: url')
        }

        const baseUrl = normalizeBaseUrl(
          input.base_url ?? process.env.NEWAGENT_SCRAPLING_BASE_URL ?? null
        )
        const endpoint = baseUrl ? `${baseUrl}/v1/extract` : null
        const request = {
          url: String(input.url),
          mode: normalizeScraplingMode(input.mode),
          selector: input.selector ? String(input.selector) : null,
          output: normalizeScraplingOutput(input.output),
          timeout_ms: normalizePositiveInteger(input.timeout_ms, 30000),
          wait_for: input.wait_for ? String(input.wait_for) : null,
          include_links: input.include_links === true
        }

        if (!endpoint) {
          return {
            worker: {
              kind: 'scrapling',
              configured: false,
              base_url: null,
              endpoint: null
            },
            request,
            ok: false,
            status_code: null,
            final_url: null,
            title: null,
            content: null,
            links: [],
            metadata: null,
            error_message:
              'Scrapling worker is not configured. Set NEWAGENT_SCRAPLING_BASE_URL or pass base_url.'
          }
        }

        const headers = {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
        const signal = typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(request.timeout_ms)
          : undefined

        try {
          const response = await fetchFn(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(request),
            signal
          })
          const payload = await safeReadJsonResponse(response)
          const content =
            payload.content
            ?? (request.output === 'html' ? payload.html : null)
            ?? (request.output === 'markdown' ? payload.markdown : null)
            ?? (request.output === 'text' ? payload.text : null)
            ?? null

          return {
            worker: {
              kind: 'scrapling',
              configured: true,
              base_url: baseUrl,
              endpoint
            },
            request,
            ok: Boolean(payload.ok ?? response.ok),
            status_code: response.status ?? null,
            final_url: payload.final_url ?? payload.url ?? request.url,
            title: payload.title ?? null,
            content,
            links: Array.isArray(payload.links) ? payload.links : [],
            metadata: payload.metadata ?? null,
            error_message:
              payload.error_message
              ?? payload.error
              ?? (response.ok ? null : `Scrapling worker returned HTTP ${response.status}`)
          }
        } catch (error) {
          return {
            worker: {
              kind: 'scrapling',
              configured: true,
              base_url: baseUrl,
              endpoint
            },
            request,
            ok: false,
            status_code: null,
            final_url: null,
            title: null,
            content: null,
            links: [],
            metadata: null,
            error_message: error.message
          }
        }
      }
    }
  ]
}

export function createToolRuntime({
  storageRoot,
  workspaceRoot,
  codexCommand = 'codex',
  fetchFn = globalThis.fetch,
  pm2Command = 'pm2',
  hookBus = null
}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('A fetch implementation is required for project probe tools')
  }

  const sessionStore = createSessionStore({ storageRoot })
  const runtimeHookBus = hookBus ?? createHookBus({ storageRoot })
  const debugRuntime = createDebugRuntime({ storageRoot })
  const specs = createDefaultSpecs(workspaceRoot)
    .concat(createProjectSpecs(storageRoot, fetchFn, pm2Command))
    .concat(createWebSpecs(fetchFn))
    .concat(createCodexSpecs(workspaceRoot, codexCommand))
    .concat([
    {
      name: 'debug_session_get',
      description: 'Inspect the current session object',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(_input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.getSession(context.sessionId)
      }
    },
    {
      name: 'debug_task_get',
      description: 'Inspect the current task object',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(_input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.getTask(context.sessionId)
      }
    },
    {
      name: 'debug_plan_step_get',
      description: 'Inspect one plan step',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.getPlanStep(context.sessionId, {
          stepId: input.step_id ?? null
        })
      }
    },
    {
      name: 'debug_approval_list',
      description: 'List approvals for the current session',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.listApprovals(context.sessionId, {
          status: input.status ?? null
        })
      }
    },
    {
      name: 'debug_context_inspect',
      description: 'Inspect the latest context selection artifacts',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(_input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.inspectContext(context.sessionId)
      }
    },
    {
      name: 'debug_timeline_replay',
      description: 'Replay timeline events for the current session',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.replayTimeline(context.sessionId, {
          limit: Number.isInteger(input.limit) ? input.limit : null
        })
      }
    },
    {
      name: 'debug_session_patch',
      description: 'Patch the current session object',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['patch']
      },
      side_effects: true,
      async handler(input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.patchSession(context.sessionId, {
          patch: input.patch,
          reason: input.reason ?? 'tool_debug_patch'
        })
      }
    },
    {
      name: 'debug_task_patch',
      description: 'Patch the current task object',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['patch']
      },
      side_effects: true,
      async handler(input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.patchTask(context.sessionId, {
          patch: input.patch,
          reason: input.reason ?? 'tool_debug_patch'
        })
      }
    },
    {
      name: 'debug_plan_step_patch',
      description: 'Patch one plan step object',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['patch']
      },
      side_effects: true,
      async handler(input, context) {
        if (!context.sessionId) {
          throw new Error('Debug tools require session context')
        }

        return debugRuntime.patchPlanStep(context.sessionId, {
          stepId: input.step_id ?? null,
          patch: input.patch,
          reason: input.reason ?? 'tool_debug_patch'
        })
      }
    }
  ])
  const toolMap = new Map(specs.map((spec) => [spec.name, spec]))

  async function emitHook({
    name,
    sessionId = null,
    actor = 'tool:runtime',
    payload = {}
  }) {
    return runtimeHookBus.emit({
      name,
      sessionId,
      actor,
      payload
    })
  }

  function listToolSpecs() {
    return specs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      permission_class: spec.permission_class,
      input_schema: spec.input_schema,
      side_effects: spec.side_effects
    }))
  }

  async function executeTool({ sessionId = null, stepId = null, toolName, input = {} }) {
    const spec = toolMap.get(toolName)

    if (!spec) {
      return {
        status: 'error',
        tool_name: toolName,
        permission_class: null,
        error: {
          message: `Unknown tool: ${toolName}`
        }
      }
    }

    if (sessionId) {
      await sessionStore.appendTimelineEvent(sessionId, {
        stepId,
        kind: 'tool_requested',
        payload: {
          tool_name: toolName,
          permission_class: spec.permission_class
        }
      })
    }
    await emitHook({
      name: 'tool.requested',
      sessionId,
      payload: {
        step_id: stepId ?? null,
        tool_name: toolName,
        permission_class: spec.permission_class
      }
    })

    if (spec.permission_class === 'dangerous') {
      if (!sessionId) {
        return {
          status: 'error',
          tool_name: toolName,
          permission_class: spec.permission_class,
          error: {
            message: 'Dangerous tools require session context'
          }
        }
      }

      const snapshot = await sessionStore.loadSession(sessionId)

      if (!hasApprovedDangerousExecution(snapshot, {
        stepId,
        toolName,
        input
      })) {
        const approval = await sessionStore.requestApproval(sessionId, {
          stepId,
          toolName,
          permissionClass: spec.permission_class,
          reason: `Tool ${toolName} requires explicit approval before execution`,
          requestedInput: input
        })
        await emitHook({
          name: 'tool.approval.waiting',
          sessionId,
          payload: {
            step_id: stepId ?? null,
            tool_name: toolName,
            approval_id: approval.id,
            permission_class: spec.permission_class
          }
        })

        return {
          status: 'waiting_approval',
          tool_name: toolName,
          permission_class: spec.permission_class,
          approval
        }
      }
    }

    try {
      const output = await spec.handler(input, {
        sessionId,
        stepId
      })

      if (sessionId) {
        await sessionStore.appendTimelineEvent(sessionId, {
          stepId,
          kind: 'tool_completed',
          payload: {
            tool_name: toolName,
            status: 'ok'
          }
        })
      }
      await emitHook({
        name: 'tool.completed',
        sessionId,
        payload: {
          step_id: stepId ?? null,
          tool_name: toolName,
          permission_class: spec.permission_class,
          output_ok: typeof output?.ok === 'boolean' ? output.ok : null
        }
      })

      return {
        status: 'ok',
        tool_name: toolName,
        permission_class: spec.permission_class,
        output
      }
    } catch (error) {
      if (sessionId) {
        await sessionStore.appendTimelineEvent(sessionId, {
          stepId,
          kind: 'tool_failed',
          payload: {
            tool_name: toolName,
            message: error.message
          }
        })
      }
      await emitHook({
        name: 'tool.failed',
        sessionId,
        payload: {
          step_id: stepId ?? null,
          tool_name: toolName,
          permission_class: spec.permission_class,
          message: error.message
        }
      })

      return {
        status: 'error',
        tool_name: toolName,
        permission_class: spec.permission_class,
        error: {
          message: error.message
        }
      }
    }
  }

  return {
    listToolSpecs,
    executeTool
  }
}
