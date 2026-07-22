import type { Stats } from '../dashboard-stats'
import type { AuditDimension } from '../audit/query'

function number(value: number): string {
  return value.toLocaleString('zh-CN')
}

function shortSession(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-6)}`
}

function Metric({ requests, tokens, cost }: {
  requests: number
  tokens: number
  cost: number
}) {
  return <span className="text-xs tabular-nums text-zinc-500">
    {number(requests)} Calls · {number(tokens)} Tokens · ${cost.toFixed(3)}
  </span>
}

export function AttributionBreakdown({
  stats, onAudit,
}: {
  stats: Stats
  onAudit: (dimension: AuditDimension) => void
}) {
  const captured = stats.attribution.find(row => row.status === 'captured')
  if (!captured || captured.records === 0) return null
  return <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-zinc-200">项目与会话</h2>
        <p className="mt-1 text-xs text-zinc-600">匿名归因数据，点击条目进入同一快照审计。</p>
      </div>
      <Metric requests={captured.requests} tokens={captured.real_total_tokens}
        cost={captured.cost} />
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-500">项目</p>
        {stats.by_project.length ? stats.by_project.slice(0, 6).map(project => <button
          type="button" key={project.group_id ?? project.name}
          onClick={() => onAudit({ project_group_id: project.group_id ?? undefined })}
          className="flex w-full flex-col gap-1 rounded-lg border border-white/[0.05] px-3 py-2 text-left hover:border-white/10 focus-visible:outline-2 focus-visible:outline-orange-500">
          <span className="truncate text-sm text-zinc-300">{project.name}</span>
          <Metric requests={project.requests} tokens={project.real_total_tokens} cost={project.cost} />
        </button>) : <p className="text-xs text-zinc-600">当前记录仅包含会话归因。</p>}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-500">会话</p>
        {stats.by_session.slice(0, 6).map(session => <button type="button"
          key={session.session_id} onClick={() => onAudit({ session_id: session.session_id })}
          className="flex w-full flex-col gap-1 rounded-lg border border-white/[0.05] px-3 py-2 text-left hover:border-white/10 focus-visible:outline-2 focus-visible:outline-orange-500">
          <span className="flex min-w-0 items-center justify-between gap-2 text-sm text-zinc-300">
            <span className="truncate font-mono">{shortSession(session.session_id)}</span>
            {session.project_name ? <span className="truncate text-xs text-zinc-600">
              {session.project_name}
            </span> : null}
          </span>
          <Metric requests={session.requests} tokens={session.real_total_tokens} cost={session.cost} />
        </button>)}
      </div>
    </div>
  </section>
}
