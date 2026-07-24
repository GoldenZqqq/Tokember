const PROVIDER_LABELS: Record<string, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  cline: 'Cline',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  grok: 'Grok Build',
  'grok-build': 'Grok Build',
  hermes: 'Hermes',
  omp: 'Oh My Pi',
  openclaw: 'OpenClaw',
  pi: 'Pi Agent',
  'pi-agent': 'Pi Agent',
  'roo-code': 'Roo Code',
}

export function providerDisplayName(provider: string): string {
  const label = PROVIDER_LABELS[provider]
  if (label) return label
  return provider.length === 0 ? provider : `${provider[0].toUpperCase()}${provider.slice(1)}`
}
