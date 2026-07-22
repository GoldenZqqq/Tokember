import type { AuditAdminRecord } from '@tokember/contracts/audit'
import type { Context, Hono } from 'hono'
import { stream } from 'hono/streaming'
import type { DB } from './db.js'
import {
  AuditRequestError,
  getAuditCutoverEvents,
  getAuditExport,
  getAuditReconciliation,
  getAuditRecords,
  getAuditSummary,
} from './audit.js'

type ExportFormat = 'csv' | 'json'

const CSV_COLUMNS = [
  'id', 'timestamp', 'device_id', 'device_name', 'provider', 'model',
  'request_count', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_creation_tokens', 'reasoning_tokens', 'fresh_input_tokens',
  'billable_output_tokens', 'real_total_tokens', 'cost_usd', 'pricing_status',
  'source_file', 'dedup_key', 'pricing_rule_id', 'pricing_source',
  'attribution_version', 'attribution_status', 'project_id', 'session_id',
  'project_group_id', 'project_name',
  'is_authoritative', 'pricing_explanation_status', 'recomputed_cost_usd',
] as const

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof AuditRequestError) return c.json(error.toResponse(), 400)
  console.error('[audit] read failed', error instanceof Error ? error.name : 'unknown')
  return c.json({ error: 'audit read failed', code: 'audit_read_failed' }, 500)
}

function safeSourceMarker(value: string | null): string | null {
  if (!value) return value
  if (/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/)/i.test(value)) return '[redacted-local-path]'
  return value
}

function safeExportRecord(row: AuditAdminRecord): AuditAdminRecord {
  return { ...row, source_file: safeSourceMarker(row.source_file) }
}

function exportValue(row: AuditAdminRecord, column: typeof CSV_COLUMNS[number]): unknown {
  if (column === 'pricing_explanation_status') return row.pricing_explanation.status
  if (column === 'recomputed_cost_usd') return row.pricing_explanation.recomputed_cost_usd
  return row[column as keyof AuditAdminRecord]
}

function csvCell(value: unknown): string {
  if (value == null) return '""'
  let text = typeof value === 'boolean' ? String(value) : String(value)
  text = text.replace(/\r\n?/g, '\n')
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function csvRow(row: AuditAdminRecord): string {
  return `${CSV_COLUMNS.map(column => csvCell(exportValue(row, column))).join(',')}\r\n`
}

function queryWithoutFormat(c: Context): Record<string, string> {
  const query = { ...c.req.query() }
  delete query.format
  return query
}

function parseFormat(value: string | undefined): ExportFormat {
  if (value === 'json' || value == null || value === '') return 'json'
  if (value === 'csv') return 'csv'
  throw new AuditRequestError('format')
}

function exportHeaders(c: Context, format: ExportFormat): void {
  const extension = format === 'csv' ? 'csv' : 'json'
  c.header('Content-Type', format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/json; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="tokember-audit-${Date.now()}.${extension}"`)
  c.header('Cache-Control', 'no-store')
}

function streamAuditExport(c: Context, db: DB): Response {
  const format = parseFormat(c.req.query('format'))
  const result = getAuditExport(db, queryWithoutFormat(c))
  exportHeaders(c, format)
  return stream(c, async output => {
    if (format === 'csv') {
      await output.write(`${CSV_COLUMNS.join(',')}\r\n`)
      for (const row of result.rows) await output.write(csvRow(safeExportRecord(row)))
      return
    }
    await output.write('[')
    let first = true
    for (const row of result.rows) {
      await output.write(`${first ? '' : ','}${JSON.stringify(safeExportRecord(row))}`)
      first = false
    }
    await output.write(']')
  })
}

export function registerAuditRoutes(admin: Hono, db: DB): void {
  admin.get('/audit/records', c => {
    try { return c.json(getAuditRecords(db, c.req.query(), true)) }
    catch (error) { return errorResponse(c, error) }
  })
  admin.get('/audit/summary', c => {
    try { return c.json(getAuditSummary(db, c.req.query())) }
    catch (error) { return errorResponse(c, error) }
  })
  admin.get('/audit/reconciliation', c => {
    try { return c.json(getAuditReconciliation(db, c.req.query())) }
    catch (error) { return errorResponse(c, error) }
  })
  admin.get('/audit/cutover-events', c => {
    try { return c.json(getAuditCutoverEvents(db, c.req.query())) }
    catch (error) { return errorResponse(c, error) }
  })
  admin.get('/audit/export', c => {
    try { return streamAuditExport(c, db) }
    catch (error) { return errorResponse(c, error) }
  })
}
