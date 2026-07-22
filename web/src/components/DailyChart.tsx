import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const COST_COLOR = '#f97316'
const TOKEN_COLOR = '#38bdf8'
const compactNumberFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

interface DailyData {
  date: string
  since: string
  until: string
  cost: number
  requests: number
  input_tokens: number
  output_tokens: number
  real_total_tokens: number
}

interface UsageTooltipProps {
  active?: boolean
  label?: string | number
  payload?: Array<{ payload?: DailyData }>
}

function formatCostTick(value: number): string {
  return `$${value >= 1 ? value.toFixed(0) : value.toFixed(2)}`
}

function formatTokenTick(value: number): string {
  return compactNumberFormatter.format(value)
}

function UsageTooltip({ active, label, payload }: UsageTooltipProps) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null

  return (
    <div className="min-w-[13.5rem] rounded-lg border border-zinc-800 bg-zinc-900/95 px-3 py-2.5">
      <p className="mb-2 text-sm text-zinc-400 tabular-nums">{label}</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-zinc-400">花费</span>
          <span className="font-semibold text-orange-400 tabular-nums">${point.cost.toFixed(3)}</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-zinc-400">真实消耗 Tokens</span>
          <span className="font-semibold text-sky-400 tabular-nums">
            {point.real_total_tokens.toLocaleString('zh-CN')}
          </span>
        </div>
      </div>
    </div>
  )
}

function UsageChartHeader({ isToday }: { isToday: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium text-zinc-400">
        {isToday ? '今日用量趋势' : '每日用量趋势'}
      </h2>
      <ul className="flex list-none items-center gap-4 text-xs text-zinc-400" aria-label="图表图例">
        <li className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-orange-500" aria-hidden="true" />
          花费
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-sky-400" aria-hidden="true" />
          Tokens
        </li>
      </ul>
    </div>
  )
}

function UsageChart({
  data, isToday, onAudit,
}: { data: DailyData[]; isToday: boolean; onAudit?: (point: DailyData) => void }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}
          accessibilityLayer className={onAudit ? 'cursor-pointer' : undefined}
          onClick={state => {
            const point = state?.activePayload?.[0]?.payload
            if (point && point.since < point.until) onAudit?.(point)
          }}>
          <defs>
            <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COST_COLOR} stopOpacity={0.3} />
              <stop offset="100%" stopColor={COST_COLOR} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="#27272a" strokeDasharray="3 3" opacity={0.45} />
          <XAxis
            dataKey="date" axisLine={false} tickLine={false} tickMargin={8}
            tick={{ fill: '#71717a', fontSize: 12 }}
            tickFormatter={value => (isToday ? value : value.slice(5))}
            interval={isToday ? 3 : 'preserveEnd'}
          />
          <YAxis
            yAxisId="cost" axisLine={false} tickLine={false} width={42}
            tick={{ fill: '#71717a', fontSize: 11 }} tickFormatter={formatCostTick}
          />
          <YAxis
            yAxisId="tokens" orientation="right" axisLine={false} tickLine={false} width={44}
            tick={{ fill: '#71717a', fontSize: 11 }} tickFormatter={formatTokenTick}
          />
          <Tooltip content={<UsageTooltip />} />
          <Area
            yAxisId="cost" type="monotone" dataKey="cost" stroke={COST_COLOR}
            strokeWidth={2} fill="url(#costGrad)" name="花费"
          />
          <Line
            yAxisId="tokens" type="monotone" dataKey="real_total_tokens"
            stroke={TOKEN_COLOR} strokeWidth={2} dot={false} activeDot={{ r: 3 }} name="Tokens"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

export function DailyChart({
  data, isToday = false, onAudit,
}: { data: DailyData[]; isToday?: boolean; onAudit?: (point: DailyData) => void }) {
  return (
    <div className="rounded-xl border border-zinc-800/50 bg-zinc-900/50 p-4">
      <UsageChartHeader isToday={isToday} />
      <UsageChart data={data} isToday={isToday} onAudit={onAudit} />
    </div>
  )
}
