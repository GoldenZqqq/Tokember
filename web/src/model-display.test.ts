import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ModelTable } from './components/ModelTable'
import {
  mergeByModelFamily,
  modelDisplayName,
  modelFamilyKey,
} from './model-display'

test('modelFamilyKey strips Grok build free billing suffixes', () => {
  assert.equal(modelFamilyKey('grok-4.5'), 'grok-4.5')
  assert.equal(modelFamilyKey('grok-4.5-build-free'), 'grok-4.5')
  assert.equal(modelFamilyKey('grok-4.5-build'), 'grok-4.5')
  assert.equal(modelFamilyKey('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(modelFamilyKey('claude-opus-4-5'), 'claude-opus-4-5')
})

test('modelDisplayName prettifies Grok families only', () => {
  assert.equal(modelDisplayName('grok-4.5'), 'Grok 4.5')
  assert.equal(modelDisplayName('grok-4.5-build-free'), 'Grok 4.5')
  assert.equal(modelDisplayName('gpt-5.6-sol'), 'gpt-5.6-sol')
})

test('mergeByModelFamily sums metrics for free and paid Grok variants', () => {
  const merged = mergeByModelFamily([
    {
      model: 'grok-4.5', provider: 'grok', cost: 10, requests: 2,
      real_total_tokens: 100, input_tokens: 80, output_tokens: 20, unpriced_requests: 0,
    },
    {
      model: 'grok-4.5-build-free', provider: 'grok', cost: 1, requests: 5,
      real_total_tokens: 50, input_tokens: 40, output_tokens: 10, unpriced_requests: 2,
    },
    {
      model: 'gpt-5.6-sol', provider: 'codex', cost: 3, requests: 1,
      real_total_tokens: 9, input_tokens: 6, output_tokens: 3, unpriced_requests: 0,
    },
  ])

  assert.equal(merged.length, 2)
  const grok = merged.find(row => row.provider === 'grok')
  assert.ok(grok)
  assert.equal(grok.model, 'grok-4.5')
  assert.equal(grok.cost, 11)
  assert.equal(grok.requests, 7)
  assert.equal(grok.real_total_tokens, 150)
  assert.equal(grok.input_tokens, 120)
  assert.equal(grok.output_tokens, 30)
  assert.equal(grok.unpriced_requests, 2)
  assert.deepEqual(grok.raw_models.sort(), ['grok-4.5', 'grok-4.5-build-free'])

  const codex = merged.find(row => row.provider === 'codex')
  assert.ok(codex)
  assert.equal(codex.model, 'gpt-5.6-sol')
  assert.deepEqual(codex.raw_models, ['gpt-5.6-sol'])
})

test('ModelTable shows family display names after merge', () => {
  const rows = mergeByModelFamily([
    {
      model: 'grok-4.5-build-free', provider: 'grok', cost: 2, requests: 3,
      real_total_tokens: 10, input_tokens: 8, output_tokens: 2, unpriced_requests: 0,
    },
    {
      model: 'grok-4.5', provider: 'grok', cost: 4, requests: 1,
      real_total_tokens: 20, input_tokens: 15, output_tokens: 5, unpriced_requests: 0,
    },
  ])
  const html = renderToStaticMarkup(createElement(ModelTable, { data: rows }))
  assert.match(html, /Grok 4\.5/)
  assert.doesNotMatch(html, /build-free/)
  assert.match(html, /\$6\.000/)
})

test('ModelTable source column uses tool display names not internal IDs', () => {
  const html = renderToStaticMarkup(createElement(ModelTable, {
    data: [
      {
        model: 'gpt-5.6-sol', provider: 'codex', cost: 1, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1, unpriced_requests: 0,
      },
      {
        model: 'claude-opus-4-6', provider: 'claude', cost: 2, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1, unpriced_requests: 0,
      },
      {
        model: 'grok-4.5', provider: 'grok', cost: 3, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1, unpriced_requests: 0,
      },
    ],
  }))
  assert.match(html, /Codex/)
  assert.match(html, /ClaudeCode/)
  assert.match(html, /Grok Build/)
  assert.doesNotMatch(html, />codex</)
  assert.doesNotMatch(html, />claude</)
  assert.doesNotMatch(html, />grok</)
})
