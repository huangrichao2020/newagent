function readBooleanEnv(env, name, fallback) {
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

export function createRemoteServerManagerProfile({
  env = process.env
} = {}) {
  const disableCodex = readBooleanEnv(env, 'NEWAGENT_DISABLE_CODEX', false)
  const allowReview = disableCodex
    ? false
    : readBooleanEnv(env, 'NEWAGENT_ENABLE_CODEX_REVIEW', true)
  const allowRepair = disableCodex
    ? false
    : readBooleanEnv(env, 'NEWAGENT_ENABLE_CODEX_REPAIR', true)
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

  return {
    agent_key: 'remote-server-manager',
    role: 'Professional remote server project manager agent',
    deployment_target: 'aliyun',
    channels: {
      primary: {
        type: 'feishu',
        connection_mode: 'long_connection',
        remote_relay_required: false
      }
    },
    model_routing: {
      planner: {
        provider: 'bailian',
        model: 'codingplan',
        provider_model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        fallback_api_key_envs: ['DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
        base_url_env: 'NEWAGENT_BAILIAN_PLANNER_BASE_URL',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1',
        extra_body: {
          enable_thinking: true
        }
      },
      execution: {
        provider: 'bailian',
        model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        fallback_api_key_envs: ['DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
        base_url_env: 'NEWAGENT_BAILIAN_EXECUTION_BASE_URL',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1'
      },
      summarization: {
        provider: 'bailian',
        model: 'qwen3.5-plus',
        api_key_env: 'NEWAGENT_BAILIAN_API_KEY',
        fallback_api_key_envs: ['DASHSCOPE_API_KEY', 'MODELSTUDIO_API_KEY'],
        base_url_env: 'NEWAGENT_BAILIAN_SUMMARIZATION_BASE_URL',
        base_url_default: 'https://coding.dashscope.aliyuncs.com/v1'
      },
      evaluation: {
        provider: 'openrouter',
        model: externalReviewModel,
        api_key_env: 'OPENROUTER_API_KEY',
        fallback_api_key_envs: ['NEWAGENT_OPENROUTER_API_KEY'],
        base_url_env: 'NEWAGENT_OPENROUTER_BASE_URL',
        base_url_default: 'https://openrouter.ai/api/v1',
        extra_headers: {
          'HTTP-Referer': openrouterSiteUrl,
          'X-OpenRouter-Title': openrouterAppName
        }
      }
    },
    external_review: {
      enabled: enableExternalReview,
      enforcing: enforceExternalReview,
      model: externalReviewModel
    },
    codex_integration: {
      allow_review: allowReview,
      allow_repair: allowRepair,
      review_tool_name: 'codex_review_workspace',
      repair_tool_name: 'codex_repair_workspace'
    }
  }
}

export function getAliyunSeedProjects() {
  return [
    {
      project_key: 'uwillberich',
      name: 'uwillberich',
      tier: 'major',
      role: 'Stock operations, reports, API, and static publishing',
      source_root: '/root/uwillberich',
      runtime_root: '/root/.uwillberich',
      publish_root: '/opt/agent-sites/chaochao/current',
      public_base_path: '/apps/chaochao/',
      pm2_name: 'uwillberich-api',
      service_endpoint: 'http://127.0.0.1:3100/api/health',
      repo_remote: 'https://github.com/huangrichao2020/uwillberich.git',
      branch: 'main',
      status: 'active'
    },
    {
      project_key: 'novel-evolution',
      name: 'novel-evolution',
      tier: 'major',
      role: 'Novel production workspace with prod and test runtimes',
      source_root: '/root/novel-evolution-src',
      runtime_root: '/root/novel-evolution',
      publish_root: null,
      public_base_path: null,
      pm2_name: 'novel-evolution',
      service_endpoint: 'http://127.0.0.1:3800/',
      repo_remote: '/root/git/novel-evolution.git',
      branch: 'main',
      status: 'active',
      notes: 'Test runtime lives at /root/novel-evolution-test and listens on 3801.'
    },
    {
      project_key: 'gent-mesh',
      name: 'gent-mesh',
      tier: 'major',
      role: 'Real-time multi-agent communication mesh',
      source_root: '/root/gent-mesh',
      runtime_root: '/root/gent-mesh',
      publish_root: null,
      public_base_path: null,
      pm2_name: 'gent-mesh-spoke',
      service_endpoint: 'http://127.0.0.1:7701/',
      repo_remote: 'https://github.com/huangrichao2020/gent-mesh.git',
      branch: 'main',
      status: 'active'
    },
    {
      project_key: 'deploy-hub',
      name: 'deploy-hub',
      tier: 'minor',
      role: 'Static site publish infrastructure',
      source_root: '/root/deploy-hub',
      runtime_root: '/opt/deploy-hub',
      publish_root: '/opt/agent-sites',
      public_base_path: '/apps/',
      pm2_name: 'deploy-hub',
      service_endpoint: 'http://127.0.0.1:3900/_deploy/ticket',
      status: 'active'
    },
    {
      project_key: 'acp-registry',
      name: 'acp-registry',
      tier: 'minor',
      role: 'Agent communication protocol registry and discovery',
      source_root: '/root/acp-registry',
      runtime_root: '/root/acp-registry',
      publish_root: null,
      public_base_path: null,
      pm2_name: 'acp-registry',
      service_endpoint: 'http://127.0.0.1:8801/health',
      status: 'active'
    },
    {
      project_key: 'ssh-channel',
      name: 'ssh-channel',
      tier: 'minor',
      role: 'Cross-machine task and duplex coordination channel',
      source_root: '/root/ssh-channel',
      runtime_root: '/root/ssh-channel',
      publish_root: null,
      public_base_path: null,
      pm2_name: null,
      service_endpoint: null,
      status: 'active'
    }
  ]
}
