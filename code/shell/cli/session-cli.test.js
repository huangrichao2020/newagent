import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeCli } from './session-cli.js'
import { createSessionStore } from '../session/session-store.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHookBus } from '../hooks/hook-bus.js'

async function createStorageRoot() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-cli-'))
  return join(root, 'storage')
}

function createStore(storageRoot) {
  return createSessionStore({ storageRoot })
}

test('start creates a session and prints a json summary', async () => {
  const storageRoot = await createStorageRoot()
  const result = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Start via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Create the first CLI session',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr, '')

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'start')
  assert.equal(payload.session.status, 'planning')
  assert.equal(payload.task.user_request, 'Create the first CLI session')
})

test('profile show returns the remote server manager defaults', async () => {
  const result = await executeCli({
    argv: ['profile', 'show', '--json']
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'profile show')
  assert.equal(payload.profile.channels.primary.type, 'feishu')
  assert.equal(payload.profile.model_routing.planner.model, 'codingplan')
  assert.equal(payload.profile.model_routing.execution.model, 'qwen3.5-plus')
})

test('project seed-aliyun writes the six known remote projects and project list returns them', async () => {
  const storageRoot = await createStorageRoot()
  const seeded = await executeCli({
    argv: ['project', 'seed-aliyun', '--storage-root', storageRoot, '--json']
  })

  assert.equal(seeded.exitCode, 0)

  const listed = await executeCli({
    argv: ['project', 'list', '--storage-root', storageRoot, '--json']
  })

  assert.equal(listed.exitCode, 0)

  const seedPayload = JSON.parse(seeded.stdout)
  const listPayload = JSON.parse(listed.stdout)
  assert.equal(seedPayload.command, 'project seed-aliyun')
  assert.equal(seedPayload.projects.length, 6)
  assert.equal(listPayload.projects.length, 6)
  assert.equal(listPayload.projects.some((project) => project.project_key === 'deploy-hub'), true)
})

test('project register upserts one explicit project record through the CLI', async () => {
  const storageRoot = await createStorageRoot()

  const result = await executeCli({
    argv: [
      'project',
      'register',
      '--storage-root',
      storageRoot,
      '--project-key',
      'ops-bot',
      '--name',
      'ops-bot',
      '--tier',
      'minor',
      '--role',
      'Operate one background automation service',
      '--source-root',
      '/srv/ops-bot',
      '--runtime-root',
      '/srv/ops-bot',
      '--pm2-name',
      'ops-bot',
      '--status',
      'active',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'project register')
  assert.equal(payload.project.project_key, 'ops-bot')
  assert.equal(payload.project.pm2_name, 'ops-bot')
})

test('route resolve exposes the manager model routing and codex tool routing', async () => {
  const planning = await executeCli({
    argv: ['route', 'resolve', '--intent', 'plan', '--json']
  })
  const repair = await executeCli({
    argv: ['route', 'resolve', '--intent', 'repair', '--json']
  })

  assert.equal(planning.exitCode, 0)
  assert.equal(repair.exitCode, 0)

  const planningPayload = JSON.parse(planning.stdout)
  const repairPayload = JSON.parse(repair.stdout)
  assert.equal(planningPayload.route.provider, 'bailian')
  assert.equal(planningPayload.route.model, 'codingplan')
  assert.equal(repairPayload.route.runtime, 'tool')
  assert.equal(repairPayload.route.tool_name, 'codex_repair_workspace')
})

test('provider invoke calls the Bailian adapter through the CLI', async () => {
  const result = await executeCli({
    argv: [
      'provider',
      'invoke',
      '--intent',
      'plan',
      '--prompt',
      'Make a plan.',
      '--json'
    ],
    dependencies: {
      bailianProvider: {
        async invokeByIntent(input) {
          assert.equal(input.intent, 'plan')
          assert.equal(input.prompt, 'Make a plan.')

          return {
            route: {
              provider: 'bailian',
              model: 'codingplan'
            },
            response: {
              content: 'Planned.'
            }
          }
        }
      }
    }
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'provider invoke')
  assert.equal(payload.route.model, 'codingplan')
  assert.equal(payload.response.content, 'Planned.')
})

test('channel feishu-profile reports readiness from the environment snapshot', async () => {
  const originalAppId = process.env.NEWAGENT_FEISHU_APP_ID
  const originalAppSecret = process.env.NEWAGENT_FEISHU_APP_SECRET
  const originalEncryptKey = process.env.NEWAGENT_FEISHU_ENCRYPT_KEY
  const originalVerificationToken = process.env.NEWAGENT_FEISHU_VERIFICATION_TOKEN
  process.env.NEWAGENT_FEISHU_APP_ID = 'app_id'
  process.env.NEWAGENT_FEISHU_APP_SECRET = 'app_secret'
  process.env.NEWAGENT_FEISHU_ENCRYPT_KEY = 'encrypt_key'
  process.env.NEWAGENT_FEISHU_VERIFICATION_TOKEN = 'verification_token'

  try {
    const result = await executeCli({
      argv: ['channel', 'feishu-profile', '--json']
    })

    assert.equal(result.exitCode, 0)

    const payload = JSON.parse(result.stdout)
    assert.equal(payload.command, 'channel feishu-profile')
    assert.equal(payload.profile.ready, true)
    assert.equal(payload.profile.connection_mode, 'long_connection')
    assert.equal(payload.profile.encrypt_key_present, true)
    assert.equal(payload.profile.verification_token_present, true)
  } finally {
    if (originalAppId === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_ID
    } else {
      process.env.NEWAGENT_FEISHU_APP_ID = originalAppId
    }

    if (originalAppSecret === undefined) {
      delete process.env.NEWAGENT_FEISHU_APP_SECRET
    } else {
      process.env.NEWAGENT_FEISHU_APP_SECRET = originalAppSecret
    }

    if (originalEncryptKey === undefined) {
      delete process.env.NEWAGENT_FEISHU_ENCRYPT_KEY
    } else {
      process.env.NEWAGENT_FEISHU_ENCRYPT_KEY = originalEncryptKey
    }

    if (originalVerificationToken === undefined) {
      delete process.env.NEWAGENT_FEISHU_VERIFICATION_TOKEN
    } else {
      process.env.NEWAGENT_FEISHU_VERIFICATION_TOKEN = originalVerificationToken
    }
  }
})

test('channel feishu-send calls the injected Feishu gateway', async () => {
  const sent = []
  const result = await executeCli({
    argv: [
      'channel',
      'feishu-send',
      '--receive-id',
      'oc_123',
      '--text',
      'hello',
      '--json'
    ],
    dependencies: {
      feishuGateway: {
        async sendTextMessage(payload) {
          sent.push(payload)
          return {
            ok: true
          }
        }
      }
    }
  })

  assert.equal(result.exitCode, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].receiveId, 'oc_123')
})

test('manager bootstrap seeds the known aliyun project baseline through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  const result = await executeCli({
    argv: ['manager', 'bootstrap', '--storage-root', storageRoot, '--json']
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'manager bootstrap')
  assert.equal(payload.seeded_project_count, 6)
})

test('manager feishu-serve can start once and return startup state', async () => {
  const storageRoot = await createStorageRoot()
  let closed = null
  const result = await executeCli({
    argv: ['manager', 'feishu-serve', '--storage-root', storageRoot, '--once', '--json'],
    dependencies: {
      feishuGateway: {
        async start() {
          return {
            channel: 'feishu',
            connection_mode: 'long_connection',
            started: true
          }
        },
        close(payload) {
          closed = payload
        },
        async replyTextMessage() {}
      }
    }
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'manager feishu-serve')
  assert.equal(payload.channel_state.started, true)
  assert.equal(payload.bootstrap.seeded_project_count, 6)
  assert.deepEqual(closed, {
    force: true
  })
})

test('manager intake-message creates a planned manager session through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  const result = await executeCli({
    argv: [
      'manager',
      'intake-message',
      '--storage-root',
      storageRoot,
      '--text',
      'Check the stock publishing chain.',
      '--json'
    ],
    dependencies: {
      bailianProvider: {
        async invokeByIntent(input) {
          assert.equal(input.intent, 'plan')

          return {
            route: {
              provider: 'bailian',
              model: 'codingplan'
            },
            request: {
              base_url: 'https://coding.dashscope.aliyuncs.com/v1',
              model: 'codingplan'
            },
            response: {
              id: 'chatcmpl-intake',
              model: 'codingplan',
              finish_reason: 'stop',
              usage: {
                total_tokens: 88
              },
              content: JSON.stringify({
                summary: '先排查股票站点，再确认发布基础设施。',
                project_keys: ['uwillberich', 'deploy-hub'],
                operator_reply: '我先查 uwillberich 和 deploy-hub，再回你结论。',
                steps: [
                  {
                    title: '检查 uwillberich 当前 release',
                    kind: 'inspect',
                    notes: '确认站点是否指向正确版本'
                  },
                  {
                    title: '检查 deploy-hub 最近发布日志',
                    kind: 'inspect',
                    notes: '确认是否有发布失败'
                  }
                ]
              })
            }
          }
        }
      }
    }
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'manager intake-message')
  assert.equal(payload.planning.plan.steps.length, 2)
  assert.match(payload.ack_text, /uwillberich/)
})

test('manager step-run executes the current safe inspect step through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  const seeded = await executeCli({
    argv: ['manager', 'bootstrap', '--storage-root', storageRoot, '--json']
  })

  assert.equal(seeded.exitCode, 0)

  const intake = await executeCli({
    argv: [
      'manager',
      'intake-message',
      '--storage-root',
      storageRoot,
      '--text',
      '检查 uwillberich 当前配置',
      '--json'
    ],
    dependencies: {
      bailianProvider: {
        async invokeByIntent() {
          return {
            route: {
              provider: 'bailian',
              model: 'codingplan'
            },
            request: {
              base_url: 'https://coding.dashscope.aliyuncs.com/v1',
              model: 'codingplan'
            },
            response: {
              content: JSON.stringify({
                summary: '先读取项目注册信息。',
                project_keys: ['uwillberich'],
                operator_reply: '先看 uwillberich 注册信息。',
                steps: [
                  {
                    title: '检查 uwillberich 当前配置',
                    kind: 'inspect'
                  }
                ]
              })
            }
          }
        }
      }
    }
  })
  const intakePayload = JSON.parse(intake.stdout)

  const result = await executeCli({
    argv: [
      'manager',
      'step-run',
      '--storage-root',
      storageRoot,
      '--session-id',
      intakePayload.session_id,
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'manager step-run')
  assert.equal(payload.status, 'completed')
  assert.equal(payload.selection.tool_name, 'project_get_registry')
})

test('manager loop-run executes consecutive safe inspect steps through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  await executeCli({
    argv: ['manager', 'bootstrap', '--storage-root', storageRoot, '--json']
  })

  const intake = await executeCli({
    argv: [
      'manager',
      'intake-message',
      '--storage-root',
      storageRoot,
      '--text',
      '检查 uwillberich 配置和在线状态',
      '--json'
    ],
    dependencies: {
      bailianProvider: {
        async invokeByIntent() {
          return {
            route: {
              provider: 'bailian',
              model: 'codingplan'
            },
            request: {
              base_url: 'https://coding.dashscope.aliyuncs.com/v1',
              model: 'codingplan'
            },
            response: {
              content: JSON.stringify({
                summary: '先看配置，再看在线状态。',
                project_keys: ['uwillberich'],
                operator_reply: '先查配置，再探活。',
                steps: [
                  {
                    title: '检查 uwillberich 当前配置',
                    kind: 'inspect'
                  },
                  {
                    title: '检查 uwillberich API 在线状态',
                    kind: 'inspect',
                    depends_on: [1]
                  }
                ]
              })
            }
          }
        }
      }
    }
  })
  const intakePayload = JSON.parse(intake.stdout)

  const result = await executeCli({
    argv: [
      'manager',
      'loop-run',
      '--storage-root',
      storageRoot,
      '--session-id',
      intakePayload.session_id,
      '--max-steps',
      '2',
      '--json'
    ],
    dependencies: {
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return `health ok ${url}`
        }
      })
    }
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'manager loop-run')
  assert.equal(payload.runs.length, 2)
  assert.equal(payload.runs[0].selection.tool_name, 'project_get_registry')
  assert.equal(payload.runs[1].selection.tool_name, 'project_probe_endpoint')
})

test('resume returns a persisted session snapshot', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Resume via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Load this session later',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const resumed = await executeCli({
    argv: [
      'resume',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--json'
    ]
  })

  assert.equal(resumed.exitCode, 0)

  const resumedPayload = JSON.parse(resumed.stdout)
  assert.equal(resumedPayload.command, 'resume')
  assert.equal(resumedPayload.session.id, startedPayload.session.id)
  assert.equal(resumedPayload.timeline_count, 3)
})

test('status returns a compact operational snapshot', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Status via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Inspect current session state',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const status = await executeCli({
    argv: [
      'status',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--json'
    ]
  })

  assert.equal(status.exitCode, 0)

  const payload = JSON.parse(status.stdout)
  assert.equal(payload.command, 'status')
  assert.equal(payload.session_id, startedPayload.session.id)
  assert.equal(payload.session_status, 'planning')
  assert.equal(payload.task_status, 'draft')
  assert.equal(payload.pending_approvals, 0)
})

test('timeline supports limiting the returned event window', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Timeline via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Inspect timeline output later',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  await executeCli({
    argv: [
      'status',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id
    ]
  })

  const timeline = await executeCli({
    argv: [
      'timeline',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--limit',
      '2',
      '--json'
    ]
  })

  assert.equal(timeline.exitCode, 0)

  const payload = JSON.parse(timeline.stdout)
  assert.equal(payload.command, 'timeline')
  assert.equal(payload.session_id, startedPayload.session.id)
  assert.equal(payload.events.length, 2)
  assert.equal(payload.events[0].kind, 'task_created')
  assert.equal(payload.events[1].kind, 'user_message_added')
})

test('hooks list returns filtered hook events through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  const hookBus = createHookBus({ storageRoot })

  await hookBus.emit({
    name: 'manager.planning.started',
    sessionId: 'session-hook-1',
    payload: {
      step_count: 2
    }
  })
  await hookBus.emit({
    name: 'manager.planning.completed',
    sessionId: 'session-hook-1',
    payload: {
      step_count: 2
    }
  })

  const result = await executeCli({
    argv: [
      'hooks',
      'list',
      '--storage-root',
      storageRoot,
      '--session-id',
      'session-hook-1',
      '--name',
      'manager.planning.completed',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'hooks list')
  assert.equal(payload.events.length, 1)
  assert.equal(payload.events[0].name, 'manager.planning.completed')
})

test('missing required arguments returns a non-zero result with a clear error', async () => {
  const result = await executeCli({
    argv: ['start', '--json']
  })

  assert.equal(result.exitCode, 1)
  assert.equal(result.stdout, '')

  const payload = JSON.parse(result.stderr)
  assert.equal(payload.error, 'Missing required option: --title')
})

test('debug session-get returns the current session object', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Debug session get via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Read the session through debug CLI',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const result = await executeCli({
    argv: [
      'debug',
      'session-get',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'debug session-get')
  assert.equal(payload.session.id, startedPayload.session.id)
  assert.equal(payload.session.status, 'planning')
})

test('debug task-patch mutates task state directly through local CLI', async () => {
  const storageRoot = await createStorageRoot()
  const store = createStore(storageRoot)
  const created = await store.createSession({
    title: 'Debug patch via CLI',
    projectKey: 'newagent',
    userRequest: 'Patch the task state locally'
  })

  const result = await executeCli({
    argv: [
      'debug',
      'task-patch',
      '--storage-root',
      storageRoot,
      '--session-id',
      created.session.id,
      '--patch-json',
      JSON.stringify({
        status: 'blocked',
        result: 'Patched from CLI'
      }),
      '--json'
    ]
  })
  const loaded = await store.loadSession(created.session.id)

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'debug task-patch')
  assert.equal(payload.entity, 'task')
  assert.equal(payload.value.status, 'blocked')
  assert.equal(loaded.task.result, 'Patched from CLI')
  assert.equal(loaded.timeline.at(-1).kind, 'debug_state_patched')
})

test('approve resolves a pending approval and returns the updated approval object', async () => {
  const storageRoot = await createStorageRoot()
  const store = createStore(storageRoot)
  const created = await store.createSession({
    title: 'Approve via CLI',
    projectKey: 'newagent',
    userRequest: 'Approve this pending action'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Edit one tracked file',
        kind: 'implementation'
      }
    ]
  })

  const snapshot = await store.loadSession(created.session.id)
  const approval = await store.requestApproval(created.session.id, {
    stepId: snapshot.plan_steps[0].id,
    toolName: 'write_file',
    permissionClass: 'dangerous',
    reason: 'Needs approval before file mutation',
    requestedInput: {
      path: 'docs/file.md'
    }
  })

  const result = await executeCli({
    argv: [
      'approve',
      '--storage-root',
      storageRoot,
      '--session-id',
      created.session.id,
      '--approval-id',
      approval.id,
      '--resolved-by',
      'user',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'approve')
  assert.equal(payload.approval.status, 'approved')
  assert.equal(payload.session_status, 'planning')
})

test('approve --continue resolves approval and completes the stored dangerous step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-cli-approve-continue-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const store = createStore(storageRoot)
  const created = await store.createSession({
    title: 'Approve continue via CLI',
    projectKey: 'newagent',
    userRequest: 'Continue the dangerous step from approve'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Write one approved file',
        kind: 'implementation'
      }
    ]
  })

  const targetPath = join(workspaceRoot, 'approve-continue.txt')
  const waiting = await executeCli({
    argv: [
      'step-run',
      '--storage-root',
      storageRoot,
      '--workspace-root',
      workspaceRoot,
      '--session-id',
      created.session.id,
      '--input',
      'Pause on the dangerous write.',
      '--tool-name',
      'write_file',
      '--tool-input-json',
      JSON.stringify({
        path: targetPath,
        content: 'approve continue path\n'
      }),
      '--json'
    ]
  })
  const waitingPayload = JSON.parse(waiting.stdout)

  const approved = await executeCli({
    argv: [
      'approve',
      '--storage-root',
      storageRoot,
      '--workspace-root',
      workspaceRoot,
      '--session-id',
      created.session.id,
      '--approval-id',
      waitingPayload.tool_result.approval.id,
      '--resolved-by',
      'user',
      '--continue',
      '--input',
      'Continue the approved write now.',
      '--json'
    ]
  })

  assert.equal(approved.exitCode, 0)

  const payload = JSON.parse(approved.stdout)
  assert.equal(payload.command, 'approve')
  assert.equal(payload.approval.status, 'approved')
  assert.equal(payload.execution.status, 'completed')
  assert.equal(payload.execution.tool_result.status, 'ok')
})

test('reject resolves a pending approval into blocked state', async () => {
  const storageRoot = await createStorageRoot()
  const store = createStore(storageRoot)
  const created = await store.createSession({
    title: 'Reject via CLI',
    projectKey: 'newagent',
    userRequest: 'Reject this pending action'
  })

  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Edit one tracked file',
        kind: 'implementation'
      }
    ]
  })

  const snapshot = await store.loadSession(created.session.id)
  const approval = await store.requestApproval(created.session.id, {
    stepId: snapshot.plan_steps[0].id,
    toolName: 'write_file',
    permissionClass: 'dangerous',
    reason: 'Needs approval before file mutation',
    requestedInput: {
      path: 'docs/file.md'
    }
  })

  const result = await executeCli({
    argv: [
      'reject',
      '--storage-root',
      storageRoot,
      '--session-id',
      created.session.id,
      '--approval-id',
      approval.id,
      '--resolved-by',
      'user',
      '--note',
      'not allowed',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'reject')
  assert.equal(payload.approval.status, 'rejected')
  assert.equal(payload.session_status, 'blocked')
})

test('abort marks the session as aborted', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Abort via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Abort this session',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const result = await executeCli({
    argv: [
      'abort',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--reason',
      'user_cancelled',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'abort')
  assert.equal(payload.session_status, 'aborted')
  assert.equal(payload.task_status, 'aborted')
})

test('context-build returns an inspectable bounded context payload', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Context build via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Build a bounded execution context',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const result = await executeCli({
    argv: [
      'context-build',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--input',
      'Assemble the next execution context.',
      '--max-sections',
      '2',
      '--max-characters',
      '120',
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'context-build')
  assert.equal(payload.selection.session_id, startedPayload.session.id)
  assert.equal(payload.selection.sources[0].kind, 'current_input')
  assert.ok(payload.merged_context.total_characters <= 120)
  assert.ok(payload.merged_context.sections.length <= 2)
})

test('memory add writes a project memory entry and memory search finds it', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Memory via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Persist one durable memory entry',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const added = await executeCli({
    argv: [
      'memory',
      'add',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--scope',
      'project',
      '--kind',
      'constraint',
      '--content',
      'Keep Feishu on a local long-lived connection.',
      '--tags',
      'feishu,constraint',
      '--json'
    ]
  })

  assert.equal(added.exitCode, 0)

  const searched = await executeCli({
    argv: [
      'memory',
      'search',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--scope',
      'project',
      '--query',
      'long-lived',
      '--json'
    ]
  })

  assert.equal(searched.exitCode, 0)

  const payload = JSON.parse(searched.stdout)
  assert.equal(payload.command, 'memory search')
  assert.equal(payload.matches.length, 1)
  assert.equal(payload.matches[0].kind, 'constraint')
})

test('step-run executes a safe current step through the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-cli-step-run-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  const store = createStore(storageRoot)
  const created = await store.createSession({
    title: 'Step run via CLI',
    projectKey: 'newagent',
    userRequest: 'Execute one safe step from the command surface'
  })
  await store.createPlan(created.session.id, {
    steps: [
      {
        title: 'Read one workspace file',
        kind: 'implementation'
      }
    ]
  })

  const filePath = join(workspaceRoot, 'note.txt')
  await writeFile(filePath, 'step run from cli\n', 'utf8')

  const result = await executeCli({
    argv: [
      'step-run',
      '--storage-root',
      storageRoot,
      '--workspace-root',
      workspaceRoot,
      '--session-id',
      created.session.id,
      '--input',
      'Read the workspace note through the executor.',
      '--tool-name',
      'read_file',
      '--tool-input-json',
      JSON.stringify({
        path: filePath
      }),
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'step-run')
  assert.equal(payload.status, 'completed')
  assert.equal(payload.tool_result.status, 'ok')
})

test('plan-create creates ordered plan steps through the CLI', async () => {
  const storageRoot = await createStorageRoot()
  const started = await executeCli({
    argv: [
      'start',
      '--storage-root',
      storageRoot,
      '--title',
      'Plan create via CLI',
      '--project-key',
      'newagent',
      '--request',
      'Create one plan from the command surface',
      '--json'
    ]
  })
  const startedPayload = JSON.parse(started.stdout)

  const result = await executeCli({
    argv: [
      'plan-create',
      '--storage-root',
      storageRoot,
      '--session-id',
      startedPayload.session.id,
      '--steps-json',
      JSON.stringify([
        {
          title: 'Read one file',
          kind: 'implementation'
        },
        {
          title: 'Review output',
          kind: 'verification'
        }
      ]),
      '--json'
    ]
  })

  assert.equal(result.exitCode, 0)

  const payload = JSON.parse(result.stdout)
  assert.equal(payload.command, 'plan-create')
  assert.equal(payload.steps.length, 2)
  assert.equal(payload.task.status, 'planned')
  assert.equal(payload.steps[0].status, 'ready')
  assert.equal(payload.steps[1].status, 'pending')
})
