import type {
  AttributionStatusRow,
  CostCoverage, DeviceStatsRow, ModelStatsRow, MonthStatsRow,
  ProviderStatsRow, QuerySnapshot, StatsResponse, StatsTotals, TrendStatsRow,
  ProjectStatsRow, SessionStatsRow,
  YearStatsResponse, YearStatsRow,
} from '@tokember/contracts/stats'
import {
  arrayValue, literalValue, numberValue, objectValue, stringValue, type JsonObject,
} from './decoders'

export interface DeviceOption { id: string; name: string }

export function decodeCostCoverage(value: unknown): CostCoverage {
  const row = objectValue(value, 'pricing_coverage')
  return {
    priced_calls: numberValue(row.priced_calls), unpriced_calls: numberValue(row.unpriced_calls),
    priced_tokens: numberValue(row.priced_tokens), unpriced_tokens: numberValue(row.unpriced_tokens),
    call_ratio: numberValue(row.call_ratio), token_ratio: numberValue(row.token_ratio),
  }
}

function aggregate(row: JsonObject) {
  return {
    calls: numberValue(row.calls), real_total_tokens: numberValue(row.real_total_tokens),
    cost: numberValue(row.cost), pricing_coverage: decodeCostCoverage(row.pricing_coverage),
  }
}

export function decodeQuerySnapshot(value: unknown): QuerySnapshot {
  const row = objectValue(value, 'snapshot')
  return {
    since: stringValue(row.since), until: stringValue(row.until),
    timezone_offset: numberValue(row.timezone_offset),
    max_record_id: numberValue(row.max_record_id),
  }
}

function totals(value: unknown): StatsTotals {
  const row = objectValue(value, 'totals')
  return {
    total_calls: numberValue(row.total_calls), total_input: numberValue(row.total_input),
    total_output: numberValue(row.total_output), total_cache_read: numberValue(row.total_cache_read),
    total_cache_creation: numberValue(row.total_cache_creation),
    real_total_tokens: numberValue(row.real_total_tokens), total_cost: numberValue(row.total_cost),
    pricing_coverage: decodeCostCoverage(row.pricing_coverage),
  }
}

function provider(value: unknown): ProviderStatsRow {
  const row = objectValue(value)
  return { ...aggregate(row), provider: stringValue(row.provider), tokens: numberValue(row.tokens) }
}

function model(value: unknown): ModelStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), model: stringValue(row.model), provider: stringValue(row.provider),
    tokens: numberValue(row.tokens), input_tokens: numberValue(row.input_tokens),
    output_tokens: numberValue(row.output_tokens),
    cache_read_tokens: numberValue(row.cache_read_tokens),
    cache_creation_tokens: numberValue(row.cache_creation_tokens),
    unpriced_calls: numberValue(row.unpriced_calls),
  }
}

function deviceStats(value: unknown): DeviceStatsRow {
  const row = objectValue(value)
  return { ...aggregate(row), device: stringValue(row.device), provider: stringValue(row.provider) }
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : numberValue(value)
}

function attribution(value: unknown): AttributionStatusRow {
  const row = objectValue(value)
  return {
    ...aggregate(row),
    status: literalValue(row.status, ['captured', 'disabled', 'unsupported', 'unknown'] as const),
    records: numberValue(row.records),
  }
}

function project(value: unknown): ProjectStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), group_id: nullableNumber(row.group_id),
    name: stringValue(row.name), members: numberValue(row.members),
  }
}

function session(value: unknown): SessionStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), session_id: stringValue(row.session_id),
    project_group_id: nullableNumber(row.project_group_id),
    project_name: row.project_name == null ? null : stringValue(row.project_name),
  }
}

function trend(value: unknown): TrendStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), date: stringValue(row.date), tokens: numberValue(row.tokens),
    since: stringValue(row.since), until: stringValue(row.until),
    input_tokens: numberValue(row.input_tokens), output_tokens: numberValue(row.output_tokens),
  }
}

export function decodeStatsResponse(value: unknown): StatsResponse {
  const body = objectValue(value, 'stats')
  return {
    snapshot: decodeQuerySnapshot(body.snapshot),
    totals: totals(body.totals),
    byProvider: arrayValue(body.byProvider).map(provider),
    byModel: arrayValue(body.byModel).map(model),
    byDevice: arrayValue(body.byDevice).map(deviceStats),
    attribution: arrayValue(body.attribution ?? []).map(attribution),
    projectOptions: arrayValue(body.projectOptions ?? []).map(project),
    byProject: arrayValue(body.byProject ?? []).map(project),
    bySession: arrayValue(body.bySession ?? []).map(session),
    daily: arrayValue(body.daily).map(trend),
  }
}

function yearRow(value: unknown): YearStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), date: stringValue(row.date),
    since: stringValue(row.since), until: stringValue(row.until),
  }
}

function monthRow(value: unknown): MonthStatsRow {
  const row = objectValue(value)
  return {
    ...aggregate(row), month: stringValue(row.month),
    since: stringValue(row.since), until: stringValue(row.until),
  }
}

export function decodeYearStatsResponse(value: unknown): YearStatsResponse {
  const body = objectValue(value, 'year stats')
  const summary = objectValue(body.totals, 'year totals')
  const peak = objectValue(body.peak, 'peak')
  return {
    year: numberValue(body.year),
    available_years: arrayValue(body.available_years).map(value => numberValue(value)),
    snapshot: decodeQuerySnapshot(body.snapshot),
    totals: {
      total_cost: numberValue(summary.total_cost), total_calls: numberValue(summary.total_calls),
      real_total_tokens: numberValue(summary.real_total_tokens), active_days: numberValue(summary.active_days),
      pricing_coverage: decodeCostCoverage(summary.pricing_coverage),
    },
    peak: { date: stringValue(peak.date), cost: numberValue(peak.cost) },
    daily: arrayValue(body.daily).map(yearRow), monthly: arrayValue(body.monthly).map(monthRow),
  }
}

export function decodeDeviceOptions(value: unknown): DeviceOption[] {
  return arrayValue(value, 'devices').map(item => {
    const row = objectValue(item, 'device')
    return { id: stringValue(row.id), name: stringValue(row.name) }
  })
}
