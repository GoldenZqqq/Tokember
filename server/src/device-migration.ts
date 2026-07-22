import type { MachineMetadata } from '@tokember/contracts/device'
import type { DB } from './db.js'

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const DEVICE_NAME_MAX_LENGTH = 120
const DEVICE_TABLES = [
  'usage_records',
  'source_cutovers',
  'source_cutover_events',
  'collector_runs',
  'device_credentials',
  'alert_rules',
  'attribution_projects',
] as const

export interface DeviceRekeyPlan {
  source_device_id: string
  target_device_id: string
  target_name: string
  counts: Record<string, number>
}

export interface DeviceRekeyResult extends DeviceRekeyPlan {
  applied: true
}

export class DeviceRekeyError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'source_not_found' | 'target_exists',
  ) {
    super(code)
  }
}

interface DeviceRow {
  id: string
  name: string
  created_at: string
  last_seen_at: string | null
  prev_seen_at: string | null
  platform: MachineMetadata['platform'] | null
  architecture: string | null
  hostname: string | null
}

function validIdentity(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value)
}

function deviceRow(db: DB, id: string): DeviceRow | null {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | null
}

function validateInput(sourceId: string, targetId: string, targetName: string): void {
  if (!validIdentity(sourceId) || !validIdentity(targetId)
    || sourceId === targetId || !targetName.trim()
    || targetName.trim().length > DEVICE_NAME_MAX_LENGTH) {
    throw new DeviceRekeyError('invalid_input')
  }
}

function countReferences(db: DB, sourceId: string): Record<string, number> {
  return Object.fromEntries(DEVICE_TABLES.map(table => [
    table,
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE device_id = ?`)
      .get(sourceId) as { count: number }).count),
  ]))
}

export function planDeviceRekey(
  db: DB,
  sourceId: string,
  targetId: string,
  targetName: string,
): DeviceRekeyPlan {
  validateInput(sourceId, targetId, targetName)
  const source = deviceRow(db, sourceId)
  if (!source) throw new DeviceRekeyError('source_not_found')
  if (deviceRow(db, targetId)) throw new DeviceRekeyError('target_exists')
  return {
    source_device_id: sourceId,
    target_device_id: targetId,
    target_name: targetName.trim(),
    counts: countReferences(db, sourceId),
  }
}

export function applyDeviceRekey(
  db: DB,
  plan: DeviceRekeyPlan,
): DeviceRekeyResult {
  const source = deviceRow(db, plan.source_device_id)
  if (!source) throw new DeviceRekeyError('source_not_found')
  if (deviceRow(db, plan.target_device_id)) throw new DeviceRekeyError('target_exists')
  db.transaction(() => {
    db.prepare(`
      INSERT INTO devices
        (id, name, created_at, last_seen_at, prev_seen_at, platform, architecture, hostname)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.target_device_id, plan.target_name, source.created_at,
      source.last_seen_at, source.prev_seen_at, source.platform,
      source.architecture, source.hostname,
    )
    for (const table of DEVICE_TABLES) {
      db.prepare(`UPDATE ${table} SET device_id = ? WHERE device_id = ?`)
        .run(plan.target_device_id, plan.source_device_id)
    }
    db.prepare('DELETE FROM devices WHERE id = ?').run(plan.source_device_id)
  })()
  return { ...plan, applied: true }
}
