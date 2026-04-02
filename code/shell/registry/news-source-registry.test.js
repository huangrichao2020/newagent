import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createNewsSourceRegistry } from './news-source-registry.js'

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'newagent-news-source-registry-'))
  const storageRoot = join(root, 'storage')

  return {
    storageRoot,
    registry: createNewsSourceRegistry({ storageRoot })
  }
}

test('listSources exposes default stock and hot feeds before any explicit writes', async () => {
  const { registry } = await createHarness()

  const sources = await registry.listSources()

  assert.equal(sources.some((source) => source.source_key === 'eastmoney_stock_fastnews'), true)
  assert.equal(sources.some((source) => source.source_key === 'v2ex_hot_topics'), true)
})

test('registerSource can add one general feed and then retrieve it by key', async () => {
  const { registry } = await createHarness()

  await registry.registerSource({
    source_key: 'custom_general_feed',
    category: 'general',
    name: 'Custom General Feed',
    transport: 'rss',
    url: 'https://example.com/feed.xml',
    notes: 'Custom feed'
  })

  const source = await registry.getSource('custom_general_feed')

  assert.equal(source?.category, 'general')
  assert.equal(source?.transport, 'rss')
  assert.equal(source?.url, 'https://example.com/feed.xml')
})
