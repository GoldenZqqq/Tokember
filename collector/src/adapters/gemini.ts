// Gemini CLI adapter — reads native local session logs.
//
// Source: ~/.gemini/tmp/<projectHash>/chats/session-*.{json,jsonl}
// Gemini CLI <=0.38 wrote one JSON object per file; >=0.39 writes JSONL (one
// object per line: a session header line, then one line per message).
//
// A 'gemini' message carries tokens.{input,output,cached,thoughts} and model.
// NOTE: Gemini's `input` count INCLUDES `cached` as a subset. We report the
// raw input (cache included) and let the server subtract cache_read — the
// server's freshInput()/real_total_tokens both assume gemini input contains
// cache. Do NOT pre-subtract here or cache would be removed twice.

import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'

import { IncrementalCursor } from '../incremental-cursor.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import {
  commitIncrementalFile,
  prepareIncrementalFile,
  retryIncrementalFile,
} from './incremental-file.js'
import { type CollectionObserver, type UsageRecord } from './types.js'

interface GeminiTokens {
  input?: number
  output?: number
  cached?: number
  thoughts?: number
}

interface GeminiMessage {
  id?: string
  timestamp?: string
  type?: string
  tokens?: GeminiTokens
  model?: string
}

interface GeminiSession {
  sessionId?: string
  startTime?: string
  messages?: GeminiMessage[]
}

function tmpDir(): string {
  return join(homedir(), '.gemini', 'tmp')
}

// Parse a JSONL session file into {sessionId, messages}. The first line with
// sessionId+startTime is the header; lines with id+type are messages. Lines
// carrying a `$set` key are meta updates and are skipped.
function parseJsonl(raw: string): GeminiSession | null {
  let sessionId = ''
  let startTime = ''
  const messages: GeminiMessage[] = []

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj['$set'] !== undefined) continue
    if (obj['sessionId'] && obj['startTime'] && !sessionId) {
      sessionId = String(obj['sessionId'])
      startTime = String(obj['startTime'])
    } else if (obj['id'] && obj['type']) {
      messages.push(obj as GeminiMessage)
    }
  }

  if (!sessionId) return null
  return { sessionId, startTime, messages }
}

function parseSessionFile(raw: string): GeminiSession | null {
  // Try single JSON first (old format), then fall back to JSONL.
  try {
    const parsed = JSON.parse(raw) as GeminiSession
    if (parsed.messages && parsed.sessionId) return parsed
  } catch {
    // not single JSON
  }
  return parseJsonl(raw)
}

function toRecords(session: GeminiSession, sourceFile: string): UsageRecord[] {
  const records: UsageRecord[] = []
  const sessionId = session.sessionId ?? ''
  const projectHash = basename(dirname(dirname(sourceFile)))
  let ordinal = 0

  for (const msg of session.messages ?? []) {
    if (msg.type !== 'gemini' || !msg.tokens || !msg.model) continue

    const t = msg.tokens
    const input = t.input ?? 0
    const output = t.output ?? 0
    const cached = t.cached ?? 0
    const thoughts = t.thoughts ?? 0
    if (input === 0 && output === 0 && cached === 0 && thoughts === 0) continue

    const messageKey = msg.id || `idx-${ordinal}`
    ordinal++

    const ts = new Date(msg.timestamp || session.startTime || 0)
    if (isNaN(ts.getTime()) || ts.getTime() < 1_000_000_000_000) continue

    records.push({
      provider: 'gemini',
      model: msg.model,
      // Raw input (cache included) — server subtracts cache_read for gemini.
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cached,
      cache_creation_tokens: 0,
      // Gemini bills "thoughts" at the output rate. Report them as reasoning
      // tokens; server pricing folds reasoning into output for gemini/codex.
      reasoning_tokens: thoughts,
      cost_usd: 0,
      timestamp: ts.toISOString(),
      source_file: 'gemini',
      dedup_key: `gemini:${sessionId}:${messageKey}`,
      attribution: {
        status: 'captured',
        ...(projectHash && projectHash !== 'tmp'
          ? { project: { kind: 'opaque' as const, value: projectHash } }
          : {}),
        session: sessionId,
      },
    })
  }

  return records
}

export async function collectGemini(
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  const base = process.env.GEMINI_TMP_DIR ?? tmpDir()
  const discovery = await discoverIncrementalFiles({
    roots: [base], cursor: incremental,
    matches: name => name.startsWith('session-')
      && (name.endsWith('.json') || name.endsWith('.jsonl')),
  })
  observer?.discover(discovery.paths.length)
  const records: UsageRecord[] = []
  for (const filePath of discovery.paths) {
    const candidate = await prepareIncrementalFile(filePath, incremental, {
      reconciling: discovery.reconciling,
    })
    if (candidate.kind !== 'read' || !candidate.signature) continue
    const timestamp = new Date(candidate.signature.mtime_ms).toISOString()
    observer?.scan(timestamp)
    let raw: string
    try {
      raw = await readFile(filePath, 'utf-8')
    } catch {
      retryIncrementalFile(incremental, candidate)
      continue
    }
    const session = parseSessionFile(raw)
    if (!session) {
      retryIncrementalFile(incremental, candidate)
      continue
    }
    records.push(...toRecords(session, filePath))
    commitIncrementalFile(incremental, candidate)
  }
  if (discovery.reconciliation_started_at) {
    incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }
  return records
}
