import type { ApiError } from '../data/api-client'
import { useT } from '../i18n'

interface ReadFeedbackProps {
  loading: boolean
  hasData: boolean
  error: ApiError | null
  label: string
  onRetry: () => void
}

function Retry({ onRetry }: { onRetry: () => void }) {
  const t = useT()
  return <button
    type="button"
    onClick={onRetry}
    className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-zinc-300"
  >{t('common.retry')}</button>
}

export function ReadFeedback(props: ReadFeedbackProps) {
  const t = useT()
  if (props.loading && !props.hasData) {
    return <p className="py-16 text-center text-sm text-zinc-500" role="status">{props.label}</p>
  }
  if (props.error && !props.hasData) {
    return <div className="space-y-3 py-16 text-center" role="alert">
      <p className="text-sm text-red-300">{props.error.message}</p>
      <Retry onRetry={props.onRetry} />
    </div>
  }
  if (props.error) {
    return <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3" role="alert">
      <p className="text-sm text-amber-200">
        {t('common.showingLastSuccess', { message: props.error.message })}
      </p>
      <Retry onRetry={props.onRetry} />
    </div>
  }
  return props.loading
    ? <p className="text-xs text-zinc-500" role="status">{t('common.refreshing')}</p>
    : null
}
