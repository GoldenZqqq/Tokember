import type { CostCoverage } from '@tokember/contracts/stats'
import { hasIncompleteCost } from '../cost-coverage'
import { useT } from '../i18n'

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function formatPercent(value: number): string {
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`
}

export function CostCoverageNotice({ coverage }: { coverage: CostCoverage }) {
  const t = useT()
  if (!hasIncompleteCost(coverage)) {
    return (
      <div className="flex items-center gap-2 text-xs text-emerald-400/80" role="status">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
        {t('coverage.full')}
      </div>
    )
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-3 text-sm text-amber-100 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <div className="flex items-center gap-2 font-medium">
        <svg className="h-4 w-4 shrink-0 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M12 9v4" strokeLinecap="round" />
          <path d="M12 17h.01" strokeLinecap="round" />
          <path d="M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" strokeLinejoin="round" />
        </svg>
        {t('coverage.partial', { percent: formatPercent(coverage.token_ratio) })}
      </div>
      <p className="min-w-0 break-words text-xs leading-5 text-amber-200/75 sm:text-right">
        {t('coverage.unpricedDetail', {
          calls: coverage.unpriced_calls.toLocaleString(),
          tokens: formatTokens(coverage.unpriced_tokens),
        })}
      </p>
    </div>
  )
}
