import { useState } from 'react'
import type { MouseEvent } from 'react'
import type { YearStatsRow } from '@tokember/contracts/stats'
import type { YearMetric } from '../../analytics/date-range'
import {
  annualMetricValue, formatAnnualMetric, yearMetricLabelKey,
} from '../../analytics/year-metric'
import { useT, type TranslateFn } from '../../i18n'

const LEVELS: Record<YearMetric, string[]> = {
  cost: ['bg-zinc-800/40', 'bg-orange-500/25', 'bg-orange-500/45', 'bg-orange-500/70', 'bg-orange-500'],
  tokens: ['bg-zinc-800/40', 'bg-sky-500/25', 'bg-sky-500/45', 'bg-sky-500/70', 'bg-sky-500'],
  calls: ['bg-zinc-800/40', 'bg-purple-500/25', 'bg-purple-500/45', 'bg-purple-500/70', 'bg-purple-500'],
}

const WEEKDAY_KEYS = [
  'weekday.sun', 'weekday.mon', 'weekday.tue', 'weekday.wed',
  'weekday.thu', 'weekday.fri', 'weekday.sat',
] as const

const MONTH_KEYS = [
  'month.m01', 'month.m02', 'month.m03', 'month.m04', 'month.m05', 'month.m06',
  'month.m07', 'month.m08', 'month.m09', 'month.m10', 'month.m11', 'month.m12',
] as const

interface HeatmapCell { date: string | null; value: number }
interface HoverState { date: string; value: number; x: number; y: number }

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0
  const ratio = value / max
  if (ratio > 0.66) return 4
  if (ratio > 0.33) return 3
  if (ratio > 0.1) return 2
  return 1
}

function buildWeeks(year: number, values: Map<string, number>): HeatmapCell[][] {
  const first = new Date(year, 0, 1)
  const cursor = new Date(first)
  cursor.setDate(first.getDate() - first.getDay())
  const last = new Date(year, 11, 31)
  const weeks: HeatmapCell[][] = []
  while (cursor <= last) {
    const week: HeatmapCell[] = []
    for (let day = 0; day < 7; day++) {
      const date = cursor.getFullYear() === year ? ymd(cursor) : null
      week.push({ date, value: date ? values.get(date) ?? 0 : 0 })
      cursor.setDate(cursor.getDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

function monthPositions(weeks: HeatmapCell[][], t: TranslateFn) {
  const positions = new Map<number, string>()
  let lastMonth = -1
  weeks.forEach((week, column) => {
    const date = week.find(cell => cell.date)?.date
    if (!date) return
    const month = Number(date.slice(5, 7)) - 1
    if (month !== lastMonth) {
      positions.set(column, t(MONTH_KEYS[month]))
      lastMonth = month
    }
  })
  return positions
}

function hoverState(
  event: MouseEvent<HTMLDivElement>,
  cell: HeatmapCell,
): HoverState | null {
  if (!cell.date) return null
  const container = event.currentTarget.closest('.relative')
  if (!container) return null
  const box = container.getBoundingClientRect()
  const dot = event.currentTarget.getBoundingClientRect()
  return {
    date: cell.date, value: cell.value,
    x: dot.left - box.left + dot.width / 2, y: dot.top - box.top,
  }
}

function WeekColumn({
  week, metric, maxValue, onHover,
}: {
  week: HeatmapCell[]
  metric: YearMetric
  maxValue: number
  onHover: (value: HoverState | null) => void
}) {
  return <div className="flex flex-col gap-[3px]">{week.map((cell, row) => <div
    key={row}
    className={`h-2.5 w-2.5 rounded-sm ${cell.date
      ? `${LEVELS[metric][levelFor(cell.value, maxValue)]} cursor-pointer` : 'bg-transparent'}`}
    onMouseEnter={cell.date ? event => onHover(hoverState(event, cell)) : undefined}
  />)}</div>
}

function HeatmapGrid({
  weeks, metric, maxValue, onHover, t,
}: {
  weeks: HeatmapCell[][]
  metric: YearMetric
  maxValue: number
  onHover: (value: HoverState | null) => void
  t: TranslateFn
}) {
  const positions = monthPositions(weeks, t)
  // GitHub-style: show Mon/Wed/Fri only (sparse labels)
  const sparse = [false, true, false, true, false, true, false]
  return <div className="overflow-x-auto"><div className="mx-auto flex w-fit flex-col gap-1.5">
    <div className="flex gap-[3px] pl-5">{weeks.map((_, column) => <div key={column}
      className="w-2.5 text-[10px] text-zinc-600">
      {positions.has(column) ? <span className="whitespace-nowrap">{positions.get(column)}</span> : ''}
    </div>)}</div>
    <div className="flex gap-[3px]">
      <div className="mr-1 flex flex-col gap-[3px]">{WEEKDAY_KEYS.map((key, index) => <div
        key={index} className="flex h-2.5 w-4 items-center text-[10px] text-zinc-600">
        {sparse[index] ? t(key) : ''}
      </div>)}</div>
      {weeks.map((week, column) => <WeekColumn key={column} week={week}
        metric={metric} maxValue={maxValue} onHover={onHover} />)}
    </div>
  </div></div>
}

function HeatmapHeader({ year, metric }: { year: number; metric: YearMetric }) {
  const t = useT()
  const metricLabel = t(yearMetricLabelKey(metric))
  return <div className="mb-4 flex items-center justify-between">
    <h2 className="text-sm font-medium text-zinc-400">
      {t('year.heatmap', { year, metric: metricLabel })}
    </h2>
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-600">
      <span>{t('year.less')}</span>
      {LEVELS[metric].map((color, index) => <span key={index}
        className={`h-2.5 w-2.5 rounded-sm ${color}`} />)}
      <span>{t('year.more')}</span>
    </div>
  </div>
}

function HeatmapTooltip({ hover, metric }: { hover: HoverState; metric: YearMetric }) {
  return <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs shadow-lg"
    style={{ left: hover.x, top: hover.y - 6 }}>
    <div className="font-medium text-zinc-100">{hover.date}</div>
    <div className="text-orange-300">{formatAnnualMetric(hover.value, metric)}</div>
  </div>
}

export function YearHeatmap({
  year, daily, metric,
}: { year: number; daily: YearStatsRow[]; metric: YearMetric }) {
  const t = useT()
  const [hover, setHover] = useState<HoverState | null>(null)
  const values = new Map(daily.map(row => [row.date, annualMetricValue(row, metric)]))
  const maxValue = daily.reduce((max, row) => Math.max(max, annualMetricValue(row, metric)), 0)
  const weeks = buildWeeks(year, values)
  return <div className="relative rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4"
    onMouseLeave={() => setHover(null)}>
    <HeatmapHeader year={year} metric={metric} />
    <HeatmapGrid weeks={weeks} metric={metric} maxValue={maxValue} onHover={setHover} t={t} />
    {hover ? <HeatmapTooltip hover={hover} metric={metric} /> : null}
  </div>
}
