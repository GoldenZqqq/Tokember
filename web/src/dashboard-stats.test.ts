import assert from 'node:assert/strict'
import test from 'node:test'
import type { StatsResponse } from '@tokember/contracts/stats'
import { fetchDashboardStats } from './dashboard-stats'

const coverage = {
  priced_calls: 1, unpriced_calls: 0, priced_tokens: 10, unpriced_tokens: 0,
  call_ratio: 1, token_ratio: 1,
}

function response(since: string, until: string, max: number): StatsResponse {
  return {
    snapshot: { since, until, timezone_offset: 0, max_record_id: max },
    totals: {
      total_calls: 1, total_input: 5, total_output: 5,
      total_cache_read: 0, total_cache_creation: 0,
      real_total_tokens: 10, total_cost: 1, pricing_coverage: coverage,
    },
    byProvider: [], byModel: [], byDevice: [], attribution: [],
    projectOptions: [], byProject: [], bySession: [], daily: [],
  }
}

test('comparison request waits for primary and reuses its ledger snapshot', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  const credentials: Array<RequestCredentials | undefined> = []
  const bodies = [
    response('2026-07-10T00:00:00.000Z', '2026-07-12T00:00:00.000Z', 7),
    response('2026-07-08T00:00:00.000Z', '2026-07-10T00:00:00.000Z', 7),
  ]
  globalThis.fetch = (input, init) => {
    urls.push(String(input))
    credentials.push(init?.credentials)
    return Promise.resolve(Response.json(bodies[urls.length - 1]))
  }
  try {
    const stats = await fetchDashboardStats({
      api: '', device: 'all', project: 'all',
      range: 'custom', comparison: 'previous-period',
      since: '2026-07-10T00:00:00.000Z', until: '2026-07-12T00:00:00.000Z',
    })
    assert.equal(urls.length, 2)
    assert.deepEqual(credentials, ['include', 'include'])
    const compared = new URL(urls[1], 'http://local').searchParams
    assert.equal(compared.get('snapshot_max_id'), '7')
    assert.equal(compared.get('since'), '2026-07-08T00:00:00.000Z')
    assert.equal(compared.get('until'), '2026-07-10T00:00:00.000Z')
    assert.equal(stats.comparison?.label, '上一周期')
    assert.equal(stats.comparison?.stats.snapshot.max_record_id, 7)
  } finally {
    globalThis.fetch = original
  }
})

test('comparison-free dashboard requests only the primary stats window', async () => {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = input => {
    urls.push(String(input))
    return Promise.resolve(Response.json(response(
      '2026-07-10T00:00:00.000Z', '2026-07-11T00:00:00.000Z', 7,
    )))
  }
  try {
    const stats = await fetchDashboardStats({
      api: '', device: 'all', project: 'all', range: 7, comparison: 'none',
    })
    assert.equal(urls.length, 1)
    assert.equal(stats.comparison, null)
  } finally {
    globalThis.fetch = original
  }
})
