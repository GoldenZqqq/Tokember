import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  buildCostCoverage,
  normalizeUsageMetrics,
  registerUsageMetricFunctions,
} from './usage-metrics.js'
import { calculateRuleCost, type PricingRule } from './pricing.js'

const rule: PricingRule = {
  id: 1, source: null, model: 'model-a', mode: 'priced',
  input_price: 2, output_price: 8, cache_read_price: 0.2, cache_write_price: 3,
  enabled: 1, created_at: '', updated_at: '',
}

test('normalizes cache-inclusive input and separate reasoning exactly once', () => {
  const codex = normalizeUsageMetrics({
    provider: 'codex',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 40,
    cache_creation_tokens: 0,
    reasoning_tokens: 10,
  })

  assert.equal(codex.request_count, 1)
  assert.equal(codex.input_includes_cache_read, true)
  assert.equal(codex.input_includes_cache_creation, false)
  assert.equal(codex.output_includes_reasoning, false)
  assert.equal(codex.fresh_input_tokens, 60)
  assert.equal(codex.billable_output_tokens, 30)
  assert.equal(codex.real_total_tokens, 130)
})

test('explicit inclusion flags prevent cache and reasoning double counting', () => {
  const metrics = normalizeUsageMetrics({
    provider: 'future-provider',
    request_count: 0,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 30,
    cache_creation_tokens: 20,
    reasoning_tokens: 20,
    input_includes_cache_read: true,
    input_includes_cache_creation: true,
    output_includes_reasoning: true,
  })

  assert.equal(metrics.request_count, 0)
  assert.equal(metrics.fresh_input_tokens, 50)
  assert.equal(metrics.billable_output_tokens, 50)
  assert.equal(metrics.real_total_tokens, 150)
})

test('prices separate or output-inclusive reasoning exactly once', () => {
  const separate = calculateRuleCost(rule, {
    provider: 'gemini', model: 'model-a', input_tokens: 0,
    output_tokens: 100_000, cache_read_tokens: 0,
    cache_creation_tokens: 0, reasoning_tokens: 50_000,
  })
  const included = calculateRuleCost(rule, {
    provider: 'future', model: 'model-a', input_tokens: 0,
    output_tokens: 150_000, cache_read_tokens: 0,
    cache_creation_tokens: 0, reasoning_tokens: 50_000,
    output_includes_reasoning: true,
  })
  assert.equal(separate, 1.2)
  assert.equal(included, 1.2)
})

test('cost coverage distinguishes unknown zero cost and handles empty totals', () => {
  assert.deepEqual(buildCostCoverage(5, 200, 2, 50), {
    priced_calls: 3,
    unpriced_calls: 2,
    priced_tokens: 150,
    unpriced_tokens: 50,
    call_ratio: 0.6,
    token_ratio: 0.75,
  })
  assert.deepEqual(buildCostCoverage(0, 0, 0, 0), {
    priced_calls: 0,
    unpriced_calls: 0,
    priced_tokens: 0,
    unpriced_tokens: 0,
    call_ratio: 1,
    token_ratio: 1,
  })
})

test('SQLite aggregate functions delegate to the canonical implementation', () => {
  const db = new Database(':memory:')
  registerUsageMetricFunctions(db)
  const row = db.prepare(`
    SELECT
      tokember_fresh_input_tokens(100, 40, 0, 1, 0) AS fresh,
      tokember_billable_output_tokens(20, 10, 0) AS output,
      tokember_real_total_tokens(100, 20, 40, 0, 10, 1, 0, 0) AS total
  `).get() as { fresh: number; output: number; total: number }

  assert.deepEqual(row, { fresh: 60, output: 30, total: 130 })
  db.close()
})
