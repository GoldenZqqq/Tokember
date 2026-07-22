import { useState, type FormEvent } from 'react'
import { adminApi } from '../../admin/api'

export function AdminLogin({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await adminApi.login(password)
      onAuthenticated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md items-center px-4">
      <form onSubmit={submit} className="relative w-full overflow-hidden rounded-2xl border border-orange-500/15 bg-gradient-to-br from-zinc-900/95 to-orange-950/20 p-6 shadow-[0_20px_70px_rgba(0,0,0,0.4),0_0_60px_rgba(249,115,22,0.07)]">
        <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-orange-500/10 blur-3xl" />
        <div className="relative">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-orange-500/10 text-orange-400">
            <LockIcon />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">管理员登录</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-500">输入管理员密码以管理模型计价规则和历史补价。</p>
          <label className="mt-6 block text-xs font-medium text-zinc-400" htmlFor="admin-password">管理员密码</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-orange-500/60 focus:ring-2 focus:ring-orange-500/15"
            placeholder="请输入密码"
            required
          />
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <button disabled={submitting} className="mt-5 w-full rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_8px_28px_rgba(249,115,22,0.25)] transition hover:bg-orange-400 disabled:opacity-60">
            {submitting ? '登录中…' : '进入设置中心'}
          </button>
        </div>
      </form>
    </div>
  )
}

function LockIcon() {
  return <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect width="14" height="10" x="5" y="11" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
}
