import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { htmlLang, type Locale } from './locales'
import { catalogs } from './messages'
import {
  LOCALE_CHANGE_EVENT,
  readLocale,
  writeLocale,
} from './preference'
import { translate, type TranslateFn, type TranslateParams } from './t'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: TranslateFn
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function applyDocumentLang(locale: Locale): void {
  try {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = htmlLang(locale)
    }
  } catch {
    // ignore non-DOM
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readLocale())

  const setLocale = useCallback((next: Locale) => {
    writeLocale(next)
    setLocaleState(next)
    applyDocumentLang(next)
  }, [])

  useEffect(() => {
    applyDocumentLang(locale)
    const onExternal = () => {
      const next = readLocale()
      setLocaleState(next)
      applyDocumentLang(next)
    }
    window.addEventListener(LOCALE_CHANGE_EVENT, onExternal)
    window.addEventListener('storage', onExternal)
    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT, onExternal)
      window.removeEventListener('storage', onExternal)
    }
  }, [locale])

  const t = useCallback<TranslateFn>((key: string, params?: TranslateParams) => {
    return translate(catalogs[locale], key, params, {
      fallback: catalogs.en,
    })
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale requires LocaleProvider')
  return ctx
}

export function useT(): TranslateFn {
  return useLocale().t
}

/** For non-React modules that receive t from the caller. */
export function createTranslator(locale: Locale): TranslateFn {
  return (key, params) => translate(catalogs[locale], key, params, {
    fallback: catalogs.en,
  })
}
