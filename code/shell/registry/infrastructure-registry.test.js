import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInfrastructureRegistry } from './infrastructure-registry.js'
import { getAliyunInfrastructureRegistry } from '../manager/agent-profile.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-infra-registry-'))
  const storageRoot = join(root, 'storage')

  return {
    storageRoot,
    registry: createInfrastructureRegistry({ storageRoot })
  }
}

test('seedRegistry writes the aliyun infrastructure baseline with projects, services, and routes', async () => {
  const { registry } = await createHarness()

  const baseline = getAliyunInfrastructureRegistry()
  await registry.seedRegistry(baseline)

  const projects = await registry.listProjects()
  const services = await registry.listServices()
  const routes = await registry.listRoutes()

  assert.equal(projects.some((project) => project.project_key === 'newagent'), true)
  assert.equal(services.some((service) => service.service_key === 'newagent-manager'), true)
  assert.equal(routes.some((route) => route.route_key === 'uwillberich-public-app'), true)
})

test('listServices and listRoutes can filter infrastructure records by project', async () => {
  const { registry } = await createHarness()

  await registry.seedRegistry(getAliyunInfrastructureRegistry())

  const newagentServices = await registry.listServices({
    projectKey: 'newagent'
  })
  const uwillberichRoutes = await registry.listRoutes({
    projectKey: 'uwillberich'
  })

  assert.equal(newagentServices.length >= 2, true)
  assert.equal(
    newagentServices.some((service) => service.service_key === 'newagent-scrapling-worker'),
    true
  )
  assert.equal(
    uwillberichRoutes.some((route) => route.path_prefix === '/apps/chaochao/'),
    true
  )
})
