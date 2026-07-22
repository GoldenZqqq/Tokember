import {
  CURSOR_KEY_LIMIT,
  CURSOR_METADATA_LIMIT,
  CURSOR_PATH_LIMIT,
  CURSOR_SCALAR_STRING_LIMIT,
  CURSOR_VALUE_LIMIT,
  HOT_DIRECTORY_LIMIT,
  HOT_FILE_LIMIT,
  RECONCILE_INTERVAL_MS,
  emptyIncrementalSourceState,
  type CursorScalar,
  type IncrementalDirectoryCursor,
  type IncrementalFileCursor,
  type IncrementalSourceState,
} from './collector-state.js'

export interface FileSignature {
  mtime_ms: number
  size_bytes: number
}

export type FileScanPlan = 'unchanged' | 'append' | 'replay'

function cloneMetadata(value: Record<string, CursorScalar>): Record<string, CursorScalar> {
  const entries = Object.entries(value)
  if (entries.length > CURSOR_METADATA_LIMIT) throw new Error('Incremental metadata is too large')
  return Object.fromEntries(entries.map(([key, item]) => {
    assertKey(key)
    assertScalar(item)
    return [key, item]
  }))
}

function cloneFile(value: IncrementalFileCursor): IncrementalFileCursor {
  return { ...value, metadata: cloneMetadata(value.metadata) }
}

function cloneDirectory(value: IncrementalDirectoryCursor): IncrementalDirectoryCursor {
  return { ...value }
}

function boundedOrder(order: string[], known: Record<string, unknown>, max: number): string[] {
  const result: string[] = []
  for (const key of order) {
    if (!(key in known) || result.includes(key)) continue
    result.push(key)
    if (result.length === max) break
  }
  return result
}

function touchBounded<T>(
  order: string[],
  values: Record<string, T>,
  options: { key: string; max: number },
): void {
  const existing = options.key in values
  if (existing) order.splice(order.indexOf(options.key), 1)
  order.unshift(options.key)
  if (order.length > options.max) delete values[order.pop()!]
}

function timestampMs(value: string | null): number | null {
  if (value == null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assertKey(key: string): void {
  if (!key || key.length > CURSOR_KEY_LIMIT) {
    throw new Error('Incremental cursor key must be bounded')
  }
}

function assertPath(path: string): void {
  if (!path || path.length > CURSOR_PATH_LIMIT) {
    throw new Error('Incremental cursor path must be bounded')
  }
}

function assertScalar(value: CursorScalar): void {
  if (typeof value === 'string' && value.length > CURSOR_SCALAR_STRING_LIMIT) {
    throw new Error('Incremental cursor value must be bounded')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Incremental cursor value must be finite')
  }
}

export class IncrementalCursor {
  private files: Record<string, IncrementalFileCursor>
  private directories: Record<string, IncrementalDirectoryCursor>
  private hotFiles: string[]
  private hotDirectories: string[]
  private values: Record<string, CursorScalar>
  private reconciledAt: string | null
  private readonly startedUninitialized: boolean
  private readonly bootstrapSinceMs: number | null

  constructor(
    previous: IncrementalSourceState = emptyIncrementalSourceState(),
    bootstrapSince: string | null = null,
  ) {
    this.hotFiles = boundedOrder(previous.hot_files, previous.files, HOT_FILE_LIMIT)
    this.hotDirectories = boundedOrder(
      previous.hot_directories, previous.directories, HOT_DIRECTORY_LIMIT,
    )
    this.files = Object.fromEntries(this.hotFiles.map(key => [key, cloneFile(previous.files[key])]))
    this.directories = Object.fromEntries(
      this.hotDirectories.map(key => [key, cloneDirectory(previous.directories[key])]),
    )
    this.values = { ...previous.values }
    this.reconciledAt = previous.last_reconciled_at
    this.startedUninitialized = this.reconciledAt == null
      && this.hotFiles.length === 0
      && this.hotDirectories.length === 0
      && Object.keys(this.values).length === 0
    const parsedBootstrap = bootstrapSince == null ? NaN : Date.parse(bootstrapSince)
    this.bootstrapSinceMs = Number.isFinite(parsedBootstrap) ? parsedBootstrap : null
  }

  isUninitialized(): boolean {
    return this.startedUninitialized
  }

  shouldBootstrapAtEnd(mtimeMs: number): boolean {
    return this.startedUninitialized
      && this.bootstrapSinceMs != null
      && mtimeMs < this.bootstrapSinceMs
  }

  needsReconciliation(now = Date.now()): boolean {
    const previous = timestampMs(this.reconciledAt)
    return previous == null || now - previous >= RECONCILE_INTERVAL_MS
  }

  coldFileNeedsScan(mtimeMs: number): boolean {
    const previous = timestampMs(this.reconciledAt)
    return previous == null || mtimeMs >= previous
  }

  knownFile(key: string): IncrementalFileCursor | undefined {
    const value = this.files[key]
    return value ? cloneFile(value) : undefined
  }

  knownDirectory(key: string): IncrementalDirectoryCursor | undefined {
    const value = this.directories[key]
    return value ? cloneDirectory(value) : undefined
  }

  hotFileEntries(): Array<[string, IncrementalFileCursor]> {
    return this.hotFiles.map(key => [key, cloneFile(this.files[key])])
  }

  hotDirectoryEntries(): Array<[string, IncrementalDirectoryCursor]> {
    return this.hotDirectories.map(key => [key, cloneDirectory(this.directories[key])])
  }

  filePlan(
    key: string,
    signature: FileSignature,
    requiredMetadata: readonly string[] = [],
  ): FileScanPlan {
    const previous = this.files[key]
    if (!previous) return 'replay'
    if (previous.mtime_ms === signature.mtime_ms
      && previous.size_bytes === signature.size_bytes
      && previous.offset_bytes === previous.size_bytes) return 'unchanged'
    const hasMetadata = requiredMetadata.every(name => name in previous.metadata)
    const hasUnreadTail = previous.offset_bytes < previous.size_bytes
      && signature.size_bytes >= previous.size_bytes
    return (signature.size_bytes > previous.size_bytes || hasUnreadTail)
      && signature.mtime_ms >= previous.mtime_ms
      && previous.offset_bytes <= previous.size_bytes
      && hasMetadata
      ? 'append'
      : 'replay'
  }

  directoryChanged(key: string, mtimeMs: number): boolean {
    return this.directories[key]?.mtime_ms !== mtimeMs
  }

  stageFile(key: string, value: IncrementalFileCursor): void {
    assertKey(key)
    assertPath(value.path)
    const cloned = cloneFile(value)
    touchBounded(this.hotFiles, this.files, { key, max: HOT_FILE_LIMIT })
    this.files[key] = cloned
  }

  removeFile(key: string): void {
    delete this.files[key]
    this.hotFiles = this.hotFiles.filter(item => item !== key)
  }

  stageDirectory(key: string, value: IncrementalDirectoryCursor): void {
    assertKey(key)
    assertPath(value.path)
    const cloned = cloneDirectory(value)
    touchBounded(this.hotDirectories, this.directories, {
      key, max: HOT_DIRECTORY_LIMIT,
    })
    this.directories[key] = cloned
  }

  removeDirectory(key: string): void {
    delete this.directories[key]
    this.hotDirectories = this.hotDirectories.filter(item => item !== key)
  }

  getValue(key: string): CursorScalar | undefined {
    return this.values[key]
  }

  setValue(key: string, value: CursorScalar): void {
    assertKey(key)
    assertScalar(value)
    if (!(key in this.values) && Object.keys(this.values).length >= CURSOR_VALUE_LIMIT) {
      throw new Error('Incremental cursor values are full')
    }
    this.values[key] = value
  }

  finishReconciliation(at: Date): void {
    this.reconciledAt = at.toISOString()
  }

  snapshot(): IncrementalSourceState {
    return {
      files: Object.fromEntries(this.hotFiles.map(key => [key, cloneFile(this.files[key])])),
      directories: Object.fromEntries(
        this.hotDirectories.map(key => [key, cloneDirectory(this.directories[key])]),
      ),
      hot_files: [...this.hotFiles],
      hot_directories: [...this.hotDirectories],
      values: { ...this.values },
      last_reconciled_at: this.reconciledAt,
    }
  }
}
