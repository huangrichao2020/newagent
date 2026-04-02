import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractFeedbackMemoryCandidates,
  prioritizeFeedbackEntries
} from './feedback-memory.js'

test('extractFeedbackMemoryCandidates recognizes operator feedback about fast ack and progress visibility', () => {
  const candidates = extractFeedbackMemoryCandidates({
    channel: 'feishu',
    messageText:
      '飞书先快速响应，最好 3 秒内先给我一个表情；如果是难题就先说你在思考，过程输出也给我。'
  })

  assert.equal(candidates.length >= 3, true)
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('飞书来消息后先快速确认收到')
    ),
    true
  )
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('不要让飞书消息长时间静默')
    ),
    true
  )
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('复杂问题先说明正在理解或排查')
    ),
    true
  )
})

test('extractFeedbackMemoryCandidates ignores ordinary operational requests', () => {
  const candidates = extractFeedbackMemoryCandidates({
    channel: 'feishu',
    messageText: '帮我检查 uwillberich 线上服务和 pm2 状态。'
  })

  assert.deepEqual(candidates, [])
})

test('extractFeedbackMemoryCandidates recognizes thread-first attention and idle precompute preferences', () => {
  const candidates = extractFeedbackMemoryCandidates({
    channel: 'feishu',
    messageText:
      '如果我引用并回复它的消息，你就严格遵照这个引用线程来答；别一直说当前模式和可继续补充。平时别闲着，免费 AI 多做预制菜，猜我关注和下一问。'
  })

  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('优先沿着该引用线程继续回答')
    ),
    true
  )
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('不要在普通回复里反复重复当前模式')
    ),
    true
  )
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('空闲时持续用低成本模型预判下一问')
    ),
    true
  )
})

test('extractFeedbackMemoryCandidates stores autonomy preference without legacy approval wording', () => {
  const candidates = extractFeedbackMemoryCandidates({
    channel: 'feishu',
    messageText: '高自主权限，自己决定就行，不用审批，别反复问我。'
  })
  const autonomy = candidates.find((candidate) => candidate.tags?.includes('autonomy'))

  assert.ok(autonomy)
  assert.doesNotMatch(autonomy.content, /审批|高风险/)
  assert.match(autonomy.content, /默认自行决定执行路径/)
})

test('extractFeedbackMemoryCandidates recognizes the three-part new-task reply style and same-task carry-forward rule', () => {
  const candidates = extractFeedbackMemoryCandidates({
    channel: 'feishu',
    messageText:
      '新的独立任务先三句：第一句理解和情况调查，第二句说准备怎么做和什么不用做，第三句开始执行并和我互动。如果我连发几条都在讲同一件执行中的事，就直接并进当前任务，别每次都重来一遍。'
  })

  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('新的独立任务默认按三段式回复')
    ),
    true
  )
  assert.equal(
    candidates.some((candidate) =>
      candidate.content.includes('如果连续多条消息仍在推进同一件执行中的事')
    ),
    true
  )
})

test('prioritizeFeedbackEntries places operating rules before generic facts', () => {
  const entries = prioritizeFeedbackEntries([
    {
      id: 'fact-1',
      kind: 'fact',
      content: 'Current deploy root is /www/wwwroot/app.',
      created_at: '2026-04-02T00:00:01Z'
    },
    {
      id: 'rule-1',
      kind: 'operating_rule',
      content: '复杂问题先说明正在理解或排查，再给正式结论。',
      created_at: '2026-04-02T00:00:02Z'
    },
    {
      id: 'pref-1',
      kind: 'preference',
      content: '处理过程中持续外显简短进度，让用户知道当前状态。',
      created_at: '2026-04-02T00:00:03Z'
    }
  ])

  assert.equal(entries[0].kind, 'operating_rule')
  assert.equal(entries[1].kind, 'preference')
  assert.equal(entries[2].kind, 'fact')
})
