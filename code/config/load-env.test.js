import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadNewagentEnv } from './load-env.js'

test('loadNewagentEnv loads .env from the current working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-env-'))
  await writeFile(
    join(root, '.env'),
    [
      '# comment',
      'NEWAGENT_BAILIAN_API_KEY=test-key',
      'NEWAGENT_FEISHU_APP_ID="cli_123"'
    ].join('\n'),
    'utf8'
  )
  delete process.env.NEWAGENT_BAILIAN_API_KEY
  delete process.env.NEWAGENT_FEISHU_APP_ID

  const result = await loadNewagentEnv({
    cwd: root
  })

  assert.equal(result.loaded, true)
  assert.equal(process.env.NEWAGENT_BAILIAN_API_KEY, 'test-key')
  assert.equal(process.env.NEWAGENT_FEISHU_APP_ID, 'cli_123')
})

test('loadNewagentEnv falls back to the parent directory and respects existing env vars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newagent-env-parent-'))
  const child = join(root, 'code')
  await mkdir(child, { recursive: true })
  await writeFile(
    join(root, '.env'),
    'NEWAGENT_FEISHU_APP_SECRET=from-file',
    'utf8'
  )
  process.env.NEWAGENT_FEISHU_APP_SECRET = 'already-set'

  const result = await loadNewagentEnv({
    cwd: child
  })

  assert.equal(result.loaded, true)
  assert.equal(process.env.NEWAGENT_FEISHU_APP_SECRET, 'already-set')
})
