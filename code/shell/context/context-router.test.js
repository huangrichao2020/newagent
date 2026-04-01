import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionStore } from '../session/session-store.js'
import { appendJsonLine } from '../../storage/json-files.js'
import { createContextRouter } from './context-router.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-context-router-'))
  const storageRoot = join(root, 'storage')
  const sessionStore = createSessionStore({ storageRoot })
  const contextRouter = createContextRouter({ storageRoot })

  return {
    root,
    storageRoot,
    sessionStore,
    contextRouter
  }
}

test('buildExecutionContext includes current input and session summary by default', async () => {
  const { sessionStore, contextRouter } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Context router baseline',
    projectKey: 'newagent',
    userRequest: 'Use current input plus session summary'
  })

  await sessionStore.updateSessionStatus(created.session.id, 'running', {
    summary: 'The session is currently implementing the context router.'
  })

  const result = await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Build the next execution turn context.'
  })

  assert.equal(result.selection.sources[0].kind, 'current_input')
  assert.equal(result.selection.sources[1].kind, 'session_summary')
  assert.equal(result.merged_context.sections[0].kind, 'current_input')
  assert.equal(result.merged_context.sections[1].kind, 'session_summary')
  assert.equal(result.merged_context.sections[1].content, 'The session is currently implementing the context router.')
})

test('buildExecutionContext loads session and project memory entries when present', async () => {
  const { storageRoot, sessionStore, contextRouter } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Context with memory',
    projectKey: 'newagent',
    userRequest: 'Bring project and session memory into the merged context'
  })

  await appendJsonLine(join(storageRoot, 'memory', 'session', `${created.session.id}.jsonl`), {
    id: 'mem-session-1',
    scope: 'session',
    kind: 'fact',
    status: 'active',
    content: 'The current task is focused on the context router.',
    tags: ['context'],
    source_event_id: 'evt-1',
    supersedes_id: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    version: 1
  })
  await appendJsonLine(join(storageRoot, 'memory', 'project', 'newagent.jsonl'), {
    id: 'mem-project-1',
    scope: 'project',
    kind: 'constraint',
    status: 'active',
    content: 'Feishu must use a local long-lived connection.',
    tags: ['feishu', 'constraint'],
    source_event_id: 'evt-2',
    supersedes_id: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    version: 1
  })

  const result = await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Assemble execution context with memory.'
  })

  assert.equal(result.selection.sources.some((source) => source.kind === 'session_memory'), true)
  assert.equal(result.selection.sources.some((source) => source.kind === 'project_memory'), true)
  assert.equal(result.merged_context.sections.some((section) => section.kind === 'session_memory'), true)
  assert.equal(result.merged_context.sections.some((section) => section.kind === 'project_memory'), true)
})

test('buildExecutionContext prioritizes learned behavior rules ahead of generic facts', async () => {
  const { storageRoot, sessionStore, contextRouter } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Context with learned rules',
    projectKey: 'newagent',
    userRequest: 'Bring learned operator rules into execution context first'
  })

  await appendJsonLine(join(storageRoot, 'memory', 'project', 'newagent.jsonl'), {
    id: 'mem-project-fact',
    scope: 'project',
    kind: 'fact',
    status: 'active',
    content: 'uwillberich runtime root is /www/wwwroot/uwillberich.',
    tags: ['runtime'],
    source_event_id: 'evt-fact',
    supersedes_id: null,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
    version: 1
  })
  await appendJsonLine(join(storageRoot, 'memory', 'project', 'newagent.jsonl'), {
    id: 'mem-project-rule',
    scope: 'project',
    kind: 'operating_rule',
    status: 'active',
    content: '复杂问题先说明正在理解或排查，再给正式结论。',
    tags: ['feedback_rule', 'operator_experience'],
    source_event_id: 'evt-rule',
    supersedes_id: null,
    created_at: '2026-04-01T00:00:01Z',
    updated_at: '2026-04-01T00:00:01Z',
    version: 1
  })

  const result = await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Build a context that foregrounds learned rules.'
  })
  const projectMemory = result.merged_context.sections.find(
    (section) => section.kind === 'project_memory'
  )

  assert.equal(projectMemory.content.startsWith('[operating_rule]'), true)
  assert.match(projectMemory.content, /复杂问题先说明正在理解或排查/)
})

test('buildExecutionContext records explicit skill references without copying whole skill bodies', async () => {
  const { sessionStore, contextRouter } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Context with skills',
    projectKey: 'newagent',
    userRequest: 'Track skill references in the selection report'
  })

  const result = await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Use the runtime and memory patterns skill.',
    skillRefs: [
      {
        name: 'agent-systems-patterns',
        path: '/Users/tingchi/.codex/skills/agent-systems-patterns/SKILL.md',
        activationReason: 'Task concerns runtime and memory design.'
      }
    ]
  })

  const skillSource = result.selection.sources.find((source) => source.kind === 'skill_ref')
  const skillSection = result.merged_context.sections.find((section) => section.kind === 'skill_ref')

  assert.equal(skillSource.name, 'agent-systems-patterns')
  assert.equal(skillSection.name, 'agent-systems-patterns')
  assert.equal(skillSection.path, '/Users/tingchi/.codex/skills/agent-systems-patterns/SKILL.md')
  assert.equal('body' in skillSection, false)
})

test('buildExecutionContext enforces section and character limits and writes derived files', async () => {
  const { storageRoot, sessionStore, contextRouter } = await createHarness()
  const created = await sessionStore.createSession({
    title: 'Bounded context',
    projectKey: 'newagent',
    userRequest: 'Keep the merged context bounded and inspectable'
  })

  for (let index = 0; index < 5; index += 1) {
    await appendJsonLine(join(storageRoot, 'memory', 'project', 'newagent.jsonl'), {
      id: `mem-project-${index}`,
      scope: 'project',
      kind: 'fact',
      status: 'active',
      content: `Project memory item ${index} ${'x'.repeat(40)}`,
      tags: ['bounded'],
      source_event_id: `evt-${index}`,
      supersedes_id: null,
      created_at: `2026-04-01T00:00:0${index}Z`,
      updated_at: `2026-04-01T00:00:0${index}Z`,
      version: 1
    })
  }

  const result = await contextRouter.buildExecutionContext({
    sessionId: created.session.id,
    currentInput: 'Build a bounded merged context.',
    maxSections: 3,
    maxCharacters: 140
  })

  assert.ok(result.merged_context.sections.length <= 3)
  assert.ok(result.merged_context.total_characters <= 140)

  const contextRoot = join(
    storageRoot,
    'sessions',
    created.session.id,
    'context'
  )
  const selectionFile = JSON.parse(
    await readFile(join(contextRoot, 'latest-selection.json'), 'utf8')
  )
  const mergedFile = JSON.parse(
    await readFile(join(contextRoot, 'latest-merged-context.json'), 'utf8')
  )

  assert.equal(selectionFile.session_id, created.session.id)
  assert.equal(mergedFile.session_id, created.session.id)
  assert.equal(Array.isArray(mergedFile.sections), true)
})
