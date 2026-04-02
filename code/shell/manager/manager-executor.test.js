import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createSessionStore } from '../session/session-store.js'
import {
  createManagerExecutor,
  selectManagerToolForStep
} from './manager-executor.js'
import { createRemoteServerManagerProfile } from './remote-server-manager-profile.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-manager-executor-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const uwillberichRoot = join(workspaceRoot, 'uwillberich')
  const uwillberichRuntimeRoot = join(workspaceRoot, '.uwillberich')
  const deployHubRoot = join(workspaceRoot, 'deploy-hub')
  const deployHubRuntimeRoot = join(workspaceRoot, 'deploy-runtime')
  const publishRoot = join(workspaceRoot, 'published')
  const sessionStore = createSessionStore({ storageRoot })
  const projectRegistry = createProjectRegistry({ storageRoot })

  await mkdir(uwillberichRoot, { recursive: true })
  await mkdir(uwillberichRuntimeRoot, { recursive: true })
  await mkdir(deployHubRoot, { recursive: true })
  await mkdir(deployHubRuntimeRoot, { recursive: true })
  await mkdir(publishRoot, { recursive: true })

  await projectRegistry.seedProjects([
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      tier: 'major',
      role: 'Stock operations',
      source_root: uwillberichRoot,
      runtime_root: uwillberichRuntimeRoot,
      publish_root: publishRoot,
      public_base_path: '/apps/chaochao/',
      pm2_name: 'uwillberich-api',
      service_endpoint: 'http://127.0.0.1:3100/api/health',
      status: 'active'
    },
    {
      project_key: 'deploy-hub',
      name: 'deploy-hub',
      tier: 'minor',
      role: 'Static site publish infrastructure',
      source_root: deployHubRoot,
      runtime_root: deployHubRuntimeRoot,
      publish_root: publishRoot,
      public_base_path: '/apps/',
      pm2_name: 'deploy-hub',
      service_endpoint: 'http://127.0.0.1:3900/_deploy/ticket',
      status: 'active'
    }
  ])

  const managerProfile = createRemoteServerManagerProfile({
    env: {}
  })

  return {
    storageRoot,
    workspaceRoot,
    sessionStore,
    projectRegistry,
    managerProfile,
    managerExecutor: createManagerExecutor({
      storageRoot,
      workspaceRoot,
      codexCommand: '/bin/echo',
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return `health ok ${url}`
        }
      }),
      managerProfile
    })
  }
}

test('selectManagerToolForStep maps inspect steps to safe registry and probe tools', () => {
  const projects = [
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      service_endpoint: 'http://127.0.0.1:3100/api/health'
    }
  ]

  const listSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '盘一下当前项目基线'
    },
    projects,
    managerProjectKeys: []
  })
  const getSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '检查 uwillberich 当前配置'
    },
    projects,
    managerProjectKeys: ['uwillberich']
  })
  const probeSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '检查 uwillberich API 在线状态'
    },
    projects,
    managerProjectKeys: ['uwillberich']
  })
  const pm2Selection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '检查 uwillberich PM2 进程状态'
    },
    projects: [
      {
        ...projects[0],
        pm2_name: 'uwillberich-api'
      }
    ],
    managerProjectKeys: ['uwillberich']
  })
  const infrastructureSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '确认 3800 和 /apps/chaochao/ 分别归谁'
    },
    projects,
    managerProjectKeys: ['uwillberich']
  })
  const serviceMatrixSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '盘一下服务器整体在线情况'
    },
    projects,
    managerProjectKeys: []
  })
  const capabilitySelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '看看当前 ssh 和协作通道能力'
    },
    projects,
    managerProjectKeys: []
  })
  const networkSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '检查当前服务器网络接口'
    },
    projects,
    managerProjectKeys: []
  })
  const projectResolveSelection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '确认 deploy-hub 的源码路径和 service endpoint 归谁'
    },
    projects,
    managerProjectKeys: []
  })

  assert.equal(listSelection.tool_name, 'project_list_registry')
  assert.equal(getSelection.tool_name, 'project_get_registry')
  assert.equal(probeSelection.tool_name, 'project_probe_endpoint')
  assert.equal(pm2Selection.tool_name, 'project_pm2_status')
  assert.equal(infrastructureSelection.tool_name, 'infrastructure_resolve_registry')
  assert.equal(serviceMatrixSelection.tool_name, 'server_ops_service_probe_matrix')
  assert.equal(capabilitySelection.tool_name, 'server_ops_capability_matrix')
  assert.equal(networkSelection.tool_name, 'server_ops_network_interfaces')
  assert.equal(projectResolveSelection.tool_name, 'project_resolve_registry')
  assert.equal(infrastructureSelection.tool_input.listen_port, 3800)
  assert.equal(infrastructureSelection.tool_input.path_prefix, '/apps/chaochao/')
})

test('selectManagerToolForStep maps Feishu workspace CRUD requests to concrete tools', () => {
  const projects = []

  const docCreateSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '创建飞书文档《今晚日报》',
      notes: 'folder_token=fldcn_parent\ncontent=# 今晚安排\ncontent_type=markdown'
    },
    projects,
    managerProjectKeys: []
  })
  const docWriteSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '往飞书文档追加内容',
      notes: 'document_id=doccn123\ncontent=## 最新进展'
    },
    projects,
    managerProjectKeys: []
  })
  const driveUploadSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '上传 README 到飞书云盘',
      notes: 'parent_node=fldcn_parent\nfile_path=./README.md'
    },
    projects,
    managerProjectKeys: []
  })
  const wikiCreateSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '在飞书知识库创建文档《作战手册》',
      notes: 'space_id=spc123'
    },
    projects,
    managerProjectKeys: []
  })
  const bitableCreateSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '创建飞书多维表格《任务看板》'
    },
    projects,
    managerProjectKeys: []
  })
  const bitableRecordSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '在飞书多维表格里新增记录',
      notes: 'app_token=appcn123\ntable_id=tblcn456\nfields={"状态":"进行中","负责人":"老板"}'
    },
    projects,
    managerProjectKeys: []
  })

  assert.equal(docCreateSelection.action, 'tool')
  assert.equal(docCreateSelection.tool_name, 'channel_feishu_doc_create')
  assert.equal(docCreateSelection.tool_input.title, '今晚日报')
  assert.equal(docCreateSelection.tool_input.folder_token, 'fldcn_parent')
  assert.equal(docCreateSelection.tool_input.content, '# 今晚安排')
  assert.equal(docCreateSelection.tool_input.content_type, 'markdown')

  assert.equal(docWriteSelection.action, 'tool')
  assert.equal(docWriteSelection.tool_name, 'channel_feishu_doc_write')
  assert.equal(docWriteSelection.tool_input.document_id, 'doccn123')
  assert.equal(docWriteSelection.tool_input.content, '## 最新进展')

  assert.equal(driveUploadSelection.action, 'tool')
  assert.equal(driveUploadSelection.tool_name, 'channel_feishu_file_upload')
  assert.equal(driveUploadSelection.tool_input.parent_node, 'fldcn_parent')
  assert.equal(driveUploadSelection.tool_input.file_path, './README.md')

  assert.equal(wikiCreateSelection.action, 'tool')
  assert.equal(wikiCreateSelection.tool_name, 'channel_feishu_wiki_create_node')
  assert.equal(wikiCreateSelection.tool_input.space_id, 'spc123')
  assert.equal(wikiCreateSelection.tool_input.obj_type, 'docx')
  assert.equal(wikiCreateSelection.tool_input.title, '作战手册')

  assert.equal(bitableCreateSelection.action, 'tool')
  assert.equal(bitableCreateSelection.tool_name, 'channel_feishu_bitable_create_app')
  assert.equal(bitableCreateSelection.tool_input.name, '任务看板')

  assert.equal(bitableRecordSelection.action, 'tool')
  assert.equal(bitableRecordSelection.tool_name, 'channel_feishu_bitable_record_create')
  assert.equal(bitableRecordSelection.tool_input.app_token, 'appcn123')
  assert.equal(bitableRecordSelection.tool_input.table_id, 'tblcn456')
  assert.deepEqual(bitableRecordSelection.tool_input.fields, {
    状态: '进行中',
    负责人: '老板'
  })
})

test('selectManagerToolForStep treats weather-data inspection as direct execution instead of project fallback', () => {
  const projects = [
    {
      project_key: 'deploy-hub',
      name: 'deploy-hub',
      service_endpoint: 'http://127.0.0.1:3900/_deploy/ticket'
    }
  ]

  const selection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '检查杭州天气数据抓取进度'
    },
    projects,
    managerProjectKeys: [],
    operatorRequest: '查一下杭州天气并建个文档发我'
  })

  assert.equal(selection.action, 'execution')
  assert.equal(selection.execution_kind, 'inspect')
  assert.equal(selection.project, null)
})

test('selectManagerToolForStep infers a weather-doc title when the planner omits structured metadata', () => {
  const selection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '创建飞书文档并填入数据'
    },
    projects: [],
    managerProjectKeys: [],
    operatorRequest: '查一下杭州近 7 天天气并建个文档发我'
  })

  assert.equal(selection.action, 'tool')
  assert.equal(selection.tool_name, 'channel_feishu_doc_create')
  assert.equal(selection.tool_input.title, '杭州近 7 天天气报告')
})

test('selectManagerToolForStep rejects legacy review and repair step kinds in the default agent loop', async () => {
  const { workspaceRoot, managerProfile } = await createHarness()
  const projects = [
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      source_root: join(workspaceRoot, 'uwillberich')
    }
  ]

  const reviewSelection = selectManagerToolForStep({
    step: {
      kind: 'review',
      title: 'Review uwillberich 发布链风险'
    },
    projects,
    managerProjectKeys: ['uwillberich'],
    workspaceRoot,
    operatorRequest: '检查发布链',
    managerProfile
  })
  const repairSelection = selectManagerToolForStep({
    step: {
      kind: 'repair',
      title: '修复 uwillberich 发布链'
    },
    projects,
    managerProjectKeys: ['uwillberich'],
    workspaceRoot,
    operatorRequest: '修复发布链',
    managerProfile
  })
  const reportSelection = selectManagerToolForStep({
    step: {
      kind: 'report',
      title: '汇报当前巡检结论'
    },
    projects,
    managerProjectKeys: ['uwillberich'],
    workspaceRoot,
    managerProfile
  })

  assert.equal(reviewSelection.supported, false)
  assert.match(reviewSelection.reason, /default agent loop/i)
  assert.equal(repairSelection.supported, false)
  assert.match(repairSelection.reason, /default agent loop/i)
  assert.equal(reportSelection.action, 'report')
})

test('selectManagerToolForStep maps internal tool-catalog requests to capability summaries instead of raw tool listings', () => {
  const selection = selectManagerToolForStep({
    step: {
      kind: 'inspect',
      title: '看看现在有哪些内部能力，不要给我工具目录'
    },
    projects: [],
    managerProjectKeys: []
  })

  assert.equal(selection.supported, true)
  assert.equal(selection.action, 'tool')
  assert.equal(selection.tool_name, 'server_ops_capability_matrix')
})

test('selectManagerToolForStep maps operate and deploy steps to execution planning', async () => {
  const { workspaceRoot } = await createHarness()
  const projects = [
    {
      project_key: 'deploy-hub',
      name: 'deploy-hub',
      source_root: join(workspaceRoot, 'deploy-hub'),
      runtime_root: join(workspaceRoot, 'deploy-runtime')
    }
  ]

  const operateSelection = selectManagerToolForStep({
    step: {
      kind: 'operate',
      title: '重启 deploy-hub 服务'
    },
    projects,
    managerProjectKeys: ['deploy-hub'],
    workspaceRoot
  })
  const deploySelection = selectManagerToolForStep({
    step: {
      kind: 'deploy',
      title: '发布 deploy-hub 到线上'
    },
    projects,
    managerProjectKeys: ['deploy-hub'],
    workspaceRoot
  })

  assert.equal(operateSelection.action, 'execution')
  assert.equal(operateSelection.execution_kind, 'operate')
  assert.equal(deploySelection.action, 'execution')
  assert.equal(deploySelection.execution_kind, 'deploy')
})

test('executeCurrentManagerStep executes one safe inspect step and advances the session', async () => {
  const { sessionStore, managerExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Run one manager inspect step',
    projectKey: 'remote-server-manager',
    userRequest: 'Inspect the stock project'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '检查 uwillberich 当前配置',
        kind: 'inspect',
        notes: '先看项目注册信息'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['uwillberich']
    }
  })

  const result = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'completed')
  assert.equal(result.selection.tool_name, 'project_get_registry')
  assert.match(result.summary, /已读取项目 uwillberich 配置/)
  assert.equal(loaded.session.status, 'completed')
  assert.ok(loaded.timeline.some((event) => event.kind === 'manager_tool_selected'))
  assert.ok(loaded.timeline.some((event) => event.kind === 'manager_step_executed'))
})

test('runManagerLoop can execute inspect and report steps in one loop', async () => {
  const { sessionStore, managerExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Loop safe manager steps',
    projectKey: 'remote-server-manager',
    userRequest: 'Inspect uwillberich and then report back'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '检查 uwillberich 当前配置',
        kind: 'inspect'
      },
      {
        title: '汇报当前巡检结论',
        kind: 'report',
        dependsOn: [0]
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['uwillberich']
    }
  })

  const result = await managerExecutor.runManagerLoop({
    sessionId: created.session.id,
    maxSteps: 2
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.runs.length, 2)
  assert.equal(result.runs[0].selection.tool_name, 'project_get_registry')
  assert.equal(result.runs[1].selection.action, 'report')
  assert.match(result.runs[0].summary, /已读取项目 uwillberich 配置/)
  assert.match(result.runs[1].report_text, /阶段汇报：/)
  assert.ok(loaded.timeline.some((event) => event.kind === 'manager_report_generated'))
  assert.ok(loaded.timeline.some((event) => event.kind === 'assistant_message_added'))
  assert.equal(result.session.status, 'completed')
})

test('runManagerLoop defers legacy repair steps instead of entering a dedicated repair mode', async () => {
  const { sessionStore, managerExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Manager repair auto execution flow',
    projectKey: 'remote-server-manager',
    userRequest: 'Repair the remote stock project'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '修复 uwillberich 发布链',
        kind: 'repair'
      },
      {
        title: '汇报修复进展',
        kind: 'report',
        dependsOn: [0]
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['uwillberich']
    }
  })

  const result = await managerExecutor.runManagerLoop({
    sessionId: created.session.id,
    maxSteps: 2
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'deferred')
  assert.equal(result.runs.length, 1)
  assert.equal(result.runs[0].status, 'deferred')
  assert.match(result.runs[0].summary, /default agent loop/i)
  assert.equal(loaded.approvals.length, 0)
})

test('executeCurrentManagerStep plans one deploy command and executes it immediately', async () => {
  const { sessionStore, storageRoot, workspaceRoot } = await createHarness()
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand: '/bin/echo',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
    executionProvider: {
      async invokeByIntent({ intent, prompt, systemPrompt }) {
        assert.equal(intent, 'operate')
        assert.match(systemPrompt, /one executable shell command/i)
        assert.match(prompt, /发布 deploy-hub 到线上/)

        return {
          route: {
            provider: 'bailian',
            model: 'qwen3.5-plus'
          },
          request: {
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
            model: 'qwen3.5-plus'
          },
          response: {
            id: 'chatcmpl-execution',
            model: 'qwen3.5-plus',
            finish_reason: 'stop',
            usage: {
              total_tokens: 48
            },
            content: JSON.stringify({
              cwd: join(workspaceRoot, 'deploy-hub'),
              command: "printf 'deploy ok\\n'",
              summary: '准备在 deploy-hub 执行发布命令',
              timeout_ms: 1000
            })
          }
        }
      }
    }
  })
  const created = await sessionStore.createSession({
    title: 'Manager deploy approval flow',
    projectKey: 'remote-server-manager',
    userRequest: 'Deploy deploy-hub'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '发布 deploy-hub 到线上',
        kind: 'deploy'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['deploy-hub']
    }
  })

  const result = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'completed')
  assert.equal(result.selection.tool_name, 'run_shell_command')
  assert.equal(result.selection.tool_input.cwd, join(workspaceRoot, 'deploy-hub'))
  assert.equal(result.selection.tool_input.command, "printf 'deploy ok\\n'")
  assert.match(result.summary, /deploy ok/)
  assert.equal(loaded.session.status, 'completed')
  assert.equal(loaded.approvals.length, 0)
})

test('executeCurrentManagerStep notifies before one restart-like deploy command', async () => {
  const { sessionStore, storageRoot, workspaceRoot } = await createHarness()
  const notices = []
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand: '/bin/echo',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
    executionProvider: {
      async invokeByIntent() {
        return {
          route: {
            provider: 'bailian',
            model: 'qwen3.5-plus'
          },
          request: {
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
            model: 'qwen3.5-plus'
          },
          response: {
            id: 'chatcmpl-execution-continue',
            model: 'qwen3.5-plus',
            finish_reason: 'stop',
            usage: {
              total_tokens: 36
            },
            content: JSON.stringify({
              cwd: join(workspaceRoot, 'deploy-hub'),
              command: 'kill -0 $$',
              summary: '准备在 deploy-hub 执行发布命令',
              timeout_ms: 1000
            })
          }
        }
      }
    }
  })
  const created = await sessionStore.createSession({
    title: 'Manager deploy continue flow',
    projectKey: 'remote-server-manager',
    userRequest: 'Deploy deploy-hub'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '发布 deploy-hub 到线上',
        kind: 'deploy'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['deploy-hub']
    }
  })

  const result = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id,
    onBeforeToolExecution: async ({ selection, step }) => {
      notices.push({
        stepTitle: step.title,
        toolName: selection.tool_name,
        command: selection.tool_input?.command ?? null
      })
    }
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'completed')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].stepTitle, '发布 deploy-hub 到线上')
  assert.equal(notices[0].toolName, 'run_shell_command')
  assert.equal(notices[0].command, 'kill -0 $$')
  assert.equal(loaded.session.status, 'completed')
  assert.equal(loaded.approvals.length, 0)
})

test('executeCurrentManagerStep rejects execution cwd values outside the target project roots', async () => {
  const { sessionStore, storageRoot, workspaceRoot, managerProfile } = await createHarness()
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand: '/bin/echo',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
    executionProvider: {
      async invokeByIntent() {
        return {
          route: {
            provider: 'bailian',
            model: 'qwen3.5-plus'
          },
          request: {
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
            model: 'qwen3.5-plus'
          },
          response: {
            id: 'chatcmpl-execution-unsafe-cwd',
            model: 'qwen3.5-plus',
            finish_reason: 'stop',
            usage: {
              total_tokens: 32
            },
            content: JSON.stringify({
              cwd: '/etc',
              command: 'pwd',
              summary: 'Try to run outside the project roots'
            })
          }
        }
      }
    },
    managerProfile
  })
  const created = await sessionStore.createSession({
    title: 'Reject out-of-root execution cwd',
    projectKey: 'remote-server-manager',
    userRequest: 'Deploy deploy-hub safely'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '发布 deploy-hub 到线上',
        kind: 'deploy'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['deploy-hub']
    }
  })

  const result = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'failed')
  assert.match(result.summary, /target project roots/i)
  assert.equal(loaded.session.status, 'blocked')
  assert.equal(loaded.task.status, 'failed')
  assert.equal(loaded.plan_steps[0].status, 'failed')
  assert.match(loaded.plan_steps[0].notes, /target project roots/i)
})

test('continueApprovedManagerStep executes one approved deploy command and completes the step', async () => {
  const { sessionStore, storageRoot, workspaceRoot } = await createHarness()
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand: '/bin/echo',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
    executionProvider: {
      async invokeByIntent() {
        return {
          route: {
            provider: 'bailian',
            model: 'qwen3.5-plus'
          },
          request: {
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
            model: 'qwen3.5-plus'
          },
          response: {
            id: 'chatcmpl-execution-continue',
            model: 'qwen3.5-plus',
            finish_reason: 'stop',
            usage: {
              total_tokens: 36
            },
            content: JSON.stringify({
              cwd: join(workspaceRoot, 'deploy-hub'),
              command: "printf 'deploy ok\\n'",
              summary: '准备在 deploy-hub 执行发布命令',
              timeout_ms: 1000
            })
          }
        }
      }
    }
  })
  const created = await sessionStore.createSession({
    title: 'Manager deploy continue flow',
    projectKey: 'remote-server-manager',
    userRequest: 'Deploy deploy-hub'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '发布 deploy-hub 到线上',
        kind: 'deploy'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['deploy-hub']
    }
  })

  const waiting = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id
  })
  const approvalId = waiting.execution.approvals[0].id

  const continued = await managerExecutor.continueApprovedManagerStep({
    sessionId: created.session.id,
    approvalId,
    currentInput: '继续'
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(waiting.status, 'waiting_approval')
  assert.equal(continued.status, 'completed')
  assert.match(continued.summary, /deploy ok/)
  assert.equal(loaded.session.status, 'completed')
  assert.equal(loaded.approvals[0].status, 'approved')
})

test('executeCurrentManagerStep rejects execution cwd values outside the target project roots', async () => {
  const { sessionStore, storageRoot, workspaceRoot, managerProfile } = await createHarness()
  const managerExecutor = createManagerExecutor({
    storageRoot,
    workspaceRoot,
    codexCommand: '/bin/echo',
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
    executionProvider: {
      async invokeByIntent() {
        return {
          route: {
            provider: 'bailian',
            model: 'qwen3.5-plus'
          },
          request: {
            base_url: 'https://coding.dashscope.aliyuncs.com/v1',
            model: 'qwen3.5-plus'
          },
          response: {
            id: 'chatcmpl-execution-unsafe-cwd',
            model: 'qwen3.5-plus',
            finish_reason: 'stop',
            usage: {
              total_tokens: 32
            },
            content: JSON.stringify({
              cwd: '/etc',
              command: 'pwd',
              summary: 'Try to run outside the project roots'
            })
          }
        }
      }
    },
    managerProfile
  })
  const created = await sessionStore.createSession({
    title: 'Reject out-of-root execution cwd',
    projectKey: 'remote-server-manager',
    userRequest: 'Deploy deploy-hub safely'
  })

  await sessionStore.createPlan(created.session.id, {
    steps: [
      {
        title: '发布 deploy-hub 到线上',
        kind: 'deploy'
      }
    ]
  })
  await sessionStore.appendTimelineEvent(created.session.id, {
    kind: 'manager_plan_generated',
    actor: 'manager:planner',
    payload: {
      project_keys: ['deploy-hub']
    }
  })

  const result = await managerExecutor.executeCurrentManagerStep({
    sessionId: created.session.id
  })
  const loaded = await sessionStore.loadSession(created.session.id)

  assert.equal(result.status, 'failed')
  assert.match(result.summary, /target project roots/i)
  assert.equal(loaded.session.status, 'blocked')
  assert.equal(loaded.task.status, 'failed')
  assert.equal(loaded.plan_steps[0].status, 'failed')
  assert.match(loaded.plan_steps[0].notes, /target project roots/i)
})
