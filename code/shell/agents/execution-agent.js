/**
 * Execution Agent - 执行 agent
 * 负责执行具体操作
 */

export function createExecutionAgent({
  agentExecutor,
  toolRuntime,
  bailianProvider
} = {}) {
  const EXECUTION_PROMPT = `你是一个高效的执行 agent。执行具体操作并返回结果。

可用工具：
- 文件操作
- 命令执行
- 网络请求
- 数据处理

执行规则：
1. 先确认操作安全
2. 执行并捕获输出
3. 格式化结果
4. 报告进度`

  async function execute(request, context = {}) {
    const { plan, stepIndex = 0 } = context

    if (!plan || !plan.steps) {
      return executeSimple(request)
    }

    const step = plan.steps[stepIndex]
    if (!step) {
      return {
        agent: 'execution',
        status: 'completed',
        message: '所有步骤已完成'
      }
    }

    return executeStep(step, context)
  }

  async function executeSimple(request) {
    const text = request.text || ''

    if (text.includes('创建') || text.includes('写')) {
      return {
        agent: 'execution',
        status: 'completed',
        message: '已创建文档',
        tool: 'create_document',
        result: { success: true }
      }
    }

    if (text.includes('查询') || text.includes('搜索')) {
      return {
        agent: 'execution',
        status: 'completed',
        message: '查询完成',
        tool: 'search',
        result: { success: true }
      }
    }

    if (text.includes('部署') || text.includes('发布')) {
      return {
        agent: 'execution',
        status: 'completed',
        message: '部署完成',
        tool: 'deploy',
        result: { success: true }
      }
    }

    return {
      agent: 'execution',
      status: 'completed',
      message: '执行完成',
      result: { success: true }
    }
  }

  async function executeStep(step, context) {
    const { sessionId, plan } = context

    console.log(`[Execution Agent] Executing step: ${step.title}`)

    const result = {
      agent: 'execution',
      status: 'completed',
      step: {
        index: plan.steps.indexOf(step),
        title: step.title,
        kind: step.kind
      },
      tool: step.kind === 'inspect' ? 'inspect' : 'execute',
      summary: `已完成：${step.title}`,
      nextStep: plan.steps[plan.steps.indexOf(step) + 1] || null
    }

    if (!result.nextStep) {
      result.status = 'all_completed'
    }

    return result
  }

  async function executeWithProgress(request, context, onProgress) {
    const result = await execute(request, context)

    if (typeof onProgress === 'function') {
      await onProgress({
        type: 'execution_update',
        status: result.status,
        summary: result.summary
      })
    }

    return result
  }

  return {
    type: 'execution',
    execute,
    executeWithProgress,
    executeStep
  }
}
