import { useT } from '../i18n'

interface Props {
  devices: { id: string; name: string }[]
  value: string
  onChange: (v: string) => void
}

export function DeviceSelector({ devices, value, onChange }: Props) {
  const t = useT()
  return (
    <select
      id="device-filter"
      name="device"
      aria-label={t('device.filterAria')}
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-orange-500 md:w-36"
    >
      <option value="all">{t('device.allDevices')}</option>
      {devices.map(d => (
        <option key={d.id} value={d.id}>{d.name}</option>
      ))}
    </select>
  )
}
