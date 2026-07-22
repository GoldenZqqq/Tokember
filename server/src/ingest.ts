import type {
  AttributionStatus,
  IngestResultCounts,
  UsageRecord as ContractUsageRecord,
} from '@tokember/contracts/usage'
import type { DB } from './db.js'
import { ensureProjectMembership } from './attribution.js'
import { resolveModelName } from './model-normalize.js'
import { resolvePricing } from './pricing.js'
import { defaultTokenSemantics } from './usage-metrics.js'

export const INGEST_MAX_BODY_BYTES = 2 * 1024 * 1024
export const INGEST_MAX_RECORDS = 500
export const INGEST_FUTURE_TOLERANCE_MS = 5 * 60_000

const MAX_DEVICE_ID_LENGTH = 128
const MAX_PROVIDER_LENGTH = 128
const MAX_MODEL_LENGTH = 256
const MAX_SOURCE_FILE_LENGTH = 1024
const MAX_DEDUP_KEY_LENGTH = 512
const MAX_ATTRIBUTION_ID_LENGTH = 96
const TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i
const ATTRIBUTION_ID = /^(?:prj|ses)_v1_[A-Za-z0-9_-]{43}$/

export type IngestErrorStatus = 400 | 404 | 409 | 410 | 413

export type IngestErrorCode =
  | 'invalid_json'
  | 'invalid_body'
  | 'invalid_records'
  | 'invalid_record'
  | 'invalid_string'
  | 'invalid_integer'
  | 'invalid_flag'
  | 'invalid_cost'
  | 'invalid_attribution'
  | 'invalid_timestamp'
  | 'future_timestamp'
  | 'batch_too_large'
  | 'payload_too_large'
  | 'duplicate_dedup_key'
  | 'dedup_device_conflict'
  | 'forbidden_source'
  | 'device_not_found'

interface IngestErrorOptions {
  code: IngestErrorCode
  status: IngestErrorStatus
  message: string
  recordIndex?: number
  field?: string
}

export class IngestRequestError extends Error {
  readonly code: IngestErrorCode
  readonly status: IngestErrorStatus
  readonly recordIndex?: number
  readonly field?: string

  constructor(options: IngestErrorOptions) {
    super(options.message)
    this.name = 'IngestRequestError'
    this.code = options.code
    this.status = options.status
    this.recordIndex = options.recordIndex
    this.field = options.field
  }

  toResponse(): Record<string, string | number> {
    return {
      error: this.message,
      code: this.code,
      ...(this.recordIndex == null ? {} : { record_index: this.recordIndex }),
      ...(this.field == null ? {} : { field: this.field }),
    }
  }
}

export interface DecodedUsageRecord extends Omit<
  ContractUsageRecord,
  'source_file' | 'attribution_version' | 'attribution_status' | 'project_id' | 'session_id'
> {
  source_file: string | null
  cost_provided: boolean
  attribution_version: 1 | null
  attribution_status: AttributionStatus | null
  project_id: string | null
  session_id: string | null
}

export interface DecodedIngestBatch {
  device_id: string
  records: DecodedUsageRecord[]
}

export type IngestResult = IngestResultCounts

interface FieldOptions {
  field: string
  recordIndex?: number
}

interface StringOptions extends FieldOptions {
  maxLength: number
  trimOutput?: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function fieldMessage(recordIndex?: number): string {
  return recordIndex == null ? 'ingest body is invalid' : 'record field is invalid'
}

function failField(code: IngestErrorCode, options: FieldOptions): never {
  throw new IngestRequestError({
    code,
    status: 400,
    message: fieldMessage(options.recordIndex),
    recordIndex: options.recordIndex,
    field: options.field,
  })
}

function requiredString(value: unknown, options: StringOptions): string {
  if (typeof value !== 'string') failField('invalid_string', options)
  const trimmed = value.trim()
  if (!trimmed || value.length > options.maxLength) {
    failField('invalid_string', options)
  }
  return options.trimOutput === false ? value : trimmed
}

function optionalString(value: unknown, options: StringOptions): string | null {
  if (value == null) return null
  return requiredString(value, options)
}

function integer(value: unknown, fallback: number, options: FieldOptions): number {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    failField('invalid_integer', options)
  }
  return value
}

function flag(value: unknown, fallback: boolean, options: FieldOptions): boolean {
  if (value == null) return fallback
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  return failField('invalid_flag', options)
}

function cost(value: unknown, options: FieldOptions): number {
  if (value == null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    failField('invalid_cost', options)
  }
  return value
}

function provided(value: unknown, options: FieldOptions): boolean {
  if (value == null) return false
  if (typeof value !== 'boolean') failField('invalid_flag', options)
  return value
}

function attributionId(
  value: unknown,
  field: 'project_id' | 'session_id',
  recordIndex: number,
): string | null {
  const decoded = optionalString(value, {
    field, recordIndex, maxLength: MAX_ATTRIBUTION_ID_LENGTH, trimOutput: false,
  })
  if (decoded != null && !ATTRIBUTION_ID.test(decoded)) {
    failField('invalid_attribution', { field, recordIndex })
  }
  return decoded
}

function decodeAttribution(value: Record<string, unknown>, recordIndex: number) {
  const fields = [
    value.attribution_version, value.attribution_status,
    value.project_id, value.session_id,
  ]
  if (fields.every(field => field == null)) {
    return {
      attribution_version: null, attribution_status: null,
      project_id: null, session_id: null,
    }
  }
  if (value.attribution_version !== 1) {
    failField('invalid_attribution', { field: 'attribution_version', recordIndex })
  }
  const rawStatus = value.attribution_status
  if (rawStatus !== 'captured' && rawStatus !== 'disabled' && rawStatus !== 'unsupported') {
    failField('invalid_attribution', { field: 'attribution_status', recordIndex })
  }
  const status: AttributionStatus = rawStatus
  const projectId = attributionId(value.project_id, 'project_id', recordIndex)
  const sessionId = attributionId(value.session_id, 'session_id', recordIndex)
  if (status === 'captured' && projectId == null && sessionId == null) {
    failField('invalid_attribution', { field: 'attribution_status', recordIndex })
  }
  if (status !== 'captured' && (projectId != null || sessionId != null)) {
    failField('invalid_attribution', {
      field: projectId != null ? 'project_id' : 'session_id', recordIndex,
    })
  }
  return {
    attribution_version: 1 as const,
    attribution_status: status,
    project_id: projectId,
    session_id: sessionId,
  }
}

function timestamp(value: unknown, now: Date, recordIndex: number): string {
  const options = { field: 'timestamp', recordIndex, maxLength: 64 }
  const raw = requiredString(value, options)
  if (!TIMESTAMP_WITH_ZONE.test(raw)) failField('invalid_timestamp', options)
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) failField('invalid_timestamp', options)
  if (parsed > now.getTime() + INGEST_FUTURE_TOLERANCE_MS) {
    failField('future_timestamp', options)
  }
  return new Date(parsed).toISOString()
}

export function isSub2ApiIdentity(value: unknown): boolean {
  return typeof value === 'string' && /^sub2api(?:-key-.*)?$/i.test(value.trim())
}

function recordField(field: string, recordIndex: number): FieldOptions {
  return { field, recordIndex }
}

function decodeCounters(value: Record<string, unknown>, recordIndex: number) {
  const field = (name: string) => recordField(name, recordIndex)
  return {
    request_count: integer(value.request_count, 1, field('request_count')),
    input_tokens: integer(value.input_tokens, 0, field('input_tokens')),
    output_tokens: integer(value.output_tokens, 0, field('output_tokens')),
    cache_read_tokens: integer(value.cache_read_tokens, 0, field('cache_read_tokens')),
    cache_creation_tokens: integer(
      value.cache_creation_tokens, 0, field('cache_creation_tokens'),
    ),
    reasoning_tokens: integer(value.reasoning_tokens, 0, field('reasoning_tokens')),
  }
}

function decodeSemantics(
  value: Record<string, unknown>,
  provider: string,
  recordIndex: number,
) {
  const defaults = defaultTokenSemantics(provider)
  const field = (name: string) => recordField(name, recordIndex)
  return {
    input_includes_cache_read: flag(
      value.input_includes_cache_read,
      defaults.input_includes_cache_read,
      field('input_includes_cache_read'),
    ),
    input_includes_cache_creation: flag(
      value.input_includes_cache_creation,
      defaults.input_includes_cache_creation,
      field('input_includes_cache_creation'),
    ),
    output_includes_reasoning: flag(
      value.output_includes_reasoning,
      defaults.output_includes_reasoning,
      field('output_includes_reasoning'),
    ),
  }
}

function decodeUsageRecord(
  value: unknown,
  recordIndex: number,
  now: Date,
): DecodedUsageRecord {
  if (!isObject(value)) {
    throw new IngestRequestError({
      code: 'invalid_record', status: 400, message: 'record is invalid', recordIndex,
    })
  }
  const provider = requiredString(value.provider, {
    field: 'provider', recordIndex, maxLength: MAX_PROVIDER_LENGTH,
  })
  if (isSub2ApiIdentity(provider)) {
    throw new IngestRequestError({
      code: 'forbidden_source', status: 410,
      message: 'Sub2API usage is excluded from activity totals',
      recordIndex, field: 'provider',
    })
  }
  const field = (name: string) => recordField(name, recordIndex)
  return {
    provider,
    model: requiredString(value.model, {
      field: 'model', recordIndex, maxLength: MAX_MODEL_LENGTH,
    }),
    ...decodeCounters(value, recordIndex),
    ...decodeSemantics(value, provider, recordIndex),
    cost_usd: cost(value.cost_usd, field('cost_usd')),
    cost_provided: provided(value.cost_provided, field('cost_provided')),
    timestamp: timestamp(value.timestamp, now, recordIndex),
    source_file: optionalString(value.source_file, {
      field: 'source_file', recordIndex, maxLength: MAX_SOURCE_FILE_LENGTH,
    }),
    dedup_key: requiredString(value.dedup_key, {
      field: 'dedup_key', recordIndex, maxLength: MAX_DEDUP_KEY_LENGTH,
      trimOutput: false,
    }),
    ...decodeAttribution(value, recordIndex),
  }
}

export function decodeIngestBody(value: unknown, now = new Date()): DecodedIngestBatch {
  if (!isObject(value)) {
    throw new IngestRequestError({
      code: 'invalid_body', status: 400, message: 'ingest body is invalid',
    })
  }
  const deviceId = requiredString(value.device_id, {
    field: 'device_id', maxLength: MAX_DEVICE_ID_LENGTH,
  })
  if (isSub2ApiIdentity(deviceId)) {
    throw new IngestRequestError({
      code: 'forbidden_source', status: 410,
      message: 'Sub2API usage is excluded from activity totals', field: 'device_id',
    })
  }
  if (!Array.isArray(value.records)) {
    throw new IngestRequestError({
      code: 'invalid_records', status: 400, message: 'records must be an array',
    })
  }
  if (value.records.length > INGEST_MAX_RECORDS) {
    throw new IngestRequestError({
      code: 'batch_too_large', status: 413, message: 'record batch is too large',
    })
  }
  const seen = new Set<string>()
  const records = value.records.map((record, index) => {
    const decoded = decodeUsageRecord(record, index, now)
    if (seen.has(decoded.dedup_key)) {
      throw new IngestRequestError({
        code: 'duplicate_dedup_key', status: 409,
        message: 'dedup key is duplicated within the batch',
        recordIndex: index, field: 'dedup_key',
      })
    }
    seen.add(decoded.dedup_key)
    return decoded
  })
  return { device_id: deviceId, records }
}

const USAGE_UPSERT_SQL = `
  INSERT INTO usage_records
    (device_id, provider, model, request_count, input_tokens, output_tokens,
     cache_read_tokens, cache_creation_tokens, reasoning_tokens,
     input_includes_cache_read, input_includes_cache_creation,
     output_includes_reasoning, cost_usd, timestamp, source_file, dedup_key,
     pricing_status, pricing_rule_id, pricing_source,
     attribution_version, attribution_status, project_id, session_id)
  VALUES
    (@device_id, @provider, @model, @request_count, @input_tokens, @output_tokens,
     @cache_read_tokens, @cache_creation_tokens, @reasoning_tokens,
     @input_includes_cache_read, @input_includes_cache_creation,
     @output_includes_reasoning, @cost_usd, @timestamp, @source_file, @dedup_key,
     @pricing_status, @pricing_rule_id, @pricing_source,
     @attribution_version, @attribution_status, @project_id, @session_id)
  ON CONFLICT(dedup_key) DO UPDATE SET
    provider = excluded.provider,
    model = excluded.model,
    request_count = excluded.request_count,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_creation_tokens = excluded.cache_creation_tokens,
    reasoning_tokens = excluded.reasoning_tokens,
    input_includes_cache_read = excluded.input_includes_cache_read,
    input_includes_cache_creation = excluded.input_includes_cache_creation,
    output_includes_reasoning = excluded.output_includes_reasoning,
    cost_usd = CASE WHEN excluded.pricing_status = 'unpriced'
      THEN usage_records.cost_usd ELSE excluded.cost_usd END,
    timestamp = excluded.timestamp,
    source_file = excluded.source_file,
    pricing_status = CASE WHEN excluded.pricing_status = 'unpriced'
      THEN usage_records.pricing_status ELSE excluded.pricing_status END,
    pricing_rule_id = CASE WHEN excluded.pricing_status = 'unpriced'
      THEN usage_records.pricing_rule_id ELSE excluded.pricing_rule_id END,
    pricing_source = CASE WHEN excluded.pricing_status = 'unpriced'
      THEN usage_records.pricing_source ELSE excluded.pricing_source END,
    attribution_version = CASE
      WHEN excluded.attribution_status = 'captured' THEN excluded.attribution_version
      WHEN usage_records.attribution_status = 'captured' OR excluded.attribution_status IS NULL
        THEN usage_records.attribution_version
      ELSE excluded.attribution_version END,
    attribution_status = CASE
      WHEN excluded.attribution_status = 'captured' THEN 'captured'
      WHEN usage_records.attribution_status = 'captured' OR excluded.attribution_status IS NULL
        THEN usage_records.attribution_status
      ELSE excluded.attribution_status END,
    project_id = CASE WHEN excluded.attribution_status = 'captured'
      THEN COALESCE(excluded.project_id, usage_records.project_id)
      ELSE usage_records.project_id END,
    session_id = CASE WHEN excluded.attribution_status = 'captured'
      THEN COALESCE(excluded.session_id, usage_records.session_id)
      ELSE usage_records.session_id END
  WHERE usage_records.provider IS NOT excluded.provider
     OR usage_records.model IS NOT excluded.model
     OR usage_records.request_count IS NOT excluded.request_count
     OR usage_records.input_tokens IS NOT excluded.input_tokens
     OR usage_records.output_tokens IS NOT excluded.output_tokens
     OR usage_records.cache_read_tokens IS NOT excluded.cache_read_tokens
     OR usage_records.cache_creation_tokens IS NOT excluded.cache_creation_tokens
     OR usage_records.reasoning_tokens IS NOT excluded.reasoning_tokens
     OR usage_records.input_includes_cache_read IS NOT excluded.input_includes_cache_read
     OR usage_records.input_includes_cache_creation IS NOT excluded.input_includes_cache_creation
     OR usage_records.output_includes_reasoning IS NOT excluded.output_includes_reasoning
     OR (excluded.pricing_status != 'unpriced' AND usage_records.cost_usd IS NOT excluded.cost_usd)
     OR (excluded.pricing_status != 'unpriced' AND usage_records.pricing_status IS NOT excluded.pricing_status)
     OR (excluded.pricing_status != 'unpriced'
       AND usage_records.pricing_rule_id IS NOT excluded.pricing_rule_id)
     OR (excluded.pricing_status != 'unpriced'
       AND usage_records.pricing_source IS NOT excluded.pricing_source)
     OR usage_records.timestamp IS NOT excluded.timestamp
     OR usage_records.source_file IS NOT excluded.source_file
     OR (excluded.attribution_status = 'captured' AND (
       usage_records.attribution_status IS NOT 'captured'
       OR usage_records.attribution_version IS NOT excluded.attribution_version
       OR (excluded.project_id IS NOT NULL
         AND usage_records.project_id IS NOT excluded.project_id)
       OR (excluded.session_id IS NOT NULL
         AND usage_records.session_id IS NOT excluded.session_id)
     ))
     OR (usage_records.attribution_status IS NOT 'captured'
       AND excluded.attribution_status IS NOT NULL
       AND usage_records.attribution_status IS NOT excluded.attribution_status)
`

function existingOwners(
  db: DB,
  records: DecodedUsageRecord[],
): Map<string, string> {
  if (records.length === 0) return new Map()
  const placeholders = records.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT dedup_key, device_id FROM usage_records
    WHERE dedup_key IN (${placeholders})
  `).all(...records.map(record => record.dedup_key)) as Array<{
    dedup_key: string
    device_id: string
  }>
  return new Map(rows.map(row => [row.dedup_key, row.device_id]))
}

function assertDeviceExists(db: DB, deviceId: string): void {
  const device = db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId)
  if (!device) {
    throw new IngestRequestError({
      code: 'device_not_found', status: 404, message: 'device not found',
      field: 'device_id',
    })
  }
}

function assertDedupOwnership(
  records: DecodedUsageRecord[],
  owners: Map<string, string>,
  deviceId: string,
): void {
  const conflictIndex = records.findIndex(record => {
    const owner = owners.get(record.dedup_key)
    return owner != null && owner !== deviceId
  })
  if (conflictIndex >= 0) {
    throw new IngestRequestError({
      code: 'dedup_device_conflict', status: 409,
      message: 'dedup key belongs to another device',
      recordIndex: conflictIndex, field: 'dedup_key',
    })
  }
}

function createUsageWriter(db: DB, deviceId: string) {
  const insert = db.prepare(USAGE_UPSERT_SQL)
  return (record: DecodedUsageRecord): boolean => {
    const model = resolveModelName(db, record.provider, record.model)
    const pricing = resolvePricing(db, { ...record, model })
    const result = insert.run({
      device_id: deviceId,
      provider: record.provider,
      model,
      request_count: record.request_count,
      input_tokens: record.input_tokens,
      output_tokens: record.output_tokens,
      cache_read_tokens: record.cache_read_tokens,
      cache_creation_tokens: record.cache_creation_tokens,
      reasoning_tokens: record.reasoning_tokens,
      input_includes_cache_read: Number(record.input_includes_cache_read),
      input_includes_cache_creation: Number(record.input_includes_cache_creation),
      output_includes_reasoning: Number(record.output_includes_reasoning),
      cost_usd: pricing.cost_usd,
      timestamp: record.timestamp,
      source_file: record.source_file,
      dedup_key: record.dedup_key,
      pricing_status: pricing.pricing_status,
      pricing_rule_id: pricing.pricing_rule_id,
      pricing_source: pricing.pricing_source,
      attribution_version: record.attribution_version,
      attribution_status: record.attribution_status,
      project_id: record.project_id,
      session_id: record.session_id,
    })
    return result.changes > 0
  }
}

function writeBatch(db: DB, batch: DecodedIngestBatch): IngestResult {
  assertDeviceExists(db, batch.device_id)
  const owners = existingOwners(db, batch.records)
  assertDedupOwnership(batch.records, owners, batch.device_id)
  const write = createUsageWriter(db, batch.device_id)
  let created = 0
  let updated = 0
  let unchanged = 0
  for (const record of batch.records) {
    const changed = write(record)
    if (!changed) unchanged++
    else if (owners.has(record.dedup_key)) updated++
    else created++
  }
  const projects = new Map<string, string>()
  for (const record of batch.records) {
    if (record.attribution_status === 'captured' && record.project_id) {
      const key = `${batch.device_id}\0${record.project_id}`
      const current = projects.get(key)
      if (current == null || current < record.timestamp) projects.set(key, record.timestamp)
    }
  }
  for (const [key, seenAt] of projects) {
    const projectId = key.slice(key.indexOf('\0') + 1)
    ensureProjectMembership(db, batch.device_id, projectId, seenAt)
  }
  return {
    created,
    updated,
    unchanged,
    total: batch.records.length,
    inserted: created + updated,
  }
}

export function ingestUsageBatch(db: DB, batch: DecodedIngestBatch): IngestResult {
  return db.transaction(() => writeBatch(db, batch))()
}
