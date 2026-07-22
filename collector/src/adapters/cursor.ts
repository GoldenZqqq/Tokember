import { join } from 'path'
import { homedir } from 'os'

import { IncrementalCursor } from '../incremental-cursor.js'
import {
  commitIncrementalFile,
  prepareIncrementalFile,
  retryIncrementalFile,
  statFileSignature,
} from './incremental-file.js'
import { openReadOnly } from './sqlite-util.js'
import { type CollectionObserver, type UsageRecord } from './types.js'

// Cursor stores every chat "bubble" as a `bubbleId:<composerId>:<uuid>` row in
// User/globalStorage/state.vscdb (table cursorDiskKV). The JSON value carries
// tokenCount.{inputTokens,outputTokens} and modelInfo.modelName. Cost is not
// stored, so we report tokens only and let the server price them.
//
// Ported from codeburn (MIT, getagentseal/codeburn) src/providers/cursor.ts,
// trimmed to the token-extraction path we need.

export function getCursorDbPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  if (process.platform === 'win32') {
    return join(homedir(), 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  }
  return join(homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
}

// Rows carry epoch-millis in createdAt. Extract everything; the server dedups
// on dedup_key so a full scan every run is safe.
const BUBBLE_COLUMNS = `
  SELECT
    rowid AS row_id,
    key AS bubble_key,
    json_extract(value, '$.tokenCount.inputTokens') AS input_tokens,
    json_extract(value, '$.tokenCount.outputTokens') AS output_tokens,
    json_extract(value, '$.modelInfo.modelName') AS model,
    json_extract(value, '$.createdAt') AS created_at
  FROM cursorDiskKV
  WHERE key LIKE 'bubbleId:%'
`

const BUBBLE_QUERY = `${BUBBLE_COLUMNS} ORDER BY rowid`
const INCREMENTAL_BUBBLE_QUERY = `${BUBBLE_COLUMNS} AND rowid > ? ORDER BY rowid`
const BUBBLE_QUERY_NO_ROWID = BUBBLE_QUERY
  .replace('    rowid AS row_id,\n', '    NULL AS row_id,\n')
  .replace(' ORDER BY rowid', '')
const CURSOR_ROW_OVERLAP = 256

interface BubbleRow {
  row_id: number | null
  bubble_key: string
  input_tokens: number | null
  output_tokens: number | null
  model: string | null
  created_at: number | string | null
}

function rowTimestamp(value: number | string | null): string | null {
  if (value == null) return null
  const date = typeof value === 'number'
    ? new Date(value)
    : new Date(Number(value) || Date.parse(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function composerId(value: string): string | null {
  const match = /^bubbleId:([^:]+):/.exec(value)
  return match?.[1] || null
}

function recordFromBubble(row: BubbleRow): UsageRecord | null {
  const input = row.input_tokens ?? 0
  const output = row.output_tokens ?? 0
  if (input === 0 && output === 0) return null
  const timestamp = rowTimestamp(row.created_at)
  if (!timestamp) return null
  const model = row.model && row.model !== 'default' ? row.model : 'cursor-auto'
  const session = composerId(row.bubble_key)
  return {
    provider: 'cursor', model,
    input_tokens: input, output_tokens: output,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    reasoning_tokens: 0, cost_usd: 0, timestamp,
    source_file: 'cursor', dedup_key: `cursor:${row.bubble_key}`,
    attribution: session
      ? { status: 'captured', session }
      : { status: 'unsupported' },
  }
}

function queryBubbles(
  db: Awaited<ReturnType<typeof openReadOnly>>['db'],
  afterRowId: number | null,
): { rows: BubbleRow[]; rowidSupported: boolean } {
  try {
    const statement = afterRowId == null ? db.prepare(BUBBLE_QUERY) : db.prepare(INCREMENTAL_BUBBLE_QUERY)
    const rows = afterRowId == null ? statement.all() : statement.all(afterRowId)
    return { rows: rows as unknown as BubbleRow[], rowidSupported: true }
  } catch {
    try {
      return {
        rows: db.prepare(BUBBLE_QUERY_NO_ROWID).all() as unknown as BubbleRow[],
        rowidSupported: false,
      }
    } catch {
      return { rows: [], rowidSupported: false }
    }
  }
}

async function cursorFingerprint(dbPath: string) {
  const wal = await statFileSignature(`${dbPath}-wal`)
  return {
    wal_mtime_ms: wal?.mtime_ms ?? null,
    wal_size_bytes: wal?.size_bytes ?? null,
  }
}

export async function collectCursor(
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  const dbPath = process.env.CURSOR_DB ?? getCursorDbPath()
  const reconciling = incremental?.needsReconciliation() ?? false
  const reconciliationStartedAt = reconciling ? new Date() : null
  const candidate = await prepareIncrementalFile(dbPath, incremental, {
    fingerprint: await cursorFingerprint(dbPath),
  })
  if (candidate.kind !== 'read' || !candidate.signature) return []
  const records: UsageRecord[] = []
  let handle
  try {
    handle = await openReadOnly(dbPath)
  } catch {
    retryIncrementalFile(incremental, candidate)
    return records
  }

  try {
    const rowidSupported = incremental?.getValue('rowid_supported') !== false
    const previousRowId = incremental?.getValue('max_rowid')
    const canContinue = !reconciling && rowidSupported && typeof previousRowId === 'number'
    const afterRowId = canContinue
      ? Math.max(0, previousRowId - CURSOR_ROW_OVERLAP)
      : null
    const result = queryBubbles(handle.db, afterRowId)
    observer?.discover(result.rows.length)
    let maxRowId = typeof previousRowId === 'number' ? previousRowId : 0
    for (const row of result.rows) {
      observer?.scan()
      if (typeof row.row_id === 'number') maxRowId = Math.max(maxRowId, row.row_id)
      const record = recordFromBubble(row)
      if (!record) continue
      observer?.watermark(record.timestamp)
      records.push(record)
    }
    incremental?.setValue('rowid_supported', result.rowidSupported)
    if (result.rowidSupported) incremental?.setValue('max_rowid', maxRowId)
    if (reconciliationStartedAt) incremental?.finishReconciliation(reconciliationStartedAt)
    commitIncrementalFile(incremental, candidate)
  } finally {
    await handle.cleanup()
  }

  return records
}
