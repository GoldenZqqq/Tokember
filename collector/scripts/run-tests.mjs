import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectTestFiles(path)
    return /\.test\.(?:ts|mjs)$/.test(entry.name) ? [path] : []
  })
}

const rootTests = readdirSync(resolve('.'), { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.test\.mjs$/.test(entry.name))
  .map(entry => resolve(entry.name))
const files = [...collectTestFiles(resolve('src')), ...rootTests].sort()
if (files.length === 0) throw new Error('No collector tests found')

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
