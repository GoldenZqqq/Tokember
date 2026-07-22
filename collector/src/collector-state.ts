import { open, readFile } from 'fs/promises'

import type { CollectionWindow } from './adapters/types.js'
import { atomicWriteText } from './atomic-file.js'
import { resolveLegacyAwareHomePath } from './runtime-paths.js'

const STATE_VERSION = 2
const MAX_DEVICES = 64
const MAX_PROVIDERS = 32
const MAX_SOURCES = 32
export const HOT_FILE_LIMIT = 128
export const HOT_DIRECTORY_LIMIT = 64
export const CURSOR_VALUE_LIMIT = 64
export const CURSOR_METADATA_LIMIT = 32
export const CURSOR_KEY_LIMIT = 512
export const CURSOR_PATH_LIMIT = 2_048
export const CURSOR_SCALAR_STRING_LIMIT = 2_048
export const DEFAULT_OVERLAP_MS = 5 * 60_000
export const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000

export type CursorScalar = string | number | boolean | null

export interface IncrementalFileCursor {
  path: string
  mtime_ms: number
  size_bytes: number
  offset_bytes: number
  metadata: Record<string, CursorScalar>
}

export interface IncrementalDirectoryCursor {
  path: string
  mtime_ms: number
}

export interface IncrementalSourceState {
  files: Record<string, IncrementalFileCursor>
  directories: Record<string, IncrementalDirectoryCursor>
  hot_files: string[]
  hot_directories: string[]
  values: Record<string, CursorScalar>
  last_reconciled_at: string | null
}

interface ProviderState {
  checkpoint: string
}

interface DeviceState {
  providers: Record<string, ProviderState>
  sources: Record<string, IncrementalSourceState>
}

export interface CollectorState {
  version: typeof STATE_VERSION
  devices: Record<string, DeviceState>
}

export class UnsupportedCollectorStateVersionError extends Error {
  constructor(version: number) {
    super(`Collector state version ${version} is newer than this Collector`)
    this.name = 'UnsupportedCollectorStateVersionError'
  }
}

class InvalidCollectorStateError extends Error {}

export function emptyIncrementalSourceState(): IncrementalSourceState {
  return {
    files: {}, directories: {}, hot_files: [], hot_directories: [],
    values: {}, last_reconciled_at: null,
  }
}

export function emptyCollectorState(): CollectorState {
  return { version: STATE_VERSION, devices: {} }
}

export function getCollectorStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.TOKEMBER_COLLECTOR_STATE || env.AI_BURN_COLLECTOR_STATE || '').trim()
  if (configured) return configured
  return resolveLegacyAwareHomePath({ fileName: 'collector-state.json' })
}

function record(value: unknown, field: string, max: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidCollectorStateError(`${field} must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length > max) throw new InvalidCollectorStateError(`${field} is too large`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new InvalidCollectorStateError(`${field} must be a bounded string`)
  }
  return value
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidCollectorStateError(`${field} must be a non-negative integer`)
  }
  return value as number
}

function timestamp(value: unknown, field: string): string {
  const input = text(value, field, 80)
  if (!Number.isFinite(Date.parse(input))) {
    throw new InvalidCollectorStateError(`${field} must be a timestamp`)
  }
  return new Date(input).toISOString()
}

function scalar(value: unknown, field: string): CursorScalar {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string' && value.length <= CURSOR_SCALAR_STRING_LIMIT) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new InvalidCollectorStateError(`${field} must be a JSON scalar`)
}

function scalarRecord(value: unknown, field: string, max: number): Record<string, CursorScalar> {
  return Object.fromEntries(Object.entries(record(value, field, max)).map(([key, item]) => [
    text(key, `${field} key`, CURSOR_KEY_LIMIT), scalar(item, `${field}.${key}`),
  ]))
}

function fileCursor(value: unknown, field: string): IncrementalFileCursor {
  const row = record(value, field, 5)
  const sizeBytes = count(row.size_bytes, `${field}.size_bytes`)
  const offsetBytes = count(row.offset_bytes, `${field}.offset_bytes`)
  if (offsetBytes > sizeBytes) throw new InvalidCollectorStateError(`${field}.offset_bytes exceeds size`)
  if (typeof row.mtime_ms !== 'number' || !Number.isFinite(row.mtime_ms) || row.mtime_ms < 0) {
    throw new InvalidCollectorStateError(`${field}.mtime_ms must be finite`)
  }
  return {
    path: text(row.path, `${field}.path`, CURSOR_PATH_LIMIT),
    mtime_ms: row.mtime_ms,
    size_bytes: sizeBytes,
    offset_bytes: offsetBytes,
    metadata: scalarRecord(row.metadata, `${field}.metadata`, CURSOR_METADATA_LIMIT),
  }
}

function directoryCursor(value: unknown, field: string): IncrementalDirectoryCursor {
  const row = record(value, field, 2)
  if (typeof row.mtime_ms !== 'number' || !Number.isFinite(row.mtime_ms) || row.mtime_ms < 0) {
    throw new InvalidCollectorStateError(`${field}.mtime_ms must be finite`)
  }
  return {
    path: text(row.path, `${field}.path`, CURSOR_PATH_LIMIT),
    mtime_ms: row.mtime_ms,
  }
}

function keyedCursors<T>(
  value: unknown,
  field: string,
  options: {
    max: number
    decode: (entry: unknown, entryField: string) => T
  },
): Record<string, T> {
  return Object.fromEntries(Object.entries(record(value, field, options.max)).map(([key, item]) => [
    text(key, `${field} key`, CURSOR_KEY_LIMIT), options.decode(item, `${field}.${key}`),
  ]))
}

function hotKeys(
  value: unknown,
  field: string,
  options: { max: number; known: Record<string, unknown> },
): string[] {
  if (!Array.isArray(value) || value.length > options.max) {
    throw new InvalidCollectorStateError(`${field} must be a bounded array`)
  }
  const keys = value.map((key, index) => text(key, `${field}.${index}`, CURSOR_KEY_LIMIT))
  if (new Set(keys).size !== keys.length || keys.some(key => !(key in options.known))) {
    throw new InvalidCollectorStateError(`${field} contains invalid keys`)
  }
  return keys
}

function sourceState(value: unknown, field: string): IncrementalSourceState {
  const row = record(value, field, 6)
  const files = keyedCursors(row.files, `${field}.files`, {
    max: HOT_FILE_LIMIT, decode: fileCursor,
  })
  const directories = keyedCursors(
    row.directories, `${field}.directories`, {
      max: HOT_DIRECTORY_LIMIT, decode: directoryCursor,
    },
  )
  return {
    files, directories,
    hot_files: hotKeys(row.hot_files, `${field}.hot_files`, {
      max: HOT_FILE_LIMIT, known: files,
    }),
    hot_directories: hotKeys(
      row.hot_directories, `${field}.hot_directories`, {
        max: HOT_DIRECTORY_LIMIT, known: directories,
      },
    ),
    values: scalarRecord(row.values, `${field}.values`, CURSOR_VALUE_LIMIT),
    last_reconciled_at: row.last_reconciled_at === null
      ? null
      : timestamp(row.last_reconciled_at, `${field}.last_reconciled_at`),
  }
}

function providerState(value: unknown, field: string): ProviderState {
  const row = record(value, field, 1)
  return { checkpoint: timestamp(row.checkpoint, `${field}.checkpoint`) }
}

function decodeDevice(value: unknown, field: string, allowMissingSources: boolean): DeviceState {
  const row = record(value, field, allowMissingSources ? 2 : 2)
  const providers = keyedCursors(row.providers, `${field}.providers`, {
    max: MAX_PROVIDERS, decode: providerState,
  })
  const sources = allowMissingSources && row.sources === undefined
    ? {}
    : keyedCursors(row.sources, `${field}.sources`, {
      max: MAX_SOURCES, decode: sourceState,
    })
  return { providers, sources }
}

function decodeCollectorState(value: unknown): CollectorState {
  const row = record(value, 'state', 2)
  if (row.version === 1) {
    const devices = keyedCursors(
      row.devices, 'state.devices', {
        max: MAX_DEVICES,
        decode: (device, field) => decodeDevice(device, field, true),
      },
    )
    return { version: STATE_VERSION, devices }
  }
  if (typeof row.version === 'number' && row.version > STATE_VERSION) {
    throw new UnsupportedCollectorStateVersionError(row.version)
  }
  if (row.version !== STATE_VERSION) throw new InvalidCollectorStateError('unsupported state version')
  const devices = keyedCursors(
    row.devices, 'state.devices', {
      max: MAX_DEVICES,
      decode: (device, field) => decodeDevice(device, field, false),
    },
  )
  return { version: STATE_VERSION, devices }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export async function loadCollectorState(
  path = getCollectorStatePath(),
  warn: (message: string) => void = message => console.warn(message),
): Promise<CollectorState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyCollectorState()
    throw error
  }
  try {
    return decodeCollectorState(JSON.parse(raw))
  } catch (error) {
    if (error instanceof UnsupportedCollectorStateVersionError) throw error
    warn('Collector state is invalid; a safe full reconciliation will run')
    return emptyCollectorState()
  }
}

function deviceState(state: CollectorState, deviceId: string): DeviceState {
  return state.devices[deviceId] ?? { providers: {}, sources: {} }
}

export function getCheckpoint(
  state: CollectorState,
  deviceId: string,
  provider: string,
): string | undefined {
  return state.devices[deviceId]?.providers?.[provider]?.checkpoint
}

export function getIncrementalSourceState(
  state: CollectorState,
  deviceId: string,
  source: string,
): IncrementalSourceState {
  return state.devices[deviceId]?.sources?.[source] ?? emptyIncrementalSourceState()
}

export function setIncrementalSourceState(
  state: CollectorState,
  options: {
    deviceId: string
    source: string
    sourceState: IncrementalSourceState
  },
): void {
  const device = deviceState(state, options.deviceId)
  device.sources[options.source] = options.sourceState
  state.devices[options.deviceId] = device
}

export function buildCollectionWindow(
  until: string,
  options: {
    cutoverAt?: string | null
    checkpoint?: string
    overlapMs?: number
  } = {},
): CollectionWindow {
  const candidates: number[] = []
  if (options.cutoverAt) candidates.push(Date.parse(options.cutoverAt))
  if (options.checkpoint) {
    candidates.push(Date.parse(options.checkpoint) - (options.overlapMs ?? DEFAULT_OVERLAP_MS))
  }
  const valid = candidates.filter(Number.isFinite)
  return {
    ...(valid.length > 0 ? { since: new Date(Math.max(...valid)).toISOString() } : {}),
    until,
  }
}

export function advanceCheckpoint(
  state: CollectorState,
  options: { deviceId: string; provider: string; checkpoint: string },
): void {
  const device = deviceState(state, options.deviceId)
  device.providers[options.provider] = { checkpoint: options.checkpoint }
  state.devices[options.deviceId] = device
}

async function preserveV1Backup(path: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  try {
    if ((JSON.parse(raw) as { version?: unknown }).version !== 1) return
  } catch {
    return
  }
  let handle
  try {
    handle = await open(`${path}.v1.bak`, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return
    throw error
  }
  try {
    await handle.writeFile(raw, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function saveCollectorState(
  state: CollectorState,
  path = getCollectorStatePath(),
): Promise<void> {
  await preserveV1Backup(path)
  await atomicWriteText(path, JSON.stringify(state, null, 2))
}
