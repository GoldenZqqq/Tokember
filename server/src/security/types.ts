export type CollectorPrincipal =
  | { kind: 'legacy' }
  | { kind: 'device'; credentialId: number; deviceId: string }

export interface SecurityEnv {
  Variables: {
    collectorPrincipal: CollectorPrincipal
  }
}
