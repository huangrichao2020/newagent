import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRemoteCliCommand,
  createRemoteCoworkerClient,
  extractJsonObject
} from './remote-coworker-client.js'

test('buildRemoteCliCommand quotes the remote repo root and arguments safely', () => {
  const command = buildRemoteCliCommand({
    remoteRepoRoot: '/root/newagent/code',
    argv: ['coworker', 'wait', '--target', 'codex_mac_local']
  })

  assert.match(command, /cd '\/root\/newagent\/code'/)
  assert.match(command, /node \.\/bin\/newagent\.js 'coworker' 'wait'/)
})

test('extractJsonObject can skip remote banner noise before the CLI payload', () => {
  const payload = extractJsonObject([
    '[系统] 暂无交接记录',
    '{',
    '  "command": "coworker wait"',
    '}'
  ].join('\n'))

  assert.equal(payload, '{\n  "command": "coworker wait"\n}')
})

test('waitForRequest runs the remote coworker wait command over ssh and parses json output', async () => {
  const calls = []
  const client = createRemoteCoworkerClient({
    execFileFn: async (file, args) => {
      calls.push({
        file,
        args
      })

      return {
        stdout: [
          '[系统] 暂无交接记录',
          JSON.stringify({
            command: 'coworker wait',
            timed_out: false,
            request: {
              id: 'request-1',
              target: 'codex_mac_local',
              status: 'claimed'
            }
          })
        ].join('\n'),
        stderr: ''
      }
    }
  })

  const result = await client.waitForRequest({
    timeoutMs: 5000,
    pollIntervalMs: 200
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'ssh')
  assert.equal(calls[0].args[0], 'aliyun')
  assert.match(calls[0].args[1], /'coworker' 'wait'/)
  assert.match(calls[0].args[1], /'--target' 'codex_mac_local'/)
  assert.match(calls[0].args[1], /'--storage-root' '\/root\/newagent\/storage'/)
  assert.equal(result.request.id, 'request-1')
})

test('replyToRequest surfaces remote command failures clearly', async () => {
  const client = createRemoteCoworkerClient({
    execFileFn: async () => {
      const error = new Error('ssh failed')
      error.stderr = 'permission denied'
      throw error
    }
  })

  await assert.rejects(
    () =>
      client.replyToRequest({
        requestId: 'request-2',
        answer: '先不要自动执行。'
      }),
    /Remote coworker command failed: permission denied/
  )
})
