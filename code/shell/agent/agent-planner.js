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

function normalizeSearchText(value) {
  return String(value ?? '').trim().toLowerCase()
}

function looksLikeBroadInventoryRequest(query) {
  return /(整体|全局|所有|全部|清单|盘一下|基线|inventory|registry|all projects|all services|all routes|what projects|which services)/iu.test(query)
}

function scoreInventoryMatch(query, values = []) {
  const normalizedQuery = normalizeSearchText(query)

  if (!normalizedQuery) {
    return 0
  }

  let score = 0

  for (const value of values) {
    const normalizedValue = normalizeSearchText(value)

    if (!normalizedValue) {
      continue
    }

    if (normalizedQuery.includes(normalizedValue)) {
      score += Math.min(18, 6 + normalizedValue.length)
      continue
    }

    for (const token of normalizedValue.split(/[^a-z0-9\u4e00-\u9fff/_\-.]+/u)) {
      if (token.length >= 2 && normalizedQuery.includes(token)) {
        score += token.length >= 4 ? 3 : 1
      }
    }
  }

  return score
}

function selectRelevantInventory(items, {
  query,
  valuesForItem,
  maxItems,
  projectBoostKeys = null,
  keepAllThreshold = 3
}) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      items: [],
      omitted_count: 0
    }
  }

  if (items.length <= keepAllThreshold || looksLikeBroadInventoryRequest(query)) {
    return {
      items,
      omitted_count: 0
    }
  }

  const ranked = items
    .map((item, index) => {
      let score = scoreInventoryMatch(query, valuesForItem(item))

      if (projectBoostKeys?.has?.(item.project_key)) {
        score += 4
      }

      return {
        item,
        index,
        score
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)

  const selected = (ranked.length > 0 ? ranked : items.slice(0, maxItems).map((item, index) => ({
    item,
    index,
    score: 0
  })))
    .slice(0, maxItems)
    .map((entry) => entry.item)

  return {
    items: selected,
    omitted_count: Math.max(0, items.length - selected.length)
  }
}

function buildPreparedContextLines(preparedContext, {
  includeNextChecks = false
} = {}) {
  if (!preparedContext) {
    return []
  }

  return [
    preparedContext.summary ? `summary: ${preparedContext.summary}` : null,
    Array.isArray(preparedContext.attention_rules) && preparedContext.attention_rules.length > 0
      ? `attention_rules: ${preparedContext.attention_rules.slice(0, 3).join('；')}`
      : null,
    includeNextChecks && Array.isArray(preparedContext.next_checks) && preparedContext.next_checks.length > 0
      ? `next_checks: ${preparedContext.next_checks.slice(0, 3).join('；')}`
      : null
  ].filter(Boolean)
}

export function buildAgentPlanningSystemPrompt({ agentProfile }) {
  const protocolRules = [
    'project_keys must only contain known project keys from the provided inventory.',
    'steps must be concrete and ordered.',
    'prefer 2 to 5 steps.',
    'operator_reply must answer the operator directly, in natural Chinese, and mention key project names only when relevant.',
    'Treat the known projects, services, and routes as optional skills. Use them as grounding only when they materially help the current request.',
    'Use the project, service, and route inventories as grounding only; do not dump paths, ports, URLs, routes, or shell commands unless the operator explicitly asks for them.',
    'When operator preferences or operating rules are provided, follow them explicitly.',
    'When recent transcript or long-term memory is provided, preserve continuity with prior turns.',
    'If the request is ambiguous, include an initial inspection step instead of guessing.',
    'Plan from the operator outcome first, not from the internal tool list. Decide whether the task can be completed directly with clear execution or API steps, and only use a capability pack when it is clearly the shortest reliable path.',
    'Do not route generic external data work through unrelated capability packs. News-only capabilities are for news, headlines, or feed collection, not weather, calendars, docs, files, wiki, or generic structured data retrieval.',
    'For weather or other structured external data requests, prefer a step that fetches one stable API or direct HTTP source, then feed the result into any follow-up workspace step.',
    'When a stable capability needs structured inputs, step notes must carry machine-readable inputs as key=value lines, for example document_id, folder_token, parent_node, space_id, app_token, table_id, record_id, or fields JSON.',
    'When the operator asks to create or update a Feishu doc/wiki/bitable item, emit a direct workspace step with structured title/content or target identifiers instead of detouring through capability inspection or unrelated data-source tools.',
    'If the operator is asking what changed, what was upgraded, or what new capabilities were added, do not pivot to unrelated service-health checks.',
    'When the operator asks to verify or assess recent changes, include at least one step that validates the claimed capability directly instead of only checking generic runtime health.',
    'depends_on uses 1-based step references in the JSON output and must only point to earlier steps.',
    'If you discover a possible new project, service, route, port, or publish path, report it as a candidate first and do not write it into the formal registry until the operator confirms.'
  ]

  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [agentProfile.role]
      },
      {
        title: 'TASK',
        lines: [
          'Plan the next concrete actions for the operator.',
          'Use project and server capabilities only when the request truly needs them.',
          'Return an actionable plan, not free-form commentary.'
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
          '      "kind": "inspect|operate|report",',
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

export function buildAgentPlanningPrompt({
  message,
  projects,
  operatorRules = [],
  sessionSummary = null,
  workingNote = null,
  longTermMemory = [],
  recentTranscript = [],
  serviceInventory = [],
  routeInventory = [],
  attentionContext = null,
  preparedContext = null
}) {
  const operatorRequest = cleanString(message.text)
    ?? JSON.stringify(message.content ?? message.raw_content ?? {})
  const inventoryQuery = [
    operatorRequest,
    workingNote?.current_focus ?? null,
    attentionContext?.primary_reference?.content ?? null
  ].filter(Boolean).join('\n')
  const relevantProjects = selectRelevantInventory(projects, {
    query: inventoryQuery,
    valuesForItem: (project) => [
      project.project_key,
      project.name,
      project.role,
      project.pm2_name,
      project.public_base_path,
      project.service_endpoint
    ],
    maxItems: 4,
    keepAllThreshold: 3
  })
  const relevantProjectKeys = new Set(
    relevantProjects.items.map((project) => project.project_key)
  )
  const relevantServices = selectRelevantInventory(serviceInventory, {
    query: inventoryQuery,
    valuesForItem: (service) => [
      service.service_key,
      service.project_key,
      service.process_name,
      service.listen_port,
      service.healthcheck_url,
      service.path_prefix
    ],
    projectBoostKeys: relevantProjectKeys,
    maxItems: 4,
    keepAllThreshold: 1
  })
  const relevantRoutes = selectRelevantInventory(routeInventory, {
    query: inventoryQuery,
    valuesForItem: (route) => [
      route.route_key,
      route.project_key,
      route.service_key,
      route.path_prefix,
      route.public_url,
      route.upstream_url,
      route.static_root
    ],
    projectBoostKeys: relevantProjectKeys,
    maxItems: 4,
    keepAllThreshold: 1
  })
  const inventory = relevantProjects.items
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

  const workingNoteLines = workingNote
    ? [
        workingNote.primary_request
          ? `primary_request: ${workingNote.primary_request}`
          : null,
        workingNote.current_focus
          ? `current_focus: ${workingNote.current_focus}`
          : null,
        Array.isArray(workingNote.appended_requests) && workingNote.appended_requests.length > 0
          ? `appended_requests: ${workingNote.appended_requests.join('；')}`
          : null,
        Array.isArray(workingNote.follow_up_questions) && workingNote.follow_up_questions.length > 0
          ? `follow_up_questions: ${workingNote.follow_up_questions.join('；')}`
          : null,
        workingNote.latest_message
          ? `latest_message: ${workingNote.latest_message}`
          : null
      ].filter(Boolean)
    : []

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
      title: 'PROJECT SKILLS',
      bullet: false,
      lines: [inventory]
    },
    {
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    }
  ]

  if (workingNoteLines.length > 0) {
    sections.push({
      title: 'WORKING NOTE',
      bullet: false,
      lines: workingNoteLines
    })
  }

  if (preparedContext) {
    sections.push({
      title: 'PREPARED CONTEXT',
      bullet: false,
      lines: buildPreparedContextLines(preparedContext, {
        includeNextChecks: true
      })
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

  if (relevantProjects.omitted_count > 0) {
    sections.push({
      title: 'PROJECT SKILL OMISSIONS',
      bullet: false,
      lines: [`omitted_projects: ${relevantProjects.omitted_count}`]
    })
  }

  if (relevantServices.items.length > 0) {
    sections.push({
      title: 'SERVICE SIGNALS',
      bullet: false,
      lines: [relevantServices.items
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

  if (relevantServices.omitted_count > 0) {
    sections.push({
      title: 'SERVICE SIGNAL OMISSIONS',
      bullet: false,
      lines: [`omitted_services: ${relevantServices.omitted_count}`]
    })
  }

  if (relevantRoutes.items.length > 0) {
    sections.push({
      title: 'ROUTE SIGNALS',
      bullet: false,
      lines: [relevantRoutes.items
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

  if (relevantRoutes.omitted_count > 0) {
    sections.push({
      title: 'ROUTE SIGNAL OMISSIONS',
      bullet: false,
      lines: [`omitted_routes: ${relevantRoutes.omitted_count}`]
    })
  }

  return buildPromptContract({
    sections
  })
}

export function parseAgentPlanningResponse({
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
    ?? `助手已为 ${projectKeys.join('、') || '当前请求'} 生成处置计划。`
  const operatorReply = cleanString(parsed.operator_reply)
    ?? `${summary} 当前共 ${steps.length} 步。`

  return {
    summary,
    project_keys: projectKeys,
    operator_reply: operatorReply,
    steps
  }
}
