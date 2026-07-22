import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProjectAttributionGroup,
  ProjectAttributionMember,
  ProjectAttributionResponse,
} from '../../admin/api'
import { adminApi } from '../../admin/api'
import { isAbortError, toApiError } from '../../data/api-client'
import { LatestRequest } from '../../data/latest-request'
import {
  beginResource, failResource, initialResource, succeedResource,
  type ResourceState,
} from '../../data/resource-state'
import { ReadFeedback } from '../ReadFeedback'

function shortId(value: string): string {
  return `${value.slice(0, 14)}…${value.slice(-6)}`
}

function metric(value: number): string {
  return value.toLocaleString('zh-CN')
}

function useProjectAttribution() {
  const [state, setState] = useState<ResourceState<ProjectAttributionResponse>>(initialResource)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [message, setMessage] = useState('')
  const latest = useRef(new LatestRequest())
  const load = useCallback(async () => {
    setState(current => beginResource(current, 'projects'))
    try {
      const result = await latest.current.execute(signal => adminApi.projectAttribution(signal))
      if (!result.current) return
      setState(current => succeedResource(current, 'projects', result.value!))
      setDrafts(Object.fromEntries(result.value!.groups.map(group => [
        group.id, group.display_name ?? '',
      ])))
    } catch (error) {
      if (!isAbortError(error)) setState(current => failResource(current, 'projects', toApiError(error)))
    }
  }, [])
  useEffect(() => { load(); return () => latest.current.cancel() }, [load])
  const mutate = async (action: () => Promise<unknown>, success: string) => {
    setMessage('')
    try { await action(); setMessage(success); await load() }
    catch (error) { setMessage(toApiError(error).message) }
  }
  return { state, drafts, setDrafts, message, load, mutate }
}

function ProjectMemberRow({
  member, group, groups, mutate,
}: {
  member: ProjectAttributionMember
  group: ProjectAttributionGroup
  groups: ProjectAttributionGroup[]
  mutate: (action: () => Promise<unknown>, success: string) => Promise<void>
}) {
  return <div className="grid gap-3 rounded-lg border border-white/[0.05] px-3 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(10rem,14rem)] lg:items-end">
    <div className="min-w-0">
      <p className="truncate text-sm text-zinc-300">{member.device_name}</p>
      <p className="mt-1 break-all font-mono text-xs text-zinc-600" title={member.project_id}>
        {shortId(member.project_id)}
      </p>
      <p className="mt-1 text-xs tabular-nums text-zinc-600">
        {metric(member.calls)} Calls · {metric(member.real_total_tokens)} Tokens
      </p>
    </div>
    {groups.length > 1 ? <label className="text-xs text-zinc-500">
      <span className="mb-1.5 block">显式合并到</span>
      <select className="field-input" defaultValue="" onChange={event => {
        const target = Number(event.target.value)
        if (target) mutate(
          () => adminApi.mergeProject(member.device_id, member.project_id, target),
          '项目成员已显式合并',
        )
      }}>
        <option value="">选择目标项目组</option>
        {groups.filter(target => target.id !== group.id).map(target => <option
          key={target.id} value={target.id}>{target.display_name || `项目 ${target.id}`}</option>)}
      </select>
    </label> : null}
  </div>
}

function ProjectGroupCard({
  group, groups, draft, onDraft, mutate,
}: {
  group: ProjectAttributionGroup
  groups: ProjectAttributionGroup[]
  draft: string
  onDraft: (value: string) => void
  mutate: (action: () => Promise<unknown>, success: string) => Promise<void>
}) {
  return <section className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
      <label className="min-w-0 flex-1 text-xs text-zinc-500">
        <span className="mb-1.5 block">项目组 #{group.id} 展示名称</span>
        <input className="field-input" value={draft} placeholder={`项目 ${group.id}`}
          onChange={event => onDraft(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-black"
          onClick={() => mutate(
            () => adminApi.updateProjectGroupName(group.id, draft.trim() || null),
            '项目名称已保存',
          )}>保存名称</button>
        <button type="button" className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300"
          onClick={() => mutate(
            () => adminApi.updateProjectGroupName(group.id, null), '展示名称已清除',
          )}>清除名称</button>
      </div>
    </div>
    <p className="mt-3 text-xs tabular-nums text-zinc-600">
      {metric(group.calls)} Calls · {metric(group.real_total_tokens)} Tokens · ${group.cost.toFixed(3)}
    </p>
    <div className="mt-4 space-y-2">{group.members.map(member => <ProjectMemberRow
      key={`${member.device_id}:${member.project_id}`} member={member}
      group={group} groups={groups} mutate={mutate} />)}</div>
  </section>
}

export function ProjectAttributionPanel() {
  const resource = useProjectAttribution()
  const data = resource.state.data
  return <div className="space-y-5">
    <header>
      <h2 className="text-2xl font-bold tracking-tight text-zinc-100">项目归因</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500">
        管理匿名项目的友好名称与跨设备显式合并。名称相同不会自动合并，用量账本也不会因改名而改变。
      </p>
    </header>
    <ReadFeedback loading={resource.state.status === 'loading' || resource.state.status === 'refreshing'}
      hasData={data != null} error={resource.state.error} label="加载项目归因…" onRetry={resource.load} />
    {resource.message ? <p className="rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-300">
      {resource.message}
    </p> : null}
    {data?.groups.length === 0 ? <p className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">
      尚无已捕获的项目归因。Collector 默认关闭，启用后新记录会出现在这里。
    </p> : null}
    {data?.groups.map(group => <ProjectGroupCard key={group.id} group={group}
      groups={data.groups} draft={resource.drafts[group.id] ?? ''}
      onDraft={value => resource.setDrafts(current => ({ ...current, [group.id]: value }))}
      mutate={resource.mutate} />)}
  </div>
}
