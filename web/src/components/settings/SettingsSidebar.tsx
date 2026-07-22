import type { SettingsPanelId } from './settings-panels'

export interface SettingsMenuItem {
  id: SettingsPanelId
  label: string
  description: string
  enabled: boolean
}

export const SETTINGS_MENU: SettingsMenuItem[] = [
  { id: 'audit', label: '用量审计', description: '记录钻取与自动对账', enabled: true },
  { id: 'alerts', label: '告警中心', description: '预算与异常事件', enabled: true },
  { id: 'attribution', label: '项目归因', description: '名称与跨设备合并', enabled: true },
  { id: 'pricing', label: '模型计价规则', description: '价格与历史补价', enabled: true },
  { id: 'devices', label: '设备与采集器', description: '设备状态与上报', enabled: true },
  { id: 'maintenance', label: '数据维护', description: '未计价与历史补价', enabled: true },
  { id: 'system', label: '系统信息', description: '运行状态与规模', enabled: true },
]

export function SettingsSidebar({
  active,
  onSelect,
}: {
  active: SettingsPanelId
  onSelect: (id: SettingsPanelId) => void
}) {
  return (
    <nav className="flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-visible" aria-label="设置菜单">
      {SETTINGS_MENU.map(item => {
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
  )
}
