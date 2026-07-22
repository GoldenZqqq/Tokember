import { copyFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

type NodeSqlite = typeof import('node:sqlite')
export type DatabaseHandle = InstanceType<NodeSqlite['DatabaseSync']>

async function databaseConstructor(): Promise<NodeSqlite['DatabaseSync']> {
  // tsup/esbuild currently rewrites a static `node:sqlite` import to the
  // nonexistent npm package `sqlite`. Keep the built-in specifier dynamic.
  const specifier = ['node', 'sqlite'].join(':')
  return ((await import(specifier)) as NodeSqlite).DatabaseSync
}

// Open a SQLite DB read-only. Apps like cc-switch and Cursor keep the file
// open with a WAL, so a direct read-only open can be refused. Fall back to a
// temp copy (with its -wal/-shm sidecars) so we always get a consistent read.
export async function openReadOnly(
  dbPath: string,
): Promise<{ db: DatabaseHandle; cleanup: () => Promise<void> }> {
  const DatabaseSync = await databaseConstructor()
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    db.prepare('SELECT 1').get() // probe: throws here if locked/invalid
    return { db, cleanup: async () => db.close() }
  } catch {
    const tmpBase = join(tmpdir(), `aiburn-${randomBytes(6).toString('hex')}.db`)
    await copyFile(dbPath, tmpBase)
    for (const ext of ['-wal', '-shm']) {
      await copyFile(dbPath + ext, tmpBase + ext).catch(() => {})
    }
    const db = new DatabaseSync(tmpBase, { readOnly: true })
    return {
      db,
      cleanup: async () => {
        db.close()
        for (const ext of ['', '-wal', '-shm']) {
          await unlink(tmpBase + ext).catch(() => {})
        }
      },
    }
  }
}
