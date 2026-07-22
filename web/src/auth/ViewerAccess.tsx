import { useState, type FormEvent } from 'react'
import type { ViewerAccessState } from './use-viewer-access'

interface ViewerAccessProps {
  state: ViewerAccessState
  onLogin: (password: string) => Promise<void>
  onRetry: () => void
  onSettings: () => void
}

export function ViewerAccess(props: ViewerAccessProps) {
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try { await props.onLogin(password) } finally { setSubmitting(false) }
  }
  if (props.state.status === 'checking') return <StatusCard text="正在检查查看权限…" />
  if (props.state.status === 'error') return <StatusCard
    text={props.state.error.message} action="重试" onAction={props.onRetry} />
  return <div className="mx-auto flex min-h-[75vh] max-w-md items-center px-4">
    <form onSubmit={submit} className="w-full rounded-2xl border border-orange-500/15 bg-zinc-900/90 p-6 shadow-2xl">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500/10 text-orange-400" aria-hidden="true">◉</div>
      <h1 className="text-2xl font-bold text-zinc-100">查看 Tokember</h1>
      <p className="mt-2 text-sm leading-relaxed text-zinc-500">输入查看密码以访问用量 Dashboard 与年度分析。</p>
      <label className="mt-6 block text-xs font-medium text-zinc-400" htmlFor="viewer-password">查看密码</label>
      <input id="viewer-password" type="password" autoComplete="current-password"
        value={password} onChange={event => setPassword(event.target.value)} required
        className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-orange-500/60 focus:ring-2 focus:ring-orange-500/15" />
      {props.state.error ? <p className="mt-3 text-sm text-red-400">{props.state.error.message}</p> : null}
      <button disabled={submitting} className="mt-5 w-full rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-orange-400 disabled:opacity-60">
        {submitting ? '登录中…' : '进入 Dashboard'}
      </button>
      <button type="button" onClick={props.onSettings} className="mt-3 w-full text-xs text-zinc-500 hover:text-zinc-300">管理员设置</button>
    </form>
  </div>
}

function StatusCard(props: { text: string; action?: string; onAction?: () => void }) {
  return <div className="flex min-h-[70vh] items-center justify-center px-4">
    <div role="status" className="rounded-xl border border-white/[0.07] bg-zinc-900/70 px-6 py-5 text-sm text-zinc-400">
      {props.text}
      {props.action ? <button type="button" onClick={props.onAction} className="ml-3 text-orange-400">{props.action}</button> : null}
    </div>
  </div>
}
