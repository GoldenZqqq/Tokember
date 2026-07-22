import { createHash } from 'crypto'
import { stat } from 'fs/promises'
import { resolve } from 'path'

import type { CursorScalar, IncrementalFileCursor } from '../collector-state.js'
import { IncrementalCursor, type FileSignature } from '../incremental-cursor.js'
import { readJsonlTail, type JsonlTailResult } from './jsonl-tail.js'

interface JsonlBaseResult {
  key: string
  path: string
  signature: FileSignature | null
}

export type IncrementalJsonlResult =
  | (JsonlBaseResult & { kind: 'missing' | 'unchanged' | 'cold' | 'bootstrap' })
  | (JsonlBaseResult & {
    kind: 'read'
    start_offset_bytes: number
    previous_metadata: Record<string, CursorScalar>
    tail: JsonlTailResult
  })

interface JsonlPlanOptions {
  reconciling?: boolean
  required_metadata?: readonly string[]
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function incrementalFileKey(path: string): string {
  return createHash('sha256').update(canonicalPath(path)).digest('hex')
}

async function signature(path: string): Promise<FileSignature | null> {
  const value = await stat(path).catch(() => null)
  return value?.isFile()
    ? { mtime_ms: value.mtimeMs, size_bytes: value.size }
    : null
}

function bootstrapCursor(
  options: {
    cursor: IncrementalCursor
    key: string
    path: string
    value: FileSignature
  },
): void {
  options.cursor.stageFile(options.key, {
    path: options.path,
    ...options.value,
    offset_bytes: options.value.size_bytes,
    metadata: { bootstrap_skipped: true },
  })
}

export async function prepareIncrementalJsonl(
  path: string,
  cursor?: IncrementalCursor,
  options: JsonlPlanOptions = {},
): Promise<IncrementalJsonlResult> {
  const key = incrementalFileKey(path)
  const value = await signature(path)
  const base = { key, path, signature: value }
  if (!value) {
    cursor?.removeFile(key)
    return { ...base, kind: 'missing' }
  }
  if (!cursor) {
    return {
      ...base, kind: 'read', start_offset_bytes: 0,
      previous_metadata: {}, tail: await readJsonlTail(path),
    }
  }
  const previous = cursor.knownFile(key)
  if (!previous && cursor.shouldBootstrapAtEnd(value.mtime_ms)) {
    bootstrapCursor({ cursor, key, path, value })
    return { ...base, kind: 'bootstrap' }
  }
  if (!previous && options.reconciling && !cursor.coldFileNeedsScan(value.mtime_ms)) {
    return { ...base, kind: 'cold' }
  }
  const plan = cursor.filePlan(key, value, options.required_metadata)
  if (plan === 'unchanged') return { ...base, kind: 'unchanged' }
  const startOffset = plan === 'append' ? previous!.offset_bytes : 0
  return {
    ...base,
    kind: 'read',
    start_offset_bytes: startOffset,
    previous_metadata: plan === 'append' ? { ...previous!.metadata } : {},
    tail: await readJsonlTail(path, startOffset),
  }
}

export function commitIncrementalJsonl(
  cursor: IncrementalCursor | undefined,
  result: Extract<IncrementalJsonlResult, { kind: 'read' }>,
  metadata: Record<string, CursorScalar> = result.previous_metadata,
): IncrementalFileCursor | null {
  if (!cursor || !result.signature) return null
  const value: IncrementalFileCursor = {
    path: result.path,
    ...result.signature,
    offset_bytes: result.tail.safe_offset_bytes,
    metadata: { ...metadata },
  }
  cursor.stageFile(result.key, value)
  return value
}
