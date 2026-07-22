import { basename } from 'path'
import type { BuildInfo } from '@tokember/contracts/release'
import type { DB } from './db.js'
import { BUILD_INFO } from './build-info.js'
import { SERVER_STARTED_AT } from './health.js'
import { emptyCollectorHealth, getCollectorHealthMap } from './collector-health.js'
import { getRecoveryStatus, type RecoveryStatus } from './recovery-status.js'

/** Keep only the last two path segments so full host paths are not exposed. */
export function redactDbPath(dbPath: string): string {
  const normalized = dbPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return basename(dbPath) || 'tokember.db'
  if (parts.length === 1) return parts[0]
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export interface SystemInfo {
  version: string
  build: BuildInfo
  started_at: string
  node_env: string
  runtime_node_version: string
  runtime_architecture: string
  db_path: string
  db_ok: boolean
  counts: {
    devices: number
    usage_records: number
    pricing_rules: number
  }
  pricing_status: { status: string; count: number }[]
  recovery: RecoveryStatus
  devices: {
    id: string
    name: string
    last_seen_at: string | null
    last_successful_run_at: string | null
    collector_status: 'healthy' | 'degraded' | 'offline' | 'never'
    schedule_interval_minutes: number | null
    online: boolean
    record_count: number
  }[]
  health: {
    status: 'ok' | 'degraded' | 'error'
    online_devices: number
    offline_devices: number
    notes: string[]
  }
}

interface QueryState {
  db_ok: boolean
  notes: string[]
}

function checkDatabase(db: DB, state: QueryState): void {
  try {
    db.prepare('SELECT 1').get()
  } catch {
    state.db_ok = false
    state.notes.push('数据库查询失败')
  }
}

function safeCount(db: DB, sql: string, state: QueryState): number {
  try {
    return (db.prepare(sql).get() as { c: number }).c
  } catch {
    state.db_ok = false
    return 0
  }
}

function pricingStatuses(db: DB, state: QueryState): SystemInfo['pricing_status'] {
  try {
    return db.prepare(`
      SELECT pricing_status AS status, COUNT(*) AS count
      FROM usage_records
      GROUP BY pricing_status
      ORDER BY count DESC, status ASC
    `).all() as SystemInfo['pricing_status']
  } catch {
    state.db_ok = false
    return []
  }
}

function deviceSummaries(db: DB, state: QueryState): SystemInfo['devices'] {
  try {
    const rows = db.prepare(`
      SELECT d.id, d.name, d.last_seen_at,
        (SELECT COUNT(*) FROM usage_records WHERE device_id = d.id) AS record_count
      FROM devices d
      ORDER BY d.last_seen_at DESC NULLS LAST, d.name
    `).all() as Omit<SystemInfo['devices'][number], 'online'>[]
    const health = getCollectorHealthMap(db)
    return rows.map(row => {
      const collector = health.get(row.id) ?? emptyCollectorHealth()
      return {
        ...row,
        last_successful_run_at: collector.last_successful_at,
        collector_status: collector.status,
        schedule_interval_minutes: collector.latest_run?.schedule_interval_minutes ?? null,
        online: collector.online,
      }
    })
  } catch {
    state.db_ok = false
    return []
  }
}

function recoveryNote(recovery: RecoveryStatus): string | null {
  if (recovery.state === 'stale') return '数据库备份已超过 24 小时'
  if (recovery.state === 'backup_failed') return '最近一次数据库备份失败'
  if (recovery.state === 'drill_failed') return '最近一次恢复演练失败'
  return null
}

function healthSummary(
  devices: SystemInfo['devices'],
  state: QueryState,
  recovery: RecoveryStatus,
): SystemInfo['health'] {
  const online_devices = devices.filter(device => device.online).length
  const offline_devices = devices.length - online_devices
  if (devices.length > 0 && online_devices === 0) {
    state.notes.push('全部设备均无近期成功采集')
  } else if (offline_devices > 0) {
    state.notes.push(`${offline_devices} 台设备离线`)
  }
  const degraded = devices.filter(device => device.collector_status === 'degraded').length
  if (degraded > 0) state.notes.push(`${degraded} 台设备最近采集异常`)
  const note = recoveryNote(recovery)
  if (note) state.notes.push(note)
  const status = !state.db_ok ? 'error' : state.notes.length > 0 ? 'degraded' : 'ok'
  return { status, online_devices, offline_devices, notes: state.notes }
}

interface SystemInfoOptions {
  buildInfo?: BuildInfo
  env?: NodeJS.ProcessEnv
  now?: Date
  readRecoveryFile?: (path: string) => string
}

type SystemInfoInput = BuildInfo | SystemInfoOptions

function normalizeSystemInfoOptions(input: SystemInfoInput): SystemInfoOptions {
  if ('schema_version' in input) return { buildInfo: input }
  return input
}

export function getSystemInfo(
  db: DB,
  dbPath: string,
  input: SystemInfoInput = {},
): SystemInfo {
  const options = normalizeSystemInfoOptions(input)
  const buildInfo = options.buildInfo ?? BUILD_INFO
  const state: QueryState = { db_ok: true, notes: [] }
  checkDatabase(db, state)
  const devices = deviceSummaries(db, state)
  const counts = {
    devices: safeCount(db, 'SELECT COUNT(*) AS c FROM devices', state),
    usage_records: safeCount(db, 'SELECT COUNT(*) AS c FROM usage_records', state),
    pricing_rules: safeCount(db, 'SELECT COUNT(*) AS c FROM pricing_rules', state),
  }
  const pricing_status = pricingStatuses(db, state)
  const recovery = getRecoveryStatus(
    (options.env ?? process.env).TOKEMBER_RECOVERY_STATUS_PATH,
    { now: options.now, readFile: options.readRecoveryFile },
  )
  const health = healthSummary(devices, state, recovery)

  return {
    version: buildInfo.version,
    build: buildInfo,
    started_at: SERVER_STARTED_AT,
    node_env: process.env.NODE_ENV || 'development',
    runtime_node_version: process.version.replace(/^v/, ''),
    runtime_architecture: process.arch,
    db_path: redactDbPath(dbPath),
    db_ok: state.db_ok,
    counts,
    pricing_status,
    recovery,
    devices,
    health,
  }
}
