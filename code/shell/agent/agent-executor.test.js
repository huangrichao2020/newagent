import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createSessionStore } from '../session/session-store.js'
import {
  createAgentExecutor,
  selectAgentToolForStep
} from './agent-executor.js'
import { createAgentProfile } from './agent-profile.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-agent-executor-'))
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

  const agentProfile = createAgentProfile({
    env: {}
  })

  return {
    storageRoot,
    workspaceRoot,
    sessionStore,
    projectRegistry,
    agentProfile,
    agentExecutor: createAgentExecutor({
      storageRoot,
      workspaceRoot,
      qwenCommand: '/bin/echo',
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return `health ok ${url}`
        }
      }),
      agentProfile
    })
  }
}

test('selectAgentToolForStep maps inspect steps to safe registry and probe tools', () => {
  const projects = [
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      service_endpoint: 'http://127.0.0.1:3100/api/health'
    }
  ]

  const listSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '盘一下当前项目基线'
    },
    projects,
    agentProjectKeys: []
  })
  const getSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '检查 uwillberich 当前配置'
    },
    projects,
    agentProjectKeys: ['uwillberich']
  })
  const probeSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '检查 uwillberich API 在线状态'
    },
    projects,
    agentProjectKeys: ['uwillberich']
  })
  const pm2Selection = selectAgentToolForStep({
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
    agentProjectKeys: ['uwillberich']
  })
  const infrastructureSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '确认 3800 和 /apps/chaochao/ 分别归谁'
    },
    projects,
    agentProjectKeys: ['uwillberich']
  })
  const serviceMatrixSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '盘一下服务器整体在线情况'
    },
    projects,
    agentProjectKeys: []
  })
  const capabilitySelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '看看当前 ssh 和协作通道能力'
    },
    projects,
    agentProjectKeys: []
  })
  const networkSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '检查当前服务器网络接口'
    },
    projects,
    agentProjectKeys: []
  })
  const projectResolveSelection = selectAgentToolForStep({
    step: {
      kind: 'inspect',
      title: '确认 deploy-hub 的源码路径和 service endpoint 归谁'
    },
    projects,
    agentProjectKeys: []
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

test('selectAgentToolForStep maps Feishu workspace CRUD requests to concrete tools', () => {
  const projects = []

  const docCreateSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '创建飞书文档《今晚日报》',
      notes: 'folder_token=fldcn_parent\ncontent=# 今晚安排\ncontent_type=markdown'
    },
    projects,
    agentProjectKeys: []
  })
  const docWriteSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '往飞书文档追加内容',
      notes: 'document_id=doccn123\ncontent=## 最新进展'
    },
    projects,
    agentProjectKeys: []
  })
  const driveUploadSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '上传 README 到飞书云盘',
      notes: 'parent_node=fldcn_parent\nfile_path=./README.md'
    },
    projects,
    agentProjectKeys: []
  })
  const wikiCreateSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '在飞书知识库创建文档《作战手册》',
      notes: 'space_id=spc123'
    },
    projects,
    agentProjectKeys: []
  })
  const bitableCreateSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '创建飞书多维表格《任务看板》'
    },
    projects,
    agentProjectKeys: []
  })
  const bitableRecordSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '在飞书多维表格里新增记录',
      notes: 'app_token=appcn123\ntable_id=tblcn456\nfields={"状态":"进行中","负责人":"老板"}'
    },
    projects,
    agentProjectKeys: []
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

test('selectAgentToolForStep maps operate and deploy steps to execution planning', async () => {
  const { workspaceRoot } = await createHarness()
  const projects = [
    {
      project_key: 'deploy-hub',
      name: 'deploy-hub',
      source_root: join(workspaceRoot, 'deploy-hub'),
      runtime_root: join(workspaceRoot, 'deploy-runtime')
    }
  ]

  const operateSelection = selectAgentToolForStep({
    step: {
      kind: 'operate',
      title: '重启 deploy-hub 服务'
    },
    projects,
    agentProjectKeys: ['deploy-hub'],
    workspaceRoot
  })
  const deploySelection = selectAgentToolForStep({
    step: {
      kind: 'deploy',
      title: '发布 deploy-hub 到线上'
    },
    projects,
    agentProjectKeys: ['deploy-hub'],
    workspaceRoot
  })

  assert.equal(operateSelection.action, 'execution')
  assert.equal(operateSelection.execution_kind, 'operate')
  assert.equal(deploySelection.action, 'execution')
  assert.equal(deploySelection.execution_kind, 'deploy')
})
