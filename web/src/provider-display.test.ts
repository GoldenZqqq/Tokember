import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CostCoverage } from '@tokember/contracts/stats'
import { ComparisonPanel } from './components/ComparisonPanel'
import { ModelTable } from './components/ModelTable'
import { ProviderBreakdown } from './components/ProviderBreakdown'
import type { Stats } from './dashboard-stats'
import { providerDisplayName } from './provider-display'

const completeCoverage: CostCoverage = {
  priced_calls: 1, unpriced_calls: 0, priced_tokens: 100, unpriced_tokens: 0,
  call_ratio: 1, token_ratio: 1,
}

function baseStats(): Stats {
  return {
    snapshot: {
      since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
      timezone_offset: -480, max_record_id: 1,
    },
    total_cost: 1, total_input_tokens: 40, total_output_tokens: 60,
    total_cache_read_tokens: 0, total_cache_creation_tokens: 0,
    real_total_tokens: 100, total_requests: 1, pricing_coverage: completeCoverage,
    comparison: null, daily: [], by_provider: [], by_model: [], by_device: [],
    attribution: [], project_options: [], by_project: [], by_session: [],
  }
}

test('provider display names use the tool names shown to users', () => {
  assert.equal(providerDisplayName('codex'), 'Codex')
  assert.equal(providerDisplayName('claude'), 'ClaudeCode')
  assert.equal(providerDisplayName('grok'), 'Grok Build')
  assert.equal(providerDisplayName('grok-build'), 'Grok Build')
  assert.equal(providerDisplayName('antigravity'), 'Antigravity')
  assert.equal(providerDisplayName('hermes'), 'Hermes')
  assert.equal(providerDisplayName('openclaw'), 'OpenClaw')
  assert.equal(providerDisplayName('pi'), 'Pi Agent')
  assert.equal(providerDisplayName('pi-agent'), 'Pi Agent')
  assert.equal(providerDisplayName('omp'), 'Oh My Pi')
  assert.equal(providerDisplayName('unknown-tool'), 'Unknown-tool')
})

test('provider breakdown renders display names instead of internal IDs', () => {
  const html = renderToStaticMarkup(createElement(ProviderBreakdown, {
    data: [
      { provider: 'codex', cost: 10, requests: 1, real_total_tokens: 2 },
      { provider: 'claude', cost: 5, requests: 1, real_total_tokens: 2 },
      { provider: 'grok', cost: 1, requests: 1, real_total_tokens: 2 },
    ],
  }))

  assert.match(html, /Codex/)
  assert.match(html, /ClaudeCode/)
  assert.match(html, /Grok Build/)
  assert.doesNotMatch(html, />codex</)
  assert.doesNotMatch(html, />claude</)
  assert.doesNotMatch(html, />grok</)
})

test('model table and comparison panel keep the same tool display names', () => {
  const modelHtml = renderToStaticMarkup(createElement(ModelTable, {
    data: [
      {
        model: 'gpt-5.6-sol', provider: 'codex', cost: 1, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1, unpriced_requests: 0,
      },
      {
        model: 'claude-opus-4-6', provider: 'claude', cost: 2, requests: 1,
        real_total_tokens: 2, input_tokens: 1, output_tokens: 1, unpriced_requests: 0,
      },
    ],
  }))
  assert.match(modelHtml, /Codex/)
  assert.match(modelHtml, /ClaudeCode/)
  assert.doesNotMatch(modelHtml, />codex</)
  assert.doesNotMatch(modelHtml, />claude</)

  const current = {
    ...baseStats(),
    by_provider: [{ provider: 'claude', cost: 2, requests: 1, real_total_tokens: 10 }],
    by_model: [{
      model: 'claude-opus-4-6', provider: 'claude', cost: 2, requests: 1,
      real_total_tokens: 10, input_tokens: 6, output_tokens: 4, unpriced_requests: 0,
    }],
  }
  const previous = {
    ...current, total_cost: 0, real_total_tokens: 0, total_requests: 0,
    by_provider: [{ provider: 'claude', cost: 0, requests: 0, real_total_tokens: 0 }],
    by_model: [], comparison: undefined,
  }
  const comparisonHtml = renderToStaticMarkup(createElement(ComparisonPanel, {
    stats: {
      ...current,
      comparison: { mode: 'previous-period', label: '上一周期', stats: previous },
    },
  }))
  assert.match(comparisonHtml, /ClaudeCode/)
  assert.doesNotMatch(comparisonHtml, />claude</)
})
