import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeDeviceOptions, decodeStatsResponse, decodeYearStatsResponse,
} from './public-decoders'

const coverage = {
  priced_calls: 1, unpriced_calls: 0, priced_tokens: 2, unpriced_tokens: 0,
  call_ratio: 1, token_ratio: 1,
}
const aggregate = { calls: 1, real_total_tokens: 2, cost: 3, pricing_coverage: coverage }

test('public decoders accept current stats and ignore extra device fields', () => {
  const stats = decodeStatsResponse({
    snapshot: {
      since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
      timezone_offset: -480, max_record_id: 1,
    },
    totals: {
      total_calls: 1, total_input: 1, total_output: 1, total_cache_read: 0,
      total_cache_creation: 0, real_total_tokens: 2, total_cost: 3,
      pricing_coverage: coverage,
    },
    byProvider: [{ ...aggregate, provider: 'codex', tokens: 2 }],
    byModel: [{
      ...aggregate, model: 'gpt', provider: 'codex', tokens: 2,
      input_tokens: 1, output_tokens: 1, unpriced_calls: 0,
    }],
    byDevice: [{ ...aggregate, device: 'd1', provider: 'codex' }],
    attribution: [{ ...aggregate, status: 'captured', records: 1 }],
    projectOptions: [{ ...aggregate, group_id: 1, name: 'Project', members: 1 }],
    byProject: [{ ...aggregate, group_id: 1, name: 'Project', members: 1 }],
    bySession: [{
      ...aggregate, session_id: 'ses_v1_test', project_group_id: 1,
      project_name: 'Project',
    }],
    daily: [{
      ...aggregate, date: '2026-07-17', tokens: 2, input_tokens: 1, output_tokens: 1,
      since: '2026-07-17T00:00:00.000Z', until: '2026-07-18T00:00:00.000Z',
    }],
  })
  assert.equal(stats.totals.total_calls, 1)
  assert.equal(stats.projectOptions[0]?.name, 'Project')
  assert.deepEqual(decodeDeviceOptions([{ id: 'd1', name: 'Device', extra: true }]), [
    { id: 'd1', name: 'Device' },
  ])
})

test('public decoders reject partial stats rather than inventing zeros', () => {
  assert.throws(() => decodeStatsResponse({ totals: {}, byProvider: [], byModel: [], byDevice: [], daily: [] }))
})

test('year decoder requires authoritative available years', () => {
  const year = decodeYearStatsResponse({
    year: 2026, available_years: [2026, 2025],
    snapshot: {
      since: '2026-01-01T00:00:00.000Z', until: '2027-01-01T00:00:00.000Z',
      timezone_offset: 0, max_record_id: 1,
    },
    totals: {
      total_cost: 0, total_calls: 0, real_total_tokens: 0,
      active_days: 0, pricing_coverage: coverage,
    },
    peak: { date: '', cost: 0 }, daily: [], monthly: [],
  })
  assert.deepEqual(year.available_years, [2026, 2025])
  assert.throws(() => decodeYearStatsResponse({
    ...year, available_years: undefined,
  }))
})
