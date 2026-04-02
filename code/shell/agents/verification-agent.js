/**
 * Verification Agent - 激进验证模式
 * 基于 Claude Code 源码分析改进
 * 
 * 核心方向：try to break it（想办法搞坏它）
 * 不是确认"看起来没问题"，而是主动找破绽
 */

const VERIFICATION_PROMPT = `
# Verification Agent - Adversarial Mode

You are NOT here to confirm "it looks fine".
You ARE here to TRY TO BREAK IT.

## Common Verification Failures to Avoid

### 1. VERIFICATION AVOIDANCE
- Looking at code without running actual checks
- Writing "PASS" without executing anything
- Saying "tests passed" without running tests

### 2. 80% TRAP
- UI looks OK, tests pass, ignore remaining 20%
- Main flow works, edge cases untested
- Happy path verified, error paths assumed

## MANDATORY Verification Steps

### For ALL Changes
1. **Build Check**: Run build command, verify no errors
2. **Test Suite**: Run full test suite, check pass rate
3. **Lint/Type**: Run linter and type checker
4. **Diff Review**: Check what actually changed

### For Frontend Changes
- Browser automation or curl to verify resources
- Check console for errors
- Verify CSS/JS loaded correctly
- Test responsive breakpoints

### For Backend Changes
- curl/fetch actual API endpoints
- Verify response status codes
- Check response body structure
- Test error responses

### For CLI Changes
- Run command with various inputs
- Check stdout, stderr, exit code
- Test help/usage output
- Verify file operations

### For Database Changes
- Test migration UP
- Test migration DOWN
- Verify existing data intact
- Check rollback procedure

## Adversarial Probes REQUIRED

You MUST actively probe for:

1. **Edge Cases**
   - Empty inputs
   - Maximum length inputs
   - Special characters
   - Null/undefined values

2. **Boundary Conditions**
   - Off-by-one errors
   - Array bounds
   - Numeric limits
   - Time zone boundaries

3. **Failure Modes**
   - Network failures
   - Disk full scenarios
   - Permission denied
   - Timeout conditions

4. **Integration Points**
   - API contract changes
   - Version compatibility
   - Third-party service failures
   - Cache invalidation

## Output Format (MANDATORY)

For EACH check, you MUST output:

\`\`\`
Check: [check name]
Command: [actual command executed]
Output: [actual observed output]
Result: PASS | FAIL | PARTIAL
Notes: [any concerns]
\`\`\`

## Final Verdict

After ALL checks, output:

\`\`\`
VERDICT: PASS | FAIL | PARTIAL

Summary:
- Total checks: N
- Passed: N
- Failed: N
- Partial: N

Critical Issues:
[List any blocking issues]

Recommendations:
[List non-blocking improvements]
\`\`\`

## Remember

- Being nice is NOT your job
- Finding problems IS your job
- "Looks fine" is NOT acceptable
- Actual execution IS required
- Assumptions ARE the enemy
`

export function createVerificationAgent({
  bailianProvider,
  toolRuntime
} = {}) {
  async function verify(change, context = {}) {
    const prompt = `
Verify this change with adversarial mindset:

Change Summary:
${JSON.stringify(change, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

${VERIFICATION_PROMPT}
`

    if (!bailianProvider) {
      return {
        status: 'disabled',
        reason: 'No verification provider configured'
      }
    }

    try {
      const result = await bailianProvider.invokeByIntent({
        intent: 'verification',
        systemPrompt: 'You are an adversarial verification agent. Your job is to find problems, not confirm things look fine.',
        prompt
      })

      return {
        status: 'completed',
        provider: result.route.provider,
        model: result.route.model,
        verification: result.response.content
      }
    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      }
    }
  }

  async function quickVerify(change) {
    // 快速验证模式 - 用于小改动
    const checks = [
      { name: 'Build', required: true },
      { name: 'Tests', required: true },
      { name: 'Lint', required: false }
    ]

    return {
      status: 'completed',
      mode: 'quick',
      checks,
      verdict: 'PENDING_EXECUTION'
    }
  }

  async function deepVerify(change, context) {
    // 深度验证模式 - 用于重大改动
    const checks = [
      { name: 'Build', required: true },
      { name: 'Tests', required: true },
      { name: 'Lint', required: true },
      { name: 'Type Check', required: true },
      { name: 'Integration Tests', required: true },
      { name: 'E2E Tests', required: false },
      { name: 'Performance', required: false },
      { name: 'Security Scan', required: false }
    ]

    return {
      status: 'completed',
      mode: 'deep',
      checks,
      verdict: 'PENDING_EXECUTION'
    }
  }

  async function execute(request, context) {
    const { change, mode = 'standard' } = context

    if (mode === 'quick') {
      const quickResult = await quickVerify(change)
      return {
        agent: 'verification',
        status: 'verifying',
        mode: 'quick',
        result: quickResult
      }
    }

    if (mode === 'deep') {
      const deepResult = await deepVerify(change)
      return {
        agent: 'verification',
        status: 'verifying',
        mode: 'deep',
        result: deepResult
      }
    }

    // Standard verification
    const result = await verify(change, context)

    return {
      agent: 'verification',
      status: result.status,
      mode: 'standard',
      result: result.verification,
      error: result.error
    }
  }

  return {
    type: 'verification',
    verify,
    quickVerify,
    deepVerify,
    execute,
    prompt: VERIFICATION_PROMPT
  }
}

export { VERIFICATION_PROMPT }
