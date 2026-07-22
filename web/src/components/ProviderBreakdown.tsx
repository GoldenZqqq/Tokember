import { useT } from '../i18n'
import { providerDisplayName } from '../provider-display'

const COLORS: Record<string, string> = {
  claude: '#a78bfa',
  'claude-code': '#a78bfa',
  'antigravity': '#34d399',
  'codex': '#60a5fa',
  grok: '#fb7185',
  'grok-build': '#fb7185',
  'hermes': '#fbbf24',
  'copilot': '#f472b6',
}

interface ProviderData {
  provider: string
  cost: number
  requests: number
  real_total_tokens: number
}

export function ProviderBreakdown({
  data, onAudit,
}: { data: ProviderData[]; onAudit?: (provider: string) => void }) {
  const t = useT()
  const total = data.reduce((s, d) => s + d.cost, 0) || 1
  // Cap height near DailyChart (~h-64 + header); extra sources scroll inside.
  const sorted = [...data].sort((a, b) => b.cost - a.cost)

  return (
    <div className="flex max-h-[22rem] flex-col rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <h2 className="mb-4 shrink-0 text-sm font-medium text-zinc-400">{t('provider.title')}</h2>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-0.5">
        {sorted.map(d => {
          const pct = (d.cost / total) * 100
          const color = COLORS[d.provider] ?? '#71717a'
          return (
            <button type="button" key={d.provider} onClick={() => onAudit?.(d.provider)}
              className="block w-full rounded-lg p-1 text-left hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-orange-500">
              <div className="mb-1 flex justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-zinc-300">{providerDisplayName(d.provider)}</span>
                <span className="shrink-0 text-right text-zinc-500">
                  {d.requests.toLocaleString()} Calls · {d.real_total_tokens.toLocaleString()} Tokens
                </span>
              </div>
              <div className="mb-1 flex justify-between text-xs text-zinc-600">
                <span>${d.cost.toFixed(2)}</span>
                <span>{pct.toFixed(0)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
