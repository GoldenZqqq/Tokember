import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import type { QuerySnapshot } from '@tokember/contracts/stats'
import {
  comparisonWindow, dashboardFiltersFromHash, dashboardHash, publicDashboardFilters,
  localInputToIso, numericDelta, sourceFiltersFromHash, sourceHash, yearFiltersFromHash,
} from './date-range'

function snapshot(since: string, until: string): QuerySnapshot {
  return { since, until, timezone_offset: 0, max_record_id: 1 }
}

test('dashboard and year hashes restore valid filters and reject malformed ranges', () => {
  const filters = dashboardFiltersFromHash(
    '#/?range=custom&since=2026-07-01T00%3A00%3A00.000Z&until=2026-07-02T00%3A00%3A00.000Z&device=d1&compare=previous-month',
  )
  assert.equal(dashboardFiltersFromHash(dashboardHash(filters)).comparison, 'previous-month')
  assert.equal(dashboardFiltersFromHash('#/?project=bad').project, 'all')
  assert.deepEqual(dashboardFiltersFromHash(
    '#/?range=custom&since=bad&until=2026-07-02T00%3A00%3A00.000Z&compare=nope',
  ), { device: 'all', project: 'all', range: 'today', comparison: 'none' })
  assert.deepEqual(yearFiltersFromHash('#/year?year=bad&metric=bad&device=%20',
    new Date('2026-01-01T00:00:00.000Z')), {
    year: 2026, device: 'all', metric: 'cost',
  })
})

test('public dashboard suppresses comparison state from legacy hashes', () => {
  const legacy = dashboardFiltersFromHash('#/?range=7&compare=previous-month')
  const publicFilters = publicDashboardFilters(legacy)

  assert.equal(legacy.comparison, 'previous-month')
  assert.equal(publicFilters.comparison, 'none')
  assert.doesNotMatch(dashboardHash(publicFilters), /compare=/)
})

test('source hashes preserve provider and dashboard window without comparison', () => {
  const hash = sourceHash('codex', {
    device: 'd1', project: '2', range: 7, comparison: 'previous-week',
  })
  const filters = sourceFiltersFromHash(hash)
  assert.deepEqual(filters, {
    provider: 'codex', device: 'd1', project: '2', range: 7, comparison: 'none',
  })
  assert.equal(new URLSearchParams(hash.split('?')[1]).get('provider'), 'codex')
})

test('comparison windows preserve duration and clamp month-end and leap days', () => {
  const period = comparisonWindow(snapshot(
    '2026-07-10T00:00:00.000Z', '2026-07-12T00:00:00.000Z',
  ), 'previous-period')
  assert.deepEqual(period, {
    since: '2026-07-08T00:00:00.000Z', until: '2026-07-10T00:00:00.000Z',
    label: '上一周期',
  })
  const month = comparisonWindow(snapshot(
    '2024-03-31T10:00:00.000Z', '2024-04-30T10:00:00.000Z',
  ), 'previous-month')
  assert.equal(month.since, '2024-02-29T10:00:00.000Z')
  assert.equal(month.until, '2024-03-30T10:00:00.000Z')
  const year = comparisonWindow(snapshot(
    '2024-02-29T10:00:00.000Z', '2024-03-01T10:00:00.000Z',
  ), 'previous-year')
  assert.equal(year.since, '2023-02-28T10:00:00.000Z')
})

test('local comparison uses the runtime timezone across DST', () => {
  const script = `
    import { comparisonWindow } from './src/analytics/date-range.ts';
    const result = comparisonWindow({
      since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T04:00:00.000Z',
      timezone_offset: 300, max_record_id: 1,
    }, 'previous-week');
    console.log(JSON.stringify(result));
  `
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', script,
  ], { cwd: process.cwd(), env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    since: '2026-03-01T05:00:00.000Z', until: '2026-03-02T05:00:00.000Z',
    label: '上周同期',
  })
})

test('local inputs and zero-base deltas never produce invalid values', () => {
  assert.equal(localInputToIso('2026-02-30T10:00'), null)
  assert.deepEqual(numericDelta(5, 0), { difference: 5, rate: null, state: 'new' })
  assert.deepEqual(numericDelta(0, 0), { difference: 0, rate: 0, state: 'zero' })
  assert.equal(numericDelta(15, 10).rate, 0.5)
})
