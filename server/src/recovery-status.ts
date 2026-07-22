import { readFileSync } from 'node:fs'

export type RecoveryState =
  | 'never' | 'healthy' | 'stale' | 'backup_failed' | 'drill_failed'
export type RecoveryCheckState = 'never' | 'passed' | 'failed'
export type RecoveryErrorCode =
  | 'busy' | 'timeout' | 'io' | 'checksum' | 'schema' | 'integrity'
  | 'smoke' | 'status'

export interface RecoveryStatus {
  state: RecoveryState
  last_attempt_at: string | null
  last_success_at: string | null
  last_failure_at: string | null
  age_seconds: number | null
  backup_bytes: number | null
  schema_version: number | null
  integrity: RecoveryCheckState
  error_code: RecoveryErrorCode | null
  drill: {
    state: RecoveryCheckState
    last_attempt_at: string | null
    last_success_at: string | null
    duration_ms: number | null
  }
}

interface RecoveryStatusOptions {
  now?: Date
  staleAfterSeconds?: number
  readFile?: (path: string) => string
}

const CHECK_STATES = ['never', 'passed', 'failed'] as const
const ERROR_CODES = [
  'busy', 'timeout', 'io', 'checksum', 'schema', 'integrity', 'smoke', 'status',
] as const

function neverStatus(): RecoveryStatus {
  return {
    state: 'never',
    last_attempt_at: null, last_success_at: null, last_failure_at: null,
    age_seconds: null, backup_bytes: null, schema_version: null,
    integrity: 'never', error_code: null,
    drill: {
      state: 'never', last_attempt_at: null, last_success_at: null, duration_ms: null,
    },
  }
}

function statusFailure(): RecoveryStatus {
  return { ...neverStatus(), state: 'backup_failed', error_code: 'status' }
}

function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  return value as Record<string, unknown>
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error()
  return value
}

function nullableInteger(value: unknown, positive = false): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0)) throw new Error()
  return Number(value)
}

function literal<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error()
  return value as T
}

function decodeStatus(value: unknown) {
  const row = object(value)
  if (row.status_schema_version !== 1) throw new Error()
  const drill = object(row.drill)
  return {
    last_attempt_at: nullableTimestamp(row.last_attempt_at),
    last_success_at: nullableTimestamp(row.last_success_at),
    last_failure_at: nullableTimestamp(row.last_failure_at),
    backup_bytes: nullableInteger(row.backup_bytes),
    schema_version: nullableInteger(row.backup_schema_version, true),
    integrity: literal(row.integrity, CHECK_STATES),
    error_code: row.error_code === null ? null : literal(row.error_code, ERROR_CODES),
    drill: {
      state: literal(drill.state, CHECK_STATES),
      last_attempt_at: nullableTimestamp(drill.last_attempt_at),
      last_success_at: nullableTimestamp(drill.last_success_at),
      duration_ms: nullableInteger(drill.duration_ms),
    },
  }
}

function derivedState(
  decoded: ReturnType<typeof decodeStatus>,
  ageSeconds: number | null,
  staleAfterSeconds: number,
): RecoveryState {
  if (decoded.drill.state === 'failed') return 'drill_failed'
  if (decoded.error_code != null) return 'backup_failed'
  if (decoded.last_success_at == null) return 'never'
  return ageSeconds != null && ageSeconds > staleAfterSeconds ? 'stale' : 'healthy'
}

export function getRecoveryStatus(
  path: string | undefined,
  options: RecoveryStatusOptions = {},
): RecoveryStatus {
  if (!path) return neverStatus()
  const readFile = options.readFile ?? (input => readFileSync(input, 'utf8'))
  try {
    const decoded = decodeStatus(JSON.parse(readFile(path)))
    const now = (options.now ?? new Date()).getTime()
    const success = decoded.last_success_at == null
      ? null : new Date(decoded.last_success_at).getTime()
    const age = success == null ? null : Math.max(0, Math.floor((now - success) / 1_000))
    return {
      ...decoded,
      state: derivedState(decoded, age, options.staleAfterSeconds ?? 86_400),
      age_seconds: age,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return neverStatus()
    return statusFailure()
  }
}
