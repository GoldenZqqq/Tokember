export type BurnPreference = 'auto' | 'on' | 'off'

export const BURN_FX_STORAGE_KEY = 'tokember.burnFx'
export const BURN_FX_CHANGE_EVENT = 'tokember-burn-fx'

export function parseBurnPreference(value: unknown): BurnPreference {
  if (value === 'auto' || value === 'on' || value === 'off') return value
  return 'auto'
}

export function readBurnPreference(): BurnPreference {
  try {
    return parseBurnPreference(globalThis.localStorage?.getItem(BURN_FX_STORAGE_KEY))
  } catch {
    return 'auto'
  }
}

export function writeBurnPreference(value: BurnPreference): void {
  try {
    globalThis.localStorage?.setItem(BURN_FX_STORAGE_KEY, value)
  } catch {
    // ignore quota / private mode
  }
  try {
    globalThis.dispatchEvent?.(new Event(BURN_FX_CHANGE_EVENT))
  } catch {
    // ignore non-DOM environments
  }
}
