// OpenClaw gateway adapter.
//
// State root: $OPENCLAW_STATE_DIR or ~/.openclaw (plus legacy product renames).
//
// Current runtime (preferred):
//   agents/<agentId>/agent/openclaw-agent.sqlite
//   tables: transcript_events(session_id, seq, event_json, created_at)
//           transcript_event_identities(session_id, event_id, seq, ...)
//
// Legacy / archive:
//   agents/<agentId>/sessions/sessions.json + *.jsonl
//
// Only assistant message.usage is billed. Prompt/response text is never kept.

import { readdir, readFile, stat } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'

import { IncrementalCursor, type FileSignature } from '../incremental-cursor.js'
import { openReadOnly, type DatabaseHandle } from './sqlite-util.js'
import { commitIncrementalJsonl, incrementalFileKey, prepareIncrementalJsonl } from './incremental-jsonl.js'
import {
  isInCollectionWindow,
  type Adapter,
  type CollectionObserver,
  type CollectionWindow,
  type UsageRecord,
} from './types.js'

const LEGACY_STATE_NAMES = ['.openclaw', '.clawdbot', '.moltbot', '.moldbot'] as const

interface OpenClawUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  input_tokens?: number
  output_tokens?: number
  cache_read?: number
  cache_write?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoningTokens?: number
  reasoning_tokens?: number
  cost?: { total?: number }
}

interface OpenClawMessage {
  role?: string
  model?: string
  provider?: string
  usage?: OpenClawUsage
  content?: unknown
}

interface OpenClawEvent {
  type?: string
  id?: string
  timestamp?: string | number
  customType?: string
  modelId?: string
  data?: { modelId?: string; provider?: string }
  message?: OpenClawMessage
  sessionId?: string
}

interface SessionIndexEntry {
  sessionId?: string
  sessionFile?: string
}

type SessionIndex = Record<string, SessionIndexEntry>

interface SqliteEventRow {
  session_id: string
  seq: number
  event_id: string | null
  event_json: string
  created_at: number
}

function stateRoots(): string[] {
  const override = process.env.OPENCLAW_STATE_DIR?.trim()
  if (override) return [override]
  const home = homedir()
  return LEGACY_STATE_NAMES.map(name => join(home, name))
}

function agentsDir(root: string): string {
  return join(root, 'agents')
}

function toIsoTimestamp(value: string | number | undefined, fallback: string): string {
  if (value == null) return fallback
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }
  const raw = String(value).trim()
  if (!raw) return fallback
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(raw)) {
    return toIsoTimestamp(asNumber, fallback)
  }
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
}

function readUsage(usage: OpenClawUsage): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
} {
  const input = usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0
  const output = usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0
  const cacheRead = usage.cacheRead
    ?? usage.cache_read
    ?? usage.cache_read_input_tokens
    ?? 0
  const cacheWrite = usage.cacheWrite
    ?? usage.cache_write
    ?? usage.cache_creation_input_tokens
    ?? 0
  const reasoning = usage.reasoningTokens ?? usage.reasoning_tokens ?? 0
  const cost = typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)
    ? usage.cost.total
    : 0
  return { input, output, cacheRead, cacheWrite, reasoning, cost }
}

function recordFromUsage(options: {
  sessionId: string
  eventId: string
  model: string
  usage: OpenClawUsage
  timestamp: string
}): UsageRecord | null {
  const tokens = readUsage(options.usage)
  if (
    tokens.input === 0 && tokens.output === 0
    && tokens.cacheRead === 0 && tokens.cacheWrite === 0
    && tokens.reasoning === 0
  ) {
    return null
  }
  const dedupKey = `openclaw:${options.sessionId}:${options.eventId}`
  return {
    provider: 'openclaw',
    model: options.model || 'openclaw-auto',
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    cache_read_tokens: tokens.cacheRead,
    cache_creation_tokens: tokens.cacheWrite,
    reasoning_tokens: tokens.reasoning,
    cost_usd: tokens.cost > 0 ? tokens.cost : 0,
    ...(tokens.cost > 0 ? { cost_provided: true as const } : {}),
    timestamp: options.timestamp,
    source_file: 'openclaw',
    dedup_key: dedupKey,
    attribution: { status: 'captured', session: options.sessionId },
  }
}

function parseJsonlLines(options: {
  filePath: string
  lines: string[]
  byId: Map<string, UsageRecord>
  fallbackTimestamp: string
  window?: CollectionWindow
}): void {
  let sessionId = basename(options.filePath, '.jsonl')
  let currentModel = ''
  for (const [lineIndex, line] of options.lines.entries()) {
    let entry: OpenClawEvent
    try {
      entry = JSON.parse(line) as OpenClawEvent
    } catch {
      continue
    }
    if (entry.type === 'session') {
      sessionId = entry.id ?? entry.sessionId ?? sessionId
      continue
    }
    if (entry.type === 'model_change' && entry.modelId) {
      currentModel = entry.modelId
      continue
    }
    if (entry.type === 'custom' && entry.customType === 'model-snapshot') {
      currentModel = entry.data?.modelId ?? currentModel
      continue
    }
    if (entry.type !== 'message' || !entry.message) continue
    const msg = entry.message
    if (msg.role !== 'assistant' || !msg.usage) continue
    const timestamp = toIsoTimestamp(entry.timestamp, options.fallbackTimestamp)
    if (!isInCollectionWindow(timestamp, options.window)) continue
    const eventId = entry.id || `${lineIndex}`
    const record = recordFromUsage({
      sessionId,
      eventId,
      model: msg.model ?? currentModel,
      usage: msg.usage,
      timestamp,
    })
    // Do not overwrite records already loaded from SQLite (same dedup key).
    if (record && !options.byId.has(record.dedup_key)) {
      options.byId.set(record.dedup_key, record)
    }
  }
}

async function discoverLegacyJsonlFiles(agentsRoot: string): Promise<string[]> {
  const files = new Set<string>()
  const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
  for (const agent of agents) {
    if (!agent.isDirectory()) continue
    const sessionsDir = join(agentsRoot, agent.name, 'sessions')
    let index: SessionIndex = {}
    try {
      index = JSON.parse(await readFile(join(sessionsDir, 'sessions.json'), 'utf8')) as SessionIndex
    } catch {
      index = {}
    }
    for (const entry of Object.values(index)) {
      if (entry.sessionFile) files.add(entry.sessionFile)
      else if (entry.sessionId) files.add(join(sessionsDir, `${entry.sessionId}.jsonl`))
    }
    const listed = await readdir(sessionsDir).catch(() => [])
    for (const name of listed) {
      if (name.endsWith('.jsonl')) files.add(join(sessionsDir, name))
    }
  }
  return [...files]
}

async function collectLegacyJsonl(
  roots: string[],
  byId: Map<string, UsageRecord>,
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
  window?: CollectionWindow,
): Promise<void> {
  const files: string[] = []
  for (const root of roots) {
    files.push(...await discoverLegacyJsonlFiles(agentsDir(root)))
  }
  observer?.discover(files.length)
  for (const file of files) {
    const exists = await stat(file).then(value => value.isFile()).catch(() => false)
    if (!exists) continue
    const result = await prepareIncrementalJsonl(file, incremental)
    if (result.kind !== 'read' || !result.signature) continue
    const fallbackTimestamp = new Date(result.signature.mtime_ms).toISOString()
    observer?.scan(fallbackTimestamp)
    parseJsonlLines({
      filePath: file,
      lines: result.tail.lines,
      byId,
      fallbackTimestamp,
      window,
    })
    commitIncrementalJsonl(incremental, result)
  }
}

async function discoverSqlitePaths(roots: string[]): Promise<string[]> {
  const paths: string[] = []
  for (const root of roots) {
    const agentsRoot = agentsDir(root)
    const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => [])
    for (const agent of agents) {
      if (!agent.isDirectory()) continue
      const dbPath = join(agentsRoot, agent.name, 'agent', 'openclaw-agent.sqlite')
      const ok = await stat(dbPath).then(value => value.isFile()).catch(() => false)
      if (ok) paths.push(dbPath)
    }
  }
  return paths
}

async function fileSignature(path: string): Promise<FileSignature | null> {
  const value = await stat(path).catch(() => null)
  return value?.isFile()
    ? { mtime_ms: value.mtimeMs, size_bytes: value.size }
    : null
}

async function combinedDbSignature(dbPath: string): Promise<FileSignature | null> {
  const main = await fileSignature(dbPath)
  if (!main) return null
  const wal = await fileSignature(`${dbPath}-wal`)
  if (!wal) return main
  return {
    mtime_ms: Math.max(main.mtime_ms, wal.mtime_ms),
    size_bytes: main.size_bytes + wal.size_bytes,
  }
}

function schemaReady(db: DatabaseHandle): boolean {
  try {
    db.prepare(
      'SELECT session_id, seq, event_json, created_at FROM transcript_events LIMIT 0',
    ).get()
    db.prepare(
      'SELECT session_id, event_id, seq FROM transcript_event_identities LIMIT 0',
    ).get()
    return true
  } catch {
    return false
  }
}

function parseEventJson(raw: string): OpenClawEvent | null {
  try {
    return JSON.parse(raw) as OpenClawEvent
  } catch {
    return null
  }
}

function usageFromEvent(event: OpenClawEvent): {
  model: string
  usage: OpenClawUsage
  eventKey: string
} | null {
  if (event.type === 'message' && event.message?.role === 'assistant' && event.message.usage) {
    return {
      model: event.message.model ?? '',
      usage: event.message.usage,
      eventKey: event.id ?? '',
    }
  }
  // Some harnesses embed the same message shape without a top-level type.
  if (event.message?.role === 'assistant' && event.message.usage) {
    return {
      model: event.message.model ?? '',
      usage: event.message.usage,
      eventKey: event.id ?? '',
    }
  }
  return null
}

async function collectSqliteDb(options: {
  dbPath: string
  byId: Map<string, UsageRecord>
  observer?: CollectionObserver
  incremental?: IncrementalCursor
  window?: CollectionWindow
}): Promise<void> {
  const signature = await combinedDbSignature(options.dbPath)
  if (!signature) return
  const key = incrementalFileKey(options.dbPath)
  const previous = options.incremental?.knownFile(key)
  if (previous && options.incremental?.filePlan(key, signature) === 'unchanged') {
    return
  }

  options.observer?.discover(1)
  let handle: Awaited<ReturnType<typeof openReadOnly>>
  try {
    handle = await openReadOnly(options.dbPath)
  } catch {
    return
  }

  try {
    if (!schemaReady(handle.db)) {
      // Keep signature unconfirmed so a future schema migration is retried.
      return
    }
    // Per-session seq cannot be reduced to a single global watermark safely.
    // When the DB/WAL signature changes we rescan transcript_events and rely on
    // stable dedup_key; unchanged signatures short-circuit above.
    const rows = handle.db.prepare(`
      SELECT e.session_id AS session_id,
             e.seq AS seq,
             i.event_id AS event_id,
             e.event_json AS event_json,
             e.created_at AS created_at
      FROM transcript_events e
      LEFT JOIN transcript_event_identities i
        ON i.session_id = e.session_id AND i.seq = e.seq
      ORDER BY e.session_id ASC, e.seq ASC
    `).all() as unknown as SqliteEventRow[]

    options.observer?.scan(new Date(signature.mtime_ms).toISOString())
    for (const row of rows) {
      const event = parseEventJson(row.event_json)
      if (!event) continue
      const parsed = usageFromEvent(event)
      if (!parsed) continue
      const timestamp = toIsoTimestamp(
        event.timestamp,
        new Date(row.created_at < 1e12 ? row.created_at * 1000 : row.created_at).toISOString(),
      )
      if (!isInCollectionWindow(timestamp, options.window)) continue
      const eventId = row.event_id || parsed.eventKey || String(row.seq)
      const record = recordFromUsage({
        sessionId: row.session_id,
        eventId,
        model: parsed.model,
        usage: parsed.usage,
        timestamp,
      })
      if (!record) continue
      // Prefer SQLite identity when both paths see the same event.
      options.byId.set(record.dedup_key, record)
    }

    // Mirror Cursor/file adapters: offset_bytes == size_bytes means fully
    // confirmed for the current signature so filePlan can return unchanged.
    options.incremental?.stageFile(key, {
      path: resolve(options.dbPath),
      ...signature,
      offset_bytes: signature.size_bytes,
      metadata: { kind: 'openclaw-sqlite' },
    })
  } finally {
    await handle.cleanup()
  }
}

async function collectSqlite(
  roots: string[],
  byId: Map<string, UsageRecord>,
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
  window?: CollectionWindow,
): Promise<void> {
  const paths = await discoverSqlitePaths(roots)
  for (const dbPath of paths) {
    await collectSqliteDb({ dbPath, byId, observer, incremental, window })
  }
}

export const collectOpenClaw: Adapter = async (window, observer, incremental) => {
  const roots = stateRoots()
  const byId = new Map<string, UsageRecord>()
  // SQLite first so its dedup keys win over legacy JSONL archives.
  await collectSqlite(roots, byId, observer, incremental, window)
  await collectLegacyJsonl(roots, byId, observer, incremental, window)
  return [...byId.values()]
}

export function getOpenClawStateRoots(): string[] {
  return stateRoots()
}

export function openClawProbePaths(): string[] {
  const roots = stateRoots()
  const paths: string[] = []
  for (const root of roots) {
    paths.push(agentsDir(root))
  }
  return paths
}
