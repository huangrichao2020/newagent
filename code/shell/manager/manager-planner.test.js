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

  assert.match(prompt, /ROLE:/)
  assert.match(prompt, /TASK:/)
  assert.match(prompt, /OUTPUT CONTRACT:/)
  assert.match(prompt, /EXECUTION PROTOCOL:/)
  assert.match(prompt, /Return JSON only/)
  assert.match(prompt, /operator_reply/)
})

test('buildManagerPlanningSystemPrompt frames the default loop as a generic agent with project skills', () => {
  const prompt = buildManagerPlanningSystemPrompt({
    managerProfile: createRemoteServerManagerProfile()
  })

  assert.match(prompt, /Use project and server capabilities only when the request truly needs them/)
  assert.match(prompt, /Treat the known projects, services, and routes as optional skills/)
  assert.match(prompt, /"kind": "inspect\|operate\|report"/)
  assert.doesNotMatch(prompt, /review\|repair/)
})

test('buildManagerPlanningSystemPrompt constrains change-summary requests and dependency numbering', () => {
  const prompt = buildManagerPlanningSystemPrompt({
    managerProfile: createRemoteServerManagerProfile()
  })

  assert.match(prompt, /what changed, what was upgraded/)
  assert.match(prompt, /validates the claimed capability directly/)
  assert.match(prompt, /depends_on uses 1-based step references/)
  assert.match(prompt, /do not write it into the formal registry until the operator confirms/)
  assert.match(prompt, /Plan from the operator outcome first/)
  assert.match(prompt, /step notes must carry machine-readable inputs/)
  assert.match(prompt, /document_id.*folder_token.*app_token/)
})

test('buildManagerPlanningSystemPrompt narrows capability routing for weather and Feishu workspace requests', () => {
  const prompt = buildManagerPlanningSystemPrompt({
    managerProfile: createRemoteServerManagerProfile()
  })

  assert.match(prompt, /Do not route generic external data work through unrelated capability packs/)
  assert.match(prompt, /fetches one stable API or direct HTTP source/)
  assert.match(prompt, /create or update a Feishu doc\/wiki\/bitable item/)
  assert.match(prompt, /direct workspace step with structured title\/content/)
})

test('buildManagerPlanningPrompt includes the operator request and project skills', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: 'Check uwillberich publishing state.'
    },
    projects: getAliyunSeedProjects().slice(0, 2)
  })

  assert.match(prompt, /PROJECT SKILLS:/)
  assert.match(prompt, /OPERATOR REQUEST:/)
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

  assert.match(prompt, /OPERATOR RULES:/)
  assert.match(prompt, /优先使用表情 reaction/)
  assert.match(prompt, /复杂问题先说明正在理解或排查/)
})

test('buildManagerPlanningPrompt includes session continuity context when available', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: '继续刚才那个 deploy 异常'
    },
    projects: getAliyunSeedProjects().slice(0, 1),
    sessionSummary: '上一个 turn 已确认 deploy-hub 正常，问题集中在 uwillberich 发布目录。',
    longTermMemory: [
      '累计摘要：用户偏好先短回执，再给执行结论。',
      '未完成事项：需要继续跟进 uwillberich 发布链。'
    ],
    recentTranscript: [
      'operator: 先看看 deploy-hub 有没有挂。',
      'assistant: deploy-hub 正常，接下来继续查 uwillberich。'
    ]
  })

  assert.match(prompt, /SESSION STATE:/)
  assert.match(prompt, /LONG-TERM MEMORY:/)
  assert.match(prompt, /RECENT TRANSCRIPT:/)
  assert.match(prompt, /继续查 uwillberich/)
})

test('buildManagerPlanningPrompt includes attention stack and prepared context when available', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: '是不是大改了，主要改了哪里？'
    },
    projects: getAliyunSeedProjects().slice(0, 1),
    workingNote: {
      primary_request: '先把这次交互改造收口。',
      current_focus: '是不是大改了，主要改了哪里？',
      appended_requests: ['补充建议：默认引用回复'],
      follow_up_questions: ['是不是大改了，主要改了哪里？'],
      latest_message: '是不是大改了，主要改了哪里？'
    },
    attentionContext: {
      primary_reference: {
        role: 'assistant',
        content: '刚才我说这次主要改了超时机制和 registry。'
      }
    },
    preparedContext: {
      summary: '当前重点是回复超时、引用消息和后台预处理。',
      operator_focuses: ['你这次到底改了什么', '现在做到哪了'],
      likely_followups: ['改了哪里', '是不是大改'],
      attention_rules: ['先回答当前问题，不要先倒项目表']
    }
  })

  assert.match(prompt, /ATTENTION STACK:/)
  assert.match(prompt, /当前正在回复的消息/)
  assert.match(prompt, /超时机制和 registry/)
  assert.match(prompt, /WORKING NOTE:/)
  assert.match(prompt, /primary_request: 先把这次交互改造收口/)
  assert.match(prompt, /appended_requests: 补充建议：默认引用回复/)
  assert.match(prompt, /PREPARED CONTEXT:/)
  assert.match(prompt, /不要先倒项目表/)
})

test('buildManagerPlanningPrompt includes service and route registry context when available', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: '帮我确认 3800 和 /apps/chaochao/ 分别归谁'
    },
    projects: getAliyunSeedProjects().slice(0, 2),
    serviceInventory: [
      {
        service_key: 'novel-evolution-web',
        project_key: 'novel-evolution',
        process_name: 'novel-evolution',
        listen_port: 3800,
        healthcheck_url: 'http://127.0.0.1:3800/'
      }
    ],
    routeInventory: [
      {
        route_key: 'uwillberich-public-app',
        project_key: 'uwillberich',
        path_prefix: '/apps/chaochao/',
        public_url: 'http://120.26.32.59/apps/chaochao/',
        static_root: '/opt/agent-sites/chaochao/current',
        entry_html: '/opt/agent-sites/chaochao/current/index.html'
      }
    ]
  })

  assert.match(prompt, /SERVICE SIGNALS:/)
  assert.match(prompt, /novel-evolution-web/)
  assert.match(prompt, /3800/)
  assert.match(prompt, /ROUTE SIGNALS:/)
  assert.match(prompt, /\/apps\/chaochao\//)
  assert.match(prompt, /\/opt\/agent-sites\/chaochao\/current\/index\.html/)
})

test('buildManagerPlanningPrompt narrows inventory to the most relevant project, service, and route matches', () => {
  const prompt = buildManagerPlanningPrompt({
    message: {
      text: '帮我发布 deploy-hub，并确认 3900 和 /apps/ 的状态'
    },
    projects: getAliyunSeedProjects(),
    serviceInventory: [
      {
        service_key: 'deploy-hub-service',
        project_key: 'deploy-hub',
        process_name: 'deploy-hub',
        listen_port: 3900,
        healthcheck_url: 'http://127.0.0.1:3900/_deploy/ticket'
      },
      {
        service_key: 'novel-evolution-web',
        project_key: 'novel-evolution',
        process_name: 'novel-evolution',
        listen_port: 3800,
        healthcheck_url: 'http://127.0.0.1:3800/'
      }
    ],
    routeInventory: [
      {
        route_key: 'deploy-hub-public-apps',
        project_key: 'deploy-hub',
        path_prefix: '/apps/',
        public_url: 'http://example.com/apps/'
      },
      {
        route_key: 'uwillberich-public-app',
        project_key: 'uwillberich',
        path_prefix: '/apps/chaochao/',
        public_url: 'http://example.com/apps/chaochao/'
      }
    ]
  })

  assert.match(prompt, /deploy-hub/)
  assert.match(prompt, /deploy-hub-service/)
  assert.match(prompt, /3900/)
  assert.match(prompt, /deploy-hub-public-apps/)
  assert.doesNotMatch(prompt, /novel-evolution-web/)
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

test('parseManagerPlanningResponse drops invalid or future dependency references', () => {
  const plan = parseManagerPlanningResponse({
    text: JSON.stringify({
      summary: '测试依赖关系清洗。',
      project_keys: ['uwillberich'],
      operator_reply: '先校正 steps。',
      steps: [
        {
          title: '第一步',
          kind: 'inspect',
          depends_on: []
        },
        {
          title: '第二步',
          kind: 'inspect',
          depends_on: [1, 9]
        },
        {
          title: '第三步',
          kind: 'inspect',
          depends_on: [0, 1, 2, 8]
        }
      ]
    }),
    availableProjects: getAliyunSeedProjects()
  })

  assert.deepEqual(plan.steps[1].dependsOn, [0])
  assert.deepEqual(plan.steps[2].dependsOn, [0, 1])
})
