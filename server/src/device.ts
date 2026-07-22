import type { MachinePlatform } from '@tokember/contracts/device'

const MACHINE_PLATFORMS: MachinePlatform[] = ['windows', 'macos', 'linux', 'other']

export interface StoredMachineMetadata {
  platform: MachinePlatform | null
  architecture: string | null
  hostname: string | null
}

function optionalString(
  value: unknown,
  maxLength: number,
  pattern?: RegExp,
): string | null | undefined {
  if (value == null) return null
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) return undefined
  return pattern && !pattern.test(normalized) ? undefined : normalized
}

export function parseMachineMetadata(value: unknown): StoredMachineMetadata | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { platform: null, architecture: null, hostname: null }
  }
  const row = value as Record<string, unknown>
  const platform = row.platform == null
    ? null
    : typeof row.platform === 'string'
      && MACHINE_PLATFORMS.includes(row.platform as MachinePlatform)
      ? row.platform as MachinePlatform
      : undefined
  const architecture = optionalString(row.architecture, 40, /^[A-Za-z0-9._-]+$/)
  const hostname = optionalString(row.hostname, 255, /^[^\u0000-\u001f\u007f]+$/)
  if (platform === undefined || architecture === undefined || hostname === undefined) return null
  return { platform, architecture, hostname }
}
