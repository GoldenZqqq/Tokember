import type {
  IngestResultCounts,
} from '@tokember/contracts/usage'
import type {
  CollectorRunAcknowledgement,
  CollectorRunReport,
} from '@tokember/contracts/collector-observability'
import type {
  SourceAuthorityState as ContractSourceAuthorityState,
  SourceProvider,
} from '@tokember/contracts/source-authority'
import type { MachineMetadata } from '@tokember/contracts/device'
import type { ProtocolIncompatibleError } from '@tokember/contracts/protocol'
import { completeUsageRecord, type UsageRecord } from './adapters/types.js'

/** Must stay within the server protocol window (see docs/data-lifecycle.md). */
export const COLLECTOR_PROTOCOL_VERSION = 1 as const

export type NativeProvider = SourceProvider
export type SourceAuthorityState = ContractSourceAuthorityState
export type SourceAuthorityMap = Partial<Record<NativeProvider, SourceAuthorityState>>

export type IngestSummary =
  | (IngestResultCounts & { precision: 'exact'; changed: number })
  | { precision: 'legacy'; total: number; inserted: number; changed: number }

interface ServerClientOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface JsonObject {
  [key: string]: unknown
}

type BatchAcknowledgement =
  | (IngestResultCounts & { precision: 'exact' })
  | { precision: 'legacy'; total: number; inserted: number }

function isObject(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function acknowledgementCount(value: unknown): number {
  if (!isCount(value)) throw new Error('Server ingest returned an invalid acknowledgement')
  return value
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function decodeAuthority(value: unknown, provider: NativeProvider): SourceAuthorityState {
  if (!isObject(value) || value.provider !== provider
    || typeof value.legacy_history !== 'boolean') {
    throw new Error(`Invalid source authority for ${provider}`)
  }
  return {
    provider,
    cutover_at: nullableTimestamp(value.cutover_at, 'cutover_at'),
    legacy_history: value.legacy_history,
    legacy_coverage_end: nullableTimestamp(value.legacy_coverage_end, 'legacy_coverage_end'),
  }
}

function decodeAuthorities(value: unknown, providers: NativeProvider[]): SourceAuthorityMap {
  if (!isObject(value)) throw new Error('Invalid source_authority response')
  return Object.fromEntries(providers.map(provider => [
    provider,
    decodeAuthority(value[provider], provider),
  ]))
}

function exactAcknowledgement(value: JsonObject, expectedTotal: number): BatchAcknowledgement {
  if (value.ok !== true) {
    throw new Error('Server ingest returned an invalid acknowledgement')
  }
  const result: IngestResultCounts = {
    created: acknowledgementCount(value.created),
    updated: acknowledgementCount(value.updated),
    unchanged: acknowledgementCount(value.unchanged),
    total: acknowledgementCount(value.total),
    inserted: acknowledgementCount(value.inserted),
  }
  if (result.total !== expectedTotal) {
    throw new Error('Server ingest returned a partial acknowledgement')
  }
  if (result.total !== result.created + result.updated + result.unchanged
    || result.inserted !== result.created + result.updated) {
    throw new Error('Server ingest returned an invalid acknowledgement')
  }
  return { precision: 'exact', ...result }
}

function decodeAcknowledgement(value: JsonObject, expectedTotal: number): BatchAcknowledgement {
  const exactFields = ['created', 'updated', 'unchanged', 'total']
  if (exactFields.some(field => field in value)) {
    return exactAcknowledgement(value, expectedTotal)
  }
  if (('ok' in value && value.ok !== true)
    || !isCount(value.inserted) || value.inserted > expectedTotal) {
    throw new Error('Server ingest returned an invalid acknowledgement')
  }
  return { precision: 'legacy', total: expectedTotal, inserted: value.inserted }
}

export class ServerClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    baseUrl: string,
    private readonly credential: string,
    options: ServerClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.credential) headers.Authorization = `Bearer ${this.credential}`
    return headers
  }

  private protocolErrorMessage(path: string, value: unknown): string | null {
    if (!isObject(value) || value.error !== 'protocol_incompatible') return null
    const body = value as Partial<ProtocolIncompatibleError>
    const hint = typeof body.upgrade_hint === 'string' && body.upgrade_hint.trim()
      ? body.upgrade_hint.trim()
      : 'Upgrade the collector or server to a matching protocol version.'
    return `Server ${path} protocol incompatible: ${hint}`
  }

  private async request(path: string, init: RequestInit): Promise<JsonObject> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    let value: unknown
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init, headers: this.headers(), signal: controller.signal,
      })
      try {
        value = await response.json()
      } catch (error) {
        if (controller.signal.aborted) throw error
        value = null
      }
    } catch {
      if (controller.signal.aborted) throw new Error(`Server ${path} request timed out`)
      throw new Error(`Server ${path} request failed`)
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const protocolMessage = this.protocolErrorMessage(path, value)
      if (protocolMessage) throw new Error(protocolMessage)
      throw new Error(`Server ${path} returned HTTP ${response.status}`)
    }
    if (!isObject(value)) throw new Error(`Server ${path} returned invalid JSON`)
    return value
  }

  async registerDevice(
    id: string,
    name: string,
    providers: NativeProvider[],
    machine?: MachineMetadata,
  ): Promise<SourceAuthorityMap> {
    const value = await this.request('/api/devices', {
      method: 'POST',
      body: JSON.stringify({
        id,
        name,
        native_sources: providers,
        protocol_version: COLLECTOR_PROTOCOL_VERSION,
        ...machine,
      }),
    })
    return decodeAuthorities(value.source_authority, providers)
  }

  async ingest(deviceId: string, records: UsageRecord[]): Promise<IngestSummary> {
    const totals: IngestResultCounts = {
      created: 0, updated: 0, unchanged: 0, total: 0, inserted: 0,
    }
    let exact = true
    for (let index = 0; index < records.length; index += 500) {
      const batch = records.slice(index, index + 500).map(completeUsageRecord)
      const value = await this.request('/api/ingest', {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, records: batch }),
      })
      const acknowledged = decodeAcknowledgement(value, batch.length)
      totals.total += acknowledged.total
      totals.inserted += acknowledged.inserted
      if (acknowledged.precision === 'legacy') exact = false
      else {
        totals.created += acknowledged.created
        totals.updated += acknowledged.updated
        totals.unchanged += acknowledged.unchanged
      }
    }
    return exact
      ? { precision: 'exact', ...totals, changed: totals.inserted }
      : { precision: 'legacy', total: totals.total, inserted: totals.inserted, changed: totals.inserted }
  }

  async commitCutover(
    deviceId: string,
    provider: NativeProvider,
    cutoverAt: string,
  ): Promise<void> {
    await this.request('/api/source-cutovers', {
      method: 'POST',
      body: JSON.stringify({ device_id: deviceId, provider, cutover_at: cutoverAt }),
    })
  }

  async reportRun(report: CollectorRunReport): Promise<CollectorRunAcknowledgement> {
    const value = await this.request('/api/collector-runs', {
      method: 'POST',
      body: JSON.stringify(report),
    })
    if (value.ok !== true || value.run_id !== report.run_id) {
      throw new Error('Server collector run returned an invalid acknowledgement')
    }
    return { ok: true, run_id: report.run_id }
  }
}
