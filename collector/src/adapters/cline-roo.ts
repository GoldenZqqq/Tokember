// Cline / Roo Code adapter — reads VS Code extension task logs.
//
// Both extensions share the same on-disk layout (Roo Code is a Cline fork):
//   <globalStorage>/<extensionId>/tasks/<taskId>/ui_messages.json
// Each `api_req_started` message carries a JSON `text` blob with tokensIn,
// tokensOut, cacheReads, cacheWrites, and — unlike Claude/Codex — a real
// `cost`. So we report cost_provided:true and let the server trust it.
//
// Parsing logic adapted from codeburn (MIT, getagentseal/codeburn):
// src/providers/vscode-cline-parser.ts.

import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { IncrementalCursor } from '../incremental-cursor.js'
import { discoverIncrementalFiles } from './incremental-discovery.js'
import {
  commitIncrementalFile,
  prepareIncrementalFile,
  retryIncrementalFile,
  statFileSignature,
} from './incremental-file.js'
import { type CollectionObserver, type UsageRecord } from './types.js'

interface UiMessage {
  type?: string
  say?: string
  text?: string
  ts?: number
}

interface ApiRequest {
  tokensIn?: number
  tokensOut?: number
  cacheReads?: number
  cacheWrites?: number
  cost?: number
}

// VS Code (and its forks) keep per-user extension data under globalStorage.
// We scan stable + Insiders + VSCodium so a user on any build is covered.
function globalStorageDirs(extensionId: string): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support')
    return [
      join(base, 'Code', 'User', 'globalStorage', extensionId),
      join(base, 'Code - Insiders', 'User', 'globalStorage', extensionId),
      join(base, 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }
  if (process.platform === 'win32') {
    const base = join(home, 'AppData', 'Roaming')
    return [
      join(base, 'Code', 'User', 'globalStorage', extensionId),
      join(base, 'Code - Insiders', 'User', 'globalStorage', extensionId),
      join(base, 'VSCodium', 'User', 'globalStorage', extensionId),
    ]
  }
  const base = join(home, '.config')
  return [
    join(base, 'Code', 'User', 'globalStorage', extensionId),
    join(base, 'Code - Insiders', 'User', 'globalStorage', extensionId),
    join(base, 'VSCodium', 'User', 'globalStorage', extensionId),
  ]
}

const MODEL_TAG_RE = /<model>([^<]+)<\/model>/

// The model name isn't on the api_req_started event; it's embedded in the
// conversation history's user turns as a <model>...</model> tag. Read it once
// per task so every call in that task is priced against the right model.
async function readTaskModel(
  taskDir: string,
  historyExists: boolean,
): Promise<{ model: string; valid: boolean }> {
  const fallback = 'cline-auto'
  if (!historyExists) return { model: fallback, valid: true }
  try {
    const raw = await readFile(join(taskDir, 'api_conversation_history.json'), 'utf-8')
    const msgs = JSON.parse(raw) as Array<{ role?: string; content?: Array<{ text?: string }> }>
    if (!Array.isArray(msgs)) return { model: fallback, valid: false }
    for (const msg of msgs) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (typeof block.text !== 'string') continue
        const m = MODEL_TAG_RE.exec(block.text)
        if (m) return {
          model: m[1].includes('/') ? m[1].split('/').pop()! : m[1],
          valid: true,
        }
      }
    }
  } catch {
    return { model: fallback, valid: false }
  }
  return { model: fallback, valid: true }
}

function recordsFromMessages(
  options: {
    messages: UiMessage[]
    provider: string
    taskId: string
    model: string
  },
): UsageRecord[] {
  const records: UsageRecord[] = []
  const requests = options.messages.filter(message => (
    message.type === 'say' && message.say === 'api_req_started'
  ))
  for (const [index, entry] of requests.entries()) {
    if (!entry.text) continue
    let parsed: ApiRequest
    try {
      parsed = JSON.parse(entry.text) as ApiRequest
    } catch {
      continue
    }
    const input = parsed.tokensIn ?? 0
    const output = parsed.tokensOut ?? 0
    if (input === 0 && output === 0) continue
    const timestamp = entry.ts ? new Date(entry.ts) : null
    if (!timestamp || !Number.isFinite(timestamp.getTime())) continue
    records.push({
      provider: options.provider, model: options.model,
      input_tokens: input, output_tokens: output,
      cache_read_tokens: parsed.cacheReads ?? 0,
      cache_creation_tokens: parsed.cacheWrites ?? 0,
      reasoning_tokens: 0, cost_usd: parsed.cost ?? 0,
      cost_provided: typeof parsed.cost === 'number',
      timestamp: timestamp.toISOString(),
      source_file: `${options.provider}:${options.taskId}`,
      dedup_key: `${options.provider}:${options.taskId}:${index}`,
      attribution: { status: 'captured', session: options.taskId },
    })
  }
  return records
}

async function collectTask(options: {
  uiPath: string
  taskId: string
  provider: string
  observer?: CollectionObserver
  incremental?: IncrementalCursor
  reconciling: boolean
}): Promise<UsageRecord[]> {
  const taskDir = dirname(options.uiPath)
  const history = await statFileSignature(join(taskDir, 'api_conversation_history.json'))
  const candidate = await prepareIncrementalFile(options.uiPath, options.incremental, {
    reconciling: options.reconciling,
    fingerprint: {
      model_mtime_ms: history?.mtime_ms ?? null,
      model_size_bytes: history?.size_bytes ?? null,
    },
  })
  if (candidate.kind !== 'read' || !candidate.signature) return []
  options.observer?.scan(new Date(candidate.signature.mtime_ms).toISOString())
  let messages: unknown
  try {
    messages = JSON.parse(await readFile(options.uiPath, 'utf-8'))
  } catch {
    retryIncrementalFile(options.incremental, candidate)
    return []
  }
  const taskModel = await readTaskModel(taskDir, history != null)
  if (!Array.isArray(messages) || !taskModel.valid) {
    retryIncrementalFile(options.incremental, candidate)
    return []
  }
  const records = recordsFromMessages({
    messages: messages as UiMessage[], provider: options.provider,
    taskId: options.taskId, model: taskModel.model,
  })
  commitIncrementalFile(options.incremental, candidate)
  return records
}

export async function collectExtension(
  options: {
    extensionId: string
    provider: string
    observer?: CollectionObserver
    incremental?: IncrementalCursor
    storageDirs?: string[]
  },
): Promise<UsageRecord[]> {
  const records: UsageRecord[] = []
  const seenTasks = new Set<string>()
  const storageDirs = options.storageDirs ?? globalStorageDirs(options.extensionId)
  const roots = storageDirs.map(directory => join(directory, 'tasks'))
  const discovery = await discoverIncrementalFiles({
    roots, cursor: options.incremental, matches: name => name === 'ui_messages.json',
  })
  options.observer?.discover(discovery.paths.length)
  for (const uiPath of discovery.paths) {
    const taskId = basename(dirname(uiPath))
    if (seenTasks.has(taskId)) continue
    seenTasks.add(taskId)
    records.push(...await collectTask({
      uiPath, taskId, provider: options.provider,
      observer: options.observer, incremental: options.incremental,
      reconciling: discovery.reconciling,
    }))
  }
  if (discovery.reconciliation_started_at) {
    options.incremental?.finishReconciliation(discovery.reconciliation_started_at)
  }
  return records
}

export async function collectCline(
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  return collectExtension({
    extensionId: 'saoudrizwan.claude-dev', provider: 'cline', observer, incremental,
  })
}

export async function collectRooCode(
  observer?: CollectionObserver,
  incremental?: IncrementalCursor,
): Promise<UsageRecord[]> {
  return collectExtension({
    extensionId: 'rooveterinaryinc.roo-cline', provider: 'roo-code', observer, incremental,
  })
}
