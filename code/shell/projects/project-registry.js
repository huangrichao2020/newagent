import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../../storage/json-files.js'

const REGISTRY_VERSION = 1

function nowIso() {
  return new Date().toISOString()
}

function registryPath(storageRoot) {
  return join(storageRoot, 'projects', 'registry.json')
}

function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    projects: []
  }
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return null
  }

  const normalized = String(value).trim()
  return normalized === '' ? null : normalized
}

function requireString(project, key) {
  const value = normalizeOptionalString(project[key])

  if (!value) {
    throw new Error(`Missing required project field: ${key}`)
  }

  return value
}

function normalizeProject(project, existing = null) {
  const createdAt = existing?.created_at ?? nowIso()
  const updatedAt = nowIso()

  return {
    project_key: requireString(project, 'project_key'),
    name: requireString(project, 'name'),
    tier: requireString(project, 'tier'),
    role: requireString(project, 'role'),
    source_root: requireString(project, 'source_root'),
    runtime_root: normalizeOptionalString(project.runtime_root),
    publish_root: normalizeOptionalString(project.publish_root),
    public_base_path: normalizeOptionalString(project.public_base_path),
    pm2_name: normalizeOptionalString(project.pm2_name),
    service_endpoint: normalizeOptionalString(project.service_endpoint),
    repo_remote: normalizeOptionalString(project.repo_remote),
    branch: normalizeOptionalString(project.branch),
    status: normalizeOptionalString(project.status) ?? 'active',
    notes: normalizeOptionalString(project.notes),
    created_at: createdAt,
    updated_at: updatedAt
  }
}

async function loadRegistryFile(storageRoot) {
  const filePath = registryPath(storageRoot)

  try {
    return await readJson(filePath)
  } catch {
    return defaultRegistry()
  }
}

async function saveRegistryFile(storageRoot, registry) {
  const filePath = registryPath(storageRoot)

  await writeJsonAtomic(filePath, {
    version: REGISTRY_VERSION,
    updated_at: nowIso(),
    projects: registry.projects
  })
}

export function createProjectRegistry({ storageRoot }) {
  async function listProjects({ tier = null, status = null } = {}) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.projects.filter((project) => {
      if (tier && project.tier !== tier) {
        return false
      }

      if (status && project.status !== status) {
        return false
      }

      return true
    })
  }

  async function getProject(projectKey) {
    const registry = await loadRegistryFile(storageRoot)

    return registry.projects.find((project) => project.project_key === projectKey) ?? null
  }

  async function registerProject(project) {
    const registry = await loadRegistryFile(storageRoot)
    const existingIndex = registry.projects.findIndex(
      (entry) => entry.project_key === project.project_key
    )
    const existing = existingIndex >= 0 ? registry.projects[existingIndex] : null
    const normalized = normalizeProject(project, existing)

    if (existingIndex >= 0) {
      registry.projects[existingIndex] = normalized
    } else {
      registry.projects.push(normalized)
    }

    registry.projects.sort((left, right) => left.project_key.localeCompare(right.project_key))
    await saveRegistryFile(storageRoot, registry)

    return normalized
  }

  async function seedProjects(projects) {
    const written = []

    for (const project of projects) {
      written.push(await registerProject(project))
    }

    return written
  }

  return {
    listProjects,
    getProject,
    registerProject,
    seedProjects
  }
}
