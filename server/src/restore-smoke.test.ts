import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { BuildInfo } from '@tokember/contracts/release'
import { initDB } from './db.js'
import { LATEST_SCHEMA_VERSION } from './migrations.js'
import { isRestoreSmokeMain, RestoreSmokeError, runRestoreSmoke } from './restore-smoke.js'

const BUILD: BuildInfo = {
  schema_version: 2,
  release_id: '0.1.0-0123456789ab',
  version: '0.1.0',
  commit: '0123456789abcdef0123456789abcdef01234567',
  built_at: '2026-07-18T00:00:00.000Z',
  node_version: process.version.replace(/^v/, ''),
  architecture: process.arch,
  lockfile_sha256: 'a'.repeat(64),
  runtime_dependencies: {},
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('restore smoke detects execution through the current release symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-restore-main-'))
  const link = join(root, 'restore-smoke.ts')
  try {
    await symlink(fileURLToPath(new URL('./restore-smoke.ts', import.meta.url)), link)
    assert.equal(isRestoreSmokeMain(link), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore smoke reuses production readiness and leaves the restored DB unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-restore-smoke-'))
  const path = join(root, 'restored.db')
  try {
    const db = initDB(path)
    db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'Device')
    db.close()
    const before = digest(await readFile(path))

    runRestoreSmoke({ path, expectedSchema: LATEST_SCHEMA_VERSION, buildInfo: BUILD })

    assert.equal(digest(await readFile(path)), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('restore smoke rejects schema and release identity mismatches without raw detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-restore-smoke-invalid-'))
  const path = join(root, 'restored.db')
  try {
    initDB(path).close()
    assert.throws(
      () => runRestoreSmoke({ path, expectedSchema: LATEST_SCHEMA_VERSION - 1, buildInfo: BUILD }),
      error => {
        if (!(error instanceof RestoreSmokeError)) return false
        assert.equal(error.code, 'schema')
        assert.doesNotMatch(error.message, new RegExp(root))
        return true
      },
    )
    assert.throws(
      () => runRestoreSmoke({
        path,
        expectedSchema: LATEST_SCHEMA_VERSION,
        buildInfo: { ...BUILD, release_id: 'development', commit: 'unknown' },
      }),
      error => error instanceof RestoreSmokeError && error.code === 'readiness',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
