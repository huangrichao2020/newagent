/**
 * Agent Profile - 配置中心
 * 基于 Claude Code 源码学习改进
 */

function readBooleanEnv(env, name, fallback = false) {
  const rawValue = env?.[name]

  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return fallback
  }

  const normalized = String(rawValue).trim().toLowerCase()

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }

  return fallback
}

function readStringEnv(env, name, fallback = null) {
  const rawValue = env?.[name]

  if (rawValue === undefined || rawValue === null) {
    return fallback
  }

  const normalized = String(rawValue).trim()

  return normalized === '' ? fallback : normalized
}

export function createAgentProfile({
  env = process.env
} = {}) {
  const disableCodex = readBooleanEnv(env, 'NEWAGENT_DISABLE_CODEX', false)
  const allowReview = disableCodex
    ? false
    : readBooleanEnv(env, 'NEWAGENT_ENABLE_CODEX_REVIEW', false)
  const allowRepair = disableCodex
    ? false
    : readBooleanEnv(env, 'NEWAGENT_ENABLE_CODEX_REPAIR', false)
  const enableExternalReview = readBooleanEnv(env, 'NEWAGENT_ENABLE_EXTERNAL_REVIEW', false)
  const enforceExternalReview = enableExternalReview
    ? readBooleanEnv(env, 'NEWAGENT_ENFORCE_EXTERNAL_REVIEW', false)
    : false
  const externalReviewModel = readStringEnv(
    env,
    'NEWAGENT_EXTERNAL_REVIEW_MODEL',
    'stepfun/step-3.5-flash:free'
  )
  const openrouterSiteUrl = readStringEnv(env, 'NEWAGENT_OPENROUTER_SITE_URL', null)
  const openrouterAppName = readStringEnv(env, 'NEWAGENT_OPENROUTER_APP_NAME', 'newagent')
  const enableBackgroundPrecompute = readBooleanEnv(
    env,
    'NEWAGENT_ENABLE_BACKGROUND_PRECOMPUTE',
    false
  )
  const backgroundPrecomputeModel = readStringEnv(
    env,
    'NEWAGENT_BACKGROUND_PRECOMPUTE_MODEL',
    externalReviewModel
  )

  return {
    agent_key: 'newagent',
    role: 'Adaptive general-purpose agent',
    default_task_mode: 'general',
    deployment_target: 'aliyun',
    capabilities: {
      general_assistant: { default: true },
      project_ops: { default: false }
    },
    channels: {
      primary: {
        type: 'feishu',
        connection_mode: 'long_connection'
      },
      coworker: {
        type: 'ssh-channel',
        connection_mode: 'duplex_long_poll',
        target: 'qwen_mac_local',
        location: 'mac_local_qwen',
        authority: 'advisory_only'
      }
    },
    model_routing: {
      planner: {
        provider: 'bailian',
        model: 'codingplan',
        provider_model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1',
        extra_body: { enable_thinking: true }
      },
      execution: {
        provider: 'bailian',
        model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1'
      },
      summarization: {
        provider: 'bailian',
        model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1'
      },
      evaluation: {
        provider: 'openrouter',
        model: externalReviewModel,
        api_key_env: 'OPENROUTER_API_KEY',
        base_url_default: 'https://openrouter.ai/api/v1'
      },
      background: {
        provider: 'openrouter',
        model: backgroundPrecomputeModel,
        api_key_env: 'OPENROUTER_API_KEY',
        base_url_default: 'https://openrouter.ai/api/v1'
      }
    },
    memory: {
      dual_track: {
        primary: { kind: 'feedback_rule', priority: 'high' },
        secondary: { kind: 'confirmation_signal', priority: 'normal', mutual_exclusion: 'hasMemoryWritesSince' }
      },
      confirmation_signals: {
        positive: ['好的', '收到', '没问题', 'perfect', 'yes exactly'],
        negative: ['不', '不用', '暂停', '停止', 'no', 'stop']
      }
    },
    background_precompute: {
      enabled: enableBackgroundPrecompute,
      model: backgroundPrecomputeModel,
      cheapest_first_gates: {
        gate1_time_check: { enabled: true, window_ms: 5 * 60 * 1000 },
        gate1_5_scan_throttle: { enabled: true, window_ms: 10 * 60 * 1000 },
        gate2_session_count: { enabled: true, min_sessions: 5 },
        gate3_concurrency_lock: { enabled: true }
      }
    },
    circuit_breaker: {
      enabled: true,
      max_consecutive_failures: 3,
      reset_timeout_ms: 5 * 60 * 1000
    },
    prompt_contracts: {
      action_moment_triggers: [
        { trigger: 'Before receiving feishu message', action: 'prepare context' },
        { trigger: 'When user sends message', action: 'classify intent' },
        { trigger: 'Before planning', action: 'check circuit breaker' },
        { trigger: 'Before executing tool', action: 'validate safety' },
        { trigger: 'After tool execution', action: 'capture confirmation signal' },
        { trigger: 'After task completion', action: 'save feedback rule' },
        { trigger: 'Before background precompute', action: 'run cheapest first gates' }
      ]
    }
  }
}
