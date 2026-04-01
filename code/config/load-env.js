import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

function parseEnvLine(line) {
  const trimmed = line.trim()

  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }

  const separatorIndex = trimmed.indexOf('=')

  if (separatorIndex <= 0) {
    return null
  }

  const key = trimmed.slice(0, separatorIndex).trim()
  let value = trimmed.slice(separatorIndex + 1).trim()

  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }

  return {
    key,
    value
  }
}

async function loadOneEnvFile(filePath) {
  const content = await readFile(filePath, 'utf8')
  const loadedKeys = []

  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line)

    if (!parsed) {
      continue
    }

    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value
      loadedKeys.push(parsed.key)
    }
  }

  return loadedKeys
}

export async function loadNewagentEnv({
  cwd = process.cwd(),
  explicitEnvFile = process.env.NEWAGENT_ENV_FILE ?? null
} = {}) {
  const candidates = explicitEnvFile
    ? [resolve(explicitEnvFile)]
    : [
        join(cwd, '.env'),
        join(dirname(cwd), '.env')
      ]

  for (const candidate of candidates) {
    try {
      const loadedKeys = await loadOneEnvFile(candidate)

      return {
        loaded: true,
        path: candidate,
        loaded_keys: loadedKeys
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }

      throw error
    }
  }

  return {
    loaded: false,
    path: null,
    loaded_keys: []
  }
}
