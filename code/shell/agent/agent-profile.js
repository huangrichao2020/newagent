/**
 * Agent Profile - 配置中心
 * 新架构简化版
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

export function createAgentProfile({ env = process.env } = {}) {
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
        { trigger: 'After task completion', action: 'save feedback rule' }
      ]
    }
  }
}

export function getAliyunSeedProjects() {
  return [
    { project_key: 'uwillberich', name: '一博交易笔记' },
    { project_key: 'munn111', name: '熊萌笔记' },
    { project_key: 'deploy-hub', name: '部署中心' },
    { project_key: 'acp-registry', name: 'ACP 注册中心' },
    { project_key: 'gent-mesh', name: 'Gent Mesh' },
    { project_key: 'novel-evolution', name: '小说进化' }
  ]
}

export function getAliyunInfrastructureRegistry() {
  return {
    services: [
      { name: 'nginx', port: 80 },
      { name: 'pm2', services: ['newagent-manager', 'newagent-scrapling-worker', 'deploy-hub'] }
    ],
    ports: [80, 443, 3900, 7700, 7701, 8800, 8801]
  }
}
