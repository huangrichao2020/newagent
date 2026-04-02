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
    role: 'Adaptive general-purpose agent. Treat project and server knowledge as optional skill packs that should be activated only when the request truly needs them.',
    default_task_mode: 'general',
    deployment_target: 'aliyun',
    capabilities: {
      general_assistant: {
        default: true,
        description: 'Default mode for direct answers, document work, structured data tasks, and lightweight execution.'
      },
      project_ops: {
        default: false,
        description: 'Optional skill pack for project context, service health, deployment, and remote-server operations.'
      }
    },
    channels: {
      primary: {
        type: 'feishu',
        connection_mode: 'long_connection',
        remote_relay_required: false
      },
      coworker: {
        type: 'ssh-channel',
        connection_mode: 'duplex_long_poll',
        remote_relay_required: false,
        target: 'qwen_mac_local',
        location: 'mac_local_qwen',
        authority: 'advisory_only',
        auto_execute_allowed: false
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
      },
      background: {
        provider: 'openrouter',
        model: backgroundPrecomputeModel,
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
    background_precompute: {
      enabled: enableBackgroundPrecompute,
      model: backgroundPrecomputeModel
    },
    registry_policy: {
      auto_discovery_write_requires_confirmation: true
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

export function getAliyunInfrastructureRegistry() {
  return {
    projects: [
      ...getAliyunSeedProjects(),
      {
        project_key: 'newagent',
        name: 'newagent',
        tier: 'major',
        role: 'Feishu agent runtime and Scrapling worker',
        source_root: '/root/newagent',
        runtime_root: '/root/newagent',
        publish_root: null,
        public_base_path: null,
        status: 'active',
        notes: 'Primary agent runs through Feishu; Scrapling worker listens on 7771.'
      },
      {
        project_key: 'ai-coach-clawhub',
        name: 'ai-coach-clawhub',
        tier: 'minor',
        role: 'AI coach web service and GitHub callback endpoint',
        source_root: '/root/ai-coach-clawhub',
        runtime_root: '/root/ai-coach-clawhub',
        publish_root: null,
        public_base_path: null,
        status: 'paused',
        notes: 'PM2 service ai-coach-v2 is currently stopped to save memory.'
      }
    ],
    services: [
      {
        service_key: 'uwillberich-api',
        project_key: 'uwillberich',
        name: 'uwillberich-api',
        role: 'Stock API and report backend',
        runtime_kind: 'pm2_python',
        manager: 'pm2',
        process_name: 'uwillberich-api',
        listen_host: '127.0.0.1',
        listen_port: 3100,
        healthcheck_url: 'http://127.0.0.1:3100/api/health',
        source_root: '/root/uwillberich',
        runtime_root: '/root/.uwillberich',
        public_base_path: '/apps/chaochao/',
        entry_html: '/opt/agent-sites/chaochao/current/index.html',
        env: 'prod',
        status: 'active'
      },
      {
        service_key: 'novel-evolution-web',
        project_key: 'novel-evolution',
        name: 'novel-evolution',
        role: 'Novel web application',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'novel-evolution',
        listen_host: '0.0.0.0',
        listen_port: 3800,
        healthcheck_url: 'http://127.0.0.1:3800/',
        source_root: '/root/novel-evolution/app',
        runtime_root: '/root/novel-evolution/app',
        entry_html: '/root/novel-evolution/app/public/bookshelf.html',
        env: 'prod',
        status: 'active'
      },
      {
        service_key: 'novel-evolution-test-web',
        project_key: 'novel-evolution',
        name: 'novel-test',
        role: 'Novel web application test instance',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'novel-test',
        listen_host: '0.0.0.0',
        listen_port: 3801,
        healthcheck_url: 'http://127.0.0.1:3801/',
        source_root: '/root/novel-evolution-test/app',
        runtime_root: '/root/novel-evolution-test/app',
        entry_html: '/root/novel-evolution-test/app/public/bookshelf.html',
        env: 'test',
        status: 'paused',
        notes: 'Stopped on 2026-04-02 to save memory.'
      },
      {
        service_key: 'deploy-hub-api',
        project_key: 'deploy-hub',
        name: 'deploy-hub',
        role: 'Static deploy orchestration service',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'deploy-hub',
        listen_host: '127.0.0.1',
        listen_port: 3900,
        healthcheck_url: 'http://127.0.0.1:3900/_deploy/ticket',
        source_root: '/root/deploy-hub',
        runtime_root: '/opt/deploy-hub',
        env: 'prod',
        status: 'active'
      },
      {
        service_key: 'gent-mesh-spoke',
        project_key: 'gent-mesh',
        name: 'gent-mesh-spoke',
        role: 'Real-time multi-agent mesh spoke',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'gent-mesh-spoke',
        listen_host: '127.0.0.1',
        listen_port: 7701,
        healthcheck_url: 'http://127.0.0.1:7701/',
        source_root: '/root/gent-mesh',
        runtime_root: '/root/gent-mesh',
        env: 'prod',
        status: 'paused',
        notes: 'Stopped on 2026-04-02 to save memory.'
      },
      {
        service_key: 'acp-registry',
        project_key: 'acp-registry',
        name: 'acp-registry',
        role: 'Agent communication registry service',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'acp-registry',
        listen_host: '127.0.0.1',
        listen_port: 8801,
        healthcheck_url: 'http://127.0.0.1:8801/health',
        source_root: '/root/acp-registry',
        runtime_root: '/root/acp-registry',
        env: 'prod',
        status: 'paused',
        notes: 'Stopped on 2026-04-02 to save memory.'
      },
      {
        service_key: 'newagent-manager',
        project_key: 'newagent',
        name: 'newagent-manager',
        role: 'Feishu agent loop and remote project coordinator',
        runtime_kind: 'pm2_node',
        manager: 'pm2',
        process_name: 'newagent-manager',
        listen_host: null,
        listen_port: null,
        healthcheck_url: null,
        source_root: '/root/newagent',
        runtime_root: '/root/newagent',
        env: 'prod',
        status: 'active',
        notes: 'Primary channel is Feishu long connection, not a public HTTP port.'
      },
      {
        service_key: 'newagent-scrapling-worker',
        project_key: 'newagent',
        name: 'newagent-scrapling-worker',
        role: 'HTML extraction worker for agent web tasks',
        runtime_kind: 'pm2_python',
        manager: 'pm2',
        process_name: 'newagent-scrapling-worker',
        listen_host: '127.0.0.1',
        listen_port: 7771,
        healthcheck_url: 'http://127.0.0.1:7771/health',
        source_root: '/root/newagent/code',
        runtime_root: '/root/newagent/code/workers/scrapling_worker',
        env: 'prod',
        status: 'active'
      },
      {
        service_key: 'ai-coach-v2',
        project_key: 'ai-coach-clawhub',
        name: 'ai-coach-v2',
        role: 'AI coach web application',
        runtime_kind: 'pm2_python',
        manager: 'pm2',
        process_name: 'ai-coach-v2',
        listen_host: '0.0.0.0',
        listen_port: 7702,
        healthcheck_url: 'http://127.0.0.1:7702/',
        source_root: '/root/ai-coach-clawhub',
        runtime_root: '/root/ai-coach-clawhub',
        env: 'prod',
        status: 'paused',
        notes: 'Stopped on 2026-04-02 to save memory.'
      }
    ],
    routes: [
      {
        route_key: 'novel-evolution-bookshelf-public',
        project_key: 'novel-evolution',
        service_key: 'novel-evolution-web',
        name: 'Novel Bookshelf Public Entry',
        route_kind: 'direct_http',
        host: '120.26.32.59:3800',
        path_prefix: '/bookshelf',
        public_url: 'http://120.26.32.59:3800/bookshelf',
        upstream_url: 'http://127.0.0.1:3800/bookshelf',
        static_root: null,
        entry_html: '/root/novel-evolution/app/public/bookshelf.html',
        exposure: 'public',
        status: 'active'
      },
      {
        route_key: 'novel-evolution-root-public',
        project_key: 'novel-evolution',
        service_key: 'novel-evolution-web',
        name: 'Novel Root Redirect',
        route_kind: 'direct_http',
        host: '120.26.32.59:3800',
        path_prefix: '/',
        public_url: 'http://120.26.32.59:3800/',
        upstream_url: 'http://127.0.0.1:3800/',
        static_root: null,
        entry_html: '/root/novel-evolution/app/public/index.html',
        exposure: 'public',
        status: 'active'
      },
      {
        route_key: 'novel-evolution-test-bookshelf',
        project_key: 'novel-evolution',
        service_key: 'novel-evolution-test-web',
        name: 'Novel Test Bookshelf Entry',
        route_kind: 'direct_http',
        host: '127.0.0.1:3801',
        path_prefix: '/bookshelf',
        public_url: null,
        upstream_url: 'http://127.0.0.1:3801/bookshelf',
        static_root: null,
        entry_html: '/root/novel-evolution-test/app/public/bookshelf.html',
        exposure: 'internal',
        status: 'paused'
      },
      {
        route_key: 'uwillberich-public-app',
        project_key: 'uwillberich',
        service_key: 'uwillberich-api',
        name: 'uwillberich Public Static App',
        route_kind: 'nginx_static',
        host: '120.26.32.59',
        path_prefix: '/apps/chaochao/',
        public_url: 'http://120.26.32.59/apps/chaochao/',
        upstream_url: null,
        static_root: '/opt/agent-sites/chaochao/current',
        entry_html: '/opt/agent-sites/chaochao/current/index.html',
        exposure: 'public',
        status: 'active'
      },
      {
        route_key: 'deploy-hub-ticket-internal',
        project_key: 'deploy-hub',
        service_key: 'deploy-hub-api',
        name: 'Deploy Hub Ticket API',
        route_kind: 'direct_http',
        host: '127.0.0.1:3900',
        path_prefix: '/_deploy/ticket',
        public_url: null,
        upstream_url: 'http://127.0.0.1:3900/_deploy/ticket',
        static_root: null,
        entry_html: null,
        exposure: 'internal',
        status: 'active'
      },
      {
        route_key: 'newagent-scrapling-extract',
        project_key: 'newagent',
        service_key: 'newagent-scrapling-worker',
        name: 'Newagent Scrapling Extract API',
        route_kind: 'direct_http',
        host: '127.0.0.1:7771',
        path_prefix: '/v1/extract',
        public_url: null,
        upstream_url: 'http://127.0.0.1:7771/v1/extract',
        static_root: null,
        entry_html: null,
        exposure: 'internal',
        status: 'active'
      },
      {
        route_key: 'gent-mesh-direct',
        project_key: 'gent-mesh',
        service_key: 'gent-mesh-spoke',
        name: 'Gent Mesh Direct Endpoint',
        route_kind: 'direct_http',
        host: '127.0.0.1:7701',
        path_prefix: '/',
        public_url: null,
        upstream_url: 'http://127.0.0.1:7701/',
        static_root: null,
        entry_html: null,
        exposure: 'internal',
        status: 'paused'
      },
      {
        route_key: 'acp-registry-health',
        project_key: 'acp-registry',
        service_key: 'acp-registry',
        name: 'ACP Registry Health Endpoint',
        route_kind: 'direct_http',
        host: '127.0.0.1:8801',
        path_prefix: '/health',
        public_url: null,
        upstream_url: 'http://127.0.0.1:8801/health',
        static_root: null,
        entry_html: null,
        exposure: 'internal',
        status: 'paused'
      },
      {
        route_key: 'ai-coach-root',
        project_key: 'ai-coach-clawhub',
        service_key: 'ai-coach-v2',
        name: 'AI Coach Root',
        route_kind: 'direct_http',
        host: '120.26.32.59:7702',
        path_prefix: '/',
        public_url: 'http://120.26.32.59:7702/',
        upstream_url: 'http://127.0.0.1:7702/',
        static_root: null,
        entry_html: null,
        exposure: 'public',
        status: 'paused'
      }
    ]
  }
}
