import { useT } from '../i18n'

export function FirstRunEmptyState() {
  const t = useT()
  return (
    <section
      aria-labelledby="first-run-title"
      className="mx-auto max-w-2xl rounded-xl border border-dashed border-orange-500/25 bg-orange-500/[0.04] p-6 sm:p-8"
    >
      <p className="text-xs font-medium text-orange-300">{t('firstRun.badge')}</p>
      <h2 id="first-run-title" className="mt-2 text-xl font-semibold text-zinc-100">
        {t('firstRun.title')}
      </h2>
      <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
        {t('firstRun.body')}
      </p>
      <ol className="mt-6 space-y-4">
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-xs font-semibold text-orange-300">1</span>
          <div className="min-w-0 text-sm">
            <p className="font-medium text-zinc-200">{t('firstRun.connectTitle')}</p>
            <a href="#/settings?panel=devices" className="mt-1 inline-block text-orange-300 underline decoration-orange-300/40 underline-offset-4 hover:text-orange-200">
              {t('firstRun.openDeviceSettings')}
            </a>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-xs font-semibold text-orange-300">2</span>
          <div className="min-w-0 text-sm">
            <p className="font-medium text-zinc-200">{t('firstRun.doctorTitle')}</p>
            <code className="mt-1 block break-all rounded-md bg-zinc-950/70 px-2.5 py-1.5 font-mono text-xs text-zinc-400">node collector/install.mjs doctor</code>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-500/15 text-xs font-semibold text-orange-300">3</span>
          <div className="min-w-0 text-sm">
            <p className="font-medium text-zinc-200">{t('firstRun.collectTitle')}</p>
            <code className="mt-1 block break-all rounded-md bg-zinc-950/70 px-2.5 py-1.5 font-mono text-xs text-zinc-400">node collector/install.mjs collect</code>
          </div>
        </li>
      </ol>
    </section>
  )
}
