import assert from 'node:assert/strict'
import test from 'node:test'
import { DashboardRepository } from './dashboard-data'
import type { Stats } from './dashboard-stats'

const stats = { total_requests: 1 } as Stats
const request = {
  api: '', device: 'all', project: 'all',
  range: 'today' as const, comparison: 'none' as const,
}

test('stats and devices use separate caches and polling does not fetch devices', async () => {
  let statsCalls = 0
  let deviceCalls = 0
  const repository = new DashboardRepository({
    stats: async () => { statsCalls += 1; return stats },
    devices: async () => { deviceCalls += 1; return [{ id: 'd1', name: 'Device' }] },
  })
  const signal = new AbortController().signal

  await repository.refreshAll(request, signal, signal)
  await repository.refreshStats(request, signal)

  assert.equal(statsCalls, 2)
  assert.equal(deviceCalls, 1)
  assert.equal(repository.peekStats(request), stats)
  assert.deepEqual(repository.peekDevices(), [{ id: 'd1', name: 'Device' }])
})

test('stats cache is keyed by device project range custom window and comparison', async () => {
  const repository = new DashboardRepository({
    stats: async input => ({ ...stats, total_requests: input.device === 'all' ? 1 : 2 }),
    devices: async () => [],
  })
  const signal = new AbortController().signal
  await repository.refreshStats(request, signal)
  const filtered = { ...request, device: 'd1' }
  await repository.refreshStats(filtered, signal)
  assert.equal(repository.peekStats(request)?.total_requests, 1)
  assert.equal(repository.peekStats(filtered)?.total_requests, 2)
  const project = { ...request, project: '7' }
  await repository.refreshStats(project, signal)
  assert.notEqual(repository.peekStats(project), repository.peekStats(request))
  const cachedCurrent = repository.peekStats(request)
  const compared = { ...request, comparison: 'previous-week' as const }
  await repository.refreshStats(compared, signal)
  assert.equal(repository.peekStats(compared)?.total_requests, 1)
  assert.equal(repository.peekStats(request), cachedCurrent)
})

test('rapid revisits reuse only a fresh full-key stats entry', () => {
  const repository = new DashboardRepository({
    stats: async () => stats,
    devices: async () => [],
  })
  repository.commitStats(request, stats, 1_000)

  assert.equal(repository.peekFreshStats(request, 10_000, 11_000), stats)
  assert.equal(repository.peekFreshStats(request, 10_000, 11_001), null)
  assert.equal(repository.peekFreshStats({ ...request, device: 'd1' }, 10_000, 1_001), null)
  repository.expireStats(request)
  assert.equal(repository.peekFreshStats(request, 10_000, 1_001), null)
  assert.equal(repository.peekStats(request), stats)
})
