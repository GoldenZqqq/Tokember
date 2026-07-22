#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKIP_PREFIXES = [
  '.agents/', '.codex/', '.git/', '.impeccable/', '.tmp/', '.trellis/',
  'docs/research/', 'node_modules/', 'output/', 'playwright-report/', 'test-results/',
]

const FORBIDDEN = [
  { id: 'public-site-url', re: /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+site\b/i },
  { id: 'onepanel-host-path', re: /\/opt\/1panel\/(?:www|apps)\//i },
  { id: 'url-embedded-credential', re: /https?:\/\/[^/\s:@]+:[^@\s/]+@/i },
  { id: 'device-token-literal', re: /\btkdc_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{20,}/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  {
    id: 'private-key-block',
    re: new RegExp(['-----BEGIN ', '(?:RSA |OPENSSH |EC )?', 'PRIVATE KEY-----'].join('')),
  },
]

const ALLOWLIST = [
  {
    file: 'scripts/public-hygiene.test.mjs',
    ids: [
      'public-site-url', 'non-test-ipv4', 'onepanel-host-path',
      'url-embedded-credential', 'private-key-block', 'device-token-literal',
    ],
  },
  { file: 'server/src/security.test.ts', ids: ['device-token-literal'] },
  { file: 'server/src/admin-routes.test.ts', ids: ['device-token-literal'] },
  { file: 'server/src/collector-runs.test.ts', ids: ['device-token-literal'] },
  { file: 'web/src/admin/api.test.ts', ids: ['device-token-literal'] },
  { file: 'web/src/components/settings/devices-panel.test.ts', ids: ['device-token-literal'] },
]

const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

function allowed(file, id) {
  return ALLOWLIST.some(entry => entry.file === file && entry.ids.includes(id))
}

function isAllowedIpv4(value) {
  const parts = value.split('.').map(Number)
  if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  if (value === '0.0.0.0' || parts[0] === 127) return true
  if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true
  if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true
  return parts[0] === 203 && parts[1] === 0 && parts[2] === 113
}

function lineFinding(id, file, line) {
  return { severity: 'error', id, file, line }
}

export function scanPublicText(file, text) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    for (const rule of FORBIDDEN) {
      if (rule.re.test(lines[index]) && !allowed(file, rule.id)) {
        findings.push(lineFinding(rule.id, file, index + 1))
      }
    }
    const addresses = lines[index].match(IPV4_PATTERN) ?? []
    if (addresses.some(address => !isAllowedIpv4(address)) && !allowed(file, 'non-test-ipv4')) {
      findings.push(lineFinding('non-test-ipv4', file, index + 1))
    }
  }
  return findings
}

function gitFiles(root, args) {
  return execFileSync('git', args, { cwd: root, windowsHide: true }).toString('utf8')
    .split('\0').filter(Boolean)
}

export function listPublicScanFiles(root) {
  const tracked = gitFiles(root, ['ls-files', '-z'])
  const others = gitFiles(root, ['ls-files', '-z', '--others', '--exclude-standard'])
  return [...new Set([...tracked, ...others])].filter(path => (
    !SKIP_PREFIXES.some(prefix => path.startsWith(prefix) || path.includes(`/${prefix}`))
    && !['.png', '.db', '.db-wal', '.db-shm', '.map'].some(suffix => path.endsWith(suffix))
  ))
}

export function scanPublicTree(root) {
  const findings = []
  for (const file of listPublicScanFiles(root)) {
    let text
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (text.length <= 1_500_000) findings.push(...scanPublicText(file, text))
  }
  return findings
}

function main() {
  const root = resolve(process.cwd())
  const findings = scanPublicTree(root)
  if (findings.length === 0) {
    process.stdout.write('scan-public-hygiene: clean (no forbidden working-tree markers)\n')
    return
  }
  process.stderr.write(`scan-public-hygiene: ${findings.length} finding(s)\n`)
  for (const item of findings.slice(0, 50)) {
    process.stderr.write(`  [${item.severity}] ${item.id} ${item.file}:${item.line}\n`)
  }
  if (findings.length > 50) process.stderr.write(`  ... and ${findings.length - 50} more\n`)
  process.exitCode = 1
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) main()
