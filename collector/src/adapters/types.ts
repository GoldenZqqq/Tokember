import type {
  TokenInclusionSemantics,
  UsageRecord as ContractUsageRecord,
} from '@tokember/contracts/usage'
import type { IncrementalCursor } from '../incremental-cursor.js'

// Shared contract for every collector adapter.
//
// An adapter reads one AI tool's native local logs and returns UsageRecord[].
// Cost is intentionally NOT computed here (except for tools that record it
// themselves, e.g. Cline/Roo): the server's resolvePricing() prices records at
// ingest time from the pricing_rules table. An adapter only needs to report
// provider + model + token counts honestly; unpriced records surface in the
// admin panel and can be repriced once a rule is configured.

type UsageMetricFields = 'request_count' | keyof TokenInclusionSemantics

export interface LocalProjectSeed {
  kind: 'path' | 'opaque'
  value: string
}

export type LocalAttribution =
  | { status: 'captured'; project?: LocalProjectSeed; session?: string }
  | { status: 'unsupported' }

export type UsageRecord = Omit<ContractUsageRecord, UsageMetricFields>
  & Partial<Pick<ContractUsageRecord, UsageMetricFields>>
  & { attribution?: LocalAttribution }

export const SEPARATE_TOKEN_SEMANTICS = {
  input_includes_cache_read: false,
  input_includes_cache_creation: false,
  output_includes_reasoning: false,
} as const satisfies TokenInclusionSemantics

export const CACHE_READ_INCLUDED_TOKEN_SEMANTICS = {
  ...SEPARATE_TOKEN_SEMANTICS,
  input_includes_cache_read: true,
} as const satisfies TokenInclusionSemantics

export function tokenSemanticsForProvider(provider: string): TokenInclusionSemantics {
  return provider === 'codex' || provider === 'gemini'
    ? CACHE_READ_INCLUDED_TOKEN_SEMANTICS
    : SEPARATE_TOKEN_SEMANTICS
}

export function completeUsageRecord(record: UsageRecord): ContractUsageRecord {
  const { attribution: _localAttribution, ...wireRecord } = record
  const semantics = tokenSemanticsForProvider(record.provider)
  return {
    ...wireRecord,
    request_count: record.request_count ?? 1,
    input_includes_cache_read: record.input_includes_cache_read
      ?? semantics.input_includes_cache_read,
    input_includes_cache_creation: record.input_includes_cache_creation
      ?? semantics.input_includes_cache_creation,
    output_includes_reasoning: record.output_includes_reasoning
      ?? semantics.output_includes_reasoning,
  }
}

export interface CollectionWindow {
  since?: string
  until: string
}

export interface CollectionScanSnapshot {
  discovered: number
  scanned: number
  watermark_at: string | null
}

export class CollectionObserver {
  private discoveredCount = 0
  private scannedCount = 0
  private watermarkTime: number | null = null

  discover(count = 1): void {
    this.discoveredCount += Math.max(0, Math.floor(count))
  }

  scan(timestamp?: string): void {
    this.scannedCount += 1
    this.watermark(timestamp)
  }

  watermark(timestamp?: string): void {
    if (!timestamp) return
    const time = Date.parse(timestamp)
    if (Number.isFinite(time) && (this.watermarkTime == null || time > this.watermarkTime)) {
      this.watermarkTime = time
    }
  }

  snapshot(): CollectionScanSnapshot {
    return {
      discovered: this.discoveredCount,
      scanned: this.scannedCount,
      watermark_at: this.watermarkTime == null
        ? null
        : new Date(this.watermarkTime).toISOString(),
    }
  }
}

export function isInCollectionWindow(
  timestamp: string,
  window?: CollectionWindow,
): boolean {
  if (!window) return true
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) return false
  return (window.since == null || value >= Date.parse(window.since))
    && value <= Date.parse(window.until)
}

// Every adapter is a plain async function that discovers and parses its own
// data source. It must never throw for a missing/unreadable source — return []
// so one absent tool cannot abort the whole collector run.
export type Adapter = (
  window?: CollectionWindow,
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
) => Promise<UsageRecord[]>
