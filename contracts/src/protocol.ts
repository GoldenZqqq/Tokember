/**
 * Collector ↔ Server wire protocol version (independent of package semver
 * and SQLite schema_version).
 */
export type ProtocolVersion = number

export interface ProtocolWindow {
  /** Preferred / current protocol version implemented by this process. */
  protocol_version: ProtocolVersion
  /** Inclusive minimum client protocol the peer accepts. */
  min_protocol_version: ProtocolVersion
  /** Inclusive maximum client protocol the peer accepts. */
  max_protocol_version: ProtocolVersion
}

/** Structured reject when client protocol is outside the server window. */
export interface ProtocolIncompatibleError {
  error: 'protocol_incompatible'
  client_protocol_version: ProtocolVersion | null
  min_protocol_version: ProtocolVersion
  max_protocol_version: ProtocolVersion
  /** Operator-safe upgrade guidance; never include secrets or host paths. */
  upgrade_hint: string
}
