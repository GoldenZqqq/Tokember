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
import { withLocale } from './test-utils'

test('modelFamilyKey strips Grok build free billing suffixes', () => {
  assert.equal(modelFamilyKey('grok-4.5'), 'grok-4.5')
  assert.equal(modelFamilyKey('grok-4.5-build-free'), 'grok-4.5')
  assert.equal(modelFamilyKey('grok-4.5-build'), 'grok-4.5')
  assert.equal(modelFamilyKey('gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(modelFamilyKey('claude-opus-4-5'), 'claude-opus-4-5')
})

test('modelFamilyKey strips Claude thinking mode suffix', () => {
  assert.equal(modelFamilyKey('claude-opus-4-6'), 'claude-opus-4-6')
  assert.equal(modelFamilyKey('claude-opus-4-6-thinking'), 'claude-opus-4-6')
  assert.equal(modelFamilyKey('claude-sonnet-4-6-thinking'), 'claude-sonnet-4-6')
  // Unrelated models that merely contain "thinking" mid-string stay intact.
  assert.equal(modelFamilyKey('thinking-model'), 'thinking-model')
})

test('modelDisplayName prettifies Grok families only', () => {
  assert.equal(modelDisplayName('grok-4.5'), 'Grok 4.5')
  assert.equal(modelDisplayName('grok-4.5-build-free'), 'Grok 4.5')
  assert.equal(modelDisplayName('gpt-5.6-sol'), 'gpt-5.6-sol')
})

function row(
  partial: Partial<Parameters<typeof mergeByModelFamily>[0][number]> & {
    model: string
    provider: string
  },
): Parameters<typeof mergeByModelFamily>[0][number] {
  return {
    cost: 0, requests: 0, real_total_tokens: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_creation_tokens: 0, unpriced_requests: 0,
    ...partial,
  }
}

test('mergeByModelFamily sums metrics for free and paid Grok variants', () => {
  const merged = mergeByModelFamily([
    row({
      model: 'grok-4.5', provider: 'grok', cost: 10, requests: 2,
      real_total_tokens: 100, input_tokens: 80, output_tokens: 20,
      cache_read_tokens: 10, cache_creation_tokens: 2,
    }),
    row({
      model: 'grok-4.5-build-free', provider: 'grok', cost: 1, requests: 5,
      real_total_tokens: 50, input_tokens: 40, output_tokens: 10,
      cache_read_tokens: 5, cache_creation_tokens: 1, unpriced_requests: 2,
    }),
    row({
      model: 'gpt-5.6-sol', provider: 'codex', cost: 3, requests: 1,
      real_total_tokens: 9, input_tokens: 6, output_tokens: 3,
    }),
  ])

  assert.equal(merged.length, 2)
  const grok = merged.find(item => item.provider === 'grok')
  assert.ok(grok)
  assert.equal(grok.model, 'grok-4.5')
  assert.equal(grok.cost, 11)
  assert.equal(grok.requests, 7)
  assert.equal(grok.real_total_tokens, 150)
  assert.equal(grok.input_tokens, 120)
  assert.equal(grok.output_tokens, 30)
  assert.equal(grok.cache_read_tokens, 15)
  assert.equal(grok.cache_creation_tokens, 3)
  assert.equal(grok.unpriced_requests, 2)
  assert.deepEqual(grok.raw_models.sort(), ['grok-4.5', 'grok-4.5-build-free'])

  const codex = merged.find(item => item.provider === 'codex')
  assert.ok(codex)
  assert.equal(codex.model, 'gpt-5.6-sol')
  assert.deepEqual(codex.raw_models, ['gpt-5.6-sol'])
})

test('mergeByModelFamily folds Claude base and thinking under the same provider', () => {
  const merged = mergeByModelFamily([
    row({
      model: 'claude-opus-4-6', provider: 'claude', cost: 10, requests: 2,
      real_total_tokens: 100, input_tokens: 80, output_tokens: 20,
      cache_read_tokens: 40, cache_creation_tokens: 10,
    }),
    row({
      model: 'claude-opus-4-6-thinking', provider: 'claude', cost: 5, requests: 3,
      real_total_tokens: 200, input_tokens: 50, output_tokens: 150,
      cache_read_tokens: 60, cache_creation_tokens: 5, unpriced_requests: 1,
    }),
    row({
      // Different provider must not merge even with the same family key.
      model: 'claude-opus-4-6-thinking', provider: 'openrouter', cost: 1, requests: 1,
      real_total_tokens: 10, input_tokens: 5, output_tokens: 5,
    }),
  ])

  assert.equal(merged.length, 2)
  const claude = merged.find(item => item.provider === 'claude')
  assert.ok(claude)
  assert.equal(claude.model, 'claude-opus-4-6')
  assert.equal(claude.cost, 15)
  assert.equal(claude.requests, 5)
  assert.equal(claude.real_total_tokens, 300)
  assert.equal(claude.input_tokens, 130)
  assert.equal(claude.output_tokens, 170)
  assert.equal(claude.cache_read_tokens, 100)
  assert.equal(claude.cache_creation_tokens, 15)
  assert.equal(claude.unpriced_requests, 1)
  assert.deepEqual(claude.raw_models.sort(), [
    'claude-opus-4-6',
    'claude-opus-4-6-thinking',
  ])

  const openrouter = merged.find(item => item.provider === 'openrouter')
  assert.ok(openrouter)
  assert.equal(openrouter.model, 'claude-opus-4-6')
  assert.deepEqual(openrouter.raw_models, ['claude-opus-4-6-thinking'])
})

test('ModelTable shows family display names after merge', () => {
  const rows = mergeByModelFamily([
    row({
      model: 'grok-4.5-build-free', provider: 'grok', cost: 2, requests: 3,
      real_total_tokens: 10, input_tokens: 8, output_tokens: 2,
    }),
    row({
      model: 'grok-4.5', provider: 'grok', cost: 4, requests: 1,
      real_total_tokens: 20, input_tokens: 15, output_tokens: 5,
    }),
  ])
  const html = renderToStaticMarkup(withLocale(createElement(ModelTable, { data: rows })))
  assert.match(html, /Grok 4\.5/)
  assert.doesNotMatch(html, /build-free/)
  assert.match(html, /\$6\.000/)
})

test('ModelTable keeps model names readable on narrow viewports', () => {
  const html = renderToStaticMarkup(withLocale(createElement(ModelTable, {
    data: [
      row({
        model: 'gpt-5.6-sol', provider: 'codex', cost: 1, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1,
      }),
    ],
  })))
  // Fixed widths + truncation keep Cost in the initial mobile viewport.
  assert.match(html, /table-fixed[^\"]*min-w-\[42rem\]/)
  assert.match(html, /w-28 max-w-28 overflow-hidden/)
  assert.match(html, /block max-w-full truncate/)
  assert.match(html, /whitespace-nowrap/)
  assert.doesNotMatch(html, /break-all/)
  assert.doesNotMatch(html, /Grouped by model family/)
})

test('ModelTable source column uses tool display names not internal IDs', () => {
  const html = renderToStaticMarkup(withLocale(createElement(ModelTable, {
    data: [
      row({
        model: 'gpt-5.6-sol', provider: 'codex', cost: 1, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1,
      }),
      row({
        model: 'claude-opus-4-6', provider: 'claude', cost: 2, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1,
      }),
      row({
        model: 'grok-4.5', provider: 'grok', cost: 3, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1,
      }),
    ],
  })))
  assert.match(html, /Codex/)
  assert.match(html, /Claude Code/)
  assert.match(html, /Grok Build/)
  assert.doesNotMatch(html, />codex</)
  assert.doesNotMatch(html, />claude</)
  assert.doesNotMatch(html, />grok</)
})

test('ModelTable shows cache and real total so prompt-cache is not invisible', () => {
  const html = renderToStaticMarkup(withLocale(createElement(ModelTable, {
    data: [
      row({
        model: 'claude-opus-5', provider: 'claude', cost: 11.475, requests: 186,
        // Mirrors the verified 2026-07-28 Claude Code ledger shape.
        real_total_tokens: 5_738_776,
        input_tokens: 844_666,
        output_tokens: 107_749,
        cache_read_tokens: 4_409_832,
        cache_creation_tokens: 376_529,
      }),
    ],
  })))
  assert.match(html, /Cache/)
  assert.match(html, /Total/)
  assert.match(html, /844\.7K/)
  assert.match(html, /4\.8M/) // 4.41M read + 0.38M write
  assert.match(html, /107\.7K/)
  assert.match(html, /5\.7M/)
  assert.match(html, /Input is non-cache prompt tokens/)
})
