import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectRegistry } from './project-registry.js'
import {
  createRemoteServerManagerProfile,
  getAliyunSeedProjects
} from '../manager/remote-server-manager-profile.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-project-registry-'))
  const storageRoot = join(root, 'storage')
  const registry = createProjectRegistry({ storageRoot })

  return {
    storageRoot,
    registry
  }
}

test('registerProject upserts a canonical server project record', async () => {
  const { registry } = await createHarness()

  const written = await registry.registerProject({
    project_key: 'uwillberich',
    name: 'uwillberich',
    tier: 'major',
    role: 'Stock operations and reporting',
    source_root: '/root/uwillberich',
    runtime_root: '/root/.uwillberich',
    publish_root: '/opt/agent-sites/chaochao/current',
    public_base_path: '/apps/chaochao/',
    pm2_name: 'uwillberich-api',
    status: 'active'
  })
  const loaded = await registry.getProject('uwillberich')

  assert.equal(written.project_key, 'uwillberich')
  assert.equal(loaded?.pm2_name, 'uwillberich-api')
  assert.equal(loaded?.public_base_path, '/apps/chaochao/')
  assert.equal(loaded?.status, 'active')
})

test('seedProjects writes the aliyun server baseline and listProjects can filter by tier', async () => {
  const { registry } = await createHarness()

  await registry.seedProjects(getAliyunSeedProjects())

  const majorProjects = await registry.listProjects({
    tier: 'major'
  })
  const minorProjects = await registry.listProjects({
    tier: 'minor'
  })

  assert.equal(majorProjects.length, 3)
  assert.equal(minorProjects.length, 3)
  assert.equal(majorProjects.some((project) => project.project_key === 'gent-mesh'), true)
  assert.equal(minorProjects.some((project) => project.project_key === 'deploy-hub'), true)
})

test('remote manager profile pins the intended channels and model routing', async () => {
  const profile = createRemoteServerManagerProfile({
    env: {}
  })

  assert.equal(profile.channels.primary.type, 'feishu')
  assert.equal(profile.channels.primary.connection_mode, 'long_connection')
  assert.equal(profile.channels.primary.remote_relay_required, false)
  assert.equal(profile.model_routing.planner.provider, 'bailian')
  assert.equal(profile.model_routing.planner.model, 'codingplan')
  assert.equal(profile.model_routing.execution.model, 'qwen3.5-plus')
  assert.equal(profile.external_review.enabled, false)
  assert.equal(profile.background_precompute.enabled, false)
  assert.equal(profile.codex_integration.allow_review, true)
  assert.equal(profile.codex_integration.allow_repair, true)
})

test('remote manager profile can disable Codex integration through env flags', async () => {
  const profile = createRemoteServerManagerProfile({
    env: {
      NEWAGENT_DISABLE_CODEX: 'true'
    }
  })

  assert.equal(profile.codex_integration.allow_review, false)
  assert.equal(profile.codex_integration.allow_repair, false)
})

test('remote manager profile can enable OpenRouter external review without storing secrets in repo config', async () => {
  const profile = createRemoteServerManagerProfile({
    env: {
      NEWAGENT_ENABLE_EXTERNAL_REVIEW: 'true',
      NEWAGENT_EXTERNAL_REVIEW_MODEL: 'stepfun/step-3.5-flash:free',
      NEWAGENT_OPENROUTER_SITE_URL: 'https://newagent.local'
    }
  })

  assert.equal(profile.external_review.enabled, true)
  assert.equal(profile.external_review.enforcing, false)
  assert.equal(profile.model_routing.evaluation.provider, 'openrouter')
  assert.equal(profile.model_routing.evaluation.model, 'stepfun/step-3.5-flash:free')
  assert.equal(profile.background_precompute.enabled, true)
  assert.equal(profile.model_routing.background.provider, 'openrouter')
  assert.equal(profile.model_routing.background.model, 'stepfun/step-3.5-flash:free')
  assert.equal(
    profile.model_routing.evaluation.extra_headers['HTTP-Referer'],
    'https://newagent.local'
  )
})
