#!/usr/bin/env node
/**
 * Stage (and optionally archive) the multi-platform Collector release pack.
 *
 * Usage:
 *   node scripts/package-collector-release.mjs \
 *     --workspace . \
 *     --output tokember-collector-pack \
 *     --commit <40-char-sha> \
 *     --built-at <iso>
 *
 * Optional:
 *   --archives tokember-release-archives   directory for tar.gz / zip + SHA256SUMS
 *   --version 0.1.0                        override package.json version
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { stageCollectorRelease } from './release-lib.mjs'

function argumentsMap(args) {
  const result = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value == null) {
      throw new Error(`invalid package-collector-release arguments near ${key}`)
    }
    result.set(key.slice(2), value)
  }
  return result
}

function fileSha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function tryArchive(kind, cwd, archiveName, sourceDirName) {
  if (kind === 'tar') {
    const result = spawnSync(
      'tar',
      ['-czf', archiveName, sourceDirName],
      { cwd, encoding: 'utf8' },
    )
    return result.status === 0
  }
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      // Compress the folder itself so extract yields packName/...
      const result = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -LiteralPath '${sourceDirName}' -DestinationPath '${archiveName}' -Force`,
        ],
        { cwd, encoding: 'utf8' },
      )
      if (result.status === 0) return true
      // Fallback: tar.exe on modern Windows can emit zip
      const tarZip = spawnSync(
        'tar',
        ['-a', '-cf', archiveName, sourceDirName],
        { cwd, encoding: 'utf8' },
      )
      return tarZip.status === 0
    }
    const result = spawnSync(
      'zip',
      ['-qr', archiveName, sourceDirName],
      { cwd, encoding: 'utf8' },
    )
    return result.status === 0
  }
  return false
}

const args = argumentsMap(process.argv.slice(2))
const workspaceRoot = resolve(args.get('workspace') ?? '.')
const outputDir = resolve(args.get('output') ?? 'tokember-collector-pack')
const commit = args.get('commit')
const builtAt = args.get('built-at') ?? new Date().toISOString()
if (!commit) throw new Error('--commit <40-char-sha> is required')

const { meta, output } = await stageCollectorRelease({
  workspaceRoot,
  outputDir,
  commit,
  builtAt,
  version: args.get('version'),
})

const archivesRoot = resolve(args.get('archives') ?? join(dirname(output), 'tokember-release-archives'))
await mkdir(archivesRoot, { recursive: true })

const packName = `tokember-collector-${meta.version}-node22`
const packRoot = join(archivesRoot, packName)
// Copy staged tree into a versioned directory name for archive roots.
await cp(output, packRoot, { recursive: true })

const checksumLines = []
const tarName = `${packName}.tar.gz`
const zipName = `${packName}.zip`
const tarOk = tryArchive('tar', archivesRoot, tarName, packName)
const zipOk = tryArchive('zip', archivesRoot, zipName, packName)

for (const name of [tarOk ? tarName : null, zipOk ? zipName : null].filter(Boolean)) {
  const digest = await fileSha256(join(archivesRoot, name))
  checksumLines.push(`${digest}  ${name}`)
}

if (checksumLines.length === 0) {
  console.warn(`No tar/zip tools available; staged directory only: ${packRoot}`)
} else {
  await writeFile(join(archivesRoot, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, 'utf8')
  console.log(`Archives written under ${archivesRoot}`)
  for (const line of checksumLines) console.log(line)
}

console.log(`Staged collector pack ${meta.version} → ${output}`)
console.log(JSON.stringify({
  package_meta: meta,
  staged: output,
  pack_root: packRoot,
  archives: archivesRoot,
  basenames: { tar: tarOk ? tarName : null, zip: zipOk ? zipName : null, staged: basename(output) },
}, null, 2))
