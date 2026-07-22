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
  const sorted = mergeByModelFamily(data)

  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 overflow-hidden">
      <div className="p-4 border-b border-zinc-800/50">
        <h2 className="text-sm font-medium text-zinc-400">模型明细</h2>
        <p className="mt-1 text-[11px] text-zinc-600">按模型族归并；免费/Build 计费档已合并</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800/50">
              <th className="text-left px-4 py-3 text-zinc-500 font-medium">模型</th>
              <th className="text-left px-4 py-3 text-zinc-500 font-medium">来源</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium">花费</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium">请求数</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium">输入</th>
              <th className="text-right px-4 py-3 text-zinc-500 font-medium">输出</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(m => (
              <tr key={`${m.provider}-${m.model}`} className="border-b border-zinc-800/30 hover:bg-zinc-800/20 transition-colors">
                <td className="px-4 py-3 text-zinc-200 text-xs">
                  <button type="button" onClick={() => onAudit?.(m.provider, auditModel(m))}
                    className="break-all text-left font-medium hover:text-orange-300 focus-visible:outline-2 focus-visible:outline-orange-500"
                    title={m.raw_models.join(', ')}>
                    {modelDisplayName(m.model)}
                  </button>
                  {m.raw_models.length > 1 && (
                    <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                      {m.raw_models.length} 个计费档
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-zinc-400">{providerDisplayName(m.provider)}</td>
                <td className="px-4 py-3 text-right">
                  <div className="text-orange-400">${m.cost.toFixed(3)}</div>
                  {m.unpriced_requests > 0 && (
                    <div
                      className="mt-0.5 text-[10px] text-amber-400/80"
                      title="这些请求有 Token 用量，但来源没有提供价格"
                    >
                      {m.unpriced_requests} 次未计价
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right text-zinc-300">{m.requests}</td>
                <td className="px-4 py-3 text-right text-emerald-400">{formatTokens(m.input_tokens)}</td>
                <td className="px-4 py-3 text-right text-purple-400">{formatTokens(m.output_tokens)}</td>
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
