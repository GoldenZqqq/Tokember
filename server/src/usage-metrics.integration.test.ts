import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StatsAggregateRow,
  StatsResponse,
  YearStatsResponse,
} from '@tokember/contracts/stats'
import { initDB } from './db.js'
import { apiRoutes } from './routes.js'

type ApiApp = ReturnType<typeof apiRoutes>

const PRIMARY_RECORDS = [
  {
    provider: 'hermes', model: 'mimo', request_count: 3,
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 10,
    cache_creation_tokens: 5, reasoning_tokens: 7,
    input_includes_cache_read: false,
    input_includes_cache_creation: false,
    output_includes_reasoning: false,
    timestamp: '2025-12-31T23:59:59.999Z',
    source_file: 'hermes-delta', dedup_key: 'metrics:hermes',
  },
  {
    provider: 'gemini', model: 'gemini-test', request_count: 1,
    input_tokens: 100, output_tokens: 20, cache_read_tokens: 40,
    cache_creation_tokens: 0, reasoning_tokens: 10,
    input_includes_cache_read: true,
    input_includes_cache_creation: false,
    output_includes_reasoning: false,
    cost_usd: 0, cost_provided: true,
    timestamp: '2025-06-01T00:00:00.000Z',
    source_file: 'gemini', dedup_key: 'metrics:gemini',
  },
]

const LEGACY_CODEX_RECORD = {
  provider: 'codex', model: 'gpt-test',
  input_tokens: 50, output_tokens: 5, cache_read_tokens: 20,
  reasoning_tokens: 5, cost_usd: 0.5, cost_provided: true,
  timestamp: '2026-01-01T00:00:00.000Z',
  source_file: 'codex', dedup_key: 'metrics:legacy-codex',
}

async function registerDevices(app: ApiApp): Promise<void> {
  for (const [id, name] of [['d1', 'Primary'], ['d2', 'Secondary']]) {
    const response = await app.request('/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    })
    assert.equal(response.status, 200)
  }
}

async function ingest(app: ApiApp, deviceId: string, records: unknown[]): Promise<void> {
  const response = await app.request('/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, records }),
  })
  assert.equal(response.status, 200)
}

function assertConservation(rows: StatsAggregateRow[]): void {
  assert.equal(rows.reduce((sum, row) => sum + row.calls, 0), 5)
  assert.equal(rows.reduce((sum, row) => sum + row.real_total_tokens, 0), 332)
  assert.equal(rows.reduce(
    (sum, row) => sum + row.pricing_coverage.unpriced_calls, 0,
  ), 3)
  assert.equal(rows.reduce(
    (sum, row) => sum + row.pricing_coverage.unpriced_tokens, 0,
  ), 142)
}

async function assertOverallStats(app: ApiApp): Promise<void> {
  const response = await app.request('/stats?days=0&timezone_offset=0')
  const stats = await response.json() as StatsResponse
  assert.equal(stats.snapshot.max_record_id, 3)
  assert.equal(stats.snapshot.timezone_offset, 0)
  assert.ok(stats.daily.every(row => row.since < row.until))
  assert.equal(stats.totals.total_calls, 5)
  assert.equal(stats.totals.real_total_tokens, 332)
  assert.deepEqual(stats.totals.pricing_coverage, {
    priced_calls: 2, unpriced_calls: 3,
    priced_tokens: 190, unpriced_tokens: 142,
    call_ratio: 0.4, token_ratio: 190 / 332,
  })
  for (const rows of [stats.byProvider, stats.byModel, stats.byDevice, stats.daily]) {
    assertConservation(rows)
  }
}

async function getYear(app: ApiApp, year: number): Promise<YearStatsResponse> {
  const response = await app.request(`/stats/year?year=${year}&timezone_offset=0`)
  return response.json() as Promise<YearStatsResponse>
}

async function assertYearBoundaries(app: ApiApp): Promise<void> {
  const [year2025, year2026] = await Promise.all([
    getYear(app, 2025), getYear(app, 2026),
  ])
  assert.equal(year2025.totals.total_calls, 4)
  assert.equal(year2025.snapshot.timezone_offset, 0)
  assert.ok(year2025.daily.every(row => row.since < row.until))
  assert.equal(year2025.monthly.length, 12)
  assert.equal(year2025.totals.real_total_tokens, 272)
  assert.equal(year2025.totals.pricing_coverage.unpriced_calls, 3)
  assert.equal(year2025.daily.reduce(
    (sum, row) => sum + row.real_total_tokens, 0,
  ), 272)
  assert.equal(year2025.monthly.reduce((sum, row) => sum + row.calls, 0), 4)
  assert.equal(year2025.monthly.reduce(
    (sum, row) => sum + row.real_total_tokens, 0,
  ), 272)
  assert.equal(year2026.totals.total_calls, 1)
  assert.equal(year2026.totals.real_total_tokens, 60)
}

test('usage metrics conserve aggregates and use half-open years', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevices(app)
  await ingest(app, 'd1', PRIMARY_RECORDS)
  await ingest(app, 'd2', [LEGACY_CODEX_RECORD])
  db.prepare("UPDATE usage_records SET pricing_status = 'ignored' WHERE dedup_key = ?")
    .run('metrics:hermes')
  await assertOverallStats(app)
  await assertYearBoundaries(app)
  const stored = db.prepare('SELECT COUNT(*) AS count FROM usage_records')
    .get() as { count: number }
  assert.equal(stored.count, 3)
  db.close()
})

test('explicit windows share snapshots and annual years respect devices', async () => {
  const db = initDB(':memory:')
  const app = apiRoutes(db)
  await registerDevices(app)
  await ingest(app, 'd1', PRIMARY_RECORDS)
  await ingest(app, 'd2', [LEGACY_CODEX_RECORD])
  const params = new URLSearchParams({
    since: '2025-01-01T00:00:00.000Z',
    until: '2026-01-01T00:00:00.000Z',
    timezone_offset: '0',
  })
  const first = await (await app.request(`/stats?${params}`)).json() as StatsResponse
  assert.equal(first.totals.total_calls, 4)
  assert.equal(first.snapshot.max_record_id, 3)
  params.set('provider', 'hermes')
  const hermes = await (await app.request(`/stats?${params}`)).json() as StatsResponse
  assert.equal(hermes.totals.total_calls, 3)
  assert.deepEqual(hermes.byProvider.map(row => row.provider), ['hermes'])
  assert.deepEqual(hermes.byModel.map(row => row.provider), ['hermes'])
  params.delete('provider')
  await ingest(app, 'd1', [{
    provider: 'hermes', model: 'late', request_count: 9,
    input_tokens: 9, timestamp: '2025-07-01T00:00:00.000Z',
    source_file: 'hermes-delta', dedup_key: 'metrics:late',
  }])
  params.set('snapshot_max_id', String(first.snapshot.max_record_id))
  const stable = await (await app.request(`/stats?${params}`)).json() as StatsResponse
  assert.equal(stable.totals.total_calls, first.totals.total_calls)

  const allYears = await getYear(app, 2025)
  assert.deepEqual(allYears.available_years, [2026, 2025])
  const d1 = await (await app.request(
    '/stats/year?year=2025&timezone_offset=0&device_id=d1',
  )).json() as YearStatsResponse
  const d2 = await (await app.request(
    '/stats/year?year=2026&timezone_offset=0&device_id=d2',
  )).json() as YearStatsResponse
  assert.deepEqual(d1.available_years, [2025])
  assert.deepEqual(d2.available_years, [2026])
  assert.equal(d1.totals.total_calls, 13)
  assert.equal(d2.totals.total_calls, 1)
  db.close()
})
