import assert from 'node:assert/strict'
import test from 'node:test'
import type { YearStatsResponse } from '@tokember/contracts/stats'
import { YearRepository } from './year-data'

const first = { year: 2025 } as YearStatsResponse
const second = { year: 2026 } as YearStatsResponse

test('annual cache is isolated by year', async () => {
  const repository = new YearRepository(async (_api, year) => year === 2025 ? first : second)
  const signal = new AbortController().signal
  await repository.refresh('', 2025, 'all', signal)
  await repository.refresh('', 2026, 'd1', signal)
  assert.equal(repository.peek(2025, 'all'), first)
  assert.equal(repository.peek(2026, 'd1'), second)
  assert.equal(repository.peek(2026, 'all'), null)
})
