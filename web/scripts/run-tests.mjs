import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectTestFiles(path)
    return entry.name.endsWith('.test.ts') ? [path] : []
  })
}

const files = collectTestFiles(resolve('src')).sort()
if (files.length === 0) throw new Error('No Web tests found')

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
