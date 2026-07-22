import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import type {
  CollectorKind,
  CollectorRunReport,
  CollectorSourceReport,
} from '@tokember/contracts/collector-observability'
import { CollectionObserver, type UsageRecord } from './adapters/types.js'
import {
  setIncrementalSourceState,
  type CollectorState,
  type IncrementalSourceState,
} from './collector-state.js'
import { IncrementalCursor } from './incremental-cursor.js'
import { atomicWriteText } from './atomic-file.js'
import { resolveLegacyAwareHomePath } from './runtime-paths.js'
import type { IngestSummary } from './server-client.js'

const OUTBOX_VERSION = 1
const MAX_PENDING_REPORTS = 100
const MAX_ERROR_LENGTH = 500

export interface ObservableSource {
  source: string
  incremental_state?: IncrementalSourceState
  bootstrap_since?: string | null
  collect: (
    observer: CollectionObserver,
    incremental?: IncrementalCursor,
  ) => Promise<UsageRecord[]>
}

export interface SourceCollection {
  source: string
  records: UsageRecord[]
  discovered: number
  scanned: number
  watermark_at: string | null
  duration_ms: number
  error_summary: string | null
  state_candidate: IncrementalSourceState | null
}

export interface RunStart {
  schema_version: 1
  run_id: string
  device_id: string
  collector_kind: CollectorKind
  collector_version: string
  schedule_interval_minutes: number
  started_at: string
}

interface OutboxState {
  version: typeof OUTBOX_VERSION
  running: RunStart[]
  reports: CollectorRunReport[]
}

export function sanitizeCollectorError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? 'unknown failure')
  return message
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bx-api-key\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, 'X-API-Key: [redacted]')
    .replace(/\b(?:TOKEMBER_DEVICE_TOKEN|TOKEMBER_API_KEY|AI_BURN_API_KEY|API_KEY)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      match => `${match.split(/[:=]/, 1)[0]}=[redacted]`)
    .replace(/\btkdc_[A-Za-z0-9_-]{12,64}_[A-Za-z0-9_-]{32,128}\b/g, '[device-token]')
    .replace(/\b[A-Za-z]:[\\/][^\s,;]+/g, '[path]')
    .replace(/\\\\[^\\\s]+\\[^\s,;]+/g, '[path]')
    .replace(/\/(?:home|Users|var\/lib|tmp|opt)\/[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_LENGTH) || 'unknown failure'
}

function maxRecordTimestamp(records: UsageRecord[]): string | null {
  let latest: number | null = null
  for (const record of records) {
    const time = Date.parse(record.timestamp)
    if (Number.isFinite(time) && (latest == null || time > latest)) latest = time
  }
  return latest == null ? null : new Date(latest).toISOString()
}

async function collectSource(source: ObservableSource): Promise<SourceCollection> {
  const observer = new CollectionObserver()
  const incremental = source.incremental_state
    ? new IncrementalCursor(source.incremental_state, source.bootstrap_since)
    : undefined
  const started = Date.now()
  try {
    const records = await source.collect(observer, incremental)
    const scan = observer.snapshot()
    return {
      source: source.source, records, ...scan,
      duration_ms: Math.max(0, Date.now() - started),
      error_summary: null,
      state_candidate: incremental?.snapshot() ?? null,
    }
  } catch (error) {
    const scan = observer.snapshot()
    return {
      source: source.source, records: [], ...scan,
      duration_ms: Math.max(0, Date.now() - started),
      error_summary: sanitizeCollectorError(error),
      state_candidate: null,
    }
  }
}

export function applySuccessfulSourceStates(
  options: {
    state: CollectorState
    deviceId: string
    collections: SourceCollection[]
    reports: CollectorSourceReport[]
  },
): string[] {
  const successful = new Set(
    options.reports.filter(report => report.status === 'success').map(report => report.source),
  )
  const applied: string[] = []
  for (const collection of options.collections) {
    if (!collection.state_candidate || !successful.has(collection.source)) continue
    setIncrementalSourceState(options.state, {
      deviceId: options.deviceId,
      source: collection.source,
      sourceState: collection.state_candidate,
    })
    applied.push(collection.source)
  }
  return applied
}

export async function collectObservableSources(
  sources: ObservableSource[],
): Promise<SourceCollection[]> {
  return Promise.all(sources.map(collectSource))
}

function successfulSourceReport(
  collection: SourceCollection,
  summary: IngestSummary,
  uploadDurationMs: number,
): CollectorSourceReport {
  const accepted = summary.inserted
  return {
    source: collection.source,
    status: 'success',
    discovered: collection.discovered,
    scanned: collection.scanned,
    emitted: collection.records.length,
    accepted,
    unchanged: summary.total - accepted,
    watermark_at: collection.watermark_at,
    last_usage_at: maxRecordTimestamp(collection.records),
    duration_ms: collection.duration_ms + uploadDurationMs,
    error_summary: null,
  }
}

export async function uploadObservableSources(
  collections: SourceCollection[],
  upload: (records: UsageRecord[]) => Promise<IngestSummary>,
): Promise<CollectorSourceReport[]> {
  const reports: CollectorSourceReport[] = []
  for (const collection of collections) {
    if (collection.error_summary) {
      reports.push({
        source: collection.source, status: 'collection_failed',
        discovered: collection.discovered, scanned: collection.scanned,
        emitted: 0, accepted: null, unchanged: null,
        watermark_at: collection.watermark_at, last_usage_at: null,
        duration_ms: collection.duration_ms, error_summary: collection.error_summary,
      })
      continue
    }
    const uploadStarted = Date.now()
    try {
      const summary = await upload(collection.records)
      reports.push(successfulSourceReport(
        collection,
        summary,
        Math.max(0, Date.now() - uploadStarted),
      ))
    } catch (error) {
      reports.push({
        source: collection.source, status: 'upload_failed',
        discovered: collection.discovered, scanned: collection.scanned,
        emitted: collection.records.length, accepted: null, unchanged: null,
        watermark_at: collection.watermark_at,
        last_usage_at: maxRecordTimestamp(collection.records),
        duration_ms: collection.duration_ms + Math.max(0, Date.now() - uploadStarted),
        error_summary: sanitizeCollectorError(error),
      })
    }
  }
  return reports
}

export function startCollectorRun(
  input: Omit<RunStart, 'schema_version' | 'run_id' | 'started_at'>,
  now = new Date(),
): RunStart {
  return {
    schema_version: 1,
    run_id: randomUUID(),
    ...input,
    started_at: now.toISOString(),
  }
}

/** Zero-ack runtime liveness source used when registration/bootstrap fails. */
export const COLLECTOR_RUNTIME_SOURCE = 'collector'

export function successfulCollectorRuntimeSource(
  durationMs = 0,
): CollectorSourceReport {
  return {
    source: COLLECTOR_RUNTIME_SOURCE,
    status: 'success',
    discovered: 0,
    scanned: 0,
    emitted: 0,
    accepted: 0,
    unchanged: 0,
    watermark_at: null,
    last_usage_at: null,
    duration_ms: Math.max(0, durationMs),
    error_summary: null,
  }
}

/**
 * Successful tool runs append a collector runtime success so a prior
 * registration-timeout row (`source=collector`, collection_failed) does not
 * permanently keep device health degraded.
 */
export function withCollectorRuntimeSuccess(
  sources: CollectorSourceReport[],
): CollectorSourceReport[] {
  if (sources.some(source => source.source === COLLECTOR_RUNTIME_SOURCE)) return sources
  if (sources.length > 0 && !sources.every(source => source.status === 'success')) {
    return sources
  }
  return [...sources, successfulCollectorRuntimeSource()]
}

export function buildCollectorRunReport(
  start: RunStart,
  sources: CollectorSourceReport[],
  finishedAt = new Date(),
): CollectorRunReport {
  const reported = withCollectorRuntimeSuccess(sources)
  const successful = reported.filter(source => source.status === 'success').length
  const status = successful === reported.length ? 'success' : successful === 0 ? 'failed' : 'partial'
  const allKnown = reported.every(source => source.accepted != null)
  const accepted = allKnown ? reported.reduce((sum, source) => sum + source.accepted!, 0) : null
  const unchanged = allKnown ? reported.reduce((sum, source) => sum + source.unchanged!, 0) : null
  const errors = reported
    .filter(source => source.error_summary)
    .map(source => `${source.source}: ${source.error_summary}`)
  return {
    ...start,
    finished_at: finishedAt.toISOString(),
    status,
    duration_ms: Math.max(0, finishedAt.getTime() - Date.parse(start.started_at)),
    emitted: reported.reduce((sum, source) => sum + source.emitted, 0),
    accepted,
    unchanged,
    error_summary: errors.length > 0 ? sanitizeCollectorError(errors.join('; ')) : null,
    sources: reported,
  }
}

export function failedCollectorRunReport(
  start: RunStart,
  error: unknown,
  finishedAt = new Date(),
): CollectorRunReport {
  const summary = sanitizeCollectorError(error)
  return buildCollectorRunReport(start, [{
    source: COLLECTOR_RUNTIME_SOURCE, status: 'collection_failed', discovered: 0, scanned: 0,
    emitted: 0, accepted: null, unchanged: null, watermark_at: null,
    last_usage_at: null, duration_ms: 0, error_summary: summary,
  }], finishedAt)
}

export function getObservabilityStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.TOKEMBER_OBSERVABILITY_STATE || env.AI_BURN_OBSERVABILITY_STATE || '').trim()
  if (configured) return configured
  return resolveLegacyAwareHomePath({ fileName: 'collector-observability.json' })
}

function emptyOutbox(): OutboxState {
  return { version: OUTBOX_VERSION, running: [], reports: [] }
}

async function loadOutbox(path: string): Promise<OutboxState> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<OutboxState>
    if (value.version !== OUTBOX_VERSION
      || !Array.isArray(value.running) || !Array.isArray(value.reports)) return emptyOutbox()
    return value as OutboxState
  } catch {
    return emptyOutbox()
  }
}

async function saveOutbox(state: OutboxState, path: string): Promise<void> {
  await atomicWriteText(path, JSON.stringify(state, null, 2))
}

export async function recoverAndBeginRun(start: RunStart, path: string): Promise<void> {
  const state = await loadOutbox(path)
  const recovered = state.running.map(run => failedCollectorRunReport(
    run, 'Collector terminated before completion', new Date(start.started_at),
  ))
  state.running = [start]
  state.reports = [...state.reports, ...recovered].slice(-MAX_PENDING_REPORTS)
  await saveOutbox(state, path)
}

export async function finishPendingRun(report: CollectorRunReport, path: string): Promise<void> {
  const state = await loadOutbox(path)
  state.running = state.running.filter(run => run.run_id !== report.run_id)
  state.reports = [
    ...state.reports.filter(item => item.run_id !== report.run_id),
    report,
  ].slice(-MAX_PENDING_REPORTS)
  await saveOutbox(state, path)
}

export async function flushPendingRuns(
  send: (report: CollectorRunReport) => Promise<unknown>,
  path: string,
): Promise<number> {
  const state = await loadOutbox(path)
  const failed: CollectorRunReport[] = []
  let sent = 0
  for (const report of state.reports) {
    try {
      await send(report)
      sent += 1
    } catch {
      failed.push(report)
    }
  }
  state.reports = failed
  await saveOutbox(state, path)
  return sent
}
