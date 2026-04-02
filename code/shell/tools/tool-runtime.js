import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHookBus } from '../hooks/hook-bus.js'
import { createSessionStore } from '../session/session-store.js'
import { createDebugRuntime } from '../debug/debug-runtime.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createInfrastructureRegistry } from '../registry/infrastructure-registry.js'
import { createNewsSourceRegistry } from '../registry/news-source-registry.js'
import { createRemoteServerManagerProfile } from '../manager/remote-server-manager-profile.js'
import {
  createFeishuApiClient,
  describeFeishuChannelConfig
} from '../channels/feishu/feishu-gateway.js'
import { createFeishuUserAuthManager } from '../channels/feishu/feishu-user-auth.js'
import { createDynamicToolRegistry } from './dynamic-tool-registry.js'

const execFileAsync = promisify(execFile)
const TOOL_CATEGORIES = [
  'core',
  'project',
  'infrastructure',
  'server_ops',
  'news',
  'channel',
  'coworker',
  'dynamic_tool',
  'internal',
  'web',
  'codex',
  'debug'
]

function normalizeString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function mergeFeishuRequestOptions(sdk, baseRequestOptions, callRequestOptions) {
  if (baseRequestOptions && callRequestOptions && typeof sdk?.withAll === 'function') {
    return sdk.withAll([baseRequestOptions, callRequestOptions])
  }

  return callRequestOptions ?? baseRequestOptions ?? undefined
}

function wrapFeishuClientWithRequestOptions(target, sdk, baseRequestOptions, cache = new WeakMap()) {
  if (!baseRequestOptions || !target || typeof target !== 'object') {
    return target
  }

  if (cache.has(target)) {
    return cache.get(target)
  }

  const proxy = new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver)

      if (typeof value === 'function') {
        return (payload, callRequestOptions) => value.call(
          object,
          payload,
          mergeFeishuRequestOptions(sdk, baseRequestOptions, callRequestOptions)
        )
      }

      if (value && typeof value === 'object') {
        return wrapFeishuClientWithRequestOptions(value, sdk, baseRequestOptions, cache)
      }

      return value
    }
  })

  cache.set(target, proxy)
  return proxy
}

function normalizeToolCategory(value, fallback = 'internal') {
  const normalized = normalizeString(value)?.toLowerCase()

  if (normalized && TOOL_CATEGORIES.includes(normalized)) {
    return normalized
  }

  return fallback
}

function inferToolCategory(name) {
  if (['read_file', 'list_files', 'search_text', 'write_file', 'run_shell_command'].includes(name)) {
    return 'core'
  }

  if (name.startsWith('project_')) {
    return 'project'
  }

  if (name.startsWith('infrastructure_')) {
    return 'infrastructure'
  }

  if (name.startsWith('server_ops_')) {
    return 'server_ops'
  }

  if (name.startsWith('news_')) {
    return 'news'
  }

  if (name.startsWith('channel_')) {
    return 'channel'
  }

  if (name.startsWith('coworker_')) {
    return 'coworker'
  }

  if (name.startsWith('dynamic_tool_')) {
    return 'dynamic_tool'
  }

  if (name.startsWith('web_')) {
    return 'web'
  }

  if (name.startsWith('codex_')) {
    return 'codex'
  }

  if (name.startsWith('debug_')) {
    return 'debug'
  }

  if (name.startsWith('tool_catalog_')) {
    return 'internal'
  }

  return 'internal'
}

function withToolCategory(specs, category) {
  return specs.map((spec) => ({
    ...spec,
    category: normalizeToolCategory(spec.category, category)
  }))
}

function describeToolSpec(spec, toolSource = 'builtin') {
  return {
    name: spec.name,
    description: spec.description,
    permission_class: spec.permission_class,
    input_schema: spec.input_schema,
    side_effects: spec.side_effects,
    category: normalizeToolCategory(spec.category, inferToolCategory(spec.name)),
    tool_source: toolSource
  }
}

function describeDynamicTool(entry) {
  return {
    name: entry.tool_name,
    description: entry.description,
    permission_class: entry.permission_class,
    input_schema: entry.input_schema,
    side_effects: entry.side_effects,
    category: normalizeToolCategory(entry.category, inferToolCategory(entry.tool_name)),
    tool_source: 'dynamic',
    lifecycle: entry.lifecycle,
    review_status: entry.review_status,
    restart_required: entry.restart_required,
    restart_strategy: entry.restart_strategy,
    restart_time_hint: entry.restart_time_hint,
    usage_count: entry.usage_count ?? 0,
    last_used_at: entry.last_used_at ?? null
  }
}

function filterToolDescriptors(descriptors, input = {}) {
  const category = normalizeString(input.category)?.toLowerCase() ?? null
  const permissionClass = normalizeString(input.permission_class)?.toLowerCase() ?? null
  const toolSource = normalizeString(input.tool_source)?.toLowerCase() ?? null
  const query = normalizeString(input.query)?.toLowerCase() ?? null

  return descriptors.filter((descriptor) => {
    if (category && descriptor.category !== category) {
      return false
    }

    if (permissionClass && descriptor.permission_class !== permissionClass) {
      return false
    }

    if (toolSource && descriptor.tool_source !== toolSource) {
      return false
    }

    if (
      query
      && !String(descriptor.name ?? '').toLowerCase().includes(query)
      && !String(descriptor.description ?? '').toLowerCase().includes(query)
    ) {
      return false
    }

    return true
  })
}

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

function locateFirstPatternMatch(content, pattern) {
  const lines = String(content ?? '').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const column = lines[index].indexOf(pattern)

    if (column >= 0) {
      return {
        line: index + 1,
        column: column + 1,
        preview: lines[index].trim()
      }
    }
  }

  return null
}

async function searchTextMatchesInPath(targetPath, pattern, maxResults) {
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

      const nested = await searchTextMatchesInPath(nextPath, pattern, maxResults - results.length)
      results.push(...nested)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    try {
      const content = await readFile(nextPath, 'utf8')
      const match = locateFirstPatternMatch(content, pattern)

      if (match) {
        results.push({
          path: nextPath,
          line: match.line,
          column: match.column,
          preview: match.preview
        })
      }
    } catch {
      // Ignore unreadable and binary-ish files.
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
      async handler(input, { signal } = {}) {
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
      async handler(input, { signal } = {}) {
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
      async handler(input, { signal } = {}) {
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
      async handler(input, { signal } = {}) {
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
          ...(signal ? { signal } : {}),
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
      async handler(input = {}, { signal } = {}) {
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
          ...(signal ? { signal } : {}),
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
      async handler(input = {}, { signal } = {}) {
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
          ...(signal ? { signal } : {}),
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

  function collectProjectRoots(project, scope = 'all') {
    const normalizedScope = normalizeString(scope)?.toLowerCase() ?? 'all'
    const scopes = normalizedScope === 'all'
      ? ['source', 'runtime', 'publish']
      : [normalizedScope]
    const roots = []

    for (const rootKind of scopes) {
      const path =
        rootKind === 'source'
          ? project.source_root
          : rootKind === 'runtime'
            ? project.runtime_root
            : rootKind === 'publish'
              ? project.publish_root
              : null

      if (!path) {
        continue
      }

      if (!roots.some((entry) => entry.path === path)) {
        roots.push({
          scope: rootKind,
          path
        })
      }
    }

    return roots
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
      name: 'project_resolve_registry',
      description: 'Resolve projects by key, PM2 name, URL, path, or free-text query',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const query = normalizeString(input.query)?.toLowerCase() ?? null
        const projectKey = normalizeString(input.project_key)
        const pm2Name = normalizeString(input.pm2_name)
        const serviceEndpoint = normalizeString(input.service_endpoint)
        const publicBasePath = normalizeString(input.public_base_path)
        const pathQuery = normalizeString(input.path)
        const projects = await projectRegistry.listProjects({
          tier: input.tier ?? null,
          status: input.status ?? null
        })

        const matches = projects.filter((project) => {
          if (projectKey && project.project_key !== projectKey) {
            return false
          }

          if (pm2Name && project.pm2_name !== pm2Name) {
            return false
          }

          if (serviceEndpoint && project.service_endpoint !== serviceEndpoint) {
            return false
          }

          if (publicBasePath && project.public_base_path !== publicBasePath) {
            return false
          }

          if (
            pathQuery
            && ![
              project.source_root,
              project.runtime_root,
              project.publish_root
            ].some((value) => value === pathQuery)
          ) {
            return false
          }

          if (
            query
            && ![
              project.project_key,
              project.name,
              project.role,
              project.source_root,
              project.runtime_root,
              project.publish_root,
              project.public_base_path,
              project.pm2_name,
              project.service_endpoint,
              project.repo_remote,
              project.notes
            ].some((value) => includesQuery(value, query))
          ) {
            return false
          }

          return true
        })

        return {
          query: input.query ?? null,
          pm2_name: pm2Name,
          service_endpoint: serviceEndpoint,
          public_base_path: publicBasePath,
          path: pathQuery,
          matches
        }
      }
    },
    {
      name: 'project_search_code',
      description: 'Search one project source, runtime, or publish tree for code and config references',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['project_key', 'pattern']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.project_key) {
          throw new Error('Missing required tool input: project_key')
        }

        if (!input.pattern) {
          throw new Error('Missing required tool input: pattern')
        }

        const project = await projectRegistry.getProject(input.project_key)

        if (!project) {
          throw new Error(`Unknown project: ${input.project_key}`)
        }

        const roots = collectProjectRoots(project, input.scope ?? 'all')
        const limit = Number.isInteger(input.max_results) ? input.max_results : 20
        const results = []

        for (const root of roots) {
          if (results.length >= limit) {
            break
          }

          const status = await readPathStatus(root.path)

          if (!status?.exists || status.type !== 'directory') {
            continue
          }

          const matches = await searchTextMatchesInPath(
            root.path,
            String(input.pattern),
            limit - results.length
          )

          results.push(...matches.map((match) => ({
            ...match,
            scope: root.scope
          })))
        }

        return {
          project_key: project.project_key,
          pattern: String(input.pattern),
          scope: input.scope ?? 'all',
          roots,
          results
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

function includesQuery(value, query) {
  if (!query) {
    return false
  }

  return String(value ?? '').toLowerCase().includes(String(query).toLowerCase())
}

function getNestedValue(record, path) {
  if (!path) {
    return record
  }

  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((current, segment) => current?.[segment], record)
}

function parseRssItems(xml) {
  const itemPattern = /<item\b[\s\S]*?<\/item>/giu
  const linkPattern = /<link>([\s\S]*?)<\/link>/iu
  const titlePattern = /<title>([\s\S]*?)<\/title>/iu
  const descriptionPattern = /<description>([\s\S]*?)<\/description>/iu
  const pubDatePattern = /<pubDate>([\s\S]*?)<\/pubDate>/iu
  const authorPattern = /<author>([\s\S]*?)<\/author>/iu

  return [...String(xml ?? '').matchAll(itemPattern)].map((match) => {
    const item = match[0]

    return {
      title: item.match(titlePattern)?.[1]?.trim() ?? null,
      url: item.match(linkPattern)?.[1]?.trim() ?? null,
      summary: item.match(descriptionPattern)?.[1]?.trim() ?? null,
      published_at: item.match(pubDatePattern)?.[1]?.trim() ?? null,
      author: item.match(authorPattern)?.[1]?.trim() ?? null
    }
  })
}

function buildRequestUrl(baseUrl, params) {
  const url = new URL(baseUrl)

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  return url.toString()
}

function toPositiveInteger(value, fallback) {
  if (Number.isInteger(value) && value > 0) {
    return value
  }

  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
  }

  const single = normalizeString(value)
  return single ? [single] : []
}

function unwrapFeishuData(response, field = null) {
  const data = response?.data ?? null

  if (!field) {
    return data
  }

  return data?.[field] ?? null
}

function tryParseJsonOutput(raw) {
  const text = String(raw ?? '').trim()

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {}

  const firstObject = text.indexOf('{')
  const lastObject = text.lastIndexOf('}')

  if (firstObject >= 0 && lastObject > firstObject) {
    try {
      return JSON.parse(text.slice(firstObject, lastObject + 1))
    } catch {}
  }

  const firstArray = text.indexOf('[')
  const lastArray = text.lastIndexOf(']')

  if (firstArray >= 0 && lastArray > firstArray) {
    try {
      return JSON.parse(text.slice(firstArray, lastArray + 1))
    } catch {}
  }

  return null
}

function normalizeFeishuFieldNames(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeString(entry))
      .filter(Boolean)
      .join(',')
  }

  return normalizeString(value)
}

function normalizeCollectedNewsItem(source, item) {
  return {
    source_key: source.source_key,
    source_name: source.name,
    category: source.category,
    title: source.transport === 'rss'
      ? normalizeString(item.title)
      : normalizeString(getNestedValue(item, source.title_field)),
    url: source.transport === 'rss'
      ? normalizeString(item.url)
      : normalizeString(getNestedValue(item, source.url_field)),
    published_at: source.transport === 'rss'
      ? normalizeString(item.published_at)
      : normalizeString(getNestedValue(item, source.published_at_field)),
    summary: source.transport === 'rss'
      ? normalizeString(item.summary)
      : normalizeString(getNestedValue(item, source.summary_field)),
    author: source.transport === 'rss'
      ? normalizeString(item.author)
      : normalizeString(getNestedValue(item, source.author_field)),
    raw: item
  }
}

function createNewsSpecs(storageRoot, fetchFn) {
  const newsSourceRegistry = createNewsSourceRegistry({ storageRoot })

  async function resolveNewsSource(input = {}, category = null) {
    if (input.source_key) {
      const source = await newsSourceRegistry.getSource(input.source_key)

      if (!source) {
        throw new Error(`Unknown news source: ${input.source_key}`)
      }

      return source
    }

    if (input.url) {
      return {
        source_key: 'inline_source',
        category: category ?? normalizeString(input.category) ?? 'general',
        name: input.name ?? 'Inline Source',
        transport: normalizeString(input.transport)?.toLowerCase() ?? 'json',
        url: input.url,
        method: normalizeString(input.method)?.toUpperCase() ?? 'GET',
        default_params: typeof input.params === 'object' && !Array.isArray(input.params)
          ? input.params
          : {},
        limit_param: normalizeString(input.limit_param),
        list_path: normalizeString(input.list_path),
        title_field: normalizeString(input.title_field) ?? 'title',
        url_field: normalizeString(input.url_field) ?? 'url',
        published_at_field: normalizeString(input.published_at_field),
        summary_field: normalizeString(input.summary_field),
        author_field: normalizeString(input.author_field),
        status: 'active'
      }
    }

    const candidates = await newsSourceRegistry.listSources({
      category: category ?? null,
      status: 'active'
    })

    if (candidates.length === 0) {
      throw new Error(
        category
          ? `No active news source is registered for category: ${category}`
          : 'No active news source is registered'
      )
    }

    return candidates[0]
  }

  async function collectFromSource(input = {}, category = null) {
    const source = await resolveNewsSource(input, category)
    const limit = Number.isInteger(input.limit) ? input.limit : 10
    const requestUrl = buildRequestUrl(source.url, {
      ...(source.default_params ?? {}),
      ...(typeof input.params === 'object' && !Array.isArray(input.params) ? input.params : {}),
      ...(source.limit_param ? { [source.limit_param]: limit } : {})
    })
    const response = await fetchFn(requestUrl, {
      method: source.method ?? 'GET',
      headers: {
        Accept: source.transport === 'rss'
          ? 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
          : 'application/json,text/plain;q=0.9,*/*;q=0.8'
      }
    })

    if (source.transport === 'rss') {
      const xml = await response.text()
      const items = parseRssItems(xml)

      return {
        source,
        request_url: requestUrl,
        items: items
          .slice(0, limit)
          .map((item) => normalizeCollectedNewsItem(source, item))
      }
    }

    const payload = typeof response.json === 'function'
      ? await response.json()
      : JSON.parse(await response.text())
    const rawItems = source.list_path
      ? getNestedValue(payload, source.list_path)
      : payload
    const items = Array.isArray(rawItems) ? rawItems : []

    return {
      source,
      request_url: requestUrl,
      items: items
        .slice(0, limit)
        .map((item) => normalizeCollectedNewsItem(source, item))
    }
  }

  return [
    {
      name: 'news_source_list',
      description: 'List registered or default network news sources by category',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return {
          sources: await newsSourceRegistry.listSources({
            category: input.category ?? null,
            status: input.status ?? null
          })
        }
      }
    },
    {
      name: 'news_source_register',
      description: 'Register one reusable network news source definition',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['source_key', 'category', 'name', 'transport', 'url']
      },
      side_effects: true,
      async handler(input = {}) {
        return {
          source: await newsSourceRegistry.registerSource(input)
        }
      }
    },
    {
      name: 'news_general_collect',
      description: 'Collect general network news from one registered source or inline feed definition',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return collectFromSource(input, input.url ? null : 'general')
      }
    },
    {
      name: 'news_stock_collect',
      description: 'Collect stock news using the stock-news source registry and Eastmoney-style feeds',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return collectFromSource(input, input.url ? null : 'stock')
      }
    },
    {
      name: 'news_hot_collect',
      description: 'Collect self-media or community hot-topic feeds from registered hot sources',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return collectFromSource(input, input.url ? null : 'hot')
      }
    }
  ]
}

function createChannelSpecs({
  storageRoot,
  workspaceRoot,
  fetchFn = globalThis.fetch,
  feishuApiClientFactory = createFeishuApiClient,
  feishuConfigDescriber = describeFeishuChannelConfig,
  feishuUserAuthManager = null
} = {}) {
  const userAuthManager = feishuUserAuthManager ?? createFeishuUserAuthManager({
    storageRoot,
    fetchFn
  })

  async function resolveFeishuWorkspaceClient({
    identity = 'auto'
  } = {}) {
    const config = feishuConfigDescriber()

    if (!config.ready) {
      throw new Error('Feishu credentials are not configured')
    }

    const bundle = await feishuApiClientFactory()
    const sdk = bundle.sdk ?? null
    const authResolution = userAuthManager && sdk
      ? await userAuthManager.resolveRequestOptions(sdk, { identity })
      : {
          active_identity: 'app',
          request_options: null,
          user: null
        }

    return {
      ...bundle,
      client: wrapFeishuClientWithRequestOptions(bundle.client, sdk, authResolution.request_options),
      auth_identity: authResolution.active_identity,
      user: authResolution.user ?? null
    }
  }

  async function listFeishuScopes() {
    const config = feishuConfigDescriber()

    if (!config.ready) {
      return {
        ready: false,
        granted: [],
        pending: [],
        summary: 'Feishu credentials are not configured'
      }
    }

    const { client } = await resolveFeishuWorkspaceClient({
      identity: 'app'
    })
    const response = await client.application.scope.list({})
    const scopes = Array.isArray(response.data?.scopes) ? response.data.scopes : []
    const granted = scopes.filter((scope) => scope.grant_status === 1)
    const pending = scopes.filter((scope) => scope.grant_status !== 1)

    return {
      ready: true,
      granted: granted.map((scope) => ({
        name: scope.scope_name,
        type: scope.scope_type
      })),
      pending: pending.map((scope) => ({
        name: scope.scope_name,
        type: scope.scope_type
      })),
      summary: `${granted.length} granted, ${pending.length} pending`
    }
  }

  async function convertFeishuDocContent(client, {
    content,
    contentType = 'markdown'
  }) {
    const normalizedContent = String(content ?? '').trim()

    if (!normalizedContent) {
      throw new Error('Missing required tool input: content')
    }

    const response = await client.docx.document.convert({
      data: {
        content_type: contentType === 'html' ? 'html' : 'markdown',
        content: normalizedContent
      }
    })
    const data = unwrapFeishuData(response) ?? {}
    const firstLevelBlockIds = Array.isArray(data.first_level_block_ids)
      ? data.first_level_block_ids.filter(Boolean)
      : []
    const descendants = Array.isArray(data.blocks) ? data.blocks : []

    if (firstLevelBlockIds.length === 0 || descendants.length === 0) {
      throw new Error('Feishu doc conversion returned no blocks')
    }

    return {
      first_level_block_ids: firstLevelBlockIds,
      descendants
    }
  }

  async function appendFeishuDocContent(client, {
    documentId,
    blockId = null,
    content,
    contentType = 'markdown'
  }) {
    if (!documentId) {
      throw new Error('Missing required tool input: document_id')
    }

    const converted = await convertFeishuDocContent(client, {
      content,
      contentType
    })
    const response = await client.docx.documentBlockDescendant.create({
      path: {
        document_id: documentId,
        block_id: blockId ?? documentId
      },
      data: {
        children_id: converted.first_level_block_ids,
        descendants: converted.descendants
      }
    })

    return {
      target_block_id: blockId ?? documentId,
      first_level_block_ids: converted.first_level_block_ids,
      descendant_count: converted.descendants.length,
      response_data: unwrapFeishuData(response)
    }
  }

  return [
    {
      name: 'channel_feishu_scope_list',
      description: 'List current Feishu app scopes so the agent can diagnose missing permissions',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler() {
        return listFeishuScopes()
      }
    },
    {
      name: 'channel_feishu_capability_matrix',
      description: 'Describe Feishu workspace capabilities, required permissions, and planned tool surface',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler() {
        const config = feishuConfigDescriber()
        let scopes = {
          ready: false,
          granted: [],
          pending: [],
          summary: 'Feishu credentials are not configured'
        }

        try {
          scopes = await listFeishuScopes()
        } catch (error) {
          scopes = {
            ready: config.ready,
            granted: [],
            pending: [],
            summary: error.message
          }
        }

        const auth = await userAuthManager.describeStatus()

        return {
          config,
          scopes,
          identity: auth,
          capabilities: [
            {
              capability: 'docs',
              tool_names: [
                'channel_feishu_doc_create',
                'channel_feishu_doc_get',
                'channel_feishu_doc_write'
              ],
              status: scopes.ready ? 'ready' : 'missing_credentials',
              required_scope_hints: [
                'docx document create / read / write',
                'drive permission member create'
              ],
              notes: 'Needed for creating and editing Feishu docs under the workspace app.'
            },
            {
              capability: 'bitable',
              tool_names: [
                'channel_feishu_bitable_create_app',
                'channel_feishu_bitable_get_app',
                'channel_feishu_bitable_create_table',
                'channel_feishu_bitable_list_tables',
                'channel_feishu_bitable_list_records',
                'channel_feishu_bitable_record_create',
                'channel_feishu_bitable_record_update'
              ],
              status: scopes.ready ? 'ready' : 'missing_credentials',
              required_scope_hints: [
                'bitable app create / get',
                'bitable table create / update',
                'bitable record create / update'
              ],
              notes: 'Needed for table creation and record editing.'
            },
            {
              capability: 'drive_files',
              tool_names: [
                'channel_feishu_drive_list',
                'channel_feishu_drive_create_folder',
                'channel_feishu_drive_move',
                'channel_feishu_file_upload'
              ],
              status: scopes.ready ? 'ready' : 'missing_credentials',
              required_scope_hints: [
                'drive file list / create folder / move / delete',
                'drive media upload'
              ],
              notes: 'Needed for uploads and drive file management.'
            },
            {
              capability: 'wiki',
              tool_names: [
                'channel_feishu_wiki_list_spaces',
                'channel_feishu_wiki_create_node',
                'channel_feishu_wiki_move_node',
                'channel_feishu_wiki_move_doc',
                'channel_feishu_wiki_update_title'
              ],
              status: scopes.ready ? 'ready' : 'missing_credentials',
              required_scope_hints: [
                'wiki space list / get node',
                'wiki node create / move / rename'
              ],
              notes: 'Wiki space membership still has to include the bot/app.'
            }
          ]
        }
      }
    },
    {
      name: 'channel_feishu_doc_create',
      description: 'Create one Feishu docx document and optionally append initial markdown or HTML content',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: true,
      async handler(input = {}) {
        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.docx.document.create({
          data: {
            title: normalizeString(input.title) ?? undefined,
            folder_token: normalizeString(input.folder_token) ?? undefined
          }
        })
        const document = unwrapFeishuData(response, 'document')

        if (!document?.document_id) {
          throw new Error('Feishu doc create did not return document_id')
        }

        let appended = null

        if (normalizeString(input.content)) {
          appended = await appendFeishuDocContent(client, {
            documentId: document.document_id,
            content: input.content,
            contentType: input.content_type ?? 'markdown'
          })
        }

        return {
          document,
          appended
        }
      }
    },
    {
      name: 'channel_feishu_doc_get',
      description: 'Load one Feishu docx document and optionally include its raw text content',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['document_id']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.document_id) {
          throw new Error('Missing required tool input: document_id')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.docx.document.get({
          path: {
            document_id: input.document_id
          }
        })
        const document = unwrapFeishuData(response, 'document')
        let raw_content = null

        if (input.include_raw_content !== false) {
          const rawResponse = await client.docx.document.rawContent({
            path: {
              document_id: input.document_id
            }
          })
          raw_content = unwrapFeishuData(rawResponse, 'content')
        }

        return {
          document,
          raw_content
        }
      }
    },
    {
      name: 'channel_feishu_doc_write',
      description: 'Append markdown or HTML content into one Feishu docx document',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['document_id', 'content']
      },
      side_effects: true,
      async handler(input = {}) {
        const { client } = await resolveFeishuWorkspaceClient()

        return appendFeishuDocContent(client, {
          documentId: input.document_id,
          blockId: normalizeString(input.block_id),
          content: input.content,
          contentType: input.content_type ?? 'markdown'
        })
      }
    },
    {
      name: 'channel_feishu_drive_list',
      description: 'List files under one Feishu Drive folder token',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.drive.v1.file.list({
          params: {
            folder_token: normalizeString(input.folder_token) ?? undefined,
            page_size: toPositiveInteger(input.page_size, 20),
            page_token: normalizeString(input.page_token) ?? undefined,
            order_by: normalizeString(input.order_by) ?? undefined,
            direction: normalizeString(input.direction) ?? undefined
          }
        })
        const data = unwrapFeishuData(response) ?? {}

        return {
          files: Array.isArray(data.files) ? data.files : [],
          has_more: data.has_more ?? false,
          page_token: data.next_page_token ?? null
        }
      }
    },
    {
      name: 'channel_feishu_drive_create_folder',
      description: 'Create one Feishu Drive folder under a parent folder token',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['name', 'folder_token']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.name) {
          throw new Error('Missing required tool input: name')
        }

        if (!input.folder_token) {
          throw new Error('Missing required tool input: folder_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.drive.v1.file.createFolder({
          data: {
            name: input.name,
            folder_token: input.folder_token
          }
        })

        return unwrapFeishuData(response) ?? {}
      }
    },
    {
      name: 'channel_feishu_drive_move',
      description: 'Move one Feishu Drive file or folder under another parent folder',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['file_token', 'folder_token']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.file_token) {
          throw new Error('Missing required tool input: file_token')
        }

        if (!input.folder_token) {
          throw new Error('Missing required tool input: folder_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.drive.v1.file.move({
          path: {
            file_token: input.file_token
          },
          data: {
            type: normalizeString(input.type) ?? 'file',
            folder_token: input.folder_token
          }
        })

        return unwrapFeishuData(response) ?? {}
      }
    },
    {
      name: 'channel_feishu_file_upload',
      description: 'Upload one local file or inline content blob into a Feishu Drive folder',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['parent_node']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.parent_node) {
          throw new Error('Missing required tool input: parent_node')
        }

        let fileBuffer = null
        let fileName = normalizeString(input.file_name)

        if (normalizeString(input.file_path)) {
          const path = normalizePath(workspaceRoot, input.file_path)
          fileBuffer = await readFile(path)
          fileName = fileName ?? basename(path)
        } else if (input.content !== undefined && input.content !== null) {
          fileBuffer = Buffer.from(String(input.content), 'utf8')
        }

        if (!fileBuffer) {
          throw new Error('Missing required tool input: file_path or content')
        }

        if (!fileName) {
          throw new Error('Missing required tool input: file_name when uploading inline content')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.drive.v1.file.uploadAll({
          data: {
            file_name: fileName,
            parent_type: 'explorer',
            parent_node: input.parent_node,
            size: fileBuffer.byteLength,
            file: fileBuffer
          }
        })

        return {
          file_token: response?.file_token ?? null,
          file_name: fileName,
          size: fileBuffer.byteLength
        }
      }
    },
    {
      name: 'channel_feishu_wiki_list_spaces',
      description: 'List Feishu wiki spaces currently visible to the app or bot',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.wiki.v2.space.list({
          params: {
            page_size: toPositiveInteger(input.page_size, 20),
            page_token: normalizeString(input.page_token) ?? undefined
          }
        })
        const data = unwrapFeishuData(response) ?? {}

        return {
          items: Array.isArray(data.items) ? data.items : [],
          has_more: data.has_more ?? false,
          page_token: data.page_token ?? null
        }
      }
    },
    {
      name: 'channel_feishu_wiki_create_node',
      description: 'Create one new Feishu wiki node under a space or parent wiki node',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['space_id', 'obj_type']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.space_id) {
          throw new Error('Missing required tool input: space_id')
        }

        if (!input.obj_type) {
          throw new Error('Missing required tool input: obj_type')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.wiki.v2.spaceNode.create({
          path: {
            space_id: input.space_id
          },
          data: {
            obj_type: input.obj_type,
            parent_node_token: normalizeString(input.parent_node_token) ?? undefined,
            node_type: normalizeString(input.node_type) ?? 'origin',
            origin_node_token: normalizeString(input.origin_node_token) ?? undefined,
            title: normalizeString(input.title) ?? undefined
          }
        })

        return {
          node: unwrapFeishuData(response, 'node')
        }
      }
    },
    {
      name: 'channel_feishu_wiki_move_node',
      description: 'Move one Feishu wiki node within or across wiki spaces',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['space_id', 'node_token']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.space_id) {
          throw new Error('Missing required tool input: space_id')
        }

        if (!input.node_token) {
          throw new Error('Missing required tool input: node_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.wiki.v2.spaceNode.move({
          path: {
            space_id: input.space_id,
            node_token: input.node_token
          },
          data: {
            target_parent_token: normalizeString(input.target_parent_token) ?? undefined,
            target_space_id: normalizeString(input.target_space_id) ?? undefined
          }
        })

        return {
          node: unwrapFeishuData(response, 'node')
        }
      }
    },
    {
      name: 'channel_feishu_wiki_move_doc',
      description: 'Move one existing Drive docx, file, or bitable object into a Feishu wiki space',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['space_id', 'obj_token', 'obj_type']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.space_id) {
          throw new Error('Missing required tool input: space_id')
        }

        if (!input.obj_token) {
          throw new Error('Missing required tool input: obj_token')
        }

        if (!input.obj_type) {
          throw new Error('Missing required tool input: obj_type')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.wiki.v2.spaceNode.moveDocsToWiki({
          path: {
            space_id: input.space_id
          },
          data: {
            parent_wiki_token: normalizeString(input.parent_wiki_token) ?? undefined,
            obj_token: input.obj_token,
            obj_type: input.obj_type,
            apply: input.apply !== false
          }
        })

        return unwrapFeishuData(response) ?? {}
      }
    },
    {
      name: 'channel_feishu_wiki_update_title',
      description: 'Update the title of one Feishu wiki node',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['space_id', 'node_token', 'title']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.space_id) {
          throw new Error('Missing required tool input: space_id')
        }

        if (!input.node_token) {
          throw new Error('Missing required tool input: node_token')
        }

        if (!input.title) {
          throw new Error('Missing required tool input: title')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        await client.wiki.v2.spaceNode.updateTitle({
          path: {
            space_id: input.space_id,
            node_token: input.node_token
          },
          data: {
            title: input.title
          }
        })

        return {
          ok: true,
          space_id: input.space_id,
          node_token: input.node_token,
          title: input.title
        }
      }
    },
    {
      name: 'channel_feishu_bitable_create_app',
      description: 'Create one Feishu bitable app',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: true,
      async handler(input = {}) {
        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.app.create({
          data: {
            name: normalizeString(input.name) ?? undefined,
            folder_token: normalizeString(input.folder_token) ?? undefined,
            time_zone: normalizeString(input.time_zone) ?? undefined
          }
        })

        return {
          app: unwrapFeishuData(response, 'app')
        }
      }
    },
    {
      name: 'channel_feishu_bitable_get_app',
      description: 'Get Feishu bitable app metadata by app_token',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.app.get({
          path: {
            app_token: input.app_token
          }
        })

        return {
          app: unwrapFeishuData(response, 'app')
        }
      }
    },
    {
      name: 'channel_feishu_bitable_create_table',
      description: 'Create one Feishu bitable table with optional initial field schema',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.appTable.create({
          path: {
            app_token: input.app_token
          },
          data: {
            table: typeof input.table === 'object' && !Array.isArray(input.table)
              ? input.table
              : {
                  name: normalizeString(input.name) ?? undefined,
                  default_view_name: normalizeString(input.default_view_name) ?? undefined,
                  fields: Array.isArray(input.fields) ? input.fields : undefined
                }
          }
        })

        return unwrapFeishuData(response) ?? {}
      }
    },
    {
      name: 'channel_feishu_bitable_list_tables',
      description: 'List tables inside one Feishu bitable app',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.appTable.list({
          path: {
            app_token: input.app_token
          },
          params: {
            page_size: toPositiveInteger(input.page_size, 20),
            page_token: normalizeString(input.page_token) ?? undefined
          }
        })
        const data = unwrapFeishuData(response) ?? {}

        return {
          items: Array.isArray(data.items) ? data.items : [],
          has_more: data.has_more ?? false,
          page_token: data.page_token ?? null,
          total: data.total ?? null
        }
      }
    },
    {
      name: 'channel_feishu_bitable_list_records',
      description: 'List records from one Feishu bitable table',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token', 'table_id']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        if (!input.table_id) {
          throw new Error('Missing required tool input: table_id')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.appTableRecord.list({
          path: {
            app_token: input.app_token,
            table_id: input.table_id
          },
          params: {
            view_id: normalizeString(input.view_id) ?? undefined,
            field_names: normalizeFeishuFieldNames(input.field_names) ?? undefined,
            page_size: toPositiveInteger(input.page_size, 20),
            page_token: normalizeString(input.page_token) ?? undefined,
            user_id_type: normalizeString(input.user_id_type) ?? undefined
          }
        })
        const data = unwrapFeishuData(response) ?? {}

        return {
          items: Array.isArray(data.items) ? data.items : [],
          has_more: data.has_more ?? false,
          page_token: data.page_token ?? null,
          total: data.total ?? null
        }
      }
    },
    {
      name: 'channel_feishu_bitable_record_create',
      description: 'Create one record in a Feishu bitable table',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token', 'table_id', 'fields']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        if (!input.table_id) {
          throw new Error('Missing required tool input: table_id')
        }

        if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) {
          throw new Error('Missing required tool input: fields')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.appTableRecord.create({
          path: {
            app_token: input.app_token,
            table_id: input.table_id
          },
          params: {
            user_id_type: normalizeString(input.user_id_type) ?? undefined
          },
          data: {
            fields: input.fields
          }
        })

        return {
          record: unwrapFeishuData(response, 'record')
        }
      }
    },
    {
      name: 'channel_feishu_bitable_record_update',
      description: 'Update one record in a Feishu bitable table',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['app_token', 'table_id', 'record_id', 'fields']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.app_token) {
          throw new Error('Missing required tool input: app_token')
        }

        if (!input.table_id) {
          throw new Error('Missing required tool input: table_id')
        }

        if (!input.record_id) {
          throw new Error('Missing required tool input: record_id')
        }

        if (!input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) {
          throw new Error('Missing required tool input: fields')
        }

        const { client } = await resolveFeishuWorkspaceClient()
        const response = await client.bitable.v1.appTableRecord.update({
          path: {
            app_token: input.app_token,
            table_id: input.table_id,
            record_id: input.record_id
          },
          params: {
            user_id_type: normalizeString(input.user_id_type) ?? undefined
          },
          data: {
            fields: input.fields
          }
        })

        return {
          record: unwrapFeishuData(response, 'record')
        }
      }
    }
  ]
}

function createServerOpsSpecs(storageRoot, fetchFn, managerProfile) {
  const infrastructureRegistry = createInfrastructureRegistry({ storageRoot })

  return [
    {
      name: 'server_ops_capability_matrix',
      description: 'Describe built-in server operations, channel, and collaboration capabilities',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler() {
        return {
          deployment_target: managerProfile.deployment_target,
          channels: managerProfile.channels,
          registry_policy: managerProfile.registry_policy,
          codex_integration: managerProfile.codex_integration,
          capabilities: [
            {
              capability: 'project_registry',
              available: true,
              tools: ['project_list_registry', 'project_get_registry', 'project_resolve_registry']
            },
            {
              capability: 'project_code_search',
              available: true,
              tools: ['project_search_code']
            },
            {
              capability: 'infrastructure_mapping',
              available: true,
              tools: ['infrastructure_list_registry', 'infrastructure_resolve_registry']
            },
            {
              capability: 'service_probe',
              available: true,
              tools: ['project_probe_endpoint', 'server_ops_service_probe_matrix']
            },
            {
              capability: 'port_inventory',
              available: true,
              tools: ['server_ops_port_matrix']
            },
            {
              capability: 'network_interfaces',
              available: true,
              tools: ['server_ops_network_interfaces']
            },
            {
              capability: 'coworker_channel',
              available: Boolean(managerProfile.channels?.coworker),
              tools: managerProfile.channels?.coworker ? ['coworker_*'] : []
            },
            {
              capability: 'dynamic_scripts',
              available: true,
              tools: ['dynamic_tool_register', 'dynamic_tool_review_queue', 'dynamic_tool_mark_reviewed']
            }
          ]
        }
      }
    },
    {
      name: 'server_ops_port_matrix',
      description: 'Summarize managed listen ports, bound services, and exposed routes',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const filterPort = Number.isInteger(input.listen_port)
          ? input.listen_port
          : Number.parseInt(String(input.listen_port ?? ''), 10)
        const listenPort = Number.isInteger(filterPort) && filterPort > 0 ? filterPort : null
        const services = await infrastructureRegistry.listServices({
          projectKey: input.project_key ?? null,
          status: input.status ?? null,
          env: input.env ?? null
        })
        const routes = await infrastructureRegistry.listRoutes({
          projectKey: input.project_key ?? null,
          status: input.status ?? null,
          exposure: input.exposure ?? null
        })
        const entries = services
          .filter((service) => !listenPort || service.listen_port === listenPort)
          .map((service) => ({
            project_key: service.project_key,
            service_key: service.service_key,
            process_name: service.process_name,
            listen_host: service.listen_host,
            listen_port: service.listen_port,
            runtime_kind: service.runtime_kind,
            manager: service.manager,
            env: service.env,
            healthcheck_url: service.healthcheck_url,
            routes: routes
              .filter((route) => route.service_key === service.service_key)
              .map((route) => ({
                route_key: route.route_key,
                name: route.name,
                path_prefix: route.path_prefix,
                public_url: route.public_url,
                entry_html: route.entry_html,
                static_root: route.static_root,
                exposure: route.exposure
              }))
          }))
          .sort((left, right) => {
            const leftPort = left.listen_port ?? Number.MAX_SAFE_INTEGER
            const rightPort = right.listen_port ?? Number.MAX_SAFE_INTEGER

            if (leftPort !== rightPort) {
              return leftPort - rightPort
            }

            return left.service_key.localeCompare(right.service_key)
          })

        return {
          listen_port: listenPort,
          entries
        }
      }
    },
    {
      name: 'server_ops_service_probe_matrix',
      description: 'Probe registered service healthcheck URLs in one batch',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const services = await infrastructureRegistry.listServices({
          projectKey: input.project_key ?? null,
          status: input.status ?? null,
          env: input.env ?? null
        })
        const runs = []

        for (const service of services) {
          if (!service.healthcheck_url) {
            runs.push({
              project_key: service.project_key,
              service_key: service.service_key,
              healthcheck_url: null,
              ok: null,
              status: null,
              status_text: null,
              error_message: 'Service does not define a healthcheck_url'
            })
            continue
          }

          try {
            const response = await fetchFn(service.healthcheck_url, {
              method: input.method ?? 'GET',
              headers: {
                Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8'
              }
            })
            const body = await response.text()

            runs.push({
              project_key: service.project_key,
              service_key: service.service_key,
              healthcheck_url: service.healthcheck_url,
              ok: response.ok,
              status: response.status,
              status_text: response.statusText,
              body_preview: body.slice(0, 240),
              error_message: null
            })
          } catch (error) {
            runs.push({
              project_key: service.project_key,
              service_key: service.service_key,
              healthcheck_url: service.healthcheck_url,
              ok: false,
              status: null,
              status_text: null,
              body_preview: null,
              error_message: error.message
            })
          }
        }

        return {
          runs
        }
      }
    },
    {
      name: 'server_ops_network_interfaces',
      description: 'Inspect host network interfaces without shelling out to distro-specific commands',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const includeInternal = input.include_internal === true
        const snapshot = networkInterfaces()
        const interfaces = Object.entries(snapshot)
          .map(([name, entries]) => ({
            name,
            addresses: (entries ?? [])
              .filter((entry) => includeInternal || entry.internal !== true)
              .map((entry) => ({
                address: entry.address,
                family: entry.family,
                cidr: entry.cidr ?? null,
                netmask: entry.netmask ?? null,
                mac: entry.mac ?? null,
                internal: entry.internal === true
              }))
          }))
          .filter((entry) => entry.addresses.length > 0)

        return {
          interfaces
        }
      }
    }
  ]
}

function createInfrastructureSpecs(storageRoot) {
  const infrastructureRegistry = createInfrastructureRegistry({ storageRoot })

  return [
    {
      name: 'infrastructure_list_registry',
      description: 'List infrastructure registry projects, services, and routes',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return {
          projects: await infrastructureRegistry.listProjects({
            status: input.status ?? null
          }),
          services: await infrastructureRegistry.listServices({
            projectKey: input.project_key ?? null,
            status: input.status ?? null,
            env: input.env ?? null
          }),
          routes: await infrastructureRegistry.listRoutes({
            projectKey: input.project_key ?? null,
            serviceKey: input.service_key ?? null,
            status: input.status ?? null,
            exposure: input.exposure ?? null
          })
        }
      }
    },
    {
      name: 'infrastructure_resolve_registry',
      description: 'Resolve ports, paths, routes, and HTML entries against the infrastructure registry',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        const query = normalizeString(input.query)?.toLowerCase() ?? null
        const port = Number.isInteger(input.listen_port)
          ? input.listen_port
          : Number.parseInt(String(input.listen_port ?? ''), 10)
        const listenPort = Number.isInteger(port) && port > 0 ? port : null
        const pathPrefix = normalizeString(input.path_prefix)
        const entryHtml = normalizeString(input.entry_html)
        const projectKey = normalizeString(input.project_key)

        const projects = (await infrastructureRegistry.listProjects())
          .filter((project) => !projectKey || project.project_key === projectKey)
          .filter((project) =>
            !query
            || includesQuery(project.project_key, query)
            || includesQuery(project.name, query)
            || includesQuery(project.role, query)
            || includesQuery(project.source_root, query)
            || includesQuery(project.runtime_root, query)
            || includesQuery(project.publish_root, query)
            || includesQuery(project.public_base_path, query)
          )

        const services = (await infrastructureRegistry.listServices({
          projectKey
        }))
          .filter((service) =>
            (!listenPort || service.listen_port === listenPort)
            && (!entryHtml || service.entry_html === entryHtml)
            && (
              !query
              || includesQuery(service.service_key, query)
              || includesQuery(service.name, query)
              || includesQuery(service.role, query)
              || includesQuery(service.process_name, query)
              || includesQuery(service.public_base_path, query)
              || includesQuery(service.entry_html, query)
              || includesQuery(service.healthcheck_url, query)
            )
          )

        const routes = (await infrastructureRegistry.listRoutes({
          projectKey
        }))
          .filter((route) =>
            (!pathPrefix || route.path_prefix === pathPrefix)
            && (!entryHtml || route.entry_html === entryHtml)
            && (
              !query
              || includesQuery(route.route_key, query)
              || includesQuery(route.name, query)
              || includesQuery(route.path_prefix, query)
              || includesQuery(route.public_url, query)
              || includesQuery(route.upstream_url, query)
              || includesQuery(route.static_root, query)
              || includesQuery(route.entry_html, query)
            )
          )

        return {
          query: input.query ?? null,
          listen_port: listenPort,
          path_prefix: pathPrefix,
          entry_html: entryHtml,
          matches: {
            projects,
            services,
            routes
          }
        }
      }
    }
  ]
}

function createDynamicToolBuiltinSpecs(storageRoot) {
  const dynamicToolRegistry = createDynamicToolRegistry({ storageRoot })

  return [
    {
      name: 'dynamic_tool_list',
      description: 'List registered dynamic tools and their lifecycle metadata',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return {
          tools: await dynamicToolRegistry.listTools({
            category: input.category ?? null,
            lifecycle: input.lifecycle ?? null,
            reviewStatus: input.review_status ?? null
          })
        }
      }
    },
    {
      name: 'dynamic_tool_review_queue',
      description: 'List dynamic tools waiting for maintenance review',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler() {
        return {
          tools: await dynamicToolRegistry.listReviewQueue()
        }
      }
    },
    {
      name: 'dynamic_tool_register',
      description: 'Register one temporary or permanent dynamic tool command',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['tool_name', 'description', 'command']
      },
      side_effects: true,
      async handler(input = {}) {
        return {
          tool: await dynamicToolRegistry.registerTool({
            category: input.category ?? inferToolCategory(input.tool_name ?? ''),
            ...input
          })
        }
      }
    },
    {
      name: 'dynamic_tool_mark_reviewed',
      description: 'Update lifecycle or review state for one dynamic tool',
      permission_class: 'dangerous',
      input_schema: {
        type: 'object',
        required: ['tool_name']
      },
      side_effects: true,
      async handler(input = {}) {
        if (!input.tool_name) {
          throw new Error('Missing required tool input: tool_name')
        }

        return {
          tool: await dynamicToolRegistry.markToolReviewed(input.tool_name, {
            lifecycle: input.lifecycle ?? null,
            reviewStatus: input.review_status ?? null,
            reviewNotes: input.review_notes ?? null
          })
        }
      }
    }
  ]
}

function buildDynamicToolSpec({
  entry,
  storageRoot,
  workspaceRoot
}) {
  return {
    name: entry.tool_name,
    description: entry.description,
    category: normalizeToolCategory(entry.category, inferToolCategory(entry.tool_name)),
    permission_class: entry.permission_class,
    input_schema: entry.input_schema,
    side_effects: entry.side_effects,
    async handler(input = {}, { signal } = {}) {
      const shell = String(
        process.env.NEWAGENT_SHELL
        ?? process.env.SHELL
        ?? '/bin/sh'
      ).trim() || '/bin/sh'
      const cwd = entry.cwd ? normalizePath(workspaceRoot, entry.cwd) : workspaceRoot
      const env = {
        ...process.env,
        NEWAGENT_DYNAMIC_TOOL_INPUT: JSON.stringify(input),
        NEWAGENT_DYNAMIC_TOOL_NAME: entry.tool_name,
        NEWAGENT_DYNAMIC_TOOL_STORAGE_ROOT: storageRoot,
        NEWAGENT_DYNAMIC_TOOL_WORKSPACE_ROOT: workspaceRoot
      }
      const { stdout, stderr } = await execFileAsync(shell, ['-lc', entry.command], {
        cwd,
        env,
        ...(signal ? { signal } : {}),
        timeout: Number.isInteger(input.timeout_ms) ? input.timeout_ms : 60000,
        maxBuffer: 1024 * 1024 * 4
      })

      const parsed_output = tryParseJsonOutput(stdout)

      return {
        cwd,
        command: entry.command,
        stdout,
        stderr,
        parsed_output,
        lifecycle: entry.lifecycle,
        review_status: entry.review_status,
        restart_required: entry.restart_required,
        restart_strategy: entry.restart_strategy,
        restart_time_hint: entry.restart_time_hint
      }
    }
  }
}

function createToolCatalogSpecs({
  listCatalogEntries,
  getCatalogEntry
}) {
  return [
    {
      name: 'tool_catalog_list',
      description: 'List the internal tool catalog by category, risk, or source',
      category: 'internal',
      permission_class: 'safe',
      input_schema: {
        type: 'object'
      },
      side_effects: false,
      async handler(input = {}) {
        return {
          tools: await listCatalogEntries(input)
        }
      }
    },
    {
      name: 'tool_catalog_get',
      description: 'Read one tool specification and its metadata from the internal catalog',
      category: 'internal',
      permission_class: 'safe',
      input_schema: {
        type: 'object',
        required: ['tool_name']
      },
      side_effects: false,
      async handler(input = {}) {
        if (!input.tool_name) {
          throw new Error('Missing required tool input: tool_name')
        }

        const tool = await getCatalogEntry(input.tool_name)

        if (!tool) {
          throw new Error(`Unknown tool: ${input.tool_name}`)
        }

        return {
          tool
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
  hookBus = null,
  managerProfile = createRemoteServerManagerProfile(),
  feishuApiClientFactory = createFeishuApiClient,
  feishuConfigDescriber = describeFeishuChannelConfig,
  feishuUserAuthManager = null
}) {
  if (typeof fetchFn !== 'function') {
    throw new Error('A fetch implementation is required for project probe tools')
  }

  const sessionStore = createSessionStore({ storageRoot })
  const runtimeHookBus = hookBus ?? createHookBus({ storageRoot })
  const debugRuntime = createDebugRuntime({ storageRoot })
  const dynamicToolRegistry = createDynamicToolRegistry({ storageRoot })
  let specs = []

  async function listCatalogEntries(input = {}) {
    const staticEntries = filterToolDescriptors(
      specs.map((spec) => describeToolSpec(spec)),
      input
    )
    const dynamicEntries = input.include_dynamic === false
      ? []
      : filterToolDescriptors(
        (await dynamicToolRegistry.listTools({
          category: input.category ?? null,
          lifecycle: input.lifecycle ?? null,
          reviewStatus: input.review_status ?? null
        })).map((entry) => describeDynamicTool(entry)),
        input
      )

    return [...staticEntries, ...dynamicEntries]
  }

  async function getCatalogEntry(toolName) {
    const staticSpec = specs.find((spec) => spec.name === toolName)

    if (staticSpec) {
      return describeToolSpec(staticSpec)
    }

    const dynamicEntry = await dynamicToolRegistry.getTool(toolName)
    return dynamicEntry ? describeDynamicTool(dynamicEntry) : null
  }

  specs = withToolCategory(createDefaultSpecs(workspaceRoot), 'core')
    .concat(withToolCategory(createProjectSpecs(storageRoot, fetchFn, pm2Command), 'project'))
    .concat(withToolCategory(createInfrastructureSpecs(storageRoot), 'infrastructure'))
    .concat(withToolCategory(createServerOpsSpecs(storageRoot, fetchFn, managerProfile), 'server_ops'))
    .concat(withToolCategory(createNewsSpecs(storageRoot, fetchFn), 'news'))
    .concat(withToolCategory(createChannelSpecs({
      storageRoot,
      workspaceRoot,
      fetchFn,
      feishuApiClientFactory,
      feishuConfigDescriber,
      feishuUserAuthManager
    }), 'channel'))
    .concat(withToolCategory(createWebSpecs(fetchFn), 'web'))
    .concat(withToolCategory(createCodexSpecs(workspaceRoot, codexCommand), 'codex'))
    .concat(withToolCategory(createDynamicToolBuiltinSpecs(storageRoot), 'dynamic_tool'))
    .concat(withToolCategory(createToolCatalogSpecs({
      listCatalogEntries,
      getCatalogEntry
    }), 'internal'))
    .concat(withToolCategory([
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
  ], 'debug'))
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
    return specs.map((spec) => describeToolSpec(spec))
  }

  async function resolveToolSpec(toolName) {
    const staticSpec = toolMap.get(toolName)

    if (staticSpec) {
      return staticSpec
    }

    const dynamicEntry = await dynamicToolRegistry.getTool(toolName)

    if (!dynamicEntry || ['pending_review', 'rejected', 'retired'].includes(dynamicEntry.review_status)) {
      return null
    }

    return buildDynamicToolSpec({
      entry: dynamicEntry,
      storageRoot,
      workspaceRoot
    })
  }

  async function executeTool({
    sessionId = null,
    stepId = null,
    toolName,
    input = {},
    abortSignal = null
  }) {
    const spec = await resolveToolSpec(toolName)

    if (!spec) {
      const dynamicEntry = toolMap.has(toolName)
        ? null
        : await dynamicToolRegistry.getTool(toolName)

      if (dynamicEntry?.review_status === 'pending_review') {
        return {
          status: 'error',
          tool_name: toolName,
          permission_class: dynamicEntry.permission_class ?? null,
          error: {
            message: `Dynamic tool is pending review: ${toolName}`,
            code: 'dynamic_tool_pending_review'
          }
        }
      }

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
        stepId,
        signal: abortSignal
      })

      if (!toolMap.has(toolName)) {
        await dynamicToolRegistry.recordToolUsage(toolName)
      }

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
      if (isAbortError(error)) {
        if (sessionId) {
          await sessionStore.appendTimelineEvent(sessionId, {
            stepId,
            kind: 'tool_aborted',
            payload: {
              tool_name: toolName,
              message: error.message
            }
          })
        }
        await emitHook({
          name: 'tool.aborted',
          sessionId,
          payload: {
            step_id: stepId ?? null,
            tool_name: toolName,
            permission_class: spec.permission_class,
            message: error.message
          }
        })

        return {
          status: 'aborted',
          tool_name: toolName,
          permission_class: spec.permission_class,
          error: {
            message: error.message,
            code: 'tool_aborted'
          }
        }
      }

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
