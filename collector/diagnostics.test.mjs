import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildDiagnosticReport, writeDiagnosticReport } from './diagnostics.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tokember-diagnostics-'))
  const collector = join(root, 'collector')
  const home = join(root, 'home')
  await mkdir(join(collector, 'dist'), { recursive: true })
  await mkdir(join(home, '.claude', 'projects'), { recursive: true })
  await writeFile(join(collector, 'dist', 'index.js'), 'export {}\n')
  await writeFile(join(collector, 'collector.env'), [
    'TOKEMBER_SERVER=https://private.example.test',
    'TOKEMBER_DEVICE_TOKEN=tkdc_private-secret',
    'TOKEMBER_SCHEDULE_MODE=adaptive',
  ].join('\n'))
  await writeFile(join(home, '.tokember-adaptive.json'), JSON.stringify({
    version: 1, band: 'recent', consecutive_failures: 2,
  }))
  return { root, collector, home }
}

test('diagnostic report is an allowlist and redacts local identity', async () => {
  const paths = await fixture()
  try {
    const report = buildDiagnosticReport({
      collectorDir: paths.collector,
      home: paths.home,
      platform: 'win32',
      architecture: 'x64',
      nodeVersion: '22.17.0',
      schedulerStatus: 'enabled',
      env: {
        TOKEMBER_ADAPTIVE_STATE: join(paths.home, '.tokember-adaptive.json'),
        USERNAME: 'private-user',
        TOKEMBER_DEVICE_TOKEN: 'tkdc_process-secret',
      },
    })
    assert.deepEqual(Object.keys(report), [
      'schema_version', 'generated_at', 'platform', 'architecture', 'node',
      'runtime', 'config', 'sources', 'scheduler', 'adaptive',
    ])
    assert.equal(report.platform, 'windows')
    assert.equal(report.runtime.mode, 'dist')
    assert.equal(report.config.server_configured, true)
    assert.equal(report.config.credential_configured, true)
    assert.equal(report.sources.claude, true)
    assert.deepEqual(Object.keys(report.sources), [
      'claude', 'codex', 'cursor', 'gemini', 'grok-build', 'cline',
      'roo-code', 'antigravity', 'openclaw', 'pi', 'omp', 'hermes',
    ])
    assert.deepEqual(report.adaptive, { version: 1, band: 'recent', failure_count: 2 })
    const serialized = JSON.stringify(report)
    assert.doesNotMatch(serialized, /private-secret|private-user|tokember-diagnostics|https:\/\//)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('diagnose CLI requires output and enforces explicit overwrite', async () => {
  const paths = await fixture()
  const install = fileURLToPath(new URL('./install.mjs', import.meta.url))
  const output = join(paths.root, 'cli-diagnostics.json')
  try {
    const missing = spawnSync(process.execPath, [install, 'diagnose'], { encoding: 'utf8' })
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /diagnose requires --output/)
    const missingValue = spawnSync(
      process.execPath, [install, 'diagnose', '--output', '--overwrite'], { encoding: 'utf8' },
    )
    assert.equal(missingValue.status, 2)
    assert.match(missingValue.stderr, /--output requires a file path/)
    const unrelated = spawnSync(
      process.execPath, [install, 'diagnose', '--output', output, '--schedule', 'fixed'],
      { encoding: 'utf8' },
    )
    assert.equal(unrelated.status, 2)
    assert.match(unrelated.stderr, /not valid for diagnose/)
    const first = spawnSync(process.execPath, [install, 'diagnose', '--output', output], { encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    const refused = spawnSync(process.execPath, [install, 'diagnose', '--output', output], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.equal(refused.stderr.trim(), 'Failed to write diagnostic report.')
    const replaced = spawnSync(process.execPath, [install, 'diagnose', '--output', output, '--overwrite'], { encoding: 'utf8' })
    assert.equal(replaced.status, 0, replaced.stderr)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('diagnostics expose stable scheduler enums on every supported platform', async () => {
  const paths = await fixture()
  try {
    for (const [platform, expected] of [['linux', 'disabled'], ['darwin', 'not_installed'], ['freebsd', 'unsupported']]) {
      const report = buildDiagnosticReport({
        collectorDir: paths.collector, home: paths.home, platform,
        schedulerStatus: expected, env: { TOKEMBER_ADAPTIVE_STATE: join(paths.home, 'missing.json') },
      })
      assert.equal(report.scheduler.status, expected)
      assert.ok(['linux', 'macos', 'other'].includes(report.platform))
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})

test('diagnostic output refuses overwrite unless explicitly requested', async () => {
  const paths = await fixture()
  const output = join(paths.root, 'diagnostics.json')
  try {
    await writeFile(output, 'existing\n')
    await assert.rejects(() => writeDiagnosticReport(output, {
      collectorDir: paths.collector, home: paths.home, schedulerStatus: 'unknown',
    }), /EEXIST/)
    await writeDiagnosticReport(output, {
      collectorDir: paths.collector, home: paths.home, schedulerStatus: 'unknown', overwrite: true,
    })
    const parsed = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(parsed.schema_version, 1)
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o077, 0)
  } finally {
    await rm(paths.root, { recursive: true, force: true })
  }
})
