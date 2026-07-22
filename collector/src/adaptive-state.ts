import { mkdir, open, readFile, stat, unlink } from 'fs/promises'
import { dirname } from 'path'
import { atomicWriteText } from './atomic-file.js'
import { emptyAdaptiveState, type AdaptiveBand, type AdaptiveScheduleState } from './adaptive-policy.js'
import { resolveLegacyAwareHomePath } from './runtime-paths.js'

const STATE_VERSION = 1
const MAX_PROBES = 32
const MAX_COUNT = 1_000_000
const LOCK_STALE_MS = 15 * 60_000
const BANDS = new Set<AdaptiveBand>(['active', 'recent', 'idle', 'failure_backoff'])

export class UnsupportedAdaptiveStateVersionError extends Error {
  constructor(version: number) {
    super(`Adaptive schedule state version ${version} is newer than this Collector`)
    this.name = 'UnsupportedAdaptiveStateVersionError'
  }
}

class InvalidAdaptiveStateError extends Error {}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidAdaptiveStateError('state must be an object')
  }
  return value as Record<string, unknown>
}

function timestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length > 80 || !Number.isFinite(Date.parse(value))) {
    throw new InvalidAdaptiveStateError(`${field} must be a timestamp`)
  }
  return new Date(value).toISOString()
}

function count(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNT) {
    throw new InvalidAdaptiveStateError(`${field} must be a bounded count`)
  }
  return value as number
}

function probes(value: unknown): Record<string, string> {
  const row = object(value)
  const entries = Object.entries(row)
  if (entries.length > MAX_PROBES) throw new InvalidAdaptiveStateError('probe is too large')
  return Object.fromEntries(entries.map(([source, signature]) => {
    if (!/^[a-z0-9-]{1,80}$/.test(source)
      || typeof signature !== 'string'
      || !/^[a-f0-9]{64}$/.test(signature)) {
      throw new InvalidAdaptiveStateError('probe entry is invalid')
    }
    return [source, signature]
  }))
}

export function decodeAdaptiveState(value: unknown): AdaptiveScheduleState {
  const row = object(value)
  if (typeof row.version === 'number' && row.version > STATE_VERSION) {
    throw new UnsupportedAdaptiveStateVersionError(row.version)
  }
  if (row.version !== STATE_VERSION || !BANDS.has(row.band as AdaptiveBand)) {
    throw new InvalidAdaptiveStateError('unsupported adaptive state')
  }
  return {
    version: STATE_VERSION,
    band: row.band as AdaptiveBand,
    next_eligible_at: timestamp(row.next_eligible_at, 'next_eligible_at')!,
    last_activity_at: timestamp(row.last_activity_at, 'last_activity_at', true),
    last_completed_at: timestamp(row.last_completed_at, 'last_completed_at', true),
    consecutive_empty: count(row.consecutive_empty, 'consecutive_empty'),
    consecutive_failures: count(row.consecutive_failures, 'consecutive_failures'),
    probe: probes(row.probe),
  }
}

export function getAdaptiveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.TOKEMBER_ADAPTIVE_STATE || '').trim()
  if (configured) return configured
  return resolveLegacyAwareHomePath({ fileName: 'adaptive-schedule.json' })
}

export async function loadAdaptiveState(
  path = getAdaptiveStatePath(),
  now = new Date(),
  warn: (message: string) => void = message => console.warn(message),
): Promise<AdaptiveScheduleState> {
  try {
    return decodeAdaptiveState(JSON.parse(await readFile(path, 'utf-8')))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyAdaptiveState(now)
    if (error instanceof UnsupportedAdaptiveStateVersionError) throw error
    warn('Adaptive schedule state is invalid; collection is due now')
    return emptyAdaptiveState(now)
  }
}

export async function saveAdaptiveState(
  state: AdaptiveScheduleState,
  path = getAdaptiveStatePath(),
): Promise<void> {
  const decoded = decodeAdaptiveState(state)
  await atomicWriteText(path, `${JSON.stringify(decoded, null, 2)}\n`)
}

export interface AdaptiveLock {
  release(): Promise<void>
}

export async function acquireAdaptiveLock(
  path = `${getAdaptiveStatePath()}.lock`,
  now = Date.now(),
): Promise<AdaptiveLock | null> {
  // New adaptive state defaults under ~/.tokember even when only ~/.ai-burn
  // exists for other files; ensure the parent directory is present before lock create.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const existing = await stat(path)
    if (now - existing.mtimeMs <= LOCK_STALE_MS) return null
    await unlink(path).catch(() => {})
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  let handle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }
  await handle.writeFile(`${process.pid}\n`, 'utf-8')
  await handle.close()
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      await unlink(path).catch(error => {
        if (errorCode(error) !== 'ENOENT') throw error
      })
    },
  }
}
