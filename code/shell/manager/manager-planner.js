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

  const draftSteps = rawSteps
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

  return draftSteps.map((step, index) => ({
    ...step,
    dependsOn: [...new Set(
      step.dependsOn
        .map((dependency) => {
          if (typeof dependency === 'number' && Number.isInteger(dependency)) {
            return dependency
          }

          if (typeof dependency === 'string') {
            const asNumber = Number.parseInt(dependency, 10)

            if (Number.isInteger(asNumber)) {
              return asNumber
            }
          }

          return null
        })
        .filter((dependency) => dependency != null && dependency >= 0 && dependency < index)
    )]
  }))
}

export function buildManagerPlanningSystemPrompt({ managerProfile }) {
  const protocolRules = [
    'project_keys must only contain known project keys from the provided inventory.',
    'steps must be concrete and ordered.',
    'prefer 2 to 5 steps.',
    'operator_reply must answer the operator directly, in natural Chinese, and mention key project names only when relevant.',
    'Use the project, service, and route inventories as grounding only; do not dump paths, ports, URLs, routes, or shell commands unless the operator explicitly asks for them.',
    'When operator preferences or operating rules are provided, follow them explicitly.',
    'When recent transcript or long-term memory is provided, preserve continuity with prior turns.',
    'If the request is ambiguous, include an initial inspection step instead of guessing.',
    'If the operator is asking what changed, what was upgraded, or what new capabilities were added, do not pivot to unrelated service-health checks.',
    'When the operator asks to verify or assess recent changes, include at least one step that validates the claimed capability directly instead of only checking generic runtime health.',
    'depends_on uses 1-based step references in the JSON output and must only point to earlier steps.'
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
  recentTranscript = [],
  serviceInventory = [],
  routeInventory = [],
  attentionContext = null,
  preparedContext = null
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
    attentionContext
      ? {
          title: 'ATTENTION STACK',
          bullet: false,
          lines: [
            'highest_priority: 当前 operator 消息',
            attentionContext.primary_reference
              ? `secondary_priority: 当前正在回复的消息 [${attentionContext.primary_reference.role}] ${attentionContext.primary_reference.content}`
              : 'secondary_priority: 无显式引用消息，本轮按当前消息单独理解',
            'lower_priority: 历史 assistant 回复、最近转录、长期记忆都只是辅助上下文'
          ]
        }
      : null,
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

  if (preparedContext) {
    sections.push({
      title: 'PREPARED CONTEXT',
      bullet: false,
      lines: [
        preparedContext.summary ? `summary: ${preparedContext.summary}` : null,
        Array.isArray(preparedContext.operator_focuses) && preparedContext.operator_focuses.length > 0
          ? `operator_focuses: ${preparedContext.operator_focuses.join('；')}`
          : null,
        Array.isArray(preparedContext.likely_followups) && preparedContext.likely_followups.length > 0
          ? `likely_followups: ${preparedContext.likely_followups.join('；')}`
          : null,
        Array.isArray(preparedContext.attention_rules) && preparedContext.attention_rules.length > 0
          ? `attention_rules: ${preparedContext.attention_rules.join('；')}`
          : null
      ]
    })
  }

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

  if (serviceInventory.length > 0) {
    sections.push({
      title: 'SERVICE REGISTRY',
      bullet: false,
      lines: [serviceInventory
        .map((service) => [
          `- key: ${service.service_key}`,
          `  project_key: ${service.project_key}`,
          `  process_name: ${service.process_name ?? 'null'}`,
          `  listen_port: ${service.listen_port ?? 'null'}`,
          `  healthcheck_url: ${service.healthcheck_url ?? 'null'}`,
          `  entry_html: ${service.entry_html ?? 'null'}`,
          `  status: ${service.status ?? 'null'}`
        ].join('\n'))
        .join('\n')]
    })
  }

  if (routeInventory.length > 0) {
    sections.push({
      title: 'ROUTE REGISTRY',
      bullet: false,
      lines: [routeInventory
        .map((route) => [
          `- key: ${route.route_key}`,
          `  project_key: ${route.project_key}`,
          `  service_key: ${route.service_key ?? 'null'}`,
          `  path_prefix: ${route.path_prefix ?? 'null'}`,
          `  public_url: ${route.public_url ?? 'null'}`,
          `  upstream_url: ${route.upstream_url ?? 'null'}`,
          `  static_root: ${route.static_root ?? 'null'}`,
          `  entry_html: ${route.entry_html ?? 'null'}`,
          `  status: ${route.status ?? 'null'}`
        ].join('\n'))
        .join('\n')]
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
