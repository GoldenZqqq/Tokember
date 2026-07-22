// Preload for unit tests: clear host collector API keys so open-development
// fixtures are not forced into Bearer auth (live TOKEMBER_*/AI_BURN_* env).
for (const key of [
  'TOKEMBER_API_KEY',
  'AI_BURN_API_KEY',
  'API_KEY',
  'TOKEMBER_ALLOW_LEGACY_API_KEY',
  'AI_BURN_ALLOW_LEGACY_API_KEY',
]) {
  delete process.env[key]
}
