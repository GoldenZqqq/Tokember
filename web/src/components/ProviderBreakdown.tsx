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
  const total = data.reduce((s, d) => s + d.cost, 0) || 1

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <h2 className="text-sm font-medium text-zinc-400 mb-4">按来源分布</h2>
      <div className="space-y-3">
        {[...data].sort((a, b) => b.cost - a.cost).map(d => {
          const pct = (d.cost / total) * 100
          const color = COLORS[d.provider] ?? '#71717a'
          return (
            <button type="button" key={d.provider} onClick={() => onAudit?.(d.provider)}
              className="block w-full rounded-lg p-1 text-left hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-orange-500">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-zinc-300">{providerDisplayName(d.provider)}</span>
                <span className="text-zinc-500">{d.requests.toLocaleString('zh-CN')} Calls · {d.real_total_tokens.toLocaleString('zh-CN')} Tokens</span>
              </div>
              <div className="mb-1 flex justify-between text-xs text-zinc-600">
                <span>${d.cost.toFixed(2)}</span>
                <span>{pct.toFixed(0)}%</span>
              </div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
