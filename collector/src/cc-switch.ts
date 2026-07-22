import type { UsageRecord } from './adapters/types.js'

function counter(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

export function ccSwitchRequestCountColumn(columns: readonly string[]): string {
  return columns.includes('request_count')
    ? 'request_count'
    : '1 AS request_count'
}

export function ccSwitchRollupToRecord(row: Record<string, unknown>): UsageRecord {
  const provider = text(row.app_type, 'unknown')
  const model = text(row.model, 'unknown')
  const date = text(row.date, '1970-01-01')
  return {
    provider,
    model,
    request_count: counter(row.request_count),
    input_tokens: counter(row.input_tokens),
    output_tokens: counter(row.output_tokens),
    cache_read_tokens: counter(row.cache_read_tokens),
    cache_creation_tokens: counter(row.cache_creation_tokens),
    reasoning_tokens: 0,
    cost_usd: Number.parseFloat(String(row.total_cost_usd ?? 0)) || 0,
    timestamp: `${date}T12:00:00.000Z`,
    source_file: 'cc-switch',
    dedup_key: `ccsw-roll:${date}:${provider}:${model}:${text(row.provider_id, '')}`,
    attribution: { status: 'unsupported' },
  }
}
