import type { DashboardRange } from '../analytics/date-range'
import { useT } from '../i18n'

export type RangeValue = DashboardRange

interface Props {
  value: RangeValue
  onChange: (value: RangeValue) => void
}

export function RangeTabs({ value, onChange }: Props) {
  const t = useT()
  const options: { value: RangeValue; label: string }[] = [
    { value: 'today', label: t('range.today') },
    { value: 7, label: t('range.d7') },
    { value: 30, label: t('range.d30') },
    { value: 0, label: t('range.all') },
    { value: 'custom', label: t('range.custom') },
  ]
  return (
    <div className="grid w-full shrink-0 grid-cols-[1.35fr_repeat(4,1fr)] overflow-hidden rounded-lg border border-zinc-800 sm:w-[15rem] md:flex md:w-auto" aria-label={t('app.ariaRange')}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 px-1.5 py-1.5 text-sm transition-colors md:flex-none md:px-3 ${
            value === option.value
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
