import type { SettingsPanelId } from './settings-panels'
import { createTranslator, LanguageSwitch, useT, type TranslateFn } from '../../i18n'

export interface SettingsMenuItem {
  id: SettingsPanelId
  label: string
  description: string
  enabled: boolean
}

/** Build menu items for the given translator (tests may pass createTranslator('en')). */
export function settingsMenuItems(t: TranslateFn): SettingsMenuItem[] {
  return [
    { id: 'audit', label: t('settings.menu.audit.label'), description: t('settings.menu.audit.description'), enabled: true },
    { id: 'alerts', label: t('settings.menu.alerts.label'), description: t('settings.menu.alerts.description'), enabled: true },
    { id: 'attribution', label: t('settings.menu.attribution.label'), description: t('settings.menu.attribution.description'), enabled: true },
    { id: 'pricing', label: t('settings.menu.pricing.label'), description: t('settings.menu.pricing.description'), enabled: true },
    { id: 'devices', label: t('settings.menu.devices.label'), description: t('settings.menu.devices.description'), enabled: true },
    { id: 'maintenance', label: t('settings.menu.maintenance.label'), description: t('settings.menu.maintenance.description'), enabled: true },
    { id: 'system', label: t('settings.menu.system.label'), description: t('settings.menu.system.description'), enabled: true },
  ]
}

/** English-default menu for tests and non-React consumers. */
export const SETTINGS_MENU = settingsMenuItems(createTranslator('en'))

export function SettingsSidebar({
  active,
  onSelect,
}: {
  active: SettingsPanelId
  onSelect: (id: SettingsPanelId) => void
}) {
  const t = useT()
  const menu = settingsMenuItems(t)

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
        <span className="text-xs text-zinc-500">{t('common.language')}</span>
        <LanguageSwitch />
      </div>
      <nav className="flex min-w-0 gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible" aria-label={t('settings.menuAria')}>
        {menu.map(item => {
          const selected = item.id === active
          return (
            <button
              key={item.id}
              type="button"
              disabled={!item.enabled}
              aria-current={selected ? 'page' : undefined}
              onClick={() => item.enabled && onSelect(item.id)}
              className={`min-w-[9.5rem] rounded-xl border px-3 py-3 text-left transition md:min-w-0 ${
                !item.enabled
                  ? 'cursor-not-allowed border-white/[0.04] bg-white/[0.02] text-zinc-600'
                  : selected
                    ? 'border-orange-500/40 bg-orange-500/15 text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                    : 'border-white/[0.06] bg-white/[0.02] text-zinc-300 hover:border-white/10 hover:bg-white/[0.04]'
              }`}
            >
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="mt-1 block text-[11px] text-zinc-600">{item.description}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
