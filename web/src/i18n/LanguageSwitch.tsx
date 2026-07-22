import { LOCALE_LABELS, type Locale } from './locales'
import { useLocale } from './context'

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale()

  return (
    <div
      className={`inline-flex overflow-hidden rounded-lg border border-zinc-800 ${className}`}
      role="group"
      aria-label="Language"
    >
      {(['en', 'zh'] as const).map(code => (
        <button
          key={code}
          type="button"
          aria-pressed={locale === code}
          onClick={() => setLocale(code as Locale)}
          className={`px-2 py-1 text-[11px] font-medium transition-colors ${
            locale === code
              ? 'bg-zinc-800 text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          {code === 'en' ? 'EN' : '中文'}
        </button>
      ))}
      <span className="sr-only">{LOCALE_LABELS[locale]}</span>
    </div>
  )
}
