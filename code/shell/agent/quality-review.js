import { buildPromptContract } from '../prompts/prompt-contract.js'

function cleanString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function stripCodeFence(text) {
  const fencedMatch = String(text ?? '').match(/```(?:json)?\s*([\s\S]*?)```/iu)

  if (fencedMatch) {
    return fencedMatch[1].trim()
  }

  return String(text ?? '').trim()
}

function extractJsonObject(text) {
  const stripped = stripCodeFence(text)

  if (stripped.startsWith('{') && stripped.endsWith('}')) {
    return stripped
  }

  const firstBrace = stripped.indexOf('{')
  const lastBrace = stripped.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('Quality review response did not contain a JSON object')
  }

  return stripped.slice(firstBrace, lastBrace + 1)
}

function normalizeStringArray(value, limit = 6) {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(
    value
      .map((item) => cleanString(item))
      .filter(Boolean)
  )].slice(0, limit)
}

function normalizeVerdict(value, fallback = 'pass') {
  const normalized = String(value ?? '').trim().toLowerCase()

  if (['pass', 'warn', 'block'].includes(normalized)) {
    return normalized
  }

  return fallback
}

function serializePlanForReview(plan) {
  if (!plan) {
    return null
  }

  return {
    ...plan,
    steps: Array.isArray(plan.steps)
      ? plan.steps.map((step) => ({
          title: step.title ?? null,
          kind: step.kind ?? null,
          notes: step.notes ?? null,
          depends_on: Array.isArray(step.dependsOn)
            ? step.dependsOn.map((dependency) => dependency + 1)
            : []
        }))
      : []
  }
}

export function buildAgentQualityReviewSystemPrompt() {
  return buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: [
          'Act as an independent quality reviewer for a remote server manager agent.'
        ]
      },
      {
        title: 'TASK',
        lines: [
          'Review the proposed output without rewriting the whole task.',
          'Focus on continuity, durability, safety, and whether the result is good enough to keep.'
        ]
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only with no markdown fence and no prose outside the JSON object.',
          'Use this schema:',
          '{',
          '  "verdict": "pass|warn|block",',
          '  "summary": "short Chinese review summary",',
          '  "issues": ["specific issue"],',
          '  "constraints": ["durable guardrail or confirmed best practice"]',
          '}'
        ]
      },
      {
        title: 'EXECUTION PROTOCOL',
        lines: [
          'Use pass when the result is safe and good enough to keep.',
          'Use warn when the result is usable but has gaps, ambiguity, or weak assumptions.',
          'Use block only when the result should not be auto-applied or auto-executed.',
          'constraints must be durable, concise, and future-useful. Do not repeat temporary noise.',
          'issues must be actionable and specific.'
        ]
      }
    ]
  })
}

export function buildAgentQualityReviewPrompt({
  mode,
  operatorRequest = null,
  sessionSummary = null,
  recentTranscript = [],
  plan = null,
  compaction = null
}) {
  const sections = [
    {
      title: 'REVIEW MODE',
      bullet: false,
      lines: [mode]
    }
  ]

  if (operatorRequest) {
    sections.push({
      title: 'OPERATOR REQUEST',
      bullet: false,
      lines: [operatorRequest]
    })
  }

  if (sessionSummary) {
    sections.push({
      title: 'SESSION SUMMARY',
      bullet: false,
      lines: [sessionSummary]
    })
  }

  if (recentTranscript.length > 0) {
    sections.push({
      title: 'RECENT TRANSCRIPT',
      lines: recentTranscript
    })
  }

  if (mode === 'plan_review' && plan) {
    sections.push({
      title: 'CANDIDATE PLAN',
      bullet: false,
      lines: [JSON.stringify(serializePlanForReview(plan), null, 2)]
    })
  }

  if (mode === 'compaction_review' && compaction) {
    sections.push({
      title: 'CANDIDATE MEMORY COMPACTION',
      bullet: false,
      lines: [JSON.stringify(compaction, null, 2)]
    })
  }

  return buildPromptContract({
    sections
  })
}

export function parseAgentQualityReviewResponse({ text }) {
  const parsed = JSON.parse(extractJsonObject(text))
  const issues = normalizeStringArray(parsed.issues)
  const constraints = normalizeStringArray(parsed.constraints)
  const summary = cleanString(parsed.summary)
    ?? (issues[0] ?? constraints[0] ?? '外部复核通过。')

  return {
    verdict: normalizeVerdict(parsed.verdict),
    summary,
    issues,
    constraints
  }
}
