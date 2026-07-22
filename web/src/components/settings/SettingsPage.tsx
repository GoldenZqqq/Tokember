import { useEffect, useRef, useState } from 'react'
import { adminApi } from '../../admin/api'
import { AdminLogin } from './AdminLogin'
import { DevicesPanel } from './DevicesPanel'
import { MaintenancePanel } from './MaintenancePanel'
import { SystemPanel } from './SystemPanel'
import { PricingRulesPanel } from './PricingRulesPanel'
import { SettingsSidebar } from './SettingsSidebar'
import { ApiError, isAbortError, toApiError } from '../../data/api-client'
import { ResourceView } from '../ResourceView'
import { LatestRequest } from '../../data/latest-request'
import { AuditPanel } from './AuditPanel'
import { AlertCenterPanel } from './AlertCenterPanel'
import { ProjectAttributionPanel } from './ProjectAttributionPanel'
import {
  initialSettingsPanels,
  settingsPanelFromHash,
  visitSettingsPanel,
  type SettingsPanelId,
} from './settings-panels'
import { LanguageSwitch, useT } from '../../i18n'

type SessionState = 'checking' | 'anonymous' | 'authenticated' | 'error'

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const t = useT()
  const [session, setSession] = useState<SessionState>('checking')
  const [sessionError, setSessionError] = useState<ApiError | null>(null)
  const [active, setActive] = useState<SettingsPanelId>(() => (
    settingsPanelFromHash(window.location.hash)
  ))
  const [visited, setVisited] = useState(() => initialSettingsPanels(active))
  const sessionRequest = useRef(new LatestRequest())

  async function loadSession() {
    setSession('checking')
    setSessionError(null)
    try {
      const result = await sessionRequest.current.execute(signal => adminApi.session(signal))
      if (result.current) {
        setSession(result.value!.authenticated ? 'authenticated' : 'anonymous')
      }
    } catch (reason) {
      if (isAbortError(reason)) return
      const error = toApiError(reason)
      if (error.kind === 'auth') setSession('anonymous')
      else { setSessionError(error); setSession('error') }
    }
  }

  useEffect(() => {
    loadSession()
    return () => sessionRequest.current.cancel()
  }, [])

  if (session === 'checking' || session === 'error') {
    return <ResourceView
      status={session === 'checking' ? 'loading' : 'error'}
      error={sessionError}
      empty={false}
      loadingLabel={t('settings.verifying')}
      emptyLabel=""
      onRetry={() => { loadSession() }}
    >{null}</ResourceView>
  }
  if (session === 'anonymous') {
    return <AdminLogin onAuthenticated={() => setSession('authenticated')} />
  }

  return (
    <div className="min-h-screen">
      <header className="mb-6 flex items-center justify-between border-b border-white/[0.06] pb-5">
        <button onClick={onBack} className="flex items-center gap-3 text-left">
          <img src="/icon-192.png" alt="" className="h-10 w-10 rounded-xl" />
          <span>
            <span className="block text-lg font-bold text-zinc-100">{t('settings.title')}</span>
            <span className="block text-xs text-zinc-600">{t('settings.subtitle')}</span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <LanguageSwitch className="hidden sm:inline-flex" />
          <button onClick={onBack} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200">{t('settings.back')}</button>
        </div>
      </header>
      <div className="grid min-w-0 gap-5 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-7">
        <SettingsSidebar active={active} onSelect={panel => {
          setVisited(current => visitSettingsPanel(current, panel))
          setActive(panel)
          window.location.hash = `#/settings?panel=${panel}`
        }} />
        <main className="min-w-0">
          {visited.map(panel => <div key={panel} hidden={panel !== active}>
            <SettingsPanel panel={panel} />
          </div>)}
        </main>
      </div>
    </div>
  )
}

function SettingsPanel({ panel }: { panel: SettingsPanelId }) {
  if (panel === 'audit') return <AuditPanel />
  if (panel === 'alerts') return <AlertCenterPanel />
  if (panel === 'attribution') return <ProjectAttributionPanel />
  if (panel === 'devices') return <DevicesPanel />
  if (panel === 'maintenance') return <MaintenancePanel />
  if (panel === 'system') return <SystemPanel />
  return <PricingRulesPanel />
}
