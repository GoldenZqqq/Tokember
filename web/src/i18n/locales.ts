export type Locale = 'en' | 'zh'

export const LOCALES: readonly Locale[] = ['en', 'zh'] as const

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  zh: '中文',
}

export function htmlLang(locale: Locale): string {
  return locale === 'zh' ? 'zh-CN' : 'en'
}
