import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionStore } from '../session/session-store.js'
import { prioritizeFeedbackEntries } from '../memory/feedback-memory.js'
import { readJsonLines, writeJsonAtomic } from '../../storage/json-files.js'

function nowIso() {
  return new Date().toISOString()
}

function createContextPaths(storageRoot, sessionId) {
  const contextRoot = join(storageRoot, 'sessions', sessionId, 'context')

  return {
    selectionFile: join(contextRoot, 'latest-selection.json'),
    mergedContextFile: join(contextRoot, 'latest-merged-context.json')
  }
}

async function safeReadJsonLines(filePath) {
  try {
    return await readJsonLines(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function safeReadSkillRef(skillRef) {
  try {
    await readFile(skillRef.path, 'utf8')

    return {
      name: skillRef.name,
      path: skillRef.path,
      activation_reason: skillRef.activationReason
    }
  } catch (error) {
    return {
      name: skillRef.name,
      path: skillRef.path,
      activation_reason: skillRef.activationReason,
      missing: true
    }
  }
}

function compactMemoryEntries(entries) {
  return prioritizeFeedbackEntries(
    entries.filter((entry) => entry.status === 'active')
  )
    .map((entry) => `[${entry.kind}] ${entry.content}`)
    .join('\n')
}

function withTruncatedContent(section, limit) {
  if (limit <= 0) {
    return null
  }

  const content = String(section.content ?? '')

  if (content.length === 0) {
    return null
  }

  if (content.length <= limit) {
    return {
      section,
      characters: content.length,
      truncated: false
    }
  }

  return {
    section: {
      ...section,
      content: content.slice(0, limit)
    },
    characters: limit,
    truncated: true
  }
}

export function createContextRouter({ storageRoot }) {
  const sessionStore = createSessionStore({ storageRoot })

  async function buildExecutionContext({
    sessionId,
    currentInput,
    maxSections = 8,
    maxCharacters = 4000,
    skillRefs = []
  }) {
    const builtAt = nowIso()
    const snapshot = await sessionStore.loadSession(sessionId)
    const sessionMemory = await safeReadJsonLines(
      join(storageRoot, 'memory', 'session', `${sessionId}.jsonl`)
    )
    const projectMemory = await safeReadJsonLines(
      join(
        storageRoot,
        'memory',
        'project',
        `${snapshot.session.project_key}.jsonl`
      )
    )
    const resolvedSkillRefs = await Promise.all(
      skillRefs.map((skillRef) => safeReadSkillRef(skillRef))
    )

    const candidates = []

    candidates.push({
      kind: 'current_input',
      content: currentInput
    })

    if (snapshot.session.summary) {
      candidates.push({
        kind: 'session_summary',
        content: snapshot.session.summary
      })
    }

    const sessionMemoryContent = compactMemoryEntries(sessionMemory)

    if (sessionMemoryContent) {
      candidates.push({
        kind: 'session_memory',
        content: sessionMemoryContent,
        entry_count: sessionMemory.filter((entry) => entry.status === 'active').length
      })
    }

    const projectMemoryContent = compactMemoryEntries(projectMemory)

    if (projectMemoryContent) {
      candidates.push({
        kind: 'project_memory',
        content: projectMemoryContent,
        entry_count: projectMemory.filter((entry) => entry.status === 'active').length
      })
    }

    for (const skillRef of resolvedSkillRefs) {
      candidates.push({
        kind: 'skill_ref',
        name: skillRef.name,
        path: skillRef.path,
        missing: skillRef.missing ?? false,
        content: skillRef.activation_reason
      })
    }

    const sections = []
    const sources = []
    let remainingCharacters = maxCharacters
    let truncated = false

    for (const candidate of candidates) {
      if (sections.length >= maxSections) {
        truncated = true
        break
      }

      const fitted = withTruncatedContent(candidate, remainingCharacters)

      if (!fitted) {
        truncated = true
        break
      }

      sections.push(fitted.section)
      sources.push({
        kind: candidate.kind,
        name: candidate.name ?? null,
        path: candidate.path ?? null,
        missing: candidate.missing ?? false,
        entry_count: candidate.entry_count ?? null,
        characters: fitted.characters
      })
      remainingCharacters -= fitted.characters
      truncated = truncated || fitted.truncated
    }

    const selection = {
      session_id: sessionId,
      task_id: snapshot.task.id,
      built_at: builtAt,
      max_sections: maxSections,
      max_characters: maxCharacters,
      sources
    }

    const mergedContext = {
      session_id: sessionId,
      task_id: snapshot.task.id,
      built_at: builtAt,
      total_characters: sections.reduce(
        (sum, section) => sum + String(section.content ?? '').length,
        0
      ),
      truncated,
      sections
    }

    const paths = createContextPaths(storageRoot, sessionId)

    await writeJsonAtomic(paths.selectionFile, selection)
    await writeJsonAtomic(paths.mergedContextFile, mergedContext)

    return {
      selection,
      merged_context: mergedContext
    }
  }

  return {
    buildExecutionContext
  }
}
