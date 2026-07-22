import { useEffect, useState } from 'react'
import type { DashboardFilters } from '../analytics/date-range'
import { isoToLocalInput, localInputToIso } from '../analytics/date-range'

interface Props {
  filters: DashboardFilters
  projects: Array<{ group_id: number; name: string }>
  onProject: (project: string) => void
  onCustomRange: (since: string, until: string) => void
}

export function AnalyticsControls(props: Props) {
  const [since, setSince] = useState(() => isoToLocalInput(props.filters.since ?? ''))
  const [until, setUntil] = useState(() => isoToLocalInput(props.filters.until ?? ''))
  const [error, setError] = useState('')

  useEffect(() => {
    setSince(isoToLocalInput(props.filters.since ?? ''))
    setUntil(isoToLocalInput(props.filters.until ?? ''))
    setError('')
  }, [props.filters.since, props.filters.until])

  const apply = () => {
    const start = localInputToIso(since)
    const end = localInputToIso(until)
    if (!start || !end || start >= end) {
      setError('请选择有效且结束晚于开始的本地时间。')
      return
    }
    setError('')
    props.onCustomRange(start, end)
  }

  if (props.filters.range !== 'custom' && props.projects.length === 0) return null
  return <section className="mb-6 flex flex-col gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:flex-wrap sm:items-end">
    {props.projects.length > 0 ? <label className="min-w-0 text-xs text-zinc-500 sm:w-52">
      <span className="mb-1.5 block">项目</span>
      <select className="field-input" value={props.filters.project}
        onChange={event => props.onProject(event.target.value)}>
        <option value="all">全部项目</option>
        {props.projects.map(project => <option key={project.group_id} value={project.group_id}>
          {project.name}
        </option>)}
      </select>
    </label> : null}
    {props.filters.range === 'custom' ? <>
      <label className="min-w-0 flex-1 text-xs text-zinc-500">
        <span className="mb-1.5 block">开始（本地时间）</span>
        <input type="datetime-local" className="field-input" value={since}
          onChange={event => setSince(event.target.value)} />
      </label>
      <label className="min-w-0 flex-1 text-xs text-zinc-500">
        <span className="mb-1.5 block">结束（本地时间）</span>
        <input type="datetime-local" className="field-input" value={until}
          onChange={event => setUntil(event.target.value)} />
      </label>
      <button type="button" onClick={apply}
        className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-black hover:bg-orange-400 focus-visible:outline-2 focus-visible:outline-orange-500">
        应用范围
      </button>
    </> : null}
    {error ? <p className="w-full text-xs text-red-300" role="alert">{error}</p> : null}
  </section>
}
