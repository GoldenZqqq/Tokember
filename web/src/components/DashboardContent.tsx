import { DailyChart } from './DailyChart'
import { ModelTable } from './ModelTable'
import { Overview } from './Overview'
import { ProviderBreakdown } from './ProviderBreakdown'
import type { RangeValue } from './RangeTabs'
import type { Stats } from '../dashboard-stats'
import type { AuditDimension } from '../audit/query'
import { AttributionBreakdown } from './AttributionBreakdown'

export function DashboardContent({
  stats, range, onAudit,
}: { stats: Stats; range: RangeValue; onAudit: (dimension?: AuditDimension) => void }) {
  return <div className="space-y-6">
    <Overview stats={stats} onAudit={() => onAudit()} />
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <DailyChart data={stats.daily} isToday={range === 'today'}
          onAudit={point => onAudit({ since: point.since, until: point.until })} />
      </div>
      <ProviderBreakdown data={stats.by_provider}
        onAudit={provider => onAudit({ provider })} />
    </div>
    <ModelTable data={stats.by_model}
      onAudit={(provider, model) => onAudit({ provider, ...(model ? { model } : {}) })} />
    <AttributionBreakdown stats={stats} onAudit={onAudit} />
  </div>
}
