import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildManagerQualityReviewPrompt,
  buildManagerQualityReviewSystemPrompt,
  parseManagerQualityReviewResponse
} from './quality-review.js'

test('buildManagerQualityReviewSystemPrompt defines a structured reviewer contract', () => {
  const prompt = buildManagerQualityReviewSystemPrompt()

  assert.match(prompt, /ROLE:/)
  assert.match(prompt, /OUTPUT CONTRACT:/)
  assert.match(prompt, /"verdict": "pass\|warn\|block"/)
})

test('buildManagerQualityReviewPrompt includes plan review context', () => {
  const prompt = buildManagerQualityReviewPrompt({
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

test('parseManagerQualityReviewResponse normalizes verdict and arrays', () => {
  const review = parseManagerQualityReviewResponse({
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
