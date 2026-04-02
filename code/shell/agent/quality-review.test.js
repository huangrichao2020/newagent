import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAgentQualityReviewPrompt,
  buildAgentQualityReviewSystemPrompt,
  parseAgentQualityReviewResponse
} from './quality-review.js'

test('buildAgentQualityReviewSystemPrompt defines a structured reviewer contract', () => {
  const prompt = buildAgentQualityReviewSystemPrompt()

  assert.match(prompt, /ROLE:/)
  assert.match(prompt, /OUTPUT CONTRACT:/)
  assert.match(prompt, /"verdict": "pass\|warn\|block"/)
})

test('buildAgentQualityReviewPrompt includes plan review context', () => {
  const prompt = buildAgentQualityReviewPrompt({
    mode: 'plan_review',
    operatorRequest: '继续刚才那个 deploy 问题',
    sessionSummary: '上一轮已经确认 deploy-hub 正常。',
    recentTranscript: [
      'operator: 先看 deploy-hub',
      'assistant: deploy-hub 正常，继续查 uwillberich'
    ],
    plan: {
      summary: '继续排查 uwillberich',
      steps: [
        {
          title: '检查 uwillberich 发布目录',
          kind: 'inspect'
        }
      ]
    }
  })

  assert.match(prompt, /REVIEW MODE:/)
  assert.match(prompt, /CANDIDATE PLAN:/)
  assert.match(prompt, /deploy-hub 正常/)
})

test('buildAgentQualityReviewPrompt shows 1-based depends_on references to the reviewer', () => {
  const prompt = buildAgentQualityReviewPrompt({
    mode: 'plan_review',
    plan: {
      summary: '检查步骤依赖',
      steps: [
        {
          title: '第一步',
          kind: 'inspect',
          dependsOn: []
        },
        {
          title: '第二步',
          kind: 'inspect',
          dependsOn: [0]
        }
      ]
    }
  })

  assert.match(prompt, /"depends_on": \[\]/)
  assert.match(prompt, /"depends_on": \[\s*1\s*\]/)
  assert.doesNotMatch(prompt, /"dependsOn": \[\s*0\s*\]/)
})

test('parseAgentQualityReviewResponse normalizes verdict and arrays', () => {
  const review = parseAgentQualityReviewResponse({
    text: JSON.stringify({
      verdict: 'warn',
      summary: '外部复核发现上下文衔接不够稳。',
      issues: ['缺少上一轮未完成事项的显式承接', '缺少上一轮未完成事项的显式承接'],
      constraints: ['继续沿用已验证的项目范围，不要擅自扩展。']
    })
  })

  assert.equal(review.verdict, 'warn')
  assert.equal(review.issues.length, 1)
  assert.equal(review.constraints.length, 1)
})
