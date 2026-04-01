import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from '../session/session-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createToolRuntime } from './tool-runtime.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-tool-runtime-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const fakeCodex = join(root, 'fake-codex')
  const fakePm2 = join(root, 'fake-pm2')
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(
    fakeCodex,
    '#!/bin/sh\nprintf "FAKE_CODEX %s\\n" "$*"\n',
    'utf8'
  )
  await writeFile(
    fakePm2,
    '#!/bin/sh\nprintf \'[{"name":"uwillberich-api","pid":12345,"pm2_env":{"status":"online","restart_time":7}}]\\n\'\n',
    'utf8'
  )
  await chmod(fakeCodex, 0o755)
  await chmod(fakePm2, 0o755)
  const sessionStore = createSessionStore({ storageRoot })
  const hookBus = createHookBus({ storageRoot })
  const toolRuntime = createToolRuntime({
    storageRoot,
    workspaceRoot,
    hookBus,
    codexCommand: fakeCodex,
    pm2Command: fakePm2,
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `stub probe for ${url}`
      }
    })
  })

  return {
    root,
    storageRoot,
    workspaceRoot,
    fakeCodex,
    fakePm2,
    sessionStore,
    hookBus,
    toolRuntime
  }
}

test('listToolSpecs exposes the minimal registered tool surface', async () => {
  const { toolRuntime } = await createHarness()
  const tools = toolRuntime.listToolSpecs()

  assert.equal(tools.some((tool) => tool.name === 'read_file'), true)
  assert.equal(tools.some((tool) => tool.name === 'list_files'), true)
  assert.equal(tools.some((tool) => tool.name === 'write_file'), true)
  assert.equal(tools.some((tool) => tool.name === 'run_shell_command'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_list_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_get_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_pm2_status'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_probe_endpoint'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_check_paths'), true)
  assert.equal(tools.some((tool) => tool.name === 'web_extract_scrapling'), true)
  assert.equal(tools.some((tool) => tool.name === 'codex_review_workspace'), true)
  assert.equal(tools.some((tool) => tool.name === 'codex_repair_workspace'), true)
  assert.equal(tools.some((tool) => tool.name === 'debug_session_get'), true)
  assert.equal(tools.some((tool) => tool.name === 'debug_task_patch'), true)
})

test('executeTool lists and reads registered server projects through safe project tools', async () => {
  const { sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Project registry inspection',
    projectKey: 'remote-server-manager',
    userRequest: 'List registered remote server projects'
  })

  const listResult = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_list_registry',
    input: {}
  })

  assert.equal(listResult.status, 'ok')
  assert.equal(Array.isArray(listResult.output.projects), true)
  assert.equal(listResult.output.projects.length, 0)
})

test('executeTool can probe a registered project endpoint through the safe project probe tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-tool-runtime-project-probe-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const fakeCodex = join(root, 'fake-codex')
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(fakeCodex, '#!/bin/sh\nprintf "FAKE_CODEX %s\\n" "$*"\n', 'utf8')
  await chmod(fakeCodex, 0o755)
  const sessionStore = createSessionStore({ storageRoot })
  const toolRuntime = createToolRuntime({
    storageRoot,
    workspaceRoot,
    codexCommand: fakeCodex,
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    })
  })
  const created = await sessionStore.createSession({
    title: 'Project endpoint probe',
    projectKey: 'remote-server-manager',
    userRequest: 'Check the stock API endpoint'
  })

  const registryTool = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_get_registry',
    input: {
      project_key: 'uwillberich'
    }
  })

  assert.equal(registryTool.status, 'error')

  const { createProjectRegistry } = await import('../projects/project-registry.js')
  const projectRegistry = createProjectRegistry({ storageRoot })
  await projectRegistry.seedProjects([
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      tier: 'major',
      role: 'stock ops',
      source_root: '/root/uwillberich',
      runtime_root: '/root/.uwillberich',
      publish_root: '/opt/agent-sites/chaochao/current',
      public_base_path: '/apps/chaochao/',
      pm2_name: 'uwillberich-api',
      service_endpoint: 'http://127.0.0.1:3100/api/health',
      status: 'active'
    }
  ])

  const getResult = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_get_registry',
    input: {
      project_key: 'uwillberich'
    }
  })
  const probeResult = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_probe_endpoint',
    input: {
      project_key: 'uwillberich'
    }
  })

  assert.equal(getResult.status, 'ok')
  assert.equal(getResult.output.project.project_key, 'uwillberich')
  assert.equal(probeResult.status, 'ok')
  assert.equal(probeResult.output.ok, true)
  assert.match(probeResult.output.body_preview, /health ok/)
  assert.equal(probeResult.output.error_message, null)
})

test('executeTool degrades probe network failures into a structured result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-tool-runtime-project-probe-fail-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const fakeCodex = join(root, 'fake-codex')
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(fakeCodex, '#!/bin/sh\nprintf "FAKE_CODEX %s\\n" "$*"\n', 'utf8')
  await chmod(fakeCodex, 0o755)
  const sessionStore = createSessionStore({ storageRoot })
  const toolRuntime = createToolRuntime({
    storageRoot,
    workspaceRoot,
    codexCommand: fakeCodex,
    fetchFn: async () => {
      throw new Error('connect ECONNRESET 127.0.0.1:7701')
    }
  })
  const created = await sessionStore.createSession({
    title: 'Project endpoint probe failure',
    projectKey: 'remote-server-manager',
    userRequest: 'Check the gent-mesh endpoint'
  })

  const { createProjectRegistry } = await import('../projects/project-registry.js')
  const projectRegistry = createProjectRegistry({ storageRoot })
  await projectRegistry.seedProjects([
    {
      project_key: 'gent-mesh',
      name: 'gent-mesh',
      tier: 'major',
      role: 'mesh',
      source_root: '/root/gent-mesh',
      runtime_root: '/root/gent-mesh',
      publish_root: null,
      public_base_path: null,
      pm2_name: 'gent-mesh-spoke',
      service_endpoint: 'http://127.0.0.1:7701/',
      status: 'active'
    }
  ])

  const probeResult = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_probe_endpoint',
    input: {
      project_key: 'gent-mesh'
    }
  })

  assert.equal(probeResult.status, 'ok')
  assert.equal(probeResult.output.ok, false)
  assert.equal(probeResult.output.status, null)
  assert.match(probeResult.output.error_message, /ECONNRESET/)
})

test('executeTool can inspect registered project paths through the safe path-check tool', async () => {
  const { storageRoot, workspaceRoot, sessionStore, toolRuntime } = await createHarness()
  const sourceRoot = join(workspaceRoot, 'source')
  const publishRoot = join(workspaceRoot, 'publish')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(publishRoot, { recursive: true })

  const { createProjectRegistry } = await import('../projects/project-registry.js')
  const projectRegistry = createProjectRegistry({ storageRoot })
  await projectRegistry.registerProject({
    project_key: 'demo-project',
    name: 'demo-project',
    tier: 'major',
    role: 'demo',
    source_root: sourceRoot,
    runtime_root: join(workspaceRoot, 'runtime'),
    publish_root: publishRoot,
    status: 'active'
  })

  const created = await sessionStore.createSession({
    title: 'Inspect project paths',
    projectKey: 'remote-server-manager',
    userRequest: 'Check project directories'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_check_paths',
    input: {
      project_key: 'demo-project'
    }
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.output.project_key, 'demo-project')
  assert.equal(result.output.source_root.exists, true)
  assert.equal(result.output.publish_root.exists, true)
  assert.equal(result.output.runtime_root.exists, false)
})

test('executeTool can inspect registered PM2 process status through the safe PM2 tool', async () => {
  const { storageRoot, sessionStore, toolRuntime } = await createHarness()

  const { createProjectRegistry } = await import('../projects/project-registry.js')
  const projectRegistry = createProjectRegistry({ storageRoot })
  await projectRegistry.registerProject({
    project_key: 'uwillberich',
    name: 'uwillberich',
    tier: 'major',
    role: 'stock ops',
    source_root: '/root/uwillberich',
    runtime_root: '/root/.uwillberich',
    publish_root: '/opt/agent-sites/chaochao/current',
    pm2_name: 'uwillberich-api',
    status: 'active'
  })
  const created = await sessionStore.createSession({
    title: 'Inspect PM2 process',
    projectKey: 'remote-server-manager',
    userRequest: 'Check PM2 state'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_pm2_status',
    input: {
      project_key: 'uwillberich'
    }
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.output.project_key, 'uwillberich')
  assert.equal(result.output.pm2_name, 'uwillberich-api')
  assert.equal(result.output.found, true)
  assert.equal(result.output.status, 'online')
})

test('executeTool runs a safe tool and appends tool timeline events', async () => {
  const { workspaceRoot, sessionStore, hookBus, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Safe tool execution',
    projectKey: 'newagent',
    userRequest: 'Read a file through the tool runtime'
  })

  const filePath = join(workspaceRoot, 'note.txt')
  await writeFile(filePath, 'hello from newagent\n', 'utf8')

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'read_file',
    input: {
      path: filePath
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'ok')
  assert.equal(result.tool_name, 'read_file')
  assert.equal(result.output.content, 'hello from newagent\n')
  assert.equal(loaded.timeline.at(-2).kind, 'tool_requested')
  assert.equal(loaded.timeline.at(-1).kind, 'tool_completed')
  const hooks = await hookBus.listEvents({
    sessionId: created.session.id
  })
  assert.ok(hooks.some((event) => event.name === 'tool.requested'))
  assert.ok(hooks.some((event) => event.name === 'tool.completed'))
})

test('executeTool triggers approval flow instead of running a dangerous tool', async () => {
  const { sessionStore, hookBus, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Dangerous tool execution',
    projectKey: 'newagent',
    userRequest: 'Pause before writing a tracked file'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Edit one file',
        kind: 'implementation'
      }
    ]
  })
  const snapshot = await sessionStore.loadSession(created.session.id)

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: snapshot.plan_steps[0].id,
    toolName: 'write_file',
    input: {
      path: join('/tmp', 'dangerous.txt'),
      content: 'blocked until approval'
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.permission_class, 'dangerous')
  assert.equal(result.approval.status, 'pending')
  assert.equal(loaded.session.status, 'waiting_approval')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.timeline.at(-1).kind, 'approval_requested')
  const hooks = await hookBus.listEvents({
    sessionId: created.session.id,
    name: 'tool.approval.waiting'
  })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].payload.tool_name, 'write_file')
})

test('executeTool runs an approved dangerous tool on retry instead of requesting approval again', async () => {
  const { workspaceRoot, sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Approved dangerous execution',
    projectKey: 'newagent',
    userRequest: 'Resume the same dangerous tool after approval'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write one approved file',
        kind: 'implementation'
      }
    ]
  })
  const snapshot = await sessionStore.loadSession(created.session.id)
  const targetPath = join(workspaceRoot, 'approved.txt')

  const firstAttempt = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: snapshot.plan_steps[0].id,
    toolName: 'write_file',
    input: {
      path: targetPath,
      content: 'approved write\n'
    }
  })

  await sessionStore.resolveApproval(
    created.session.id,
    firstAttempt.approval.id,
    'approved',
    {
      resolvedBy: 'user'
    }
  )

  const secondAttempt = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: snapshot.plan_steps[0].id,
    toolName: 'write_file',
    input: {
      path: targetPath,
      content: 'approved write\n'
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)
  const content = await readFile(targetPath, 'utf8')

  assert.equal(secondAttempt.status, 'ok')
  assert.equal(content, 'approved write\n')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.timeline.at(-1).kind, 'tool_completed')
})

test('executeTool normalizes unknown-tool failures without throwing', async () => {
  const { toolRuntime } = await createHarness()

  const result = await toolRuntime.executeTool({
    toolName: 'missing_tool',
    input: {}
  })

  assert.equal(result.status, 'error')
  assert.equal(result.tool_name, 'missing_tool')
  assert.match(result.error.message, /Unknown tool/)
})

test('executeTool runs a safe semantic debug tool against session state', async () => {
  const { sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Safe semantic debug tool',
    projectKey: 'newagent',
    userRequest: 'Inspect the session state through a debug tool'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'debug_session_get',
    input: {}
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.output.id, created.session.id)
  assert.equal(result.output.status, 'planning')
})

test('executeTool runs the codex review adapter as a safe tool', async () => {
  const { sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Codex review adapter',
    projectKey: 'newagent',
    userRequest: 'Allow the manager to call codex for review'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'codex_review_workspace',
    input: {
      instruction: 'Review the current repository state.',
      json: true
    }
  })

  assert.equal(result.status, 'ok')
  assert.match(result.output.stdout, /FAKE_CODEX exec review --uncommitted --json Review the current repository state\./)
})

test('executeTool returns a structured unavailable result when Scrapling worker is not configured', async () => {
  const { sessionStore, hookBus, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Scrapling unavailable',
    projectKey: 'remote-server-manager',
    userRequest: 'Try the Scrapling extraction tool without a worker'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'web_extract_scrapling',
    input: {
      url: 'https://example.com'
    }
  })
  const hooks = await hookBus.listEvents({
    sessionId: created.session.id,
    name: 'tool.completed'
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.output.ok, false)
  assert.equal(result.output.worker.configured, false)
  assert.match(result.output.error_message, /not configured/i)
  assert.equal(hooks.at(-1)?.payload.tool_name, 'web_extract_scrapling')
})

test('executeTool calls the configured Scrapling worker and normalizes the response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-tool-runtime-scrapling-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const fakeCodex = join(root, 'fake-codex')
  const fakePm2 = join(root, 'fake-pm2')
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(fakeCodex, '#!/bin/sh\nprintf "FAKE_CODEX %s\\n" "$*"\n', 'utf8')
  await writeFile(fakePm2, '#!/bin/sh\nprintf \'[]\\n\'\n', 'utf8')
  await chmod(fakeCodex, 0o755)
  await chmod(fakePm2, 0o755)

  const requests = []
  const hookBus = createHookBus({ storageRoot })
  const sessionStore = createSessionStore({ storageRoot })
  const originalBaseUrl = process.env.NEWAGENT_SCRAPLING_BASE_URL
  process.env.NEWAGENT_SCRAPLING_BASE_URL = 'http://127.0.0.1:7771/'

  try {
    const toolRuntime = createToolRuntime({
      storageRoot,
      workspaceRoot,
      codexCommand: fakeCodex,
      pm2Command: fakePm2,
      hookBus,
      fetchFn: async (url, options = {}) => {
        requests.push({
          url,
          method: options.method,
          headers: options.headers,
          body: JSON.parse(options.body)
        })

        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          async json() {
            return {
              ok: true,
              final_url: 'https://example.com/final',
              title: 'Example Title',
              content: '# Example markdown',
              links: ['https://example.com/a'],
              metadata: {
                fetched_via: 'dynamic'
              }
            }
          }
        }
      }
    })

    const created = await sessionStore.createSession({
      title: 'Scrapling extract',
      projectKey: 'remote-server-manager',
      userRequest: 'Extract a remote web page through Scrapling'
    })

    const result = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'web_extract_scrapling',
      input: {
        url: 'https://example.com',
        mode: 'dynamic',
        selector: '#main',
        output: 'markdown',
        include_links: true,
        wait_for: 'network_idle'
      }
    })
    const hooks = await hookBus.listEvents({
      sessionId: created.session.id,
      name: 'tool.completed'
    })

    assert.equal(result.status, 'ok')
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'http://127.0.0.1:7771/v1/extract')
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].body.url, 'https://example.com')
    assert.equal(requests[0].body.mode, 'dynamic')
    assert.equal(requests[0].body.selector, '#main')
    assert.equal(requests[0].body.output, 'markdown')
    assert.equal(requests[0].body.include_links, true)
    assert.equal(requests[0].body.wait_for, 'network_idle')
    assert.equal(result.output.ok, true)
    assert.equal(result.output.final_url, 'https://example.com/final')
    assert.equal(result.output.title, 'Example Title')
    assert.equal(result.output.content, '# Example markdown')
    assert.deepEqual(result.output.links, ['https://example.com/a'])
    assert.equal(result.output.worker.configured, true)
    assert.equal(hooks.at(-1)?.payload.tool_name, 'web_extract_scrapling')
  } finally {
    if (originalBaseUrl === undefined) {
      delete process.env.NEWAGENT_SCRAPLING_BASE_URL
    } else {
      process.env.NEWAGENT_SCRAPLING_BASE_URL = originalBaseUrl
    }
  }
})

test('executeTool routes semantic debug mutation through approval flow', async () => {
  const { sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Dangerous semantic debug tool',
    projectKey: 'newagent',
    userRequest: 'Pause before patching the task state'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'debug_task_patch',
    input: {
      patch: {
        status: 'blocked'
      },
      reason: 'manual_debug_patch'
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.permission_class, 'dangerous')
  assert.equal(result.approval.tool_name, 'debug_task_patch')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.timeline.at(-1).kind, 'approval_requested')
})

test('executeTool routes codex repair through approval flow instead of mutating immediately', async () => {
  const { sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Codex repair adapter',
    projectKey: 'newagent',
    userRequest: 'Pause before codex applies a repair'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Repair one project issue',
        kind: 'implementation'
      }
    ]
  })
  const snapshot = await sessionStore.loadSession(created.session.id)

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: snapshot.plan_steps[0].id,
    toolName: 'codex_repair_workspace',
    input: {
      instruction: 'Fix the current workspace issue.'
    }
  })

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.permission_class, 'dangerous')
  assert.equal(result.approval.tool_name, 'codex_repair_workspace')
})
