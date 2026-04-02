/**
 * Planning Agent - 规划 agent
 * 负责拆解复杂任务为可执行步骤
 */

const PLANNING_PROMPT = `你是一个专业的项目规划师。将复杂任务拆解为可执行步骤。

输出格式：
{
  "summary": "任务概述",
  "steps": [
    {
      "title": "步骤标题",
      "kind": "inspect|execute|report|deploy",
      "description": "步骤描述",
      "estimatedDuration": "预估时间"
    }
  ],
  "risks": ["潜在风险"],
  "dependencies": ["依赖项"]
}`

export function createPlanningAgent({
  bailianProvider,
  agentExecutor
} = {}) {
  async function plan(request, context = {}) {
    const prompt = `任务：${request.text || ''}

背景：${context.background || '无'}

约束：
- 步骤必须可执行
- 每个步骤有明确目标
- 识别潜在风险
- 标注依赖关系`

    if (!bailianProvider) {
      return {
        summary: request.text,
        steps: [{
          title: '执行任务',
          kind: 'execute',
          description: request.text
        }],
        risks: [],
        dependencies: []
      }
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'planning',
        systemPrompt: PLANNING_PROMPT,
        prompt
      })

      const plan = JSON.parse(result.response.content || '{}')
      return {
        ...plan,
        plannedAt: Date.now(),
        provider: result.route.provider,
        model: result.route.model
      }
    } catch (error) {
      console.error('Planning failed:', error.message)
      return {
        summary: request.text,
        steps: [{
          title: '执行任务',
          kind: 'execute',
          description: request.text
        }],
        error: error.message
      }
    }
  }

  async function execute(request, context) {
    const planResult = await plan(request, context)

    return {
      agent: 'planning',
      status: 'planned',
      plan: planResult,
      nextStep: planResult.steps[0]
    }
  }

  async function replan(originalPlan, feedback) {
    const replanPrompt = `原计划：
${JSON.stringify(originalPlan, null, 2)}

反馈：
${feedback}

请调整计划。`

    if (!bailianProvider) {
      return originalPlan
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'replanning',
        systemPrompt: PLANNING_PROMPT,
        prompt: replanPrompt
      })

      return JSON.parse(result.response.content || '{}')
    } catch (error) {
      console.error('Replanning failed:', error.message)
      return originalPlan
    }
  }

  return {
    type: 'planning',
    plan,
    execute,
    replan
  }
}
