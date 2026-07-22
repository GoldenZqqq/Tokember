import type {
  ProtocolIncompatibleError,
  ProtocolVersion,
  ProtocolWindow,
} from '@tokember/contracts/protocol'

/** Day-0 collector/server wire protocol. Raise only with a compatibility plan. */
export const SERVER_PROTOCOL_VERSION = 1 as const
export const SERVER_MIN_PROTOCOL_VERSION = 1 as const
export const SERVER_MAX_PROTOCOL_VERSION = 1 as const

const UPGRADE_HINT =
  'Upgrade the Tokember collector to a release that supports this server protocol, '
  + 'or pin both sides to a compatible version. See docs/data-lifecycle.md and docs/COMPATIBILITY.md.'

export function getProtocolWindow(): ProtocolWindow {
  return {
    protocol_version: SERVER_PROTOCOL_VERSION,
    min_protocol_version: SERVER_MIN_PROTOCOL_VERSION,
    max_protocol_version: SERVER_MAX_PROTOCOL_VERSION,
  }
}

/**
 * Parse optional client protocol from a JSON body field.
 * Omitted / null / undefined → treat as 1 (pre-handshake collectors).
 * Invalid values return null so the route can reject as incompatible.
 */
export function parseClientProtocolVersion(value: unknown): ProtocolVersion | null {
  if (value === undefined || value === null) return 1
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed >= 1) return parsed
  }
  return null
}

export function isProtocolCompatible(clientVersion: ProtocolVersion | null): boolean {
  if (clientVersion == null) return false
  return clientVersion >= SERVER_MIN_PROTOCOL_VERSION
    && clientVersion <= SERVER_MAX_PROTOCOL_VERSION
}

export function protocolIncompatibleBody(
  clientVersion: ProtocolVersion | null,
): ProtocolIncompatibleError {
  return {
    error: 'protocol_incompatible',
    client_protocol_version: clientVersion,
    min_protocol_version: SERVER_MIN_PROTOCOL_VERSION,
    max_protocol_version: SERVER_MAX_PROTOCOL_VERSION,
    upgrade_hint: UPGRADE_HINT,
  }
}
