import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAgentRuntime } from './agent-runtime.js'
import { createSessionStore } from '../session/session-store.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createMemoryStore } from '../memory/memory-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createAgentProfile } from './agent-profile.js'

async function createHarness({
  nowFn = Date.now,
  enableExternalReview = false,
  agentExecutor = null,
  feishuAppendMergeWindowMs = undefined,
  plannerDelayMs = 0,
  fetchDelayMs = 0,
  progressReplyDelayMs = 2000,
  longRunningFeedbackMs = undefined,
  longRunningCheckpointMs = undefined,
  longRunningExtensionApprovalMs = undefined,
  longRunningFinalStopMs = undefined,
  plannerResponse = null,
  operateResponse = null,
  evaluationResponse = {
    verdict: 'pass',
    summary: '外部复核通过。',
    issues: [],
    constraints: []
  }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'newagent-agent-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const replies = []
  const plannerCalls = []
  const summaryCalls = []
  const conversationCalls = []
  const evaluationCalls = []
  const backgroundCalls = []
  const providerCalls = []
  let generatedReplyId = 0
  const agentProfile = createAgentProfile({
    env: enableExternalReview
      ? {
          NEWAGENT_ENABLE_EXTERNAL_REVIEW: 'true',
          NEWAGENT_EXTERNAL_REVIEW_MODEL: 'stepfun/step-3.5-flash:free'
        }
      : {}
  })
  const feishuGateway = {
    startOptions: null,
    async addMessageReaction(payload) {
      replies.push({
        method: 'addMessageReaction',
        ...payload
      })
      return {
        ok: true,
        data: {
          reaction_id: `${payload.messageId}:${payload.emojiType}:${replies.length}`
        }
      }
    },
    async deleteMessageReaction(payload) {
      replies.push({
        method: 'deleteMessageReaction',
        ...payload
      })
      return {
        ok: true
      }
    },
    async sendTextMessage(payload) {
      generatedReplyId += 1
      replies.push({
        method: 'sendTextMessage',
        ...payload
      })
      return {
        ok: true,
        data: {
          message_id: `om_generated_${generatedReplyId}`
        }
      }
    },
    async replyTextMessage(payload) {
      generatedReplyId += 1
      replies.push({
        method: 'replyTextMessage',
        ...payload
      })
      return {
        ok: true,
        data: {
          message_id: `om_generated_${generatedReplyId}`
        }
      }
    },
    async updateTextMessage(payload) {
      replies.push({
        method: 'updateTextMessage',
        ...payload
      })
      return {
        ok: true,
        data: {
          message_id: payload.messageId
        }
      }
    },
    async sendInteractiveCard(payload) {
      generatedReplyId += 1
      replies.push({
        method: 'sendInteractiveCard',
        ...payload
      })
      return {
        ok: true,
        data: {
          message_id: `om_generated_${generatedReplyId}`
        }
      }
    },
    async replyInteractiveCard(payload) {
      generatedReplyId += 1
      replies.push({
        method: 'replyInteractiveCard',
        ...payload
      })
      return {
        ok: true,
        data: {
          message_id: `om_generated_${generatedReplyId}`
        }
      }
    },
    async start({ onMessage }) {
      this.startOptions = arguments[0]
      this.onMessage = onMessage
      return {
        channel: 'feishu',
        connection_mode: 'long_connection',
        started: true
      }
    }
  }

  return {
    storageRoot,
    workspaceRoot,
    replies,
    plannerCalls,
    summaryCalls,
    conversationCalls,
    evaluationCalls,
    backgroundCalls,
    providerCalls,
    feishuGateway,
    runtime: createAgentRuntime({
      storageRoot,
      workspaceRoot,
      agentProfile,
      agentExecutor,
      nowFn,
      feishuAppendMergeWindowMs,
      progressReplyDelayMs,
      longRunningFeedbackMs,
      longRunningCheckpointMs,
      longRunningExtensionApprovalMs,
      longRunningFinalStopMs,
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          if (fetchDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, fetchDelayMs))
          }

          return `health ok ${url}`
        }
      }),
      feishuGateway,
      bailianProvider: {
        async invokeByIntent(input) {
          providerCalls.push(input)

          if (plannerDelayMs > 0 && input.intent !== 'evaluate' && input.intent !== 'summarize') {
            await new Promise((resolve) => setTimeout(resolve, plannerDelayMs))
          }

          if (input.intent === 'evaluate') {
            evaluationCalls.push(input)

            return {
              route: {
                provider: 'openrouter',
                model: 'stepfun/step-3.5-flash:free'
              },
              request: {
                base_url: 'https://openrouter.ai/api/v1',
                model: 'stepfun/step-3.5-flash:free'
              },
              response: {
                id: 'chatcmpl-agent-evaluate',
                model: 'stepfun/step-3.5-flash:free',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 88
                },
                content: JSON.stringify(evaluationResponse)
              }
            }
          }

          if (input.intent === 'background') {
            backgroundCalls.push(input)

            return {
              route: {
                provider: 'openrouter',
                model: 'stepfun/step-3.5-flash:free'
              },
              request: {
                base_url: 'https://openrouter.ai/api/v1',
                model: 'stepfun/step-3.5-flash:free'
              },
              response: {
                id: 'chatcmpl-agent-background',
                model: 'stepfun/step-3.5-flash:free',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 72
                },
                content: JSON.stringify({
                  summary: '当前重点是快答改动范围、进度和下一步。',
                  operator_focuses: ['这次到底改了什么', '现在做到哪了'],
                  likely_followups: ['是不是大改了', '改了哪里'],
                  ready_replies: [
                    {
                      trigger: '改了哪里',
                      question: '这次主要改了哪里',
                      reply: '这次主要改了超时机制、基础设施 registry 和飞书回复链路。'
                    }
                  ],
                  next_checks: ['继续收紧 direct reply 和引用消息注意力'],
                  attention_rules: ['当前用户消息优先，别先倒项目表']
                })
              }
            }
          }

          if (input.intent === 'summary') {
            conversationCalls.push(input)

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
                id: 'chatcmpl-agent-conversation',
                model: 'qwen3.5-plus',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 84
                },
                content: '算是中等改动。核心是补了超时机制、基础设施 registry，还有飞书回复链路的收口，不是推翻重写。'
              }
            }
          }

          if (input.intent === 'summarize') {
            summaryCalls.push(input)

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
                id: 'chatcmpl-agent-summary',
                model: 'qwen3.5-plus',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 96
                },
                content: JSON.stringify({
                  summary: '累计来看，当前主要在跟进 uwillberich 与 deploy-hub 的排查结果。',
                  facts: [
                    'uwillberich 和 deploy-hub 是最近几轮关注的重点项目。'
                  ],
                  open_loops: [
                    '继续跟进上一轮尚未收敛的排查结论。'
                  ],
                  preferences: [
                    '先快速确认收到，再给处理结论。'
                  ]
                })
              }
            }
          }

          if (input.intent === 'operate') {
            const resolvedOperateResponse = typeof operateResponse === 'function'
              ? operateResponse({
                  workspaceRoot
                })
              : operateResponse

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
                id: 'chatcmpl-agent-operate',
                model: 'qwen3.5-plus',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 48
                },
                content: JSON.stringify(resolvedOperateResponse ?? {
                  cwd: workspaceRoot,
                  command: 'pwd',
                  summary: '检查当前工作目录。',
                  timeout_ms: 1000
                })
              }
            }
          }

          plannerCalls.push(input)

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
              id: 'chatcmpl-agent',
              model: 'codingplan',
              finish_reason: 'stop',
              usage: {
                total_tokens: 120
              },
              content: JSON.stringify(plannerResponse ?? {
                summary: '先检查股票项目发布链，再确认 deploy-hub 是否异常。',
                project_keys: ['uwillberich', 'deploy-hub'],
                operator_reply: '先查 uwillberich 和 deploy-hub，再给你回执行结论。',
                steps: [
                  {
                    title: '检查 uwillberich 发布目录和当前 release',
                    kind: 'inspect',
                    notes: '确认站点当前指向'
                  },
                  {
                    title: '检查 deploy-hub 最近的发布票据和日志',
                    kind: 'inspect',
                    notes: '确认基础设施是否异常',
                    depends_on: [1]
                  }
                ]
              })
            }
          }
        }
      }
    }),
    sessionStore: createSessionStore({ storageRoot }),
    projectRegistry: createProjectRegistry({ storageRoot }),
    memoryStore: createMemoryStore({ storageRoot }),
    hookBus: createHookBus({ storageRoot })
  }
}

test('bootstrapServerBaseline seeds the six known aliyun projects', async () => {
  const { runtime, projectRegistry } = await createHarness()
  const result = await runtime.bootstrapServerBaseline()
  const projects = await projectRegistry.listProjects()

  assert.equal(result.seeded_project_count, 6)
  assert.equal(projects.length, 6)
})

test('requestCoworkerHelp and resolveCoworkerRequest persist a Mac-local Qwen exchange', async () => {
  const { runtime, sessionStore, memoryStore, hookBus } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Need one Qwen exchange',
    projectKey: 'newagent',
    userRequest: 'Create one coworker request'
  })

  const request = await runtime.requestCoworkerHelp({
    sessionId: created.session.id,
    question: '请确认 ssh-channel 先走长轮询是不是合理。',
    context: '目标是先联系本机 Qwen。'
  })
  const resolved = await runtime.resolveCoworkerRequest({
    requestId: request.id,
    answer: '合理，先别做真双向 socket。',
    resolvedBy: 'qwen_mac_local'
  })
  const snapshot = await sessionStore.loadSession(created.session.id)
  const memory = await memoryStore.searchMemoryEntries({
    sessionId: created.session.id,
    scope: 'session',
    query: 'Mac-local Qwen replied'
  })
  const hooks = await hookBus.listEvents({
    sessionId: created.session.id
  })

  assert.equal(request.target, 'qwen_mac_local')
  assert.equal(resolved.status, 'resolved')
  assert.ok(snapshot.timeline.some((event) => event.kind === 'coworker_request_created'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'coworker_request_resolved'))
  assert.equal(memory.length, 1)
  assert.ok(hooks.some((event) => event.name === 'coworker.request.created'))
  assert.ok(hooks.some((event) => event.name === 'coworker.request.resolved'))
})

test('handleChannelMessage records positive confirmation signals as reusable memory', async () => {
  const { runtime, memoryStore } = await createHarness()

  await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_confirm_1',
      chat_id: 'oc_confirm',
      sender_open_id: 'ou_confirm',
      text: '先看看 deploy-hub 最近有没有异常'
    },
    autoExecuteSafeInspect: false
  })
  const second = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_confirm_2',
      chat_id: 'oc_confirm',
      sender_open_id: 'ou_confirm',
      text: '就这样'
    },
    autoExecuteSafeInspect: false
  })
  const confirmationSignals = await memoryStore.searchMemoryEntries({
    sessionId: second.session_id,
    scope: 'project',
    tag: 'confirmation_signal'
  })

  assert.equal(confirmationSignals.length, 1)
  assert.match(confirmationSignals[0].content, /用户确认上一轮有效做法可继续沿用/)
})

test('handleChannelMessage answers a quoted follow-up question directly without replanning', async () => {
  const { runtime, sessionStore, replies, plannerCalls, conversationCalls } = await createHarness()

  const first = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_followup_1',
      chat_id: 'oc_followup',
      sender_open_id: 'ou_followup',
      text: '先看看 deploy-hub 最近有没有异常'
    },
    autoExecuteSafeInspect: false
  })
  const firstSnapshot = await sessionStore.loadSession(first.session_id)
  const referencedMessageId = firstSnapshot.timeline
    .filter((event) =>
      event.kind === 'assistant_message_added'
      && event.payload?.stage === 'final_reply'
      && event.payload?.message_id
    )
    .at(-1)?.payload?.message_id

  const second = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_followup_2',
      chat_id: 'oc_followup',
      sender_open_id: 'ou_followup',
      text: '是不是大改了，改了哪里？',
      parent_message_id: referencedMessageId,
      referenced_message_ids: [referencedMessageId]
    },
    autoExecuteSafeInspect: false
  })

  assert.equal(first.session_id, second.session_id)
  assert.equal(plannerCalls.length, 1)
  assert.equal(conversationCalls.length, 1)
  assert.equal(second.planning, null)
  assert.equal(second.execution, null)
  assert.match(second.direct_reply.text, /超时机制|registry|飞书回复链路/)
  assert.match(conversationCalls[0].prompt, /ATTENTION STACK:/)
  assert.match(conversationCalls[0].prompt, /REFERENCED MESSAGE:/)
})

test('handleChannelMessage answers a self-reflection question directly without turning it into server inspection', async () => {
  const { runtime, plannerCalls, replies } = await createHarness()

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_self_1',
      chat_id: 'oc_self',
      sender_open_id: 'ou_self',
      text: '小云，你跑在一台阿里云服务器上你知道的吧。我 mac 电脑上的 Qwen 一直在帮助你变得更好。我刚刚和它一起给你做了很多新特性的改造和赋能，你再想想是哪些？'
    },
    autoExecuteSafeInspect: false
  })

  assert.equal(plannerCalls.length, 0)
  assert.equal(result.planning, null)
  assert.equal(result.execution, null)
  assert.equal(result.direct_reply.source, 'self_reflection')
  assert.match(result.direct_reply.text, /阿里云服务器/)
  assert.match(result.direct_reply.text, /Mac 上的 Qwen/)
  assert.match(result.direct_reply.text, /飞书回复更重排版/)
  assert.equal(
    replies.some((entry) => entry.method === 'replyInteractiveCard'),
    true
  )
})

test('handleChannelMessage can use external review as a second judge before auto execution', async () => {
  const { runtime, memoryStore, evaluationCalls } = await createHarness({
    enableExternalReview: true,
    evaluationResponse: {
      verdict: 'block',
      summary: '外部复核认为当前计划还缺少上一轮承接。',
      issues: ['缺少上一轮未完成事项的显式承接'],
      constraints: ['外部复核要求先明确上一轮未完成事项，再自动推进。']
    }
  })
  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_eval_block',
      chat_id: 'oc_eval_block',
      sender_open_id: 'ou_eval_block',
      text: '继续刚才那个 deploy 问题'
    }
  })
  const qualityConstraints = await memoryStore.searchMemoryEntries({
    sessionId: result.session_id,
    scope: 'session',
    tag: 'quality_constraint'
  })

  assert.equal(result.execution, null)
  assert.match(result.ack_text, /外部复核提示/)
  assert.match(result.ack_text, /暂不自动推进/)
  assert.equal(qualityConstraints.length, 1)
  assert.equal(evaluationCalls.length, 1)
  assert.match(evaluationCalls[0].prompt, /CANDIDATE PLAN:/)
})

test('runFeishuMaintenanceOnce compacts due Feishu context in the background loop', async () => {
  let currentTime = Date.now()
  const { runtime, memoryStore, summaryCalls } = await createHarness({
    nowFn: () => currentTime
  })

  const first = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_maintenance_1',
      chat_id: 'oc_maintenance',
      sender_open_id: 'ou_maintenance',
      text: '先检查 deploy-hub 最近的发布情况'
    },
    autoExecuteSafeInspect: false
  })

  currentTime += 6 * 60 * 60 * 1000

  const maintenance = await runtime.runFeishuMaintenanceOnce()
  const compactedEntries = await memoryStore.searchMemoryEntries({
    sessionId: first.session_id,
    scope: 'session',
    tag: 'context_compaction'
  })

  assert.equal(maintenance.status, 'compacted')
  assert.equal(summaryCalls.length, 1)
  assert.equal(compactedEntries.length, 1)
})

test('startFeishuLoop bootstraps projects and registers the Feishu onMessage handler', async () => {
  const { runtime, feishuGateway, projectRegistry } = await createHarness()
  const result = await runtime.startFeishuLoop()
  const projects = await projectRegistry.listProjects()

  assert.equal(result.bootstrap.seeded_project_count, 6)
  assert.equal(result.channel_state.started, true)
  assert.equal(result.maintenance_state.started, true)
  assert.equal(typeof feishuGateway.onMessage, 'function')
  assert.equal(feishuGateway.startOptions.immediateReactionEmojiType, 'SMILE')
  assert.equal(feishuGateway.startOptions.immediateReplyText, '已读喵，我在看啦。')
  assert.equal(projects.length, 6)
})

test('startFeishuLoop preserves existing project registry overrides while filling baseline gaps', async () => {
  const { runtime, projectRegistry, workspaceRoot } = await createHarness()
  const customDeployHubRoot = join(workspaceRoot, 'custom-deploy-hub')

  await runtime.bootstrapServerBaseline()
  await mkdir(customDeployHubRoot, { recursive: true })
  await projectRegistry.registerProject({
    project_key: 'deploy-hub',
    name: 'deploy-hub',
    tier: 'minor',
    role: 'Static site publish infrastructure',
    source_root: customDeployHubRoot,
    runtime_root: join(workspaceRoot, 'custom-deploy-runtime'),
    publish_root: join(workspaceRoot, 'custom-published'),
    public_base_path: '/apps/custom/',
    pm2_name: 'deploy-hub-custom',
    service_endpoint: 'http://127.0.0.1:3901/_deploy/ticket',
    status: 'active'
  })

  const result = await runtime.startFeishuLoop()
  const deployHub = await projectRegistry.getProject('deploy-hub')

  assert.equal(result.bootstrap.seeded_project_count, 0)
  assert.equal(result.bootstrap.seeded_infra_project_count, 0)
  assert.equal(deployHub?.source_root, customDeployHubRoot)
  assert.equal(deployHub?.runtime_root, join(workspaceRoot, 'custom-deploy-runtime'))
  assert.equal(deployHub?.pm2_name, 'deploy-hub-custom')
})

test('startFeishuLoop batches consecutive Feishu messages into one turn after a short quiet window', async () => {
  const { runtime, feishuGateway, plannerCalls, sessionStore } = await createHarness({
    feishuAppendMergeWindowMs: 10
  })

  await runtime.startFeishuLoop()

  const firstResultPromise = feishuGateway.onMessage({
    message_id: 'om_batch_1',
    chat_id: 'oc_batch',
    sender_open_id: 'ou_batch',
    text: '先看 deploy-hub'
  })

  await new Promise((resolve) => setTimeout(resolve, 1))

  const secondResultPromise = feishuGateway.onMessage({
    message_id: 'om_batch_2',
    chat_id: 'oc_batch',
    sender_open_id: 'ou_batch',
    text: '再顺手看 uwillberich'
  })

  const firstResult = await firstResultPromise
  const secondResult = await secondResultPromise
  const snapshot = await sessionStore.loadSession(firstResult.session_id)
  const receivedEvents = snapshot.timeline.filter((event) => event.kind === 'channel_message_received')

  assert.equal(firstResult.session_id, secondResult.session_id)
  assert.equal(plannerCalls.length, 1)
  assert.equal(snapshot.task.user_request, '先看 deploy-hub\n再顺手看 uwillberich')
  assert.equal(receivedEvents.length, 2)
  assert.equal(receivedEvents[0].payload.message_id, 'om_batch_1')
  assert.equal(receivedEvents[1].payload.message_id, 'om_batch_2')
})

test('startFeishuLoop queues appended Feishu messages behind an active turn and handles them next', async () => {
  const { runtime, feishuGateway, plannerCalls, sessionStore } = await createHarness({
    feishuAppendMergeWindowMs: 5,
    plannerDelayMs: 30
  })

  await runtime.startFeishuLoop()

  const firstResultPromise = feishuGateway.onMessage({
    message_id: 'om_queue_1',
    chat_id: 'oc_queue',
    sender_open_id: 'ou_queue',
    text: '先看 deploy-hub'
  })

  await new Promise((resolve) => setTimeout(resolve, 12))

  const secondResultPromise = feishuGateway.onMessage({
    message_id: 'om_queue_2',
    chat_id: 'oc_queue',
    sender_open_id: 'ou_queue',
    text: '再看 worker 状态'
  })

  const firstResult = await firstResultPromise
  const secondResult = await secondResultPromise
  const snapshot = await sessionStore.loadSession(secondResult.session_id)

  assert.equal(firstResult.session_id, secondResult.session_id)
  assert.equal(plannerCalls.length, 2)
  assert.equal(snapshot.task.user_request, '补充建议：再看 worker 状态')
  assert.equal(
    snapshot.timeline.filter((event) => event.kind === 'session_turn_started').length >= 1,
    true
  )
  assert.match(plannerCalls[1].prompt, /RECENT TRANSCRIPT:/)
  assert.match(plannerCalls[1].prompt, /补充建议：再看 worker 状态/)
})

test('startFeishuLoop updates the Feishu reply mode through /fast and reports it via /status', async () => {
  const { runtime, feishuGateway } = await createHarness()

  await runtime.startFeishuLoop()

  const fastResult = await feishuGateway.onMessage({
    message_id: 'om_fast_mode',
    chat_id: 'oc_fast_mode',
    sender_open_id: 'ou_fast_mode',
    text: '/fast'
  })
  const statusResult = await feishuGateway.onMessage({
    message_id: 'om_fast_status',
    chat_id: 'oc_fast_mode',
    sender_open_id: 'ou_fast_mode',
    text: '/status'
  })

  assert.match(fastResult.ack_text, /快回/)
  assert.match(statusResult.ack_text, /fast/)
  assert.match(statusResult.ack_text, /当前模式/)
})

test('startFeishuLoop accepts /appendmsg and queues appended suggestions behind the active turn', async () => {
  const { runtime, feishuGateway, plannerCalls, sessionStore } = await createHarness({
    feishuAppendMergeWindowMs: 5,
    plannerDelayMs: 30
  })

  await runtime.startFeishuLoop()

  const firstResultPromise = feishuGateway.onMessage({
    message_id: 'om_append_1',
    chat_id: 'oc_append',
    sender_open_id: 'ou_append',
    text: '先看 deploy-hub'
  })

  await new Promise((resolve) => setTimeout(resolve, 12))

  const appendResult = await feishuGateway.onMessage({
    message_id: 'om_append_2',
    chat_id: 'oc_append',
    sender_open_id: 'ou_append',
    text: '/appendmsg 再看 worker 状态'
  })

  const firstResult = await firstResultPromise

  await new Promise((resolve) => setTimeout(resolve, 120))

  const snapshot = await sessionStore.loadSession(firstResult.session_id)

  assert.match(appendResult.ack_text, /已追加/)
  assert.equal(plannerCalls.length, 2)
  assert.equal(snapshot.task.user_request, '补充建议：再看 worker 状态')
  assert.match(plannerCalls[1].prompt, /补充建议：再看 worker 状态/)
})

test('startFeishuLoop auto-appends direct follow-up cues behind the active turn and marks them queued', async () => {
  const { runtime, feishuGateway, plannerCalls, sessionStore, replies } = await createHarness({
    feishuAppendMergeWindowMs: 5,
    plannerDelayMs: 30
  })

  await runtime.startFeishuLoop()

  const firstResultPromise = feishuGateway.onMessage({
    message_id: 'om_auto_append_1',
    chat_id: 'oc_auto_append',
    sender_open_id: 'ou_auto_append',
    text: '先看 deploy-hub'
  })

  await new Promise((resolve) => setTimeout(resolve, 12))

  const secondResultPromise = feishuGateway.onMessage({
    message_id: 'om_auto_append_2',
    chat_id: 'oc_auto_append',
    sender_open_id: 'ou_auto_append',
    text: '顺便也看一下 worker 状态'
  })

  const firstResult = await firstResultPromise
  const secondResult = await secondResultPromise
  const snapshot = await sessionStore.loadSession(secondResult.session_id)
  const queuedReactions = replies.filter((entry) =>
    entry.method === 'addMessageReaction' && entry.messageId === 'om_auto_append_2'
  )

  assert.equal(firstResult.session_id, secondResult.session_id)
  assert.equal(plannerCalls.length, 2)
  assert.equal(snapshot.task.user_request, '补充建议：顺便也看一下 worker 状态')
  assert.match(plannerCalls[1].prompt, /补充建议：顺便也看一下 worker 状态/)
  assert.ok(queuedReactions.length >= 2)
})

test('startFeishuLoop stops the active turn at the next safe point when /stop arrives', async () => {
  const { runtime, feishuGateway, sessionStore } = await createHarness({
    plannerDelayMs: 30,
    progressReplyDelayMs: 0,
    feishuAppendMergeWindowMs: 0
  })

  await runtime.startFeishuLoop()

  const firstResultPromise = feishuGateway.onMessage({
    message_id: 'om_stop_active_1',
    chat_id: 'oc_stop_active',
    sender_open_id: 'ou_stop_active',
    text: '先详细排查 deploy-hub 当前状态'
  })

  await new Promise((resolve) => setTimeout(resolve, 5))

  const stopResult = await feishuGateway.onMessage({
    message_id: 'om_stop_active_2',
    chat_id: 'oc_stop_active',
    sender_open_id: 'ou_stop_active',
    text: '/stop'
  })

  const firstResult = await firstResultPromise

  assert.match(stopResult.ack_text, /stop|停止/)
  assert.equal(firstResult.stopped, true)

  if (firstResult.session_id) {
    const snapshot = await sessionStore.loadSession(firstResult.session_id)
    assert.equal(snapshot.session.status, 'aborted')
  }
})

test('handleChannelMessage sends a 30-second style progress feedback before planning finishes', async () => {
  const { runtime, sessionStore } = await createHarness({
    plannerDelayMs: 30,
    progressReplyDelayMs: 0,
    longRunningFeedbackMs: 5,
    longRunningCheckpointMs: 100,
    longRunningFinalStopMs: 200
  })

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_timeout_warn',
      chat_id: 'oc_timeout_warn',
      sender_open_id: 'ou_timeout_warn',
      text: '帮我细查 deploy-hub 现状'
    },
    autoExecuteSafeInspect: false
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.ok(
    snapshot.timeline.some(
      (event) =>
        ['assistant_message_added', 'assistant_message_updated'].includes(event.kind)
        && event.payload.stage === 'timeout_warning'
    )
  )
})

test('handleChannelMessage requests more time at the checkpoint and defaults to continue after 10 seconds of silence', async () => {
  const { runtime, sessionStore } = await createHarness({
    plannerDelayMs: 30,
    progressReplyDelayMs: 0,
    longRunningFeedbackMs: 5,
    longRunningCheckpointMs: 10,
    longRunningExtensionApprovalMs: 5,
    longRunningFinalStopMs: 200,
    plannerResponse: {
      summary: '先探活 deploy-hub。',
      project_keys: ['deploy-hub'],
      operator_reply: '先探活 deploy-hub，再继续判断后续动作。',
      steps: [
        {
          title: '探活 deploy-hub 服务状态',
          kind: 'inspect',
          notes: '确认 3900 服务是否正常'
        }
      ]
    }
  })

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_timeout_extend',
      chat_id: 'oc_timeout_extend',
      sender_open_id: 'ou_timeout_extend',
      text: '帮我继续查 deploy-hub'
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.equal(result.stopped, false)
  assert.equal(result.execution?.runs?.length >= 1, true)
  assert.ok(
    snapshot.timeline.some(
      (event) =>
        event.kind === 'assistant_message_added'
        && event.payload.stage === 'timeout_extension_request'
    )
  )
  assert.ok(
    snapshot.timeline.some(
      (event) =>
        event.kind === 'agent_timeout_extension_resolved'
        && event.payload.decision === 'default_approved'
    )
  )
})

test('handleChannelMessage degrades gracefully when planner fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-agent-fail-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createAgentRuntime({
    storageRoot,
    feishuGateway: {
      async addMessageReaction(payload) {
        replies.push(payload)
      },
      async sendTextMessage(payload) {
        replies.push(payload)
      },
      async replyTextMessage(payload) {
        replies.push(payload)
      }
    },
    bailianProvider: {
      async invokeByIntent() {
        throw new Error('Missing Bailian API key')
      }
    }
  })
  const sessionStore = createSessionStore({ storageRoot })

  await runtime.bootstrapServerBaseline()

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_fail',
      text: 'Plan this request.'
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.match(result.ack_text, /规划失败/)
  assert.equal(snapshot.plan_steps.length, 0)
  assert.ok(snapshot.timeline.some((event) => event.kind === 'agent_plan_failed'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'session_summary_updated'))
  assert.equal(replies[0].emojiType, 'SMILE')
  assert.ok(replies.filter((entry) => entry.emojiType).length >= 2)
  assert.ok(replies.some((entry) => typeof entry.text === 'string'))
})

test('handleChannelMessage sends a progress update when planning crosses the delay threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-agent-progress-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createAgentRuntime({
    storageRoot,
    progressReplyDelayMs: 0,
    feishuGateway: {
      async addMessageReaction(payload) {
        replies.push(payload)
      },
      async sendTextMessage(payload) {
        replies.push(payload)
      },
      async replyTextMessage(payload) {
        replies.push(payload)
      }
    },
    bailianProvider: {
      async invokeByIntent() {
        await new Promise((resolve) => setTimeout(resolve, 5))

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
            id: 'chatcmpl-agent-progress',
            model: 'codingplan',
            finish_reason: 'stop',
            usage: {
              total_tokens: 32
            },
            content: JSON.stringify({
              summary: '先理解用户想做什么，再汇报。',
              project_keys: ['uwillberich'],
              operator_reply: '我先确认你的意图，再给你执行结论。',
              steps: [
                {
                  title: '确认 uwillberich 当前项目上下文',
                  kind: 'inspect',
                  notes: '这里只验证慢规划时的进度提示'
                }
              ]
            })
          }
        }
      }
    }
  })
  const sessionStore = createSessionStore({ storageRoot })

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_progress',
      sender_open_id: 'ou_progress',
      text: '帮我看看线上到底哪块坏了'
    },
    autoExecuteSafeInspect: false
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.equal(replies[0].emojiType, 'SMILE')
  assert.ok(
    snapshot.timeline.some(
      (event) => event.kind === 'assistant_message_added' && event.payload.stage === 'progress_ack'
    )
  )
})

test('handleChannelMessage records a gateway immediate reaction without sending it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-agent-preacked-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createAgentRuntime({
    storageRoot,
    feishuGateway: {
      async addMessageReaction() {
        throw new Error('duplicate reaction should not be sent')
      },
      async sendTextMessage(payload) {
        replies.push(payload)
      },
      async replyTextMessage(payload) {
        replies.push(payload)
      }
    }
  })
  const sessionStore = createSessionStore({ storageRoot })

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_preacked',
      sender_open_id: 'ou_preacked',
      text: '帮我看下线上状态',
      immediate_ack: {
        kind: 'reaction',
        ok: true,
        source: 'feishu_gateway',
        message_id: 'om_preacked',
        emoji_type: 'SMILE'
      }
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.equal(replies.length, 1)
  assert.match(replies[0].text, /已创建/)
  assert.ok(snapshot.timeline.some((event) => event.kind === 'assistant_reaction_added'))
  assert.equal(
    snapshot.timeline.find((event) => event.kind === 'assistant_reaction_added')?.payload.source,
    'feishu_gateway'
  )
})
