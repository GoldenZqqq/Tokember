import { stat } from 'fs/promises'

import type { CursorScalar, IncrementalFileCursor } from '../collector-state.js'
import { IncrementalCursor, type FileSignature } from '../incremental-cursor.js'
import { incrementalFileKey } from './incremental-jsonl.js'

interface IncrementalFileBase {
  key: string
  path: string
  signature: FileSignature | null
  fingerprint: Record<string, CursorScalar>
}

export type IncrementalFileResult = IncrementalFileBase & {
  kind: 'missing' | 'unchanged' | 'cold' | 'read'
}

interface IncrementalFileOptions {
  reconciling?: boolean
  fingerprint?: Record<string, CursorScalar>
}

export async function statFileSignature(path: string): Promise<FileSignature | null> {
  const value = await stat(path).catch(() => null)
  return value?.isFile()
    ? { mtime_ms: value.mtimeMs, size_bytes: value.size }
    : null
}

function sameFingerprint(
  previous: Record<string, CursorScalar>,
  current: Record<string, CursorScalar>,
): boolean {
  const entries = Object.entries(current)
  return entries.length === Object.keys(previous).length
    && entries.every(([key, value]) => previous[key] === value)
}

export async function prepareIncrementalFile(
  path: string,
  cursor?: IncrementalCursor,
  options: IncrementalFileOptions = {},
): Promise<IncrementalFileResult> {
  const key = incrementalFileKey(path)
  const signature = await statFileSignature(path)
  const fingerprint = options.fingerprint ?? {}
  const base = { key, path, signature, fingerprint }
  if (!signature) {
    cursor?.removeFile(key)
    return { ...base, kind: 'missing' }
  }
  if (!cursor) return { ...base, kind: 'read' }
  const previous = cursor.knownFile(key)
  if (!previous && options.reconciling && !cursor.coldFileNeedsScan(signature.mtime_ms)) {
    return { ...base, kind: 'cold' }
  }
  if (previous
    && previous.mtime_ms === signature.mtime_ms
    && previous.size_bytes === signature.size_bytes
    && sameFingerprint(previous.metadata, fingerprint)) {
    return { ...base, kind: 'unchanged' }
  }
  return { ...base, kind: 'read' }
}

export function commitIncrementalFile(
  cursor: IncrementalCursor | undefined,
  result: IncrementalFileResult,
): IncrementalFileCursor | null {
  if (!cursor || result.kind !== 'read' || !result.signature) return null
  const value: IncrementalFileCursor = {
    path: result.path,
    ...result.signature,
    offset_bytes: result.signature.size_bytes,
    metadata: { ...result.fingerprint },
  }
  cursor.stageFile(result.key, value)
  return value
}

export function retryIncrementalFile(
  cursor: IncrementalCursor | undefined,
  result: IncrementalFileResult,
): void {
  if (!cursor || result.kind !== 'read') return
  cursor.stageFile(result.key, {
    path: result.path,
    mtime_ms: 0,
    size_bytes: 0,
    offset_bytes: 0,
    metadata: { retry_pending: true },
  })
}
