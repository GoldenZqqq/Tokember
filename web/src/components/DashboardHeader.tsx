import type { RangeValue } from './RangeTabs'
import { DeviceSelector } from './DeviceSelector'
import { RangeTabs } from './RangeTabs'

interface Props {
  devices: { id: string; name: string }[]
  device: string
  range: RangeValue
  onDeviceChange: (value: string) => void
  onRangeChange: (value: RangeValue) => void
  onSettings: () => void
  onRefresh: () => void
  refreshing: boolean
  onYear: () => void
}

export function DashboardHeader(props: Props) {
  return (
    <header className="mb-8 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
      <div className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 md:w-auto md:grid-cols-[auto_auto]">
        <img
          src="/icon-192.png"
          alt=""
          className="h-11 w-11 rounded-xl shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_8px_24px_rgba(249,115,22,0.16)]"
        />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Tokember</h1>
          <p className="text-sm leading-snug text-zinc-500">
            <span className="block md:inline">Track every token.</span>
            {' '}
            <span className="block md:inline">Read every ember.</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 md:hidden">
          <SettingsButton onClick={props.onSettings} className="flex" />
          <YearButton onClick={props.onYear} className="flex" />
          <RefreshButton onClick={props.onRefresh} refreshing={props.refreshing} className="flex" />
        </div>
      </div>

      <div className="grid w-full min-w-0 grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_15rem] md:flex md:w-auto md:gap-3">
        <DeviceSelector devices={props.devices} value={props.device} onChange={props.onDeviceChange} />
        <RangeTabs value={props.range} onChange={props.onRangeChange} />
        <RefreshButton onClick={props.onRefresh} refreshing={props.refreshing} className="hidden md:flex" />
        <YearButton onClick={props.onYear} className="hidden md:flex" />
        <SettingsButton onClick={props.onSettings} className="hidden md:flex" />
      </div>
    </header>
  )
}

function YearButton({ onClick, className }: { onClick: () => void; className: string }) {
  return (
    <button type="button" onClick={onClick} className={`${className} flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200`} aria-label="年度统计">
      <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 10h18M8 2v4M16 2v4" /><rect x="7" y="14" width="3" height="3" rx="0.5" /><rect x="14" y="14" width="3" height="3" rx="0.5" /></svg>
    </button>
  )
}

function RefreshButton({ onClick, refreshing, className }: { onClick: () => void; refreshing: boolean; className: string }) {
  return (
    <button type="button" onClick={onClick} disabled={refreshing} className={`${className} flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-60`} aria-label="刷新数据">
      <svg className={`h-4.5 w-4.5 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
    </button>
  )
}

function SettingsButton({ onClick, className }: { onClick: () => void; className: string }) {
  return (
    <button type="button" onClick={onClick} className={`${className} flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200`} aria-label="打开设置">
      <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
    </button>
  )
}
