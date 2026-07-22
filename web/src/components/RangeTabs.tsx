import type { DashboardRange } from '../analytics/date-range'

export type RangeValue = DashboardRange

const RANGE_OPTIONS: { value: RangeValue; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 0, label: 'All' },
  { value: 'custom', label: 'Custom' },
]

interface Props {
  value: RangeValue
  onChange: (value: RangeValue) => void
}

export function RangeTabs({ value, onChange }: Props) {
  return (
    <div className="grid w-full shrink-0 grid-cols-[1.35fr_repeat(4,1fr)] overflow-hidden rounded-lg border border-zinc-800 sm:w-[15rem] md:flex md:w-auto" aria-label="统计时间范围">
      {RANGE_OPTIONS.map(option => (
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
