import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function cleanText(value) {
  return String(value ?? '').trim()
}

function quoteShellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`
}

function extractJsonObject(text) {
  const raw = String(text ?? '').trim()
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error('Remote coworker response did not contain a JSON object')
  }

  return raw.slice(firstBrace, lastBrace + 1)
}

function buildRemoteCliCommand({
  remoteRepoRoot,
  argv
}) {
  const command = argv.map((item) => quoteShellArg(item)).join(' ')
  return `cd ${quoteShellArg(remoteRepoRoot)} && node ./bin/newagent.js ${command}`
}

export function createRemoteCoworkerClient({
  remoteHost = 'aliyun',
  remoteRepoRoot = '/root/newagent/code',
  remoteStorageRoot = '/root/newagent/storage',
  execFileFn = execFileAsync
} = {}) {
  async function runRemoteCoworkerCommand(argv) {
    const normalizedArgv = [
      ...argv,
      '--storage-root',
      remoteStorageRoot,
      '--json'
    ]
    const remoteCommand = buildRemoteCliCommand({
      remoteRepoRoot,
      argv: normalizedArgv
    })

    try {
      const result = await execFileFn('ssh', [remoteHost, remoteCommand], {
        maxBuffer: 10 * 1024 * 1024
      })

      return JSON.parse(extractJsonObject(result.stdout))
    } catch (error) {
      const stdout = error?.stdout ?? ''
      const stderr = error?.stderr ?? ''
      const message = cleanText(stderr) || cleanText(stdout) || error?.message || 'Unknown remote coworker error'

      throw new Error(`Remote coworker command failed: ${message}`)
    }
  }

  async function waitForRequest({
    target = 'codex_mac_local',
    claimBy = 'codex_mac_local',
    location = 'mac_local_codex',
    timeoutMs = 30 * 1000,
    pollIntervalMs = 1000,
    afterId = null
  } = {}) {
    const argv = [
      'coworker',
      'wait',
      '--target',
      target,
      '--claim-by',
      claimBy,
      '--location',
      location,
      '--timeout-ms',
      String(timeoutMs),
      '--poll-interval-ms',
      String(pollIntervalMs)
    ]

    if (afterId) {
      argv.push('--after-id', afterId)
    }

    return runRemoteCoworkerCommand(argv)
  }

  async function replyToRequest({
    requestId,
    answer,
    resolvedBy = 'codex_mac_local',
    location = 'mac_local_codex'
  }) {
    return runRemoteCoworkerCommand([
      'coworker',
      'reply',
      '--request-id',
      requestId,
      '--answer',
      answer,
      '--resolved-by',
      resolvedBy,
      '--location',
      location
    ])
  }

  async function listRequests({
    target = 'codex_mac_local',
    status = null,
    limit = 20
  } = {}) {
    const argv = [
      'coworker',
      'list',
      '--target',
      target,
      '--limit',
      String(limit)
    ]

    if (status) {
      argv.push('--status', status)
    }

    return runRemoteCoworkerCommand(argv)
  }

  return {
    listRequests,
    replyToRequest,
    runRemoteCoworkerCommand,
    waitForRequest
  }
}

export {
  buildRemoteCliCommand,
  extractJsonObject
}
