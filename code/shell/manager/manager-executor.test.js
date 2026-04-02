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

test('selectManagerToolForStep maps review, repair, and report steps to manager actions', async () => {
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

  assert.equal(reviewSelection.action, 'tool')
  assert.equal(reviewSelection.tool_name, 'codex_review_workspace')
  assert.equal(reviewSelection.tool_input.cwd, join(workspaceRoot, 'uwillberich'))
  assert.match(reviewSelection.tool_input.instruction, /ROLE:/)
  assert.match(reviewSelection.tool_input.instruction, /Review the target workspace/)
  assert.match(reviewSelection.tool_input.instruction, /RESPONSE RULES:/)
  assert.equal(repairSelection.action, 'tool')
  assert.equal(repairSelection.tool_name, 'codex_repair_workspace')
  assert.equal(repairSelection.tool_input.full_auto, true)
  assert.equal(reportSelection.action, 'report')
})

test('selectManagerToolForStep defers review and repair when Codex is disabled', async () => {
  const { workspaceRoot } = await createHarness()
  const projects = [
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      source_root: join(workspaceRoot, 'uwillberich')
    }
  ]
  const managerProfile = createRemoteServerManagerProfile({
    env: {
      NEWAGENT_DISABLE_CODEX: 'true'
    }
  })

  const reviewSelection = selectManagerToolForStep({
    step: {
      kind: 'review',
      title: 'Review uwillberich 发布链风险'
    },
    projects,
    managerProjectKeys: ['uwillberich'],
    workspaceRoot,
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
    managerProfile
  })

  assert.equal(reviewSelection.supported, false)
  assert.match(reviewSelection.reason, /disabled/i)
  assert.equal(repairSelection.supported, false)
  assert.match(repairSelection.reason, /disabled/i)
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
  assert.match(result.runs[1].report_text, /总管阶段汇报：/)
  assert.ok(loaded.timeline.some((event) => event.kind === 'manager_report_generated'))
  assert.ok(loaded.timeline.some((event) => event.kind === 'assistant_message_added'))
  assert.equal(result.session.status, 'completed')
})

test('runManagerLoop pauses when a repair step requests approval', async () => {
  const { sessionStore, managerExecutor } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Manager repair approval flow',
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

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.runs.length, 1)
  assert.equal(result.runs[0].selection.tool_name, 'codex_repair_workspace')
  assert.match(result.runs[0].summary, /等待审批/)
  assert.equal(loaded.session.status, 'waiting_approval')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.approvals[0].tool_name, 'codex_repair_workspace')
})

test('executeCurrentManagerStep plans one deploy command and pauses for approval', async () => {
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
              command: 'npm run deploy',
              summary: '准备在 deploy-hub 执行发布命令',
              timeout_ms: 180000
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

  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.selection.tool_name, 'run_shell_command')
  assert.equal(result.selection.tool_input.cwd, join(workspaceRoot, 'deploy-hub'))
  assert.equal(result.selection.tool_input.command, 'npm run deploy')
  assert.match(result.summary, /npm run deploy/)
  assert.equal(loaded.session.status, 'waiting_approval')
  assert.equal(loaded.approvals.length, 1)
  assert.equal(loaded.approvals[0].tool_name, 'run_shell_command')
  assert.deepEqual(loaded.approvals[0].requested_input, {
    cwd: join(workspaceRoot, 'deploy-hub'),
    command: 'npm run deploy',
    timeout_ms: 180000
  })
})
