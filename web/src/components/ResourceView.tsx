import type { ReactNode } from 'react'
import type { ApiError } from '../data/api-client'
import type { ResourceStatus } from '../data/resource-state'
import { useT } from '../i18n'

interface ResourceViewProps {
  status: ResourceStatus
  error: ApiError | null
  empty: boolean
  loadingLabel: string
  emptyLabel: string
  onRetry: () => void
  children: ReactNode
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  const t = useT()
  return (
    <button
      type="button"
      onClick={onRetry}
      className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.07]"
    >{t('common.retry')}</button>
  )
}

export function ResourceView(props: ResourceViewProps) {
  const t = useT()
  if (props.status === 'loading' || props.status === 'idle') {
    return <div className="flex h-64 items-center justify-center gap-3 text-sm text-zinc-500" role="status">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
      {props.loadingLabel}
    </div>
  }
  if (props.status === 'error') {
    return <div className="space-y-3 py-20 text-center" role="alert">
      <p className="text-sm text-red-300">{props.error?.message ?? t('common.loadFailed')}</p>
      <RetryButton onRetry={props.onRetry} />
    </div>
  }
  return <>
    {props.status === 'refreshing' ? (
      <p className="mb-4 text-xs text-zinc-500" role="status">{t('common.refreshingData')}</p>
    ) : null}
    {props.status === 'stale' ? (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3" role="alert">
        <p className="text-sm text-amber-200">
          {t('common.showingLastSuccess', {
            message: props.error?.message ?? t('common.refreshFailed'),
          })}
        </p>
        <RetryButton onRetry={props.onRetry} />
      </div>
    ) : null}
    {props.empty ? (
      <div className="py-20 text-center text-zinc-500">{props.emptyLabel}</div>
    ) : props.children}
  </>
}
