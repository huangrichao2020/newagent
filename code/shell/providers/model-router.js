import { createRemoteServerManagerProfile } from '../manager/remote-server-manager-profile.js'

const INTENT_TO_ROUTE = new Map([
  ['plan', 'planner'],
  ['planning', 'planner'],
  ['architecture', 'planner'],
  ['spec', 'planner'],
  ['project_inventory', 'planner'],
  ['execute', 'execution'],
  ['execution', 'execution'],
  ['operate', 'execution'],
  ['summarize', 'summarization'],
  ['summary', 'summarization'],
  ['review', 'review'],
  ['repair', 'repair'],
  ['fix', 'repair']
])

export function createModelRouter({ managerProfile = createRemoteServerManagerProfile() } = {}) {
  function resolveRoute(intent) {
    const normalizedIntent = String(intent ?? '').trim().toLowerCase()

    if (!normalizedIntent) {
      throw new Error('Missing required route intent')
    }

    const routeKey = INTENT_TO_ROUTE.get(normalizedIntent)

    if (!routeKey) {
      throw new Error(`Unknown route intent: ${intent}`)
    }

    if (routeKey === 'review') {
      if (!managerProfile.codex_integration.allow_review) {
        return {
          intent: normalizedIntent,
          route_key: routeKey,
          runtime: 'disabled',
          reason: 'Codex review is disabled for this environment'
        }
      }

      return {
        intent: normalizedIntent,
        route_key: routeKey,
        runtime: 'tool',
        tool_name: managerProfile.codex_integration.review_tool_name
      }
    }

    if (routeKey === 'repair') {
      if (!managerProfile.codex_integration.allow_repair) {
        return {
          intent: normalizedIntent,
          route_key: routeKey,
          runtime: 'disabled',
          reason: 'Codex repair is disabled for this environment'
        }
      }

      return {
        intent: normalizedIntent,
        route_key: routeKey,
        runtime: 'tool',
        tool_name: managerProfile.codex_integration.repair_tool_name
      }
    }

    return {
      intent: normalizedIntent,
      route_key: routeKey,
      runtime: 'llm',
      ...managerProfile.model_routing[routeKey]
    }
  }

  return {
    resolveRoute
  }
}
