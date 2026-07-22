export type ClaudeCodexSourceMode = 'auto' | 'cc-switch' | 'native'
export type ClaudeCodexSource = Exclude<ClaudeCodexSourceMode, 'auto'>

const VALID_MODES: ClaudeCodexSourceMode[] = ['auto', 'cc-switch', 'native']

export function parseClaudeCodexSourceMode(
  value: string | undefined,
): ClaudeCodexSourceMode {
  if (!value) return 'native'
  if (VALID_MODES.includes(value as ClaudeCodexSourceMode)) {
    return value as ClaudeCodexSourceMode
  }
  throw new Error(
    `TOKEMBER_CLAUDE_CODEX_SOURCE must be one of: ${VALID_MODES.join(', ')}`,
  )
}

export function selectClaudeCodexSource(
  mode: ClaudeCodexSourceMode,
  _ccSwitchAvailable: boolean,
): ClaudeCodexSource {
  if (mode !== 'auto') return mode
  return 'native'
}
