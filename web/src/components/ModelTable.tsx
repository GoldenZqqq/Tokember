import { useT } from '../i18n'
import { providerDisplayName } from '../provider-display'
import {
  mergeByModelFamily,
  modelDisplayName,
  type ModelAggregateRow,
  type ModelFamilyRow,
} from '../model-display'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

export function ModelTable({
  data, onAudit,
}: {
  data: ModelAggregateRow[]
  onAudit?: (provider: string, model?: string) => void
}) {
  const t = useT()
  const sorted = mergeByModelFamily(data)

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
      <div className="p-4 border-b border-zinc-800/50">
        <h2 className="text-sm font-medium text-zinc-400">{t('modelTable.title')}</h2>
        <p className="mt-1 text-[11px] text-zinc-600">{t('modelTable.subtitle')}</p>
      </div>
      <div className="overflow-x-auto">
        {/* min-w keeps 6 columns readable on phone; scroll instead of crushing the model name */}
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-zinc-800/50">
              <th className="text-left px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.model')}</th>
              <th className="text-left px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.source')}</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.cost')}</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.requests')}</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.input')}</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium whitespace-nowrap">{t('modelTable.output')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(m => (
              <tr key={`${m.provider}-${m.model}`} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                <td className="px-4 py-3 text-zinc-200 text-xs whitespace-nowrap">
                  <button type="button" onClick={() => onAudit?.(m.provider, auditModel(m))}
                    className="text-left font-medium hover:text-orange-300 focus-visible:outline-2 focus-visible:outline-orange-500"
                    title={m.raw_models.join(', ')}>
                    {modelDisplayName(m.model)}
                  </button>
                  {m.raw_models.length > 1 && (
                    <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                      {t('modelTable.billingTiers', { n: m.raw_models.length })}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-400 whitespace-nowrap">{providerDisplayName(m.provider)}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <div className="text-orange-400">${m.cost.toFixed(3)}</div>
                  {m.unpriced_requests > 0 && (
                    <div
                      className="mt-0.5 text-[10px] text-amber-400/80"
                      title={t('modelTable.unpricedTitle')}
                    >
                      {t('modelTable.unpriced', { n: m.unpriced_requests })}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-zinc-300 whitespace-nowrap tabular-nums">{m.requests}</td>
                <td className="px-4 py-3 text-right text-emerald-400 whitespace-nowrap tabular-nums">{formatTokens(m.input_tokens)}</td>
                <td className="px-4 py-3 text-right text-purple-400 whitespace-nowrap tabular-nums">{formatTokens(m.output_tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Exact model filter only when the family is a single raw ID. */
function auditModel(row: ModelFamilyRow): string | undefined {
  return row.raw_models.length === 1 ? row.raw_models[0] : undefined
}
