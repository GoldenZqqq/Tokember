import type { BurnPreference } from './burn-preference'

export type BurnIntensity = 'off' | 'idle' | 'warm' | 'blaze'

/** Auto mode: at least this many real tokens → warm edges. */
export const BURN_WARM_TOKENS = 200_000
/** Auto mode: at least this many real tokens → full sparks. */
export const BURN_BLAZE_TOKENS = 5_000_000

export function resolveBurnIntensity(input: {
  preference: BurnPreference
  reducedMotion: boolean
  /** null when stats are not loaded yet */
  realTotalTokens: number | null
  /** true on Admin settings route */
  routeBlocksFx: boolean
}): BurnIntensity {
  if (input.routeBlocksFx || input.preference === 'off') return 'off'

  if (input.preference === 'on') {
    // Forced on stays warm so the overlay never permanently blazes.
    return 'warm'
  }

  // preference === 'auto'
  if (input.realTotalTokens == null) return 'off'
  const tokens = input.realTotalTokens
  if (tokens >= BURN_BLAZE_TOKENS) {
    return input.reducedMotion ? 'warm' : 'blaze'
  }
  if (tokens >= BURN_WARM_TOKENS) return 'warm'
  return 'idle'
}
