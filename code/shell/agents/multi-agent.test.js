/**
 * 多 Agent 架构测试
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageMerger } from './message-merger.js'
import { createDispatcher, AGENT_TYPES } from './dispatcher.js'
import { createFrontAgent } from './front-agent.js'

test('MessageMerger - 应该合并同一件事的多轮消息', () => {
  const merger = createMessageMerger()

  const previous = { text: '帮我查一下杭州天气', timestamp: Date.now() }
  const current = { text: '顺便再查一下上海天气', timestamp: Date.now() + 1000 }

  const result = merger.shouldMerge(current, previous, 1000)

  assert.equal(result.shouldMerge, true)
  assert.equal(result.reason, 'continuation_marker')
})

test('MessageMerger - 不应该合并不同事的消息', () => {
  const merger = createMessageMerger()

  const previous = { text: '帮我查一下杭州天气', timestamp: Date.now() }
  const current = { text: '帮我创建一个新的飞书文档', timestamp: Date.now() + 1000 }

  const result = merger.shouldMerge(current, previous, 1000)

  assert.equal(result.shouldMerge, false)
})

test('MessageMerger - 应该识别问题回复', () => {
  const merger = createMessageMerger()

  const previous = { text: '你要查哪个城市的天气？', timestamp: Date.now() }
  const current = { text: '好的，查杭州的', timestamp: Date.now() + 1000 }

  const result = merger.shouldMerge(current, previous, 1000)

  assert.equal(result.shouldMerge, true)
  assert.equal(result.reason, 'question_reply')
})

test('Dispatcher - 应该正确分类运维任务', async () => {
  const dispatcher = createDispatcher()

  const result = await dispatcher.dispatch({
    text: '检查一下 pm2 服务状态'
  })

  assert.equal(result.classification.agent, AGENT_TYPES.OPS)
})

test('Dispatcher - 应该正确分类验证任务', async () => {
  const dispatcher = createDispatcher()

  const result = await dispatcher.dispatch({
    text: '验证一下部署结果是否正确'
  })

  // 验证任务包含"验证"关键词
  assert.equal(result.classification.agent, AGENT_TYPES.VALIDATION)
})

test('Dispatcher - 应该正确分类复盘任务', async () => {
  const dispatcher = createDispatcher()

  const result = await dispatcher.dispatch({
    text: '复盘总结这次任务'
  })

  // 复盘任务包含"复盘"关键词
  assert.equal(result.classification.agent, AGENT_TYPES.REVIEW)
})

test('Dispatcher - 应该正确分类规划任务', async () => {
  const dispatcher = createDispatcher()

  const result = await dispatcher.dispatch({
    text: '规划项目的开发步骤'
  })

  // 规划任务包含"规划"关键词
  assert.equal(result.classification.agent, AGENT_TYPES.PLANNING)
})

test('Dispatcher - 应该正确分类执行任务', async () => {
  const dispatcher = createDispatcher()

  const result = await dispatcher.dispatch({
    text: '执行创建文档操作'
  })

  // 执行任务包含"执行"或"创建"关键词
  assert.equal(result.classification.agent, AGENT_TYPES.EXECUTION)
})

test('FrontAgent - 应该创建新会话', async () => {
  const dispatcher = createDispatcher()
  const merger = createMessageMerger()
  const frontAgent = createFrontAgent({ dispatcher, messageMerger: merger })

  const message = { text: '帮我查一下杭州天气', timestamp: Date.now() }
  const result = await frontAgent.receiveMessage(message, 'test_conv_1')

  assert.equal(result.type, 'new_conversation')
  assert.ok(result.taskId)
})

test('FrontAgent - 应该合并连续消息', async () => {
  const dispatcher = createDispatcher()
  const merger = createMessageMerger()
  const frontAgent = createFrontAgent({ dispatcher, messageMerger: merger })

  const message1 = { text: '帮我查一下杭州天气', timestamp: Date.now() }
  const result1 = await frontAgent.receiveMessage(message1, 'test_conv_2')

  const message2 = { text: '顺便再查一下上海天气', timestamp: Date.now() + 1000 }
  const result2 = await frontAgent.receiveMessage(message2, 'test_conv_2')

  // 连续消息会被合并（可能是 merged_message 或 new_task_merged）
  assert.ok(['merged_message', 'new_task_merged'].includes(result2.type))
})

test('FrontAgent - 应该创建新任务', async () => {
  const dispatcher = createDispatcher()
  const merger = createMessageMerger()
  const frontAgent = createFrontAgent({ dispatcher, messageMerger: merger })

  const message1 = { text: '帮我查一下杭州天气', timestamp: Date.now() }
  await frontAgent.receiveMessage(message1, 'test_conv_3')

  const message2 = { text: '帮我创建一个新的飞书文档', timestamp: Date.now() + 1000 }
  const result2 = await frontAgent.receiveMessage(message2, 'test_conv_3')

  assert.equal(result2.type, 'new_task')
})
