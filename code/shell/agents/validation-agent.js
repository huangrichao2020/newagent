/**
 * Validation Agent - 验证 agent
 * 负责验证执行结果
 */

const VALIDATION_PROMPT = `你是一个严谨的验证 agent。验证执行结果是否正确。

验证维度：
1. 功能正确性
2. 数据完整性
3. 性能指标
4. 错误处理

输出格式：
{
  "passed": true/false,
  "checks": [
    {"name": "检查项", "passed": true/false, "details": "详情"}
  ],
  "issues": ["发现的问题"],
  "recommendations": ["改进建议"]
}`

export function createValidationAgent({
  bailianProvider,
  toolRuntime
} = {}) {
  async function validate(executionResult, criteria = {}) {
    const prompt = `验证执行结果：
${JSON.stringify(executionResult, null, 2)}

验证标准：
${JSON.stringify(criteria, null, 2)}`

    if (!bailianProvider) {
      return {
        passed: true,
        checks: [{
          name: '基本验证',
          passed: true,
          details: '无验证 provider，默认通过'
        }],
        issues: [],
        recommendations: []
      }
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'validation',
        systemPrompt: VALIDATION_PROMPT,
        prompt
      })

      return JSON.parse(result.response.content || '{}')
    } catch (error) {
      console.error('Validation failed:', error.message)
      return {
        passed: false,
        error: error.message
      }
    }
  }

  async function execute(request, context) {
    const { executionResult, criteria } = context

    if (!executionResult) {
      return {
        agent: 'validation',
        status: 'failed',
        message: '缺少执行结果，无法验证'
      }
    }

    const validationResult = await validate(executionResult, criteria)

    return {
      agent: 'validation',
      status: validationResult.passed ? 'passed' : 'failed',
      validation: validationResult,
      message: validationResult.passed ? '验证通过' : `验证失败：${validationResult.issues?.join(', ') || '未知问题'}`
    }
  }

  async function validateAndRetry(executionResult, criteria, maxRetries = 3) {
    let attempts = 0
    let lastResult = null

    while (attempts < maxRetries) {
      const result = await validate(executionResult, criteria)
      lastResult = result

      if (result.passed) {
        return {
          passed: true,
          attempts: attempts + 1,
          result
        }
      }

      attempts++
      console.log(`[Validation] Attempt ${attempts} failed, retrying...`)
    }

    return {
      passed: false,
      attempts,
      result: lastResult
    }
  }

  return {
    type: 'validation',
    validate,
    execute,
    validateAndRetry
  }
}
