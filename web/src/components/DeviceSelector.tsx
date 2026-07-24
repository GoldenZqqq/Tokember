import { useEffect, useId, useRef, useState } from 'react'
import { useT } from '../i18n'

interface Props {
  devices: { id: string; name: string }[]
  value: string
  onChange: (v: string) => void
  /** `select` = full-width/narrow native control (default). `icon` = compact header button + menu. */
  variant?: 'select' | 'icon'
  className?: string
}

export function DeviceSelector({
  devices,
  value,
  onChange,
  variant = 'select',
  className = '',
}: Props) {
  // Single-device (or empty) installs have nothing useful to filter — hide the control.
  if (devices.length < 2) return null

  if (variant === 'icon') {
    return (
      <DeviceIconMenu
        devices={devices}
        value={value}
        onChange={onChange}
        className={className}
      />
    )
  }

  return (
    <DeviceNativeSelect
      devices={devices}
      value={value}
      onChange={onChange}
      className={className}
    />
  )
}

function DeviceNativeSelect({
  devices,
  value,
  onChange,
  className,
}: {
  devices: { id: string; name: string }[]
  value: string
  onChange: (v: string) => void
  className: string
}) {
  const t = useT()
  return (
    <select
      id="device-filter"
      name="device"
      aria-label={t('device.filterAria')}
      value={value}
      onChange={e => onChange(e.target.value)}
      className={`w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-orange-500 md:w-36 ${className}`}
    >
      <option value="all">{t('device.allDevices')}</option>
      {devices.map(d => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  )
}

function DeviceIconMenu({
  devices,
  value,
  onChange,
  className,
}: {
  devices: { id: string; name: string }[]
  value: string
  onChange: (v: string) => void
  className: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const options: { id: string; name: string }[] = [
    { id: 'all', name: t('device.allDevices') },
    ...devices,
  ]

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label={t('device.filterAria')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:border-zinc-700 hover:text-zinc-200"
      >
        <svg className="h-4.5 w-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('device.filterAria')}
          className="absolute right-0 z-50 mt-1.5 min-w-[11rem] max-w-[min(18rem,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl shadow-black/40"
        >
          {options.map(option => {
            const selected = value === option.id
            return (
              <li key={option.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200'
                  }`}
                >
                  <span className="truncate">{option.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
