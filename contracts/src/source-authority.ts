export type SourceProvider = 'claude' | 'codex'

export interface SourceAuthorityState {
  provider: SourceProvider
  cutover_at: string | null
  legacy_history: boolean
  legacy_coverage_end: string | null
}
