import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const REGISTRY_VERSION = 1

function nowIso() {
  return new Date().toISOString()
}

function registryPath(storageRoot) {
  return join(storageRoot, 'registry', 'infrastructure.json')
}

function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    projects: [],
    services: [],
    routes: []
  }
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function normalizeOptionalPort(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const parsed = Number.parseInt(String(value), 10)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid port value: ${value}`)
  }

  return parsed
}

function requireString(record, key, label) {
  const value = normalizeOptionalString(record[key])

  if (!value) {
    throw new Error(`Missing required ${label} field: ${key}`)
  }

  return value
}

function normalizeProject(project, existing = null) {
  return {
    project_key: requireString(project, 'project_key', 'project'),
    name: requireString(project, 'name', 'project'),
    tier: requireString(project, 'tier', 'project'),
    role: requireString(project, 'role', 'project'),
    source_root: requireString(project, 'source_root', 'project'),
    runtime_root: normalizeOptionalString(project.runtime_root),
    publish_root: normalizeOptionalString(project.publish_root),
    public_base_path: normalizeOptionalString(project.public_base_path),
    status: normalizeOptionalString(project.status) ?? 'active',
    notes: normalizeOptionalString(project.notes),
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  }
}

function normalizeService(service, existing = null) {
  return {
    service_key: requireString(service, 'service_key', 'service'),
    project_key: requireString(service, 'project_key', 'service'),
    name: requireString(service, 'name', 'service'),
    role: requireString(service, 'role', 'service'),
    runtime_kind: requireString(service, 'runtime_kind', 'service'),
    manager: normalizeOptionalString(service.manager),
    process_name: normalizeOptionalString(service.process_name),
    listen_host: normalizeOptionalString(service.listen_host),
    listen_port: normalizeOptionalPort(service.listen_port),
    healthcheck_url: normalizeOptionalString(service.healthcheck_url),
    source_root: normalizeOptionalString(service.source_root),
    runtime_root: normalizeOptionalString(service.runtime_root),
    public_base_path: normalizeOptionalString(service.public_base_path),
    entry_html: normalizeOptionalString(service.entry_html),
    env: normalizeOptionalString(service.env) ?? 'prod',
    status: normalizeOptionalString(service.status) ?? 'active',
    notes: normalizeOptionalString(service.notes),
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  }
}

function normalizeRoute(route, existing = null) {
  return {
    route_key: requireString(route, 'route_key', 'route'),
    project_key: requireString(route, 'project_key', 'route'),
    service_key: normalizeOptionalString(route.service_key),
    name: requireString(route, 'name', 'route'),
    route_kind: requireString(route, 'route_kind', 'route'),
    host: normalizeOptionalString(route.host),
    path_prefix: normalizeOptionalString(route.path_prefix),
    public_url: normalizeOptionalString(route.public_url),
    upstream_url: normalizeOptionalString(route.upstream_url),
    static_root: normalizeOptionalString(route.static_root),
    entry_html: normalizeOptionalString(route.entry_html),
    exposure: normalizeOptionalString(route.exposure) ?? 'internal',
    status: normalizeOptionalString(route.status) ?? 'active',
    notes: normalizeOptionalString(route.notes),
    created_at: existing?.created_at ?? nowIso(),
    updated_at: nowIso()
  }
}

async function loadRegistryFile(storageRoot) {
  try {
    return await readJson(registryPath(storageRoot))
  } catch {
    return defaultRegistry()
  }
}

async function saveRegistryFile(storageRoot, registry) {
  await writeJsonAtomic(registryPath(storageRoot), {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    projects: registry.projects,
    services: registry.services,
    routes: registry.routes
  })
}

export function createInfrastructureRegistry({ storageRoot }) {
  async function listProjects({ status = null } = {}) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.projects.filter((project) => !status || project.status === status)
  }

  async function getProject(projectKey) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.projects.find((project) => project.project_key === projectKey) ?? null
  }

  async function registerProject(project) {
    const registry = await loadRegistryFile(storageRoot)
    const index = registry.projects.findIndex((entry) => entry.project_key === project.project_key)
    const normalized = normalizeProject(project, index >= 0 ? registry.projects[index] : null)

    if (index >= 0) {
      registry.projects[index] = normalized
    } else {
      registry.projects.push(normalized)
    }

    registry.projects.sort((left, right) => left.project_key.localeCompare(right.project_key))
    await saveRegistryFile(storageRoot, registry)

    return normalized
  }

  async function listServices({ projectKey = null, status = null, env = null } = {}) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.services.filter((service) => {
      if (projectKey && service.project_key !== projectKey) {
        return false
      }

      if (status && service.status !== status) {
        return false
      }

      if (env && service.env !== env) {
        return false
      }

      return true
    })
  }

  async function getService(serviceKey) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.services.find((service) => service.service_key === serviceKey) ?? null
  }

  async function registerService(service) {
    const registry = await loadRegistryFile(storageRoot)
    const index = registry.services.findIndex((entry) => entry.service_key === service.service_key)
    const normalized = normalizeService(service, index >= 0 ? registry.services[index] : null)

    if (index >= 0) {
      registry.services[index] = normalized
    } else {
      registry.services.push(normalized)
    }

    registry.services.sort((left, right) => left.service_key.localeCompare(right.service_key))
    await saveRegistryFile(storageRoot, registry)

    return normalized
  }

  async function listRoutes({ projectKey = null, serviceKey = null, status = null, exposure = null } = {}) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.routes.filter((route) => {
      if (projectKey && route.project_key !== projectKey) {
        return false
      }

      if (serviceKey && route.service_key !== serviceKey) {
        return false
      }

      if (status && route.status !== status) {
        return false
      }

      if (exposure && route.exposure !== exposure) {
        return false
      }

      return true
    })
  }

  async function getRoute(routeKey) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.routes.find((route) => route.route_key === routeKey) ?? null
  }

  async function registerRoute(route) {
    const registry = await loadRegistryFile(storageRoot)
    const index = registry.routes.findIndex((entry) => entry.route_key === route.route_key)
    const normalized = normalizeRoute(route, index >= 0 ? registry.routes[index] : null)

    if (index >= 0) {
      registry.routes[index] = normalized
    } else {
      registry.routes.push(normalized)
    }

    registry.routes.sort((left, right) => left.route_key.localeCompare(right.route_key))
    await saveRegistryFile(storageRoot, registry)

    return normalized
  }

  async function seedRegistry({
    projects = [],
    services = [],
    routes = []
  } = {}) {
    const writtenProjects = []
    const writtenServices = []
    const writtenRoutes = []

    for (const project of projects) {
      writtenProjects.push(await registerProject(project))
    }

    for (const service of services) {
      writtenServices.push(await registerService(service))
    }

    for (const route of routes) {
      writtenRoutes.push(await registerRoute(route))
    }

    return {
      projects: writtenProjects,
      services: writtenServices,
      routes: writtenRoutes
    }
  }

  return {
    listProjects,
    getProject,
    registerProject,
    listServices,
    getService,
    registerService,
    listRoutes,
    getRoute,
    registerRoute,
    seedRegistry
  }
}
