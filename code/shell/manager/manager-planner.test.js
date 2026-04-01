import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManagerPlanningPrompt,
  buildManagerPlanningSystemPrompt,
  parseManagerPlanningResponse
} from './manager-planner.js'
import {
  createRemoteServerManagerProfile,
  getAliyunSeedProjects
} from './remote-server-manager-profile.js'

test('buildManagerPlanningSystemPrompt returns the JSON-only planner contract', () => {
  const prompt = buildManagerPlanningSystemPrompt({
    managerProfile: createRemoteServerManagerProfile()
  })

  assert.match(prompt, /Return JSON only/)
  assert.match(prompt, /operator_reply/)
})

test('buildManagerPlanningPrompt includes the operator request and project inventory', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: 'Check uwillberich publishing state.'
    },
    projects: getAliyunSeedProjects().slice(0, 2)
  })

  assert.match(prompt, /uwillberich/)
  assert.match(prompt, /novel-evolution/)
  assert.match(prompt, /Check uwillberich publishing state/)
})

test('buildManagerPlanningPrompt includes operator feedback rules when available', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: '帮我看看线上到底哪块坏了'
    },
    projects: getAliyunSeedProjects().slice(0, 1),
    operatorRules: [
      {
        kind: 'operating_rule',
        content: '飞书来消息后先快速确认收到，优先使用表情 reaction；不要等完整规划结束再回应。'
      },
      {
        kind: 'preference',
        content: '复杂问题先说明正在理解或排查，再给正式结论。'
      }
    ]
  })

  assert.match(prompt, /Operator preferences and operating rules/)
  assert.match(prompt, /优先使用表情 reaction/)
  assert.match(prompt, /复杂问题先说明正在理解或排查/)
})

test('parseManagerPlanningResponse normalizes a fenced JSON plan', () => {
  const plan = parseManagerPlanningResponse({
    text: [
      '```json',
      JSON.stringify({
        summary: '先排查股票站点发布链。',
        project_keys: ['uwillberich', 'unknown-project'],
        operator_reply: '先查 uwillberich 发布链，再确认 deploy-hub 状态。',
        steps: [
          {
            title: '检查 uwillberich 发布目录',
            kind: 'inspect',
            notes: '确认 current release',
            depends_on: []
          },
          {
            title: '确认 deploy-hub 当前票据状态',
            kind: 'inspect',
            notes: '排除发布基础设施问题',
            depends_on: [1]
          }
        ]
      }),
      '```'
    ].join('\n'),
    availableProjects: getAliyunSeedProjects()
  })

  assert.equal(plan.project_keys.length, 1)
  assert.equal(plan.project_keys[0], 'uwillberich')
  assert.equal(plan.steps.length, 2)
  assert.deepEqual(plan.steps[1].dependsOn, [0])
})
