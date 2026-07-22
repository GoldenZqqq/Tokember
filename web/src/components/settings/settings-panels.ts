export const SETTINGS_PANEL_IDS = [
  'audit',
  'alerts',
  'attribution',
  'pricing',
  'devices',
  'maintenance',
  'system',
] as const

export type SettingsPanelId = typeof SETTINGS_PANEL_IDS[number]

export function isSettingsPanelId(value: string | null): value is SettingsPanelId {
  return SETTINGS_PANEL_IDS.some(panel => panel === value)
}

export function settingsPanelFromHash(hash: string): SettingsPanelId {
  const panel = new URLSearchParams(hash.split('?')[1] ?? '').get('panel')
  return isSettingsPanelId(panel) ? panel : 'pricing'
}

export function initialSettingsPanels(active: SettingsPanelId): SettingsPanelId[] {
  return [active]
}

export function visitSettingsPanel(
  visited: SettingsPanelId[],
  panel: SettingsPanelId,
): SettingsPanelId[] {
  return visited.includes(panel) ? visited : [...visited, panel]
}
