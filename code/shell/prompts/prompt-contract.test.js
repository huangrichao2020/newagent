import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPromptContract } from './prompt-contract.js'

test('buildPromptContract renders titled sections with bullet and plain modes', () => {
  const prompt = buildPromptContract({
    sections: [
      {
        title: 'ROLE',
        lines: ['Act as a remote project manager.']
      },
      {
        title: 'OUTPUT CONTRACT',
        bullet: false,
        lines: [
          'Return JSON only.',
          '{',
          '  "summary": "..."',
          '}'
        ]
      }
    ]
  })

  assert.match(prompt, /ROLE:/)
  assert.match(prompt, /- Act as a remote project manager\./)
  assert.match(prompt, /OUTPUT CONTRACT:/)
  assert.match(prompt, /Return JSON only\./)
  assert.match(prompt, /"summary"/)
})
