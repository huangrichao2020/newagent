import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from '../session/session-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createToolRuntime } from './tool-runtime.js'

async function createHarness(options = {}) {
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
    }),
    ...options
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
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  assert.equal(tools.some((tool) => tool.name === 'read_file'), true)
  assert.equal(tools.some((tool) => tool.name === 'list_files'), true)
  assert.equal(tools.some((tool) => tool.name === 'write_file'), true)
  assert.equal(tools.some((tool) => tool.name === 'run_shell_command'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_list_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_get_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_resolve_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_search_code'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_pm2_status'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_probe_endpoint'), true)
  assert.equal(tools.some((tool) => tool.name === 'project_check_paths'), true)
  assert.equal(tools.some((tool) => tool.name === 'infrastructure_list_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'infrastructure_resolve_registry'), true)
  assert.equal(tools.some((tool) => tool.name === 'server_ops_capability_matrix'), true)
  assert.equal(tools.some((tool) => tool.name === 'server_ops_port_matrix'), true)
  assert.equal(tools.some((tool) => tool.name === 'server_ops_service_probe_matrix'), true)
  assert.equal(tools.some((tool) => tool.name === 'server_ops_network_interfaces'), true)
  assert.equal(tools.some((tool) => tool.name === 'news_source_list'), true)
  assert.equal(tools.some((tool) => tool.name === 'news_source_register'), true)
  assert.equal(tools.some((tool) => tool.name === 'news_general_collect'), true)
  assert.equal(tools.some((tool) => tool.name === 'news_stock_collect'), true)
  assert.equal(tools.some((tool) => tool.name === 'news_hot_collect'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_scope_list'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_capability_matrix'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_doc_create'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_doc_get'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_doc_write'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_drive_list'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_drive_create_folder'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_drive_move'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_file_upload'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_wiki_list_spaces'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_wiki_create_node'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_wiki_move_node'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_wiki_move_doc'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_wiki_update_title'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_create_app'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_get_app'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_create_table'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_list_tables'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_list_records'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_record_create'), true)
  assert.equal(tools.some((tool) => tool.name === 'channel_feishu_bitable_record_update'), true)
  assert.equal(tools.some((tool) => tool.name === 'web_extract_scrapling'), true)
  assert.equal(tools.some((tool) => tool.name === 'codex_review_workspace'), true)
  assert.equal(tools.some((tool) => tool.name === 'codex_repair_workspace'), true)
  assert.equal(tools.some((tool) => tool.name === 'dynamic_tool_list'), true)
  assert.equal(tools.some((tool) => tool.name === 'dynamic_tool_register'), true)
  assert.equal(tools.some((tool) => tool.name === 'dynamic_tool_review_queue'), true)
  assert.equal(tools.some((tool) => tool.name === 'dynamic_tool_mark_reviewed'), true)
  assert.equal(tools.some((tool) => tool.name === 'tool_catalog_list'), true)
  assert.equal(tools.some((tool) => tool.name === 'tool_catalog_get'), true)
  assert.equal(tools.some((tool) => tool.name === 'debug_session_get'), true)
  assert.equal(tools.some((tool) => tool.name === 'debug_task_patch'), true)
  assert.equal(byName.get('read_file')?.category, 'core')
  assert.equal(byName.get('project_get_registry')?.category, 'project')
  assert.equal(byName.get('server_ops_port_matrix')?.category, 'server_ops')
  assert.equal(byName.get('news_stock_collect')?.category, 'news')
  assert.equal(byName.get('channel_feishu_scope_list')?.category, 'channel')
  assert.equal(byName.get('dynamic_tool_register')?.category, 'dynamic_tool')
  assert.equal(byName.get('tool_catalog_list')?.category, 'internal')
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

test('executeTool can resolve projects and search project code within registered roots', async () => {
  const { storageRoot, workspaceRoot, sessionStore, toolRuntime } = await createHarness()
  const sourceRoot = join(workspaceRoot, 'proj-source')
  const runtimeRoot = join(workspaceRoot, 'proj-runtime')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    join(sourceRoot, 'service.js'),
    'export function buildSummary() { return "ok" }\n',
    'utf8'
  )
  await writeFile(
    join(runtimeRoot, 'worker.js'),
    'const buildSummary = () => "runtime"\n',
    'utf8'
  )

  const { createProjectRegistry } = await import('../projects/project-registry.js')
  const projectRegistry = createProjectRegistry({ storageRoot })
  await projectRegistry.registerProject({
    project_key: 'demo-project',
    name: 'Demo Project',
    tier: 'major',
    role: 'demo runtime',
    source_root: sourceRoot,
    runtime_root: runtimeRoot,
    publish_root: null,
    public_base_path: '/demo/',
    pm2_name: 'demo-project-web',
    service_endpoint: 'http://127.0.0.1:3999/health',
    status: 'active'
  })

  const created = await sessionStore.createSession({
    title: 'Resolve and search project',
    projectKey: 'remote-server-manager',
    userRequest: '确认 demo 项目和 buildSummary 调用线索'
  })

  const resolved = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_resolve_registry',
    input: {
      query: 'demo-project-web'
    }
  })
  const searched = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'project_search_code',
    input: {
      project_key: 'demo-project',
      pattern: 'buildSummary'
    }
  })

  assert.equal(resolved.status, 'ok')
  assert.equal(resolved.output.matches.length, 1)
  assert.equal(resolved.output.matches[0].project_key, 'demo-project')
  assert.equal(searched.status, 'ok')
  assert.equal(searched.output.results.length, 2)
  assert.equal(searched.output.results.some((entry) => entry.scope === 'source'), true)
  assert.equal(searched.output.results.some((entry) => entry.scope === 'runtime'), true)
  assert.match(searched.output.results[0].preview, /buildSummary/)
})

test('executeTool can resolve infrastructure registry matches for ports and path prefixes', async () => {
  const { storageRoot, sessionStore, toolRuntime } = await createHarness()
  const { createInfrastructureRegistry } = await import('../registry/infrastructure-registry.js')
  const infrastructureRegistry = createInfrastructureRegistry({ storageRoot })
  await infrastructureRegistry.seedRegistry({
    projects: [
      {
        project_key: 'novel-evolution',
        name: 'novel-evolution',
        tier: 'major',
        role: 'novel app',
        source_root: '/root/novel-evolution',
        runtime_root: '/root/novel-evolution',
        publish_root: '/opt/agent-sites/novel/current',
        public_base_path: '/novel/'
      }
    ],
    services: [
      {
        service_key: 'novel-evolution-web',
        project_key: 'novel-evolution',
        name: 'novel-evolution-web',
        role: 'web',
        runtime_kind: 'pm2',
        process_name: 'novel-evolution',
        listen_port: 3800,
        healthcheck_url: 'http://127.0.0.1:3800/'
      }
    ],
    routes: [
      {
        route_key: 'chaochao-public',
        project_key: 'novel-evolution',
        service_key: 'novel-evolution-web',
        name: 'chaochao-public',
        route_kind: 'nginx',
        path_prefix: '/apps/chaochao/',
        public_url: 'https://example.com/apps/chaochao/',
        entry_html: '/opt/agent-sites/chaochao/current/index.html'
      }
    ]
  })
  const created = await sessionStore.createSession({
    title: 'Resolve infrastructure registry',
    projectKey: 'remote-server-manager',
    userRequest: '确认 3800 和 /apps/chaochao/ 分别归谁'
  })

  const result = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'infrastructure_resolve_registry',
    input: {
      listen_port: 3800,
      path_prefix: '/apps/chaochao/'
    }
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.output.matches.services.length, 1)
  assert.equal(result.output.matches.routes.length, 1)
  assert.equal(result.output.matches.services[0].service_key, 'novel-evolution-web')
  assert.equal(result.output.matches.routes[0].route_key, 'chaochao-public')
})

test('executeTool can summarize server ops capabilities and port-service mappings', async () => {
  const { storageRoot, sessionStore, toolRuntime } = await createHarness()
  const { createInfrastructureRegistry } = await import('../registry/infrastructure-registry.js')
  const infrastructureRegistry = createInfrastructureRegistry({ storageRoot })
  await infrastructureRegistry.seedRegistry({
    projects: [
      {
        project_key: 'uwillberich',
        name: 'uwillberich',
        tier: 'major',
        role: 'stock ops',
        source_root: '/root/uwillberich',
        runtime_root: '/root/.uwillberich',
        publish_root: '/opt/agent-sites/chaochao/current',
        public_base_path: '/apps/chaochao/'
      }
    ],
    services: [
      {
        service_key: 'uwillberich-api',
        project_key: 'uwillberich',
        name: 'uwillberich-api',
        role: 'api',
        runtime_kind: 'pm2',
        process_name: 'uwillberich-api',
        listen_port: 3100,
        healthcheck_url: 'http://127.0.0.1:3100/api/health'
      }
    ],
    routes: [
      {
        route_key: 'uwillberich-public-app',
        project_key: 'uwillberich',
        service_key: 'uwillberich-api',
        name: 'uwillberich-public-app',
        route_kind: 'nginx',
        path_prefix: '/apps/chaochao/',
        public_url: 'https://example.com/apps/chaochao/'
      }
    ]
  })
  const created = await sessionStore.createSession({
    title: 'Server ops matrix',
    projectKey: 'remote-server-manager',
    userRequest: '盘一下当前可用能力和端口服务矩阵'
  })

  const capabilities = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'server_ops_capability_matrix',
    input: {}
  })
  const ports = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'server_ops_port_matrix',
    input: {
      listen_port: 3100
    }
  })
  const probes = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'server_ops_service_probe_matrix',
    input: {}
  })

  assert.equal(capabilities.status, 'ok')
  assert.equal(capabilities.output.capabilities.some((entry) => entry.capability === 'dynamic_scripts'), true)
  assert.equal(ports.status, 'ok')
  assert.equal(ports.output.entries.length, 1)
  assert.equal(ports.output.entries[0].routes[0].route_key, 'uwillberich-public-app')
  assert.equal(probes.status, 'ok')
  assert.equal(probes.output.runs.length, 1)
  assert.equal(probes.output.runs[0].ok, true)
})

test('executeTool can list default news sources and collect stock news from the seeded source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-tool-runtime-news-'))
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
      async json() {
        if (String(url).includes('eastmoney')) {
          return {
            data: [
              {
                Title: '盘前快讯',
                ShowTime: '2026-04-02 09:20:00',
                Url: 'https://example.com/stock-fastnews'
              }
            ]
          }
        }

        return []
      },
      async text() {
        return ''
      }
    })
  })
  const created = await sessionStore.createSession({
    title: 'News collection',
    projectKey: 'remote-server-manager',
    userRequest: '别让 newagent 变成瞎子'
  })

  const sources = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'news_source_list',
    input: {}
  })
  const stockNews = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'news_stock_collect',
    input: {
      limit: 1
    }
  })

  assert.equal(sources.status, 'ok')
  assert.equal(sources.output.sources.some((source) => source.source_key === 'eastmoney_stock_fastnews'), true)
  assert.equal(stockNews.status, 'ok')
  assert.equal(stockNews.output.source.source_key, 'eastmoney_stock_fastnews')
  assert.equal(stockNews.output.items.length, 1)
  assert.equal(stockNews.output.items[0].title, '盘前快讯')
})

test('executeTool can inspect Feishu channel readiness and capability matrix without credentials', async () => {
  const previousAppId = process.env.NEWAGENT_FEISHU_APP_ID
  const previousAppSecret = process.env.NEWAGENT_FEISHU_APP_SECRET

  delete process.env.NEWAGENT_FEISHU_APP_ID
  delete process.env.NEWAGENT_FEISHU_APP_SECRET

  try {
    const { sessionStore, toolRuntime } = await createHarness()
    const created = await sessionStore.createSession({
      title: 'Feishu capability check',
      projectKey: 'remote-server-manager',
      userRequest: '看看飞书文档和知识库权限准备情况'
    })

    const scopes = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_scope_list',
      input: {}
    })
    const capabilities = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_capability_matrix',
      input: {}
    })

    assert.equal(scopes.status, 'ok')
    assert.equal(scopes.output.ready, false)
    assert.equal(capabilities.status, 'ok')
    assert.equal(capabilities.output.capabilities.some((entry) => entry.capability === 'docs'), true)
    assert.equal(capabilities.output.capabilities.some((entry) => entry.capability === 'wiki'), true)
  } finally {
    if (previousAppId === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_ID
    } else {
      process.env.NEWAGENT_FEISHU_APP_ID = previousAppId
    }

    if (previousAppSecret === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_SECRET
    } else {
      process.env.NEWAGENT_FEISHU_APP_SECRET = previousAppSecret
    }
  }
})

test('executeTool can run Feishu workspace CRUD tools through the injected API client', async () => {
  const previousAppId = process.env.NEWAGENT_FEISHU_APP_ID
  const previousAppSecret = process.env.NEWAGENT_FEISHU_APP_SECRET
  process.env.NEWAGENT_FEISHU_APP_ID = 'cli-test-app'
  process.env.NEWAGENT_FEISHU_APP_SECRET = 'cli-test-secret'

  try {
    const { sessionStore, toolRuntime, workspaceRoot } = await createHarness({
      feishuApiClientFactory: () => ({
        client: {
          application: {
            scope: {
              async list() {
                return {
                  data: {
                    scopes: [
                      {
                        scope_name: 'docx:document',
                        scope_type: 'tenant',
                        grant_status: 1
                      }
                    ]
                  }
                }
              }
            }
          },
          docx: {
            document: {
              async create(payload) {
                return {
                  data: {
                    document: {
                      document_id: 'doc_123',
                      title: payload?.data?.title ?? 'Untitled'
                    }
                  }
                }
              },
              async get() {
                return {
                  data: {
                    document: {
                      document_id: 'doc_123',
                      title: 'Daily Brief'
                    }
                  }
                }
              },
              async rawContent() {
                return {
                  data: {
                    content: 'existing raw content'
                  }
                }
              },
              async convert(payload) {
                return {
                  data: {
                    first_level_block_ids: ['blk_first'],
                    blocks: [
                      {
                        block_id: 'blk_first',
                        block_type: 2,
                        text: {
                          elements: [
                            {
                              text_run: {
                                content: payload.data.content
                              }
                            }
                          ]
                        }
                      }
                    ]
                  }
                }
              }
            },
            documentBlockDescendant: {
              async create(payload) {
                return {
                  data: {
                    target_block_id: payload.path.block_id,
                    children: payload.data.children_id
                  }
                }
              }
            }
          },
          drive: {
            v1: {
              file: {
                async list() {
                  return {
                    data: {
                      files: [
                        {
                          token: 'file_1',
                          name: 'brief.md',
                          type: 'file'
                        }
                      ],
                      has_more: false,
                      next_page_token: null
                    }
                  }
                },
                async createFolder(payload) {
                  return {
                    data: {
                      token: `folder_${payload.data.name}`,
                      url: 'https://feishu.example/folder'
                    }
                  }
                },
                async move(payload) {
                  return {
                    data: {
                      task_id: `move_${payload.path.file_token}`
                    }
                  }
                },
                async uploadAll(payload) {
                  return {
                    file_token: `upload_${payload.data.file_name}`
                  }
                }
              }
            }
          },
          wiki: {
            v2: {
              space: {
                async list() {
                  return {
                    data: {
                      items: [
                        {
                          space_id: 'space_1',
                          name: 'Ops Wiki'
                        }
                      ],
                      has_more: false,
                      page_token: null
                    }
                  }
                }
              },
              spaceNode: {
                async create(payload) {
                  return {
                    data: {
                      node: {
                        node_token: 'wiki_node_1',
                        space_id: payload.path.space_id,
                        title: payload.data.title ?? 'Untitled'
                      }
                    }
                  }
                },
                async move(payload) {
                  return {
                    data: {
                      node: {
                        node_token: payload.path.node_token,
                        space_id: payload.path.space_id,
                        parent_node_token: payload.data.target_parent_token ?? null
                      }
                    }
                  }
                },
                async moveDocsToWiki(payload) {
                  return {
                    data: {
                      wiki_token: `wiki_${payload.data.obj_token}`,
                      task_id: null,
                      applied: payload.data.apply ?? true
                    }
                  }
                },
                async updateTitle() {
                  return {
                    data: {}
                  }
                }
              }
            }
          },
          bitable: {
            v1: {
              app: {
                async create(payload) {
                  return {
                    data: {
                      app: {
                        app_token: 'bitable_app_1',
                        name: payload?.data?.name ?? 'Ops Board'
                      }
                    }
                  }
                },
                async get(payload) {
                  return {
                    data: {
                      app: {
                        app_token: payload.path.app_token,
                        name: 'Ops Board'
                      }
                    }
                  }
                }
              },
              appTable: {
                async create(payload) {
                  return {
                    data: {
                      table_id: 'tbl_1',
                      table: payload.data.table
                    }
                  }
                },
                async list() {
                  return {
                    data: {
                      items: [
                        {
                          table_id: 'tbl_1',
                          name: 'Tasks'
                        }
                      ],
                      has_more: false,
                      page_token: null,
                      total: 1
                    }
                  }
                }
              },
              appTableRecord: {
                async list() {
                  return {
                    data: {
                      items: [
                        {
                          record_id: 'rec_1',
                          fields: {
                            title: 'Investigate'
                          }
                        }
                      ],
                      has_more: false,
                      page_token: null,
                      total: 1
                    }
                  }
                },
                async create(payload) {
                  return {
                    data: {
                      record: {
                        record_id: 'rec_created',
                        fields: payload.data.fields
                      }
                    }
                  }
                },
                async update(payload) {
                  return {
                    data: {
                      record: {
                        record_id: payload.path.record_id,
                        fields: payload.data.fields
                      }
                    }
                  }
                }
              }
            }
          }
        }
      })
    })
    const created = await sessionStore.createSession({
      title: 'Feishu workspace CRUD',
      projectKey: 'remote-server-manager',
      userRequest: '把文档、知识库和多维表格工具跑起来'
    })
    const uploadPath = join(workspaceRoot, 'brief.txt')
    await writeFile(uploadPath, 'upload me', 'utf8')

    const scopes = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_scope_list',
      input: {}
    })
    const capabilityMatrix = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_capability_matrix',
      input: {}
    })
    const docCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_doc_create',
      input: {
        title: 'Daily Brief',
        content: '# Daily Brief'
      }
    })
    const docGet = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_doc_get',
      input: {
        document_id: 'doc_123'
      }
    })
    const docWrite = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_doc_write',
      input: {
        document_id: 'doc_123',
        content: '## Follow-up'
      }
    })
    const driveList = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_drive_list',
      input: {}
    })
    const folderCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_drive_create_folder',
      input: {
        name: 'Agent Outputs',
        folder_token: 'root_folder'
      }
    })
    const driveMove = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_drive_move',
      input: {
        file_token: 'file_1',
        folder_token: 'folder_A'
      }
    })
    const fileUpload = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_file_upload',
      input: {
        parent_node: 'root_folder',
        file_path: uploadPath
      }
    })
    const wikiSpaces = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_wiki_list_spaces',
      input: {}
    })
    const wikiCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_wiki_create_node',
      input: {
        space_id: 'space_1',
        obj_type: 'docx',
        title: 'Ops Runbook'
      }
    })
    const wikiMove = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_wiki_move_node',
      input: {
        space_id: 'space_1',
        node_token: 'wiki_node_1',
        target_parent_token: 'parent_1'
      }
    })
    const wikiMoveDoc = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_wiki_move_doc',
      input: {
        space_id: 'space_1',
        obj_token: 'doc_123',
        obj_type: 'docx'
      }
    })
    const wikiRename = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_wiki_update_title',
      input: {
        space_id: 'space_1',
        node_token: 'wiki_node_1',
        title: 'Ops Runbook v2'
      }
    })
    const bitableCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_create_app',
      input: {
        name: 'Ops Board'
      }
    })
    const bitableGet = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_get_app',
      input: {
        app_token: 'bitable_app_1'
      }
    })
    const tableCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_create_table',
      input: {
        app_token: 'bitable_app_1',
        table: {
          name: 'Tasks'
        }
      }
    })
    const tableList = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_list_tables',
      input: {
        app_token: 'bitable_app_1'
      }
    })
    const recordList = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_list_records',
      input: {
        app_token: 'bitable_app_1',
        table_id: 'tbl_1'
      }
    })
    const recordCreate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_record_create',
      input: {
        app_token: 'bitable_app_1',
        table_id: 'tbl_1',
        fields: {
          title: 'Ship feature'
        }
      }
    })
    const recordUpdate = await toolRuntime.executeTool({
      sessionId: created.session.id,
      toolName: 'channel_feishu_bitable_record_update',
      input: {
        app_token: 'bitable_app_1',
        table_id: 'tbl_1',
        record_id: 'rec_created',
        fields: {
          title: 'Ship feature now'
        }
      }
    })

    assert.equal(scopes.status, 'ok')
    assert.equal(scopes.output.ready, true)
    assert.equal(capabilityMatrix.status, 'ok')
    assert.equal(
      capabilityMatrix.output.capabilities.find((entry) => entry.capability === 'docs')?.tool_names.includes('channel_feishu_doc_create'),
      true
    )
    assert.equal(docCreate.status, 'ok')
    assert.equal(docCreate.output.document.document_id, 'doc_123')
    assert.equal(docGet.status, 'ok')
    assert.equal(docGet.output.raw_content, 'existing raw content')
    assert.equal(docWrite.status, 'ok')
    assert.equal(docWrite.output.descendant_count, 1)
    assert.equal(driveList.status, 'ok')
    assert.equal(driveList.output.files.length, 1)
    assert.equal(folderCreate.status, 'ok')
    assert.equal(folderCreate.output.token, 'folder_Agent Outputs')
    assert.equal(driveMove.status, 'ok')
    assert.equal(driveMove.output.task_id, 'move_file_1')
    assert.equal(fileUpload.status, 'ok')
    assert.equal(fileUpload.output.file_token, 'upload_brief.txt')
    assert.equal(wikiSpaces.status, 'ok')
    assert.equal(wikiSpaces.output.items[0].space_id, 'space_1')
    assert.equal(wikiCreate.status, 'ok')
    assert.equal(wikiCreate.output.node.node_token, 'wiki_node_1')
    assert.equal(wikiMove.status, 'ok')
    assert.equal(wikiMove.output.node.parent_node_token, 'parent_1')
    assert.equal(wikiMoveDoc.status, 'ok')
    assert.equal(wikiMoveDoc.output.wiki_token, 'wiki_doc_123')
    assert.equal(wikiRename.status, 'ok')
    assert.equal(wikiRename.output.ok, true)
    assert.equal(bitableCreate.status, 'ok')
    assert.equal(bitableCreate.output.app.app_token, 'bitable_app_1')
    assert.equal(bitableGet.status, 'ok')
    assert.equal(bitableGet.output.app.name, 'Ops Board')
    assert.equal(tableCreate.status, 'ok')
    assert.equal(tableCreate.output.table_id, 'tbl_1')
    assert.equal(tableList.status, 'ok')
    assert.equal(tableList.output.items[0].table_id, 'tbl_1')
    assert.equal(recordList.status, 'ok')
    assert.equal(recordList.output.items.length, 1)
    assert.equal(recordCreate.status, 'ok')
    assert.equal(recordCreate.output.record.record_id, 'rec_created')
    assert.equal(recordUpdate.status, 'ok')
    assert.equal(recordUpdate.output.record.fields.title, 'Ship feature now')
  } finally {
    if (previousAppId === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_ID
    } else {
      process.env.NEWAGENT_FEISHU_APP_ID = previousAppId
    }

    if (previousAppSecret === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_SECRET
    } else {
      process.env.NEWAGENT_FEISHU_APP_SECRET = previousAppSecret
    }
  }
})

test('executeTool can expose the tool catalog including dynamic tool metadata', async () => {
  const { sessionStore, toolRuntime, workspaceRoot } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Tool catalog',
    projectKey: 'remote-server-manager',
    userRequest: '看看 newagent 现在有哪些内部工具'
  })
  const scriptPath = join(workspaceRoot, 'dynamic-tool-list.js')
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({ ok: true }))'
    ].join('\n'),
    'utf8'
  )
  await chmod(scriptPath, 0o755)

  const firstAttempt = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: created.task.id,
    toolName: 'dynamic_tool_register',
    input: {
      tool_name: 'server_ops_firewall_snapshot',
      description: 'Temporary firewall snapshot helper',
      category: 'server_ops',
      command: `node ${scriptPath}`
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

  await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: created.task.id,
    toolName: 'dynamic_tool_register',
    input: {
      tool_name: 'server_ops_firewall_snapshot',
      description: 'Temporary firewall snapshot helper',
      category: 'server_ops',
      command: `node ${scriptPath}`
    }
  })

  const listed = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'tool_catalog_list',
    input: {
      category: 'server_ops'
    }
  })
  const fetched = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'tool_catalog_get',
    input: {
      tool_name: 'server_ops_firewall_snapshot'
    }
  })

  assert.equal(listed.status, 'ok')
  assert.equal(listed.output.tools.some((tool) => tool.name === 'server_ops_port_matrix'), true)
  assert.equal(listed.output.tools.some((tool) => tool.name === 'server_ops_firewall_snapshot'), true)
  assert.equal(fetched.status, 'ok')
  assert.equal(fetched.output.tool.category, 'server_ops')
  assert.equal(fetched.output.tool.tool_source, 'dynamic')
})

test('executeTool can register, list, and invoke one dynamic tool with review metadata', async () => {
  const { sessionStore, toolRuntime, workspaceRoot } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Dynamic tool registration',
    projectKey: 'remote-server-manager',
    userRequest: 'Register a temporary helper'
  })
  const scriptPath = join(workspaceRoot, 'dynamic-tool.js')
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'const input = JSON.parse(process.env.NEWAGENT_DYNAMIC_TOOL_INPUT || "{}")',
      'process.stdout.write(JSON.stringify({ echoed: input.text || null, ok: true }))'
    ].join('\n'),
    'utf8'
  )
  await chmod(scriptPath, 0o755)

  const firstAttempt = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: created.task.id,
    toolName: 'dynamic_tool_register',
    input: {
      tool_name: 'temp_echo_json',
      description: 'Temporary echo helper',
      category: 'internal',
      command: `node ${scriptPath}`,
      cwd: workspaceRoot,
      permission_class: 'safe',
      lifecycle: 'temporary',
      review_status: 'pending_review',
      restart_required: true,
      restart_time_hint: '04:00'
    }
  })

  assert.equal(firstAttempt.status, 'waiting_approval')

  await sessionStore.resolveApproval(
    created.session.id,
    firstAttempt.approval.id,
    'approved',
    {
      resolvedBy: 'user'
    }
  )

  const registered = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: created.task.id,
    toolName: 'dynamic_tool_register',
    input: {
      tool_name: 'temp_echo_json',
      description: 'Temporary echo helper',
      category: 'internal',
      command: `node ${scriptPath}`,
      cwd: workspaceRoot,
      permission_class: 'safe',
      lifecycle: 'temporary',
      review_status: 'pending_review',
      restart_required: true,
      restart_time_hint: '04:00'
    }
  })
  const listed = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'dynamic_tool_review_queue',
    input: {}
  })
  const invoked = await toolRuntime.executeTool({
    sessionId: created.session.id,
    toolName: 'temp_echo_json',
    input: {
      text: 'hello dynamic'
    }
  })

  assert.equal(registered.status, 'ok')
  assert.equal(listed.status, 'ok')
  assert.equal(listed.output.tools.length, 1)
  assert.equal(listed.output.tools[0].tool_name, 'temp_echo_json')
  assert.equal(listed.output.tools[0].category, 'internal')
  assert.equal(invoked.status, 'ok')
  assert.equal(invoked.output.parsed_output.echoed, 'hello dynamic')
  assert.equal(invoked.output.restart_required, true)
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

test('executeTool can run an approved shell command through the portable shell adapter', async () => {
  const { workspaceRoot, sessionStore, toolRuntime } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Approved shell command execution',
    projectKey: 'newagent',
    userRequest: 'Run one approved shell command'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: 'Run one approved shell command',
        kind: 'implementation'
      }
    ]
  })
  const snapshot = await sessionStore.loadSession(created.session.id)

  const firstAttempt = await toolRuntime.executeTool({
    sessionId: created.session.id,
    stepId: snapshot.plan_steps[0].id,
    toolName: 'run_shell_command',
    input: {
      cwd: workspaceRoot,
      command: 'pwd'
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
    toolName: 'run_shell_command',
    input: {
      cwd: workspaceRoot,
      command: 'pwd'
    }
  })

  assert.equal(secondAttempt.status, 'ok')
  assert.equal(secondAttempt.output.command, 'pwd')
  assert.equal(secondAttempt.output.cwd, workspaceRoot)
  assert.match(
    secondAttempt.output.stdout,
    new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  )
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
      url: 'https://example.com',
      base_url: ''
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
