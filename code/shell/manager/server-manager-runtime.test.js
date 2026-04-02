import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServerManagerRuntime } from './server-manager-runtime.js'
import { createSessionStore } from '../session/session-store.js'
import { createProjectRegistry } from '../projects/project-registry.js'
import { createMemoryStore } from '../memory/memory-store.js'
import { createHookBus } from '../hooks/hook-bus.js'
import { createRemoteServerManagerProfile } from './remote-server-manager-profile.js'

async function createHarness({
  nowFn = Date.now,
  enableExternalReview = false,
  evaluationResponse = {
    verdict: 'pass',
    summary: '外部复核通过。',
    issues: [],
    constraints: []
  }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'newagent-server-manager-'))
  const storageRoot = join(root, 'storage')
  const workspaceRoot = join(root, 'workspace')
  const replies = []
  const plannerCalls = []
  const summaryCalls = []
  const evaluationCalls = []
  const providerCalls = []
  const managerProfile = createRemoteServerManagerProfile({
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
      replies.push(payload)
    },
    async sendTextMessage(payload) {
      replies.push(payload)
    },
    async replyTextMessage(payload) {
      replies.push(payload)
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
    evaluationCalls,
    providerCalls,
    feishuGateway,
    runtime: createServerManagerRuntime({
      storageRoot,
      workspaceRoot,
      managerProfile,
      nowFn,
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() {
          return `health ok ${url}`
        }
      }),
      feishuGateway,
      bailianProvider: {
        async invokeByIntent(input) {
          providerCalls.push(input)

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
                id: 'chatcmpl-manager-evaluate',
                model: 'stepfun/step-3.5-flash:free',
                finish_reason: 'stop',
                usage: {
                  total_tokens: 88
                },
                content: JSON.stringify(evaluationResponse)
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
                id: 'chatcmpl-manager-summary',
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
              id: 'chatcmpl-manager',
              model: 'codingplan',
              finish_reason: 'stop',
              usage: {
                total_tokens: 120
              },
              content: JSON.stringify({
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

test('handleChannelMessage creates a manager session and replies through Feishu', async () => {
  const { runtime, sessionStore, replies, plannerCalls, hookBus } = await createHarness()
  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_123',
      chat_id: 'oc_123',
      sender_open_id: 'ou_123',
      text: 'Check the remote stock project.'
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.match(result.ack_text, /已创建/)
  assert.match(result.ack_text, /uwillberich/)
  assert.match(result.ack_text, /已自动推进/)
  assert.match(result.ack_text, /已检查|已读取|已探活/)
  assert.equal(result.planning.plan.steps.length, 2)
  assert.equal(result.execution.runs.length, 2)
  assert.equal(snapshot.task.user_request, 'Check the remote stock project.')
  assert.equal(snapshot.plan_steps.length, 2)
  assert.equal(snapshot.session.status, 'completed')
  assert.ok(snapshot.timeline.some((event) => event.kind === 'channel_message_received'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_plan_generated'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_step_executed'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_loop_completed'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_safe_loop_completed'))
  assert.equal(replies.length, 2)
  assert.equal(replies[0].messageId, 'om_123')
  assert.equal(replies[0].emojiType, 'SMILE')
  assert.ok(snapshot.timeline.some((event) => event.kind === 'assistant_reaction_added'))
  assert.equal(plannerCalls.length, 1)
  const hooks = await hookBus.listEvents({
    sessionId: result.session_id
  })
  assert.ok(hooks.some((event) => event.name === 'channel.message.received'))
  assert.ok(hooks.some((event) => event.name === 'channel.ack.sent'))
  assert.ok(hooks.some((event) => event.name === 'manager.planning.started'))
  assert.ok(hooks.some((event) => event.name === 'manager.planning.completed'))
  assert.ok(hooks.some((event) => event.name === 'manager.loop.completed'))
  assert.ok(hooks.some((event) => event.name === 'channel.reply.sent'))
})

test('handleChannelMessage reuses one unified Feishu session and injects prior transcript into planning', async () => {
  const { runtime, sessionStore, plannerCalls } = await createHarness()
  const first = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_unified_1',
      chat_id: 'oc_unified',
      sender_open_id: 'ou_unified',
      text: '先看看 deploy-hub 最近有没有异常'
    },
    autoExecuteSafeInspect: false
  })
  const second = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_unified_2',
      chat_id: 'oc_unified',
      sender_open_id: 'ou_unified',
      text: '继续刚才那个问题，别重新开新会话'
    },
    autoExecuteSafeInspect: false
  })
  const snapshot = await sessionStore.loadSession(second.session_id)

  assert.equal(second.session_id, first.session_id)
  assert.match(second.ack_text, /继续沿用总管会话/)
  assert.equal(snapshot.task.user_request, '继续刚才那个问题，别重新开新会话')
  assert.ok(snapshot.timeline.some((event) => event.kind === 'session_turn_started'))
  assert.equal(plannerCalls.length, 2)
  assert.match(plannerCalls[1].prompt, /RECENT TRANSCRIPT:/)
  assert.match(plannerCalls[1].prompt, /先看看 deploy-hub 最近有没有异常/)
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

test('handleChannelMessage compacts Feishu context after the five-hour interval and stores long-term memory', async () => {
  let currentTime = Date.now()
  const { runtime, sessionStore, memoryStore, summaryCalls, plannerCalls, hookBus } = await createHarness({
    nowFn: () => currentTime
  })

  await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_compact_1',
      chat_id: 'oc_compact',
      sender_open_id: 'ou_compact',
      text: '先排查一下 deploy-hub 和 uwillberich'
    },
    autoExecuteSafeInspect: false
  })

  currentTime += 6 * 60 * 60 * 1000

  const second = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_compact_2',
      chat_id: 'oc_compact',
      sender_open_id: 'ou_compact',
      text: '五小时过去了，继续刚才那个排查'
    },
    autoExecuteSafeInspect: false
  })
  const snapshot = await sessionStore.loadSession(second.session_id)
  const compactedEntries = await memoryStore.searchMemoryEntries({
    sessionId: second.session_id,
    scope: 'session',
    tag: 'context_compaction'
  })
  const hooks = await hookBus.listEvents({
    sessionId: second.session_id,
    name: 'manager.context.compacted'
  })

  assert.equal(summaryCalls.length, 1)
  assert.equal(compactedEntries.length, 1)
  assert.match(compactedEntries[0].content, /摘要：累计来看/)
  assert.ok(snapshot.timeline.some((event) => event.kind === 'conversation_compacted'))
  assert.equal(hooks.length, 1)
  assert.match(summaryCalls[0].prompt, /NEW TRANSCRIPT TO MERGE:/)
  assert.match(summaryCalls[0].prompt, /先排查一下 deploy-hub 和 uwillberich/)
  assert.match(plannerCalls[1].prompt, /LONG-TERM MEMORY:/)
  assert.match(plannerCalls[1].prompt, /累计来看/)
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

test('handleChannelMessage surfaces approval pause when repair enters the loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-server-manager-repair-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createServerManagerRuntime({
    storageRoot,
    workspaceRoot: join(root, 'workspace'),
    managerProfile: createRemoteServerManagerProfile({
      env: {}
    }),
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
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return `health ok ${url}`
      }
    }),
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
            id: 'chatcmpl-manager-repair',
            model: 'codingplan',
            finish_reason: 'stop',
            usage: {
              total_tokens: 64
            },
            content: JSON.stringify({
              summary: '先修复 uwillberich 发布链，再回报处理状态。',
              project_keys: ['uwillberich'],
              operator_reply: '先修复 uwillberich，再给你回处理状态。',
              steps: [
                {
                  title: '修复 uwillberich 发布链',
                  kind: 'repair',
                  notes: '需要改动代码'
                },
                {
                  title: '汇报修复结果',
                  kind: 'report',
                  depends_on: [1]
                }
              ]
            })
          }
        }
      }
    }
  })
  const sessionStore = createSessionStore({ storageRoot })

  await runtime.bootstrapServerBaseline()

  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_repair',
      text: '修一下股票项目发布链'
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.equal(result.execution.status, 'waiting_approval')
  assert.match(result.ack_text, /等待审批/)
  assert.equal(snapshot.session.status, 'waiting_approval')
  assert.equal(snapshot.approvals.length, 1)
  assert.equal(snapshot.approvals[0].tool_name, 'codex_repair_workspace')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].emojiType, 'SMILE')
  const hookBus = createHookBus({ storageRoot })
  const hooks = await hookBus.listEvents({
    sessionId: result.session_id
  })
  assert.ok(hooks.some((event) => event.name === 'manager.approval.waiting'))
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

test('handleChannelMessage degrades gracefully when planner fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-server-manager-fail-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createServerManagerRuntime({
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
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_plan_failed'))
  assert.ok(snapshot.timeline.some((event) => event.kind === 'session_summary_updated'))
  assert.equal(replies.length, 2)
  assert.equal(replies[0].emojiType, 'SMILE')
})

test('handleChannelMessage sends a progress update when planning crosses the delay threshold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-server-manager-progress-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createServerManagerRuntime({
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
            id: 'chatcmpl-manager-progress',
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

  assert.equal(replies.length, 3)
  assert.equal(replies[0].emojiType, 'SMILE')
  assert.match(replies[1].text, /正在排查|马上给你结论/)
  assert.match(replies[2].text, /我先确认你的意图/)
  assert.ok(
    snapshot.timeline.some(
      (event) => event.kind === 'assistant_message_added' && event.payload.stage === 'progress_ack'
    )
  )
})

test('handleChannelMessage records a gateway immediate reaction without sending it twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-server-manager-preacked-'))
  const storageRoot = join(root, 'storage')
  const replies = []
  const runtime = createServerManagerRuntime({
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

test('handleChannelMessage short-circuits lightweight ping messages and still replies on Feishu', async () => {
  const { runtime, sessionStore, replies, plannerCalls } = await createHarness()
  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    autoReply: false,
    message: {
      message_id: 'om_ping_short',
      chat_id: 'oc_ping_short',
      sender_open_id: 'ou_ping_short',
      text: '在不'
    }
  })
  const snapshot = await sessionStore.loadSession(result.session_id)

  assert.equal(result.ack_text, '在，有事直接说。')
  assert.equal(plannerCalls.length, 0)
  assert.equal(result.planning, null)
  assert.equal(result.execution, null)
  assert.equal(snapshot.session.status, 'completed')
  assert.equal(snapshot.task.status, 'completed')
  assert.equal(replies.length, 2)
  assert.equal(replies[0].emojiType, 'SMILE')
  assert.equal(replies[1].text, '在，有事直接说。')
  assert.ok(snapshot.timeline.some((event) => event.kind === 'manager_ping_detected'))
  assert.ok(
    snapshot.timeline.some(
      (event) => event.kind === 'assistant_message_added' && event.payload.stage === 'final_reply'
    )
  )
})

test('handleChannelMessage learns operator feedback rules and injects them into the planner prompt', async () => {
  const { runtime, sessionStore, memoryStore, plannerCalls, hookBus } = await createHarness()
  const result = await runtime.handleChannelMessage({
    channel: 'feishu',
    message: {
      message_id: 'om_feedback_rule',
      chat_id: 'oc_feedback_rule',
      sender_open_id: 'ou_feedback_rule',
      text:
        '飞书先快速响应，最好 3 秒内先给我一个表情；如果是难题就先说你在思考，过程输出也给我。'
    },
    autoExecuteSafeInspect: false
  })
  const snapshot = await sessionStore.loadSession(result.session_id)
  const learnedRules = await memoryStore.searchMemoryEntries({
    sessionId: result.session_id,
    scope: 'project',
    tag: 'feedback_rule'
  })

  assert.equal(learnedRules.length >= 3, true)
  assert.equal(
    learnedRules.some((entry) =>
      entry.content.includes('飞书来消息后先快速确认收到')
    ),
    true
  )
  assert.equal(
    learnedRules.some((entry) =>
      entry.content.includes('复杂问题先说明正在理解或排查')
    ),
    true
  )
  assert.match(plannerCalls[0].prompt, /OPERATOR RULES:/)
  assert.match(plannerCalls[0].prompt, /优先使用表情 reaction/)
  assert.ok(snapshot.timeline.some((event) => event.kind === 'feedback_memory_learned'))
  const hooks = await hookBus.listEvents({
    sessionId: result.session_id,
    name: 'manager.feedback.learned'
  })
  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].payload.written_count >= 3, true)
})
