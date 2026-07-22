import type { Stats } from '../dashboard-stats'
import { hasIncompleteCost } from '../cost-coverage'
import { useT, type TranslateFn } from '../i18n'

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toFixed(0)
}

function formatApprox(n: number, locale: string): string {
  if (locale.startsWith('zh')) {
    if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(2)} 亿`
    if (n >= 10_000) return `${(n / 10_000).toFixed(2)} 万`
  }
  return n.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  })
}

export function Overview({ stats, onAudit }: { stats: Stats; onAudit?: () => void }) {
  const t = useT()
  const incompleteCost = hasIncompleteCost(stats.pricing_coverage)
  const cards = overviewCards(stats, incompleteCost, t)
  const numberLocale = typeof document !== 'undefined' && document.documentElement.lang.startsWith('zh')
    ? 'zh-CN'
    : 'en-US'

  return (
    <div className="space-y-4">
      <section role={onAudit ? 'button' : undefined} tabIndex={onAudit ? 0 : undefined}
        aria-label={onAudit ? t('overview.auditAria') : undefined}
        onClick={onAudit} onKeyDown={event => {
          if (onAudit && (event.key === 'Enter' || event.key === ' ')) onAudit()
        }}
        className="relative overflow-hidden rounded-2xl border border-orange-500/15 bg-gradient-to-br from-zinc-900/95 via-zinc-900/80 to-orange-950/20 p-5 focus-visible:outline-2 focus-visible:outline-orange-500 md:p-6">
        <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-orange-500/10 blur-3xl" />
        <div className="relative flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500/20 to-amber-400/5 text-orange-400 shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_8px_24px_rgba(249,115,22,0.12)]">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m13 2-9 12h8l-1 8 9-12h-8l1-8Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium tracking-wide text-zinc-400">{t('overview.realTokens')}</p>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <p className="text-3xl font-bold leading-none tracking-tight text-zinc-50 tabular-nums md:text-4xl" title={stats.real_total_tokens.toLocaleString(numberLocale)}>
                {stats.real_total_tokens.toLocaleString(numberLocale)}
              </p>
              <span className="rounded-md bg-white/[0.04] px-2 py-1 text-xs font-medium text-zinc-400">
                ≈ {formatApprox(stats.real_total_tokens, numberLocale)}
              </span>
            </div>
            <p className="mt-2 text-[11px] text-zinc-600">{t('overview.realTokensHint')}</p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map(c => (
          <button type="button" onClick={onAudit} key={c.label}
            className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4 text-left hover:border-zinc-700 focus-visible:outline-2 focus-visible:outline-orange-500">
            <p className="mb-1 text-xs text-zinc-500">{c.label}</p>
            <p className={`text-2xl font-bold ${c.color}`}>{c.value}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

function overviewCards(stats: Stats, incompleteCost: boolean, t: TranslateFn) {
  return [
    {
      label: incompleteCost ? t('overview.knownCost') : t('overview.totalCost'),
      value: `$${stats.total_cost.toFixed(2)}`,
      color: 'text-orange-400',
    },
    { label: t('overview.totalRequests'), value: formatNumber(stats.total_requests), color: 'text-blue-400' },
    { label: t('overview.inputTokens'), value: formatNumber(stats.total_input_tokens), color: 'text-emerald-400' },
    { label: t('overview.outputTokens'), value: formatNumber(stats.total_output_tokens), color: 'text-purple-400' },
  ]
}
