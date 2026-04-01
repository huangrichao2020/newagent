import { buildPromptContract } from '../prompts/prompt-contract.js'

function cleanString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function stripCodeFence(text) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  return text.trim()
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text)

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped
  }

  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Planner response did not contain a JSON object')
  }

  return stripped.slice(firstBrace, lastBrace + 1)
}

function normalizeProjectKeys(projectKeys, availableProjectKeys) {
  if (!Array.isArray(projectKeys)) {
    return []
  }

  return [...new Set(
    projectKeys
      .map((item) => cleanString(item))
      .filter(Boolean)
      .filter((item) => availableProjectKeys.has(item))
  )]
}

function normalizeSteps(rawSteps) {
  if (!Array.isArray(rawSteps)) {
    return []
  }

  return rawSteps
    .map((step, index) => {
      const title = cleanString(step?.title)

      if (!title) {
        return null
      }

      const kind = cleanString(step?.kind) ?? 'general'
      const notes = cleanString(step?.notes)
      const rawDependsOn = Array.isArray(step?.depends_on)
        ? step.depends_on
        : Array.isArray(step?.dependsOn)
          ? step.dependsOn
          : []
      const dependsOn = rawDependsOn
        .map((dependency) => {
          if (typeof dependency === 'number' && dependency >= 1) {
            return dependency - 1
          }

          if (typeof dependency === 'string') {
            const asNumber = Number.parseInt(dependency, 10)

            if (Number.isInteger(asNumber) && asNumber >= 1) {
              return asNumber - 1
            }
          }

          return dependency
        })
        .filter((dependency) => dependency !== null && dependency !== undefined)

      return {
        title,
        kind,
        notes,
        dependsOn,
        index: index + 1
      }
    })
    .filter(Boolean)
    .slice(0, 8)
}

export function buildManagerPlanningSystemPrompt({ managerProfile }) {
  const protocolRules = [
    'project_keys must only contain known project keys from the provided inventory.',
    'steps must be concrete and ordered.',
    'prefer 2 to 5 steps.',
    'operator_reply must be concise, in Chinese, and mention the key project names when relevant.',
    'When operator preferences or operating rules are provided, follow them explicitly.',
    'When recent transcript or long-term memory is provided, preserve continuity with prior turns.',
    'If the request is ambiguous, include an initial inspection step instead of guessing.'
  ]

  if (!managerProfile.codex_integration.allow_review) {
    protocolRules.push('Do not emit review steps because Codex review is disabled in this environment.')
  }

  if (!managerProfile.codex_integration.allow_repair) {
    protocolRules.push('Do not emit repair steps because Codex repair is disabled in this environment.')
  }

  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [managerProfile.role]
      },
      {
        title: 'TASK',
        lines: [
          'Manage remote server projects and plan the next concrete actions.',
          'Return an operational plan, not free-form commentary.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "summary": "short operational summary",',
          '  "project_keys": ["known-project-key"],',
          '  "operator_reply": "short Chinese reply to the operator",',
          '  "steps": [',
          '    {',
          '      "title": "action title",',
          '      "kind": "inspect|operate|deploy|review|repair|report",',
          '      "notes": "why this step exists",',
          '      "depends_on": [1]',
          '    }',
          '  ]',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: protocolRules
      }
    ]
  })
}

export function buildManagerPlanningPrompt({
  message,
  projects,
  operatorRules = [],
  sessionSummary = null,
  longTermMemory = [],
  recentTranscript = []
}) {
  const inventory = projects
    .map((project) => [
      `- key: ${project.project_key}`,
      `  tier: ${project.tier}`,
      `  role: ${project.role}`,
      `  source_root: ${project.source_root}`,
      `  runtime_root: ${project.runtime_root ?? 'null'}`,
      `  publish_root: ${project.publish_root ?? 'null'}`,
      `  pm2_name: ${project.pm2_name ?? 'null'}`,
      `  service_endpoint: ${project.service_endpoint ?? 'null'}`
    ].join('\n'))
    .join('\n')

  const operatorRequest = cleanString(message.text)
    ?? JSON.stringify(message.content ?? message.raw_content ?? {})

  const sections = [
    {
      title: 'PROJECT INVENTORY',
      bullet: false,
      lines: [inventory]
    },
    {
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    }
  ]

  if (sessionSummary) {
    sections.push({
      title: 'SESSION STATE',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (longTermMemory.length > 0) {
    sections.push({
      title: 'LONG-TERM MEMORY',
      lines: longTermMemory
    })
  }

  if (recentTranscript.length > 0) {
    sections.push({
      title: 'RECENT TRANSCRIPT',
      lines: recentTranscript
    })
  }

  if (operatorRules.length > 0) {
    sections.push({
      title: 'OPERATOR RULES',
      lines: operatorRules.map((rule) => `[${rule.kind}] ${rule.content}`)
    })
  }

  return buildPromptContract({
    sections
  })
}

export function parseManagerPlanningResponse({
  text,
  availableProjects
}) {
  const parsed = JSON.parse(extractJsonObject(text))
  const availableProjectKeys = new Set(
    availableProjects.map((project) => project.project_key)
  )
  const projectKeys = normalizeProjectKeys(
    parsed.project_keys ?? parsed.projects,
    availableProjectKeys
  )
  const steps = normalizeSteps(parsed.steps)

  if (steps.length === 0) {
    throw new Error('Planner response did not include any valid steps')
  }

  const summary = cleanString(parsed.summary)
    ?? `总管已为 ${projectKeys.join('、') || '当前请求'} 生成处置计划。`
  const operatorReply = cleanString(parsed.operator_reply)
    ?? `${summary} 当前共 ${steps.length} 步。`

  return {
    summary,
    project_keys: projectKeys,
    operator_reply: operatorReply,
    steps
  }
}
