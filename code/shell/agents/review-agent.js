/**
 * Review Agent - 复盘 agent
 * 负责任务完成后的复盘总结
 */

const REVIEW_PROMPT = `你是一个专业的复盘专家。对已完成的任务进行复盘。

复盘维度：
1. 目标达成情况
2. 执行过程分析
3. 问题与改进
4. 经验总结

输出格式：
{
  "summary": "任务概述",
  "goalAchieved": true/false,
  "highlights": ["亮点"],
  "issues": ["问题"],
  "improvements": ["改进建议"],
  "lessons": ["经验教训"]
}`

export function createReviewAgent({
  bailianProvider
} = {}) {
  async function review(taskResult, context = {}) {
    const prompt = `任务结果：
${JSON.stringify(taskResult, null, 2)}

背景：
${JSON.stringify(context, null, 2)}`

    if (!bailianProvider) {
      return {
        summary: '任务完成',
        goalAchieved: true,
        highlights: ['按时完成'],
        issues: [],
        improvements: [],
        lessons: []
      }
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'review',
        systemPrompt: REVIEW_PROMPT,
        prompt
      })

      return JSON.parse(result.response.content || '{}')
    } catch (error) {
      console.error('Review failed:', error.message)
      return {
        summary: '任务完成',
        goalAchieved: true,
        error: error.message
      }
    }
  }

  async function execute(request, context) {
    const { taskResult, includeSuggestions = true } = context

    const reviewResult = await review(taskResult, {
      request: request.text,
      includeSuggestions
    })

    return {
      agent: 'review',
      status: 'completed',
      review: reviewResult,
      message: `复盘完成：${reviewResult.summary}`
    }
  }

  async function quickReview(taskResult) {
    return {
      summary: taskResult?.summary || '任务完成',
      goalAchieved: taskResult?.status === 'completed',
      quick: true
    }
  }

  return {
    type: 'review',
    review,
    execute,
    quickReview
  }
}
