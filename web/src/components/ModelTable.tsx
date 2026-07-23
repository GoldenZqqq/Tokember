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
      </div>
      <div className="overflow-x-auto">
        {/* Fixed mobile widths keep the cost column visible without crushing model names. */}
        <table className="w-full table-fixed min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-zinc-800/50">
              <th className="w-32 max-w-32 px-3 py-3 text-left text-zinc-500 font-medium whitespace-nowrap sm:w-48 sm:max-w-48 sm:px-4">{t('modelTable.model')}</th>
              <th className="w-24 max-w-24 px-3 py-3 text-left text-zinc-500 font-medium whitespace-nowrap sm:w-32 sm:max-w-32 sm:px-4">{t('modelTable.source')}</th>
              <th className="w-20 max-w-20 px-3 py-3 text-right text-zinc-500 font-medium whitespace-nowrap sm:px-4">{t('modelTable.cost')}</th>
              <th className="w-20 max-w-20 px-3 py-3 text-right text-zinc-500 font-medium whitespace-nowrap sm:px-4">{t('modelTable.requests')}</th>
              <th className="w-20 max-w-20 px-3 py-3 text-right text-zinc-500 font-medium whitespace-nowrap sm:px-4">{t('modelTable.input')}</th>
              <th className="w-20 max-w-20 px-3 py-3 text-right text-zinc-500 font-medium whitespace-nowrap sm:px-4">{t('modelTable.output')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(m => (
              <tr key={`${m.provider}-${m.model}`} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                <td className="w-32 max-w-32 overflow-hidden px-3 py-3 text-zinc-200 text-xs whitespace-nowrap sm:w-48 sm:max-w-48 sm:px-4">
                  <button type="button" onClick={() => onAudit?.(m.provider, auditModel(m))}
                    className="block max-w-full truncate text-left font-medium hover:text-orange-300 focus-visible:outline-2 focus-visible:outline-orange-500"
                    title={m.raw_models.join(', ')}>
                    {modelDisplayName(m.model)}
                  </button>
                  {m.raw_models.length > 1 && (
                    <div className="mt-0.5 max-w-full truncate font-mono text-[10px] text-zinc-600">
                      {t('modelTable.billingTiers', { n: m.raw_models.length })}
                    </div>
                  )}
                </td>
                <td className="w-24 max-w-24 overflow-hidden px-3 py-3 text-zinc-400 whitespace-nowrap sm:w-32 sm:max-w-32 sm:px-4">{providerDisplayName(m.provider)}</td>
                <td className="w-20 max-w-20 px-3 py-3 text-right whitespace-nowrap sm:px-4">
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
                <td className="w-20 max-w-20 px-3 py-3 text-right text-zinc-300 whitespace-nowrap tabular-nums sm:px-4">{m.requests}</td>
                <td className="w-20 max-w-20 px-3 py-3 text-right text-emerald-400 whitespace-nowrap tabular-nums sm:px-4">{formatTokens(m.input_tokens)}</td>
                <td className="w-20 max-w-20 px-3 py-3 text-right text-purple-400 whitespace-nowrap tabular-nums sm:px-4">{formatTokens(m.output_tokens)}</td>
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
