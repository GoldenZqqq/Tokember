import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  RecoveryError,
  createVerifiedBackup,
  readRecoveryStatus,
  runRecoveryCycle,
  runRestoreDrill,
} from './recovery-lib.mjs'
import { isRecoveryMain, parseRecoveryArgs } from './recovery.mjs'

function seedDatabase(path) {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY,
      timestamp TEXT NOT NULL,
      value TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, name) VALUES (9, 'fixture');
  `)
  const insert = db.prepare('INSERT INTO usage_records (timestamp, value) VALUES (?, ?)')
  db.transaction(() => {
    for (let index = 0; index < 2_000; index += 1) {
      insert.run(new Date(1_700_000_000_000 + index).toISOString(), `value-${index}`)
    }
  })()
  return db
}

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'tokember-recovery-'))
  const sourcePath = join(workspace, 'source.db')
  const backupRoot = join(workspace, 'periodic')
  const writer = seedDatabase(sourcePath)
  return { workspace, sourcePath, backupRoot, writer }
}

async function cleanup(input) {
  input.writer.close()
  await rm(input.workspace, { recursive: true, force: true })
}

function mode(info) {
  return info.mode & 0o777
}

test('recovery CLI accepts only bounded host-owned cycle arguments', () => {
  assert.deepEqual(parseRecoveryArgs([
    'cycle', '--app-root', '/opt/tokember', '--service', 'tokember',
    '--keep', '14', '--timeout-ms', '120000', '--pages', '128', '--retries', '1',
  ]), {
    appRoot: '/opt/tokember', service: 'tokember', keep: 14,
    timeoutMs: 120_000, pagesPerStep: 128, retries: 1,
  })
  for (const args of [
    ['cycle', '--app-root', '.'],
    ['cycle', '--app-root', '/'],
    ['cycle', '--app-root', '/opt/tokember', '--service', '../other'],
    ['cycle', '--app-root', '/opt/tokember', '--keep', '0'],
    ['restore', '--app-root', '/opt/tokember'],
    ['cycle', '--app-root', '/opt/tokember', '--database', '/tmp/other.db'],
  ]) {
    assert.throws(() => parseRecoveryArgs(args), RecoveryError)
  }
})

test('recovery CLI detects execution through the current release symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-recovery-main-'))
  const link = join(root, 'recovery.mjs')
  try {
    await symlink(fileURLToPath(new URL('./recovery.mjs', import.meta.url)), link)
    assert.equal(isRecoveryMain(link), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('online backup publishes an integral restricted set during bounded WAL writes', async () => {
  const input = await fixture()
  let concurrentWrites = 0
  try {
    const insert = input.writer.prepare(
      'INSERT INTO usage_records (timestamp, value) VALUES (?, ?)',
    )
    const backup = await createVerifiedBackup({
      Database,
      sourcePath: input.sourcePath,
      backupRoot: input.backupRoot,
      pagesPerStep: 8,
      onProgress: () => {
        if (concurrentWrites >= 12) return
        insert.run(new Date().toISOString(), `concurrent-${concurrentWrites}`)
        concurrentWrites += 1
      },
    })
    const copy = new Database(backup.databasePath, { readonly: true, fileMustExist: true })
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(
      copy.prepare('SELECT COUNT(*) AS count FROM usage_records').get().count,
      2_000 + concurrentWrites,
    )
    copy.close()

    assert.equal(mode(await stat(backup.directory)), 0o700)
    assert.equal(mode(await stat(backup.databasePath)), 0o600)
    assert.equal(mode(await stat(backup.manifestPath)), 0o600)
    const serialized = await readFile(backup.manifestPath, 'utf8')
    assert.doesNotMatch(serialized, new RegExp(input.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(serialized, /source\.db|tokember\.db/)
    assert.deepEqual(JSON.parse(serialized).integrity, 'passed')
  } finally {
    await cleanup(input)
  }
})

test('retryable lock errors stop after the configured retry budget', async () => {
  const input = await fixture()
  let attempts = 0
  try {
    await assert.rejects(() => createVerifiedBackup({
      Database,
      sourcePath: input.sourcePath,
      backupRoot: input.backupRoot,
      retries: 2,
    }, {
      backup: async () => {
        attempts += 1
        throw Object.assign(new Error('private lock detail'), { code: 'SQLITE_BUSY' })
      },
      sleep: async () => {},
    }), error => {
      assert.equal(error instanceof RecoveryError, true)
      assert.equal(error.code, 'busy')
      assert.doesNotMatch(error.message, /private lock detail/)
      return true
    })
    assert.equal(attempts, 3)
    assert.deepEqual(await readdir(join(input.backupRoot, 'sets')), [])
  } finally {
    await cleanup(input)
  }
})

test('missing source and transfer timeout leave no publishable or staged backup', async () => {
  const input = await fixture()
  try {
    await assert.rejects(() => createVerifiedBackup({
      Database,
      sourcePath: join(input.workspace, 'missing.db'),
      backupRoot: input.backupRoot,
    }), error => error instanceof RecoveryError && error.code === 'io')
    assert.deepEqual(await readdir(join(input.backupRoot, '.staging')), [])

    let tick = 0
    await assert.rejects(() => createVerifiedBackup({
      Database,
      sourcePath: input.sourcePath,
      backupRoot: input.backupRoot,
      timeoutMs: 1,
    }, {
      clock: () => { tick += 10; return tick },
      backup: async (_db, _path, options) => options.progress({}),
    }), error => error instanceof RecoveryError && error.code === 'timeout')
    assert.deepEqual(await readdir(join(input.backupRoot, '.staging')), [])
    assert.deepEqual(await readdir(join(input.backupRoot, 'sets')), [])
  } finally {
    await cleanup(input)
  }
})

test('successful cycles prune only old periodic sets after restore smoke passes', async () => {
  const input = await fixture()
  const releaseBackup = join(input.workspace, 'release-backup', 'tokember.db')
  try {
    await chmod(input.workspace, 0o700)
    await mkdir(dirname(releaseBackup), { recursive: true })
    await writeFile(releaseBackup, 'release-copy')
    for (let index = 0; index < 3; index += 1) {
      await runRecoveryCycle({
        Database,
        sourcePath: input.sourcePath,
        backupRoot: input.backupRoot,
        keep: 2,
        now: () => new Date(`2026-07-1${index + 1}T00:00:00.000Z`),
      }, { runSmoke: async () => {} })
    }
    const sets = await readdir(join(input.backupRoot, 'sets'))
    assert.equal(sets.length, 2)
    assert.equal(await readFile(releaseBackup, 'utf8'), 'release-copy')
    const status = await readRecoveryStatus(input.backupRoot)
    assert.equal(status.error_code, null)
    assert.equal(status.drill.state, 'passed')
    assert.equal(status.backup_schema_version, 9)
    assert.doesNotMatch(JSON.stringify(status), /release-backup|source\.db|tokember\.db/)
  } finally {
    await cleanup(input)
  }
})

test('backup failure preserves the latest success and records only a safe code', async () => {
  const input = await fixture()
  try {
    await runRecoveryCycle({
      Database, sourcePath: input.sourcePath, backupRoot: input.backupRoot,
    }, { runSmoke: async () => {} })
    const before = await readRecoveryStatus(input.backupRoot)
    const setsBefore = await readdir(join(input.backupRoot, 'sets'))

    await assert.rejects(() => runRecoveryCycle({
      Database, sourcePath: input.sourcePath, backupRoot: input.backupRoot,
    }, {
      createBackup: async () => { throw new RecoveryError('io') },
      runSmoke: async () => {},
    }), error => error instanceof RecoveryError && error.code === 'io')

    const after = await readRecoveryStatus(input.backupRoot)
    assert.equal(after.last_success_at, before.last_success_at)
    assert.equal(after.error_code, 'io')
    assert.ok(after.last_failure_at)
    assert.deepEqual(await readdir(join(input.backupRoot, 'sets')), setsBefore)
  } finally {
    await cleanup(input)
  }
})

test('restore checksum and smoke failures keep the verified backup', async () => {
  const input = await fixture()
  try {
    const backup = await createVerifiedBackup({
      Database, sourcePath: input.sourcePath, backupRoot: input.backupRoot,
    })
    await writeFile(backup.databasePath, 'tampered')
    await assert.rejects(() => runRestoreDrill(backup, {
      Database, backupRoot: input.backupRoot,
    }, { runSmoke: async () => {} }), error => (
      error instanceof RecoveryError && error.code === 'checksum'
    ))
    assert.equal((await stat(backup.databasePath)).isFile(), true)

    const cycleRoot = join(input.workspace, 'cycle')
    await assert.rejects(() => runRecoveryCycle({
      Database, sourcePath: input.sourcePath, backupRoot: cycleRoot,
    }, { runSmoke: async () => { throw new Error('private smoke detail') } }), error => (
      error instanceof RecoveryError && error.code === 'smoke'
    ))
    const status = await readRecoveryStatus(cycleRoot)
    assert.equal(status.drill.state, 'failed')
    assert.equal(status.error_code, 'smoke')
    assert.equal((await readdir(join(cycleRoot, 'sets'))).length, 1)
    assert.doesNotMatch(JSON.stringify(status), /private smoke detail/)
  } finally {
    await cleanup(input)
  }
})
