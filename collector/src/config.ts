import { createHash } from 'crypto'
import { arch, hostname, platform } from 'os'
import type { MachineMetadata, MachinePlatform } from '@tokember/contracts/device'
import { resolveLegacyAwareHomePath } from './runtime-paths.js'

type RuntimeEnv = NodeJS.ProcessEnv
const DEFAULT_SCHEDULE_INTERVAL_MINUTES = 30
const COLLECTOR_VERSION = '0.2.0'
export type ScheduleMode = 'fixed' | 'adaptive'

function firstConfigured(env: RuntimeEnv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = (env[key] || '').trim()
    if (value) return value
  }
  return ''
}

function scheduleIntervalMinutes(env: RuntimeEnv): number {
  const configured = firstConfigured(env, [
    'TOKEMBER_SCHEDULE_INTERVAL_MINUTES',
    'AI_BURN_SCHEDULE_INTERVAL_MINUTES',
  ])
  if (!configured) return DEFAULT_SCHEDULE_INTERVAL_MINUTES
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_080) {
    throw new Error('TOKEMBER_SCHEDULE_INTERVAL_MINUTES must be an integer between 1 and 10080')
  }
  return value
}

function scheduleMode(env: RuntimeEnv): ScheduleMode {
  const value = firstConfigured(env, ['TOKEMBER_SCHEDULE_MODE', 'AI_BURN_SCHEDULE_MODE'])
  if (!value || value === 'fixed') return 'fixed'
  if (value === 'adaptive') return 'adaptive'
  throw new Error('TOKEMBER_SCHEDULE_MODE must be fixed or adaptive')
}

function enabledFlag(env: RuntimeEnv, keys: readonly string[]): boolean {
  const value = firstConfigured(env, keys)
  if (!value) return false
  if (value === '1' || value.toLowerCase() === 'true') return true
  if (value === '0' || value.toLowerCase() === 'false') return false
  throw new Error(`${keys[0]} must be true or false`)
}

function machinePlatform(value: NodeJS.Platform): MachinePlatform {
  if (value === 'win32') return 'windows'
  if (value === 'darwin') return 'macos'
  if (value === 'linux') return 'linux'
  return 'other'
}

function machineMetadata(host: string): MachineMetadata {
  return { platform: machinePlatform(platform()), architecture: arch(), hostname: host }
}

export function collectorConfig(env: RuntimeEnv = process.env) {
  const host = hostname()
  return {
    // No production URL default — missing server is a configuration error.
    serverUrl: firstConfigured(env, ['TOKEMBER_SERVER', 'AI_BURN_SERVER']).replace(/\/+$/, ''),
    credential: firstConfigured(env, [
      'TOKEMBER_DEVICE_TOKEN', 'TOKEMBER_API_KEY', 'AI_BURN_API_KEY', 'API_KEY',
    ]),
    deviceId: firstConfigured(env, ['TOKEMBER_DEVICE_ID', 'AI_BURN_DEVICE_ID'])
      || createHash('md5').update(host).digest('hex').slice(0, 12),
    deviceName: firstConfigured(env, ['TOKEMBER_DEVICE_NAME', 'AI_BURN_DEVICE_NAME']) || host,
    machine: machineMetadata(host),
    collectorVersion: firstConfigured(env, ['TOKEMBER_COLLECTOR_VERSION']) || COLLECTOR_VERSION,
    scheduleIntervalMinutes: scheduleIntervalMinutes(env),
    scheduleMode: scheduleMode(env),
    attributionEnabled: enabledFlag(env, [
      'TOKEMBER_ATTRIBUTION_ENABLED', 'AI_BURN_ATTRIBUTION_ENABLED',
    ]),
    attributionSecretFile: firstConfigured(env, [
      'TOKEMBER_ATTRIBUTION_SECRET_FILE', 'AI_BURN_ATTRIBUTION_SECRET_FILE',
    ]) || resolveLegacyAwareHomePath({ fileName: 'attribution-secret' }),
  }
}

/** Fail closed before any network write when the collector target is incomplete. */
export function assertCollectorTarget(config: {
  serverUrl: string
  credential: string
}): void {
  if (!config.serverUrl) {
    throw new Error(
      'Collector is not configured: set TOKEMBER_SERVER (example https://tokember.example)',
    )
  }
  if (!config.credential) {
    throw new Error(
      'Collector is not configured: set TOKEMBER_DEVICE_TOKEN (preferred) or TOKEMBER_API_KEY',
    )
  }
}

export function configuredSourceMode(env: RuntimeEnv = process.env): string | undefined {
  const explicit = firstConfigured(env, ['TOKEMBER_CLAUDE_CODEX_SOURCE', 'AI_BURN_CLAUDE_CODEX_SOURCE'])
  if (explicit) return explicit
  const toggle = firstConfigured(env, ['TOKEMBER_ENABLE_CCSWITCH', 'AI_BURN_ENABLE_CCSWITCH'])
  if (toggle === '1') return 'cc-switch'
  if (toggle === '0') return 'native'
  return undefined
}
