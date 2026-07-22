import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { DeviceCredential, DeviceCredentialInput } from '@tokember/contracts/security'
import { adminApi, type DeviceSummary } from '../../admin/api'
import { toApiError, type ApiError } from '../../data/api-client'
import { ReadFeedback } from '../ReadFeedback'

export function DeviceCredentialPanel({ devices }: { devices: DeviceSummary[] }) {
  const [credentials, setCredentials] = useState<DeviceCredential[]>([])
  const [legacyAllowed, setLegacyAllowed] = useState(true)
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<ApiError | null>(null)
  async function load() {
    setLoading(true)
    setError(null)
    try {
      const result = await adminApi.deviceCredentials()
      setCredentials(result.credentials)
      setLegacyAllowed(result.legacy_api_key_allowed)
    } catch (reason) {
      setError(toApiError(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])
  async function create(input: DeviceCredentialInput) {
    await mutate(async () => adminApi.createDeviceCredential(input))
  }
  async function rotate(id: number) {
    await mutate(async () => adminApi.rotateDeviceCredential(id))
  }
  async function mutate(action: () => ReturnType<typeof adminApi.createDeviceCredential>) {
    setError(null)
    try {
      const result = await action()
      setToken(result.token)
      await load()
    } catch (reason) {
      setError(toApiError(reason))
    }
  }
  async function revoke(id: number) {
    setError(null)
    try { await adminApi.revokeDeviceCredential(id); await load() }
    catch (reason) { setError(toApiError(reason)) }
  }
  return <CredentialPanelView devices={devices} credentials={credentials}
    legacyAllowed={legacyAllowed} token={token} loading={loading} error={error}
    onLoad={load} onCreate={create} onRotate={rotate} onRevoke={revoke}
    onClear={() => setToken('')} />
}

function CredentialPanelView(props: {
  devices: DeviceSummary[]; credentials: DeviceCredential[]; legacyAllowed: boolean
  token: string; loading: boolean; error: ApiError | null; onLoad: () => void
  onCreate: (input: DeviceCredentialInput) => Promise<void>
  onRotate: (id: number) => Promise<void>; onRevoke: (id: number) => Promise<void>
  onClear: () => void
}) {
  return <section className="rounded-xl border border-white/[0.07] bg-zinc-900/45 p-4 md:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">设备写入凭证</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">
          每个 token 只允许代表绑定设备；创建或轮换后的完整 token 仅显示一次。
        </p>
      </div>
      <span className={`rounded-full px-2.5 py-1 text-xs ${props.legacyAllowed
        ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
        共享 key {props.legacyAllowed ? '兼容中' : '已关闭'}
      </span>
    </div>
    <ReadFeedback loading={props.loading} hasData={props.credentials.length > 0}
      error={props.error} label="加载设备凭证中…" onRetry={props.onLoad} />
    <CredentialForm devices={props.devices} onCreate={props.onCreate} />
    {props.token ? <OneTimeToken token={props.token} onClear={props.onClear} /> : null}
    <CredentialList credentials={props.credentials}
      onRotate={props.onRotate} onRevoke={props.onRevoke} />
  </section>
}

function CredentialForm(props: {
  devices: DeviceSummary[]
  onCreate: (input: DeviceCredentialInput) => Promise<void>
}) {
  const [deviceId, setDeviceId] = useState(props.devices[0]?.id ?? '')
  const [deviceName, setDeviceName] = useState('')
  const [label, setLabel] = useState('Primary')
  const [submitting, setSubmitting] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      await props.onCreate({
        device_id: deviceId.trim(), label: label.trim(),
        ...(deviceName.trim() ? { device_name: deviceName.trim() } : {}),
      })
    } finally { setSubmitting(false) }
  }
  return <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Field label="设备 ID"><input list="known-device-ids" value={deviceId}
      onChange={event => setDeviceId(event.target.value)} required className={INPUT} />
      <datalist id="known-device-ids">{props.devices.map(device =>
        <option key={device.id} value={device.id}>{device.name}</option>)}</datalist></Field>
    <Field label="新设备名称（可选）"><input value={deviceName}
      onChange={event => setDeviceName(event.target.value)} className={INPUT} /></Field>
    <Field label="标签"><input value={label} onChange={event => setLabel(event.target.value)}
      required className={INPUT} /></Field>
    <div className="flex items-end"><button disabled={submitting}
      className="w-full rounded-lg bg-orange-500 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-orange-400 disabled:opacity-60">
      {submitting ? '创建中…' : '创建设备 token'}
    </button></div>
  </form>
}

const INPUT = 'mt-1 w-full rounded-lg border border-white/10 bg-zinc-950/70 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-orange-500/60'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="text-xs text-zinc-400">{label}{children}</label>
}

export function OneTimeToken({ token, onClear }: { token: string; onClear: () => void }) {
  return <div className="mt-4 rounded-lg border border-orange-500/20 bg-orange-500/[0.06] p-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs font-medium text-orange-300">请立即复制，此 token 不会再次显示</p>
      <button type="button" onClick={onClear} className="text-xs text-zinc-500 hover:text-zinc-300">隐藏</button>
    </div>
    <code className="mt-2 block break-all rounded bg-zinc-950/80 p-2 text-xs text-zinc-200">{token}</code>
  </div>
}

function CredentialList(props: {
  credentials: DeviceCredential[]
  onRotate: (id: number) => Promise<void>
  onRevoke: (id: number) => Promise<void>
}) {
  if (props.credentials.length === 0) return <p className="mt-4 text-xs text-zinc-500">尚未创建设备凭证。</p>
  return <div className="mt-4 divide-y divide-white/[0.06] border-t border-white/[0.06]">
    {props.credentials.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-200">{item.device_name} · {item.label}</p>
        <p className="mt-1 break-all font-mono text-[11px] text-zinc-500">
          {item.device_id} / {item.token_id} · 最近使用 {item.last_used_at ?? '从未'}
        </p>
      </div>
      <div className="flex gap-2">
        {item.revoked_at ? <span className="px-2 py-1 text-xs text-zinc-500">已撤销</span> : <>
          <Action label="轮换" onClick={() => { props.onRotate(item.id) }} />
          <Action label="撤销" danger onClick={() => { props.onRevoke(item.id) }} />
        </>}
      </div>
    </div>)}
  </div>
}

function Action(props: { label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={props.onClick}
    className={`rounded-md border px-2.5 py-1.5 text-xs ${props.danger
      ? 'border-rose-500/20 text-rose-300 hover:bg-rose-500/10'
      : 'border-white/10 text-zinc-300 hover:bg-white/[0.04]'}`}>
    {props.label}
  </button>
}
