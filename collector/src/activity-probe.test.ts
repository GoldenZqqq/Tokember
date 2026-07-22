import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { probeActivity } from './activity-probe.js'

test('activity probe hashes bounded metadata and detects hot file changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-probe-'))
  const file = join(directory, 'hot.jsonl')
  try {
    await writeFile(file, 'one\n', 'utf-8')
    const first = await probeActivity([{ source: 'codex', paths: [directory, file] }], {})
    assert.equal(first.activityObserved, false)
    assert.deepEqual(first.changedSources, [])
    assert.deepEqual(first.uncertainSources, [])
    assert.equal(first.inspected, 2)
    const stable = await probeActivity([{ source: 'codex', paths: [file, directory, file] }], first.signatures)
    assert.equal(stable.activityObserved, false)
    assert.equal(stable.inspected, 2)
    await writeFile(file, 'one\ntwo\n', 'utf-8')
    const changed = await probeActivity([{ source: 'codex', paths: [directory, file] }], first.signatures)
    assert.equal(changed.activityObserved, true)
    assert.deepEqual(changed.changedSources, ['codex'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('permission errors wake once, stay stable, and wake again when readable', async () => {
  const missing = join(tmpdir(), 'tokember-probe-missing-never-created')
  const first = await probeActivity([{ source: 'gemini', paths: [missing] }], {})
  const second = await probeActivity([{ source: 'gemini', paths: [missing] }], first.signatures)
  assert.equal(second.activityObserved, false)
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  const uncertain = await probeActivity(
    [{ source: 'gemini', paths: [missing] }],
    first.signatures,
    async () => { throw denied },
  )
  assert.equal(uncertain.activityObserved, true)
  assert.equal(uncertain.uncertain, true)
  assert.deepEqual(uncertain.changedSources, ['gemini'])
  assert.deepEqual(uncertain.uncertainSources, ['gemini'])
  const stableUncertain = await probeActivity(
    [{ source: 'gemini', paths: [missing] }],
    uncertain.signatures,
    async () => { throw denied },
  )
  assert.equal(stableUncertain.activityObserved, false)
  assert.deepEqual(stableUncertain.changedSources, [])
  assert.deepEqual(stableUncertain.uncertainSources, ['gemini'])
  const recovered = await probeActivity(
    [{ source: 'gemini', paths: [missing] }],
    uncertain.signatures,
    async () => ({
      isDirectory: () => false,
      mtimeMs: 1,
      size: 2,
    }),
  )
  assert.equal(recovered.activityObserved, true)
  assert.deepEqual(recovered.changedSources, ['gemini'])
  assert.deepEqual(recovered.uncertainSources, [])
})

test('activity diagnostics expose sorted source ids only', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  const result = await probeActivity([
    { source: 'zeta', paths: ['private-zeta'] },
    { source: 'alpha', paths: ['private-alpha'] },
  ], { alpha: 'old-alpha', zeta: 'old-zeta' }, async () => { throw denied })
  assert.deepEqual(result.changedSources, ['alpha', 'zeta'])
  assert.deepEqual(result.uncertainSources, ['alpha', 'zeta'])
})

test('probe work is capped independently of cold history size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-probe-bound-'))
  try {
    const sources = Array.from({ length: 33 }, (_, index) => ({ source: `source-${index}`, paths: [] }))
    await assert.rejects(() => probeActivity(sources, {}), /too many sources/)
    await mkdir(join(directory, 'hot'))
    const paths = Array.from({ length: 257 }, (_, index) => join(directory, `cold-${index}`))
    await assert.rejects(() => probeActivity([{ source: 'grok-build', paths }], {}), /too many paths/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
