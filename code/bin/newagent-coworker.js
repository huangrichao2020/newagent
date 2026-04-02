#!/usr/bin/env node
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createLocalCoworkerInbox } from '../shell/coworkers/local-coworker-inbox.js'
import { createCoworkerNotifier } from '../shell/coworkers/coworker-notifier.js'
import { createRemoteCoworkerClient } from '../shell/coworkers/remote-coworker-client.js'

function parseArgs(argv) {
  const args = [...argv]
  const commandTokens = []
  const booleanOptions = new Set(['json', 'notify', 'once', 'no-notify'])

  while (args[0] && !args[0].startsWith('--')) {
    commandTokens.push(args.shift())
  }

  const command = commandTokens.join(' ')
  const options = {}

  while (args.length > 0) {
    const token = args.shift()

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`)
    }

    const key = token.slice(2)

    if (booleanOptions.has(key)) {
      options[key] = true
      continue
    }

    const value = args.shift()

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for option: --${key}`)
    }

    options[key] = value
  }

  return {
    command,
    options
  }
}

function requireOption(options, name) {
  const value = options[name]

  if (!value) {
    throw new Error(`Missing required option: --${name}`)
  }

  return value
}

function formatOutput(payload, asJson) {
  if (asJson) {
    return `${JSON.stringify(payload, null, 2)}\n`
  }

  if (payload.record) {
    return [
      `request_id: ${payload.record.id}`,
      `local_status: ${payload.record.local_status ?? 'received'}`,
      `status: ${payload.record.status ?? 'unknown'}`,
      `title: ${payload.record.title ?? 'null'}`,
      `question: ${payload.record.question ?? 'null'}`
    ].join('\n') + '\n'
  }

  if (payload.request) {
    return [
      `request_id: ${payload.request.id}`,
      `title: ${payload.request.title ?? 'null'}`,
      `authority: ${payload.request.authority ?? 'advisory_only'}`,
      `question: ${payload.request.question ?? 'null'}`
    ].join('\n') + '\n'
  }

  if (Array.isArray(payload.records)) {
    return `${payload.records.map((record) => `${record.id} ${record.local_status}`).join('\n')}\n`
  }

  return `${JSON.stringify(payload, null, 2)}\n`
}

function formatError(error, asJson) {
  if (asJson) {
    return `${JSON.stringify({ error: error.message }, null, 2)}\n`
  }

  return `Error: ${error.message}\n`
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const asJson = options.json === true
  const inboxRoot = options['inbox-root']
    ?? resolve(homedir(), '.codex', 'memories', 'newagent-coworker-inbox')
  const inbox = createLocalCoworkerInbox({
    inboxRoot
  })
  const notifier = createCoworkerNotifier({
    enabled: options.notify === true || (options.once !== true && options['no-notify'] !== true)
  })
  const remoteClient = createRemoteCoworkerClient({
    remoteHost: options['remote-host'] ?? 'aliyun',
    remoteRepoRoot: options['remote-repo-root'] ?? '/root/newagent/code',
    remoteStorageRoot: options['remote-storage-root'] ?? '/root/newagent/storage'
  })

  if (command === 'listen') {
    do {
      const payload = await remoteClient.waitForRequest({
        target: options.target ?? 'codex_mac_local',
        claimBy: options['claim-by'] ?? 'codex_mac_local',
        location: options.location ?? 'mac_local_codex',
        timeoutMs: options['timeout-ms']
          ? Number.parseInt(options['timeout-ms'], 10)
          : 30 * 1000,
        pollIntervalMs: options['poll-interval-ms']
          ? Number.parseInt(options['poll-interval-ms'], 10)
          : 1000,
        afterId: options['after-id'] ?? null
      })

      if (payload.request) {
        const record = await inbox.recordRequest(payload.request)
        try {
          const notification = await notifier.notifyRequest(payload.request)

          if (notification.delivered) {
            await inbox.markNotified(payload.request.id)
          }
        } catch (error) {
          await inbox.markNotified(payload.request.id, {
            delivered: false,
            error: error.message
          })
        }

        process.stdout.write(formatOutput({
          command: 'listen',
          timed_out: false,
          request: payload.request,
          record
        }, asJson))
      } else if (options.once === true) {
        process.stdout.write(formatOutput({
          command: 'listen',
          timed_out: true,
          request: null
        }, asJson))
        return
      }
    } while (options.once !== true)

    return
  }

  if (command === 'reply') {
    const payload = await remoteClient.replyToRequest({
      requestId: requireOption(options, 'request-id'),
      answer: requireOption(options, 'answer'),
      resolvedBy: options['resolved-by'] ?? 'codex_mac_local',
      location: options.location ?? 'mac_local_codex'
    })

    await inbox.recordRequest(payload.request)
    await inbox.markReplied(payload.request.id, {
      answer: payload.request.answer
    })
    process.stdout.write(formatOutput({
      command: 'reply',
      request: payload.request
    }, asJson))
    return
  }

  if (command === 'list') {
    const records = await inbox.listRecords({
      localStatus: options.status ?? null,
      limit: options.limit ? Number.parseInt(options.limit, 10) : null
    })

    process.stdout.write(formatOutput({
      command: 'list',
      records
    }, asJson))
    return
  }

  if (command === 'get') {
    const record = await inbox.getRecord(requireOption(options, 'request-id'))

    if (!record) {
      throw new Error(`Unknown local coworker inbox record: ${options['request-id']}`)
    }

    process.stdout.write(formatOutput({
      command: 'get',
      record
    }, asJson))
    return
  }

  if (command === 'latest') {
    const record = await inbox.getLatestRecord({
      localStatus: options.status ?? null
    })

    process.stdout.write(formatOutput({
      command: 'latest',
      record
    }, asJson))
    return
  }

  if (command === 'reply-latest') {
    const answer = requireOption(options, 'answer')
    const record = await inbox.getLatestRecord({
      localStatus: options.status ?? 'received'
    })

    if (!record) {
      throw new Error('No matching local coworker inbox record to reply to')
    }

    const payload = await remoteClient.replyToRequest({
      requestId: record.id,
      answer,
      resolvedBy: options['resolved-by'] ?? 'codex_mac_local',
      location: options.location ?? 'mac_local_codex'
    })

    await inbox.recordRequest(payload.request)
    await inbox.markReplied(payload.request.id, {
      answer: payload.request.answer
    })
    process.stdout.write(formatOutput({
      command: 'reply-latest',
      request: payload.request,
      record: await inbox.getRecord(payload.request.id)
    }, asJson))
    return
  }

  throw new Error(`Unsupported command: ${command || 'null'}`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(formatError(error, process.argv.includes('--json')))
  process.exitCode = 1
}
