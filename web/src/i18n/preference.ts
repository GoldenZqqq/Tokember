import type { Locale } from './locales'

export const LOCALE_STORAGE_KEY = 'tokember.locale'
export const LOCALE_CHANGE_EVENT = 'tokember-locale'

export function parseLocale(value: unknown): Locale {
  if (value === 'en' || value === 'zh') return value
  return 'en'
}

/** Default is always English when preference is missing or invalid. */
export function readLocale(): Locale {
  try {
    return parseLocale(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return 'en'
  }
}

export function writeLocale(value: Locale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // ignore quota / private mode
  }
  try {
    globalThis.dispatchEvent?.(new Event(LOCALE_CHANGE_EVENT))
  } catch {
    // ignore non-DOM environments
  }
}
