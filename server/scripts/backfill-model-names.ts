// One-off backfill: normalize existing usage_records.model to the canonical
// (dash) form, matching what ingest now does via normalizeModel(). Existing
// rows keep their original spelling until this runs, so the dashboard would
// otherwise show the same model split across old/new names.
//
// Usage (from server/):
//   tsx scripts/backfill-model-names.ts               # dry-run, prints a plan
//   tsx scripts/backfill-model-names.ts --apply       # backs up, then updates
//
// DB path resolves from DB_PATH env, else the canonical/legacy database resolver. Safe by design:
//   - dry-run is the default; --apply is required to write
//   - --apply copies the DB to <db>.bak-<timestamp> before touching a row
//   - only the `model` column changes; rows, tokens, cost are untouched
//   - runs in a single transaction

import Database from 'better-sqlite3'
import { copyFileSync, existsSync } from 'fs'
import { resolveDbPath } from '../src/db.js'
import { normalizeModel } from '../src/model-normalize.js'

const apply = process.argv.includes('--apply')
const dbPath = resolveDbPath(process.env.DB_PATH)

const db = new Database(dbPath)

interface ModelRow {
  model: string
  count: number
}

const rows = db.prepare(`
  SELECT model, COUNT(*) AS count FROM usage_records GROUP BY model
`).all() as ModelRow[]

// Group current names by their canonical form so the plan shows what merges.
const plan = new Map<string, { from: ModelRow[]; total: number }>()
for (const row of rows) {
  const canonical = normalizeModel(row.model)
  if (canonical === row.model) continue // already canonical
  const entry = plan.get(canonical) ?? { from: [], total: 0 }
  entry.from.push(row)
  entry.total += row.count
  plan.set(canonical, entry)
}

if (plan.size === 0) {
  console.log('Nothing to do — every model name is already canonical.')
  db.close()
  process.exit(0)
}

console.log(`DB: ${dbPath}`)
console.log(`Models to rename (${plan.size} canonical targets):\n`)
let affectedRows = 0
for (const [canonical, entry] of [...plan.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  → ${canonical}  (${entry.total} rows)`)
  for (const f of entry.from.sort((a, b) => b.count - a.count)) {
    console.log(`       ${f.model}  (${f.count})`)
    affectedRows += f.count
  }
}
console.log(`\nTotal rows affected: ${affectedRows}`)

if (!apply) {
  console.log('\nDry-run only. Re-run with --apply to write (a backup is made first).')
  db.close()
  process.exit(0)
}

// --apply: back up first, then update every non-canonical name in one tx.
// The DB is WAL mode, so a bare copy of the main .db file can miss rows still
// in the -wal. Checkpoint first to fold the WAL into the main file, then copy
// the main file plus any surviving sidecars so the backup is self-contained.
db.pragma('wal_checkpoint(TRUNCATE)')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = `${dbPath}.bak-${stamp}`
copyFileSync(dbPath, backupPath)
for (const ext of ['-wal', '-shm']) {
  if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, backupPath + ext)
}
console.log(`\nBackup written: ${backupPath}`)

const update = db.prepare('UPDATE usage_records SET model = ? WHERE model = ?')
const runAll = db.transaction(() => {
  let changed = 0
  for (const entry of plan.values()) {
    for (const f of entry.from) {
      changed += update.run(normalizeModel(f.model), f.model).changes
    }
  }
  return changed
})

const changed = runAll()
console.log(`Updated ${changed} rows.`)
console.log('\nNext: run a reprice so newly-canonical unpriced rows can match rules:')
console.log('  POST /api/admin/pricing/reprice  {"apply": true}   (admin panel → 数据维护)')
db.close()
