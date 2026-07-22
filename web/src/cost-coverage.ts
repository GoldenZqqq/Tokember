import type { CostCoverage } from '@tokember/contracts/stats'

export const COMPLETE_COST_COVERAGE: CostCoverage = {
  priced_calls: 0,
  unpriced_calls: 0,
  priced_tokens: 0,
  unpriced_tokens: 0,
  call_ratio: 1,
  token_ratio: 1,
}

export function hasIncompleteCost(coverage: CostCoverage): boolean {
  return coverage.unpriced_calls > 0 || coverage.unpriced_tokens > 0
}
