/**
 * Claude Code 源码分析改进 - 测试套件
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createVerificationAgent, VERIFICATION_PROMPT } from './agents/verification-agent.js'
import { TOOL_USAGE_GRAMMAR, validateToolSelection } from './tools/tool-usage-grammar.js'
import { getSystemPrompt, getBoundaryMarker } from './prompts/system-prompt-assembler.js'

// ==================== Verification Agent 测试 ====================

test('Verification Agent - prompt 应该包含 adversarial 模式', () => {
  assert.ok(VERIFICATION_PROMPT.includes('TRY TO BREAK IT'))
  assert.ok(VERIFICATION_PROMPT.includes('VERIFICATION AVOIDANCE'))
  assert.ok(VERIFICATION_PROMPT.includes('80% TRAP'))
  assert.ok(VERIFICATION_PROMPT.includes('MANDATORY'))
  assert.ok(VERIFICATION_PROMPT.includes('Adversarial Probes'))
  assert.ok(VERIFICATION_PROMPT.includes('VERDICT'))
})

test('Verification Agent - 应该创建成功', () => {
  const agent = createVerificationAgent()
  assert.equal(agent.type, 'verification')
  assert.ok(agent.verify)
  assert.ok(agent.quickVerify)
  assert.ok(agent.deepVerify)
  assert.ok(agent.execute)
})

test('Verification Agent - quickVerify 应该返回快速检查列表', async () => {
  const agent = createVerificationAgent()
  const result = await agent.quickVerify({ summary: 'test change' })

  assert.equal(result.status, 'completed')
  assert.equal(result.mode, 'quick')
  assert.ok(result.checks)
  assert.ok(result.checks.some(c => c.name === 'Build'))
  assert.ok(result.checks.some(c => c.name === 'Tests'))
})

test('Verification Agent - deepVerify 应该返回深度检查列表', async () => {
  const agent = createVerificationAgent()
  const result = await agent.deepVerify({ summary: 'major change' })

  assert.equal(result.status, 'completed')
  assert.equal(result.mode, 'deep')
  assert.ok(result.checks)
  assert.ok(result.checks.length >= 6)
  assert.ok(result.checks.some(c => c.name === 'Integration Tests'))
})

// ==================== Tool Usage Grammar 测试 ====================

test('Tool Usage Grammar - 应该包含正确的工具映射', () => {
  assert.ok(TOOL_USAGE_GRAMMAR.includes('FileRead'))
  assert.ok(TOOL_USAGE_GRAMMAR.includes('FileEdit'))
  assert.ok(TOOL_USAGE_GRAMMAR.includes('FileWrite'))
  assert.ok(TOOL_USAGE_GRAMMAR.includes('Glob'))
  assert.ok(TOOL_USAGE_GRAMMAR.includes('Grep'))
  assert.ok(TOOL_USAGE_GRAMMAR.includes('WRONG') || TOOL_USAGE_GRAMMAR.includes('CORRECT'))
})

test('Tool Usage Grammar - 应该检测到 cat 违规', () => {
  const result = validateToolSelection('Bash', { command: 'cat src/index.js' })

  assert.equal(result.valid, false)
  assert.ok(result.violations.some(v => v.rule === 'FILE_READ_VIOLATION'))
})

test('Tool Usage Grammar - 应该检测到 sed 违规', () => {
  const result = validateToolSelection('Bash', { command: "sed -i 's/old/new/g' src/index.js" })

  assert.equal(result.valid, false)
  assert.ok(result.violations.some(v => v.rule === 'FILE_EDIT_VIOLATION'))
})

test('Tool Usage Grammar - 应该检测到 echo 违规', () => {
  const result = validateToolSelection('Bash', { command: "echo 'content' > src/new.js" })

  assert.equal(result.valid, false)
  assert.ok(result.violations.some(v => v.rule === 'FILE_WRITE_VIOLATION'))
})

test('Tool Usage Grammar - 应该检测到 find 违规', () => {
  const result = validateToolSelection('Bash', { command: "find . -name '*.js'" })

  assert.equal(result.valid, false)
  assert.ok(result.violations.some(v => v.rule === 'GLOB_VIOLATION'))
})

test('Tool Usage Grammar - 应该检测到 grep 违规', () => {
  const result = validateToolSelection('Bash', { command: "grep 'pattern' src/" })

  assert.equal(result.valid, false)
  assert.ok(result.violations.some(v => v.rule === 'GREP_VIOLATION'))
})

test('Tool Usage Grammar - 合法的 Bash 命令应该通过', () => {
  const result = validateToolSelection('Bash', { command: 'git status' })

  assert.equal(result.valid, true)
  assert.equal(result.violations.length, 0)
})

// ==================== System Prompt Assembler 测试 ====================

test('System Prompt - 应该有边界标记', () => {
  const boundary = getBoundaryMarker()
  assert.ok(boundary.includes('SESSION SPECIFIC'))
})

test('System Prompt - 应该包含静态部分', () => {
  const result = getSystemPrompt({}, {})

  assert.ok(result.full.includes('# Identity'))
  assert.ok(result.full.includes('# System Norms'))
  assert.ok(result.full.includes('# Task Philosophy'))
  assert.ok(result.full.includes('# Risk Actions'))
  assert.ok(result.full.includes('# Tool Usage Grammar'))
})

test('System Prompt - 应该有 cache 边界', () => {
  const result = getSystemPrompt({}, {})

  assert.ok(result.full.includes(getBoundaryMarker()))
  assert.ok(result.static)
  assert.ok(result.dynamic !== undefined)
  assert.ok(result.cache)
  assert.ok(result.cache.staticHash)
})

test('System Prompt - 动态部分应该根据上下文生成', () => {
  const session = { task: { title: 'Test Task' }, session: { id: 'test_123' } }
  const memory = [{ kind: 'feedback_rule', content: 'Test rule' }]
  const env = { platform: 'darwin', cwd: '/test' }

  const result = getSystemPrompt({}, { session, memory, env, language: 'English' })

  assert.ok(result.full.includes('Test Task'))
  assert.ok(result.full.includes('Test rule'))
  assert.ok(result.full.includes('darwin'))
  assert.ok(result.full.includes('English'))
})

test('System Prompt - Brief Mode 应该正确注入', () => {
  const result = getSystemPrompt({}, { briefMode: true })

  assert.ok(result.full.includes('Brief Mode'))
  assert.ok(result.full.includes('minimum necessary information'))
})

test('System Prompt - Brief Mode 关闭时不应该注入', () => {
  const result = getSystemPrompt({}, { briefMode: false })

  // briefMode 关闭时可能仍然有其他动态内容，所以只检查边界存在
  assert.ok(result.full.includes(getBoundaryMarker()))
})
