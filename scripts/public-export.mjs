#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const OUTPUT_PATTERN = /^tokember-public-export(?:-[A-Za-z0-9._-]+)?$/

const PUBLIC_ROOT_FILES = new Set([
  '.dockerignore', '.env.example', '.gitattributes', '.gitignore', '.npmrc',
  'CHANGELOG.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'Dockerfile',
  'LICENSE', 'PRODUCT.md', 'README.md', 'SECURITY.md', 'SUPPORT.md',
  'docker-compose.yml', 'mise.toml', 'package-lock.json', 'package.json',
  'playwright.config.ts',
])

const PUBLIC_PREFIXES = [
  'collector/', 'contracts/', 'e2e/', 'scripts/', 'server/', 'site/', 'web/',
  '.github/ISSUE_TEMPLATE/',
]

const PUBLIC_EXACT = new Set([
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/workflows/ci.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/release.yml',
])

const PRIVATE_EXACT = new Set([
  '.github/workflows/deploy.yml', 'AGENTS.md',
])

const PRIVATE_PREFIXES = [
  '.agents/', '.codex/', '.impeccable/', '.trellis/', 'docs/research/',
  'videos/',
]

function normalizePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\')) {
    throw new Error('invalid export path')
  }
  const segments = path.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('invalid export path')
  }
  return path
}

function hasSensitiveName(path) {
  const lower = path.toLowerCase()
  const name = lower.split('/').at(-1)
  if (lower.split('/').some(segment => segment === '.git' || segment === 'node_modules')) return true
  if (name === 'collector.env' || name === '.env' || name === 'id_rsa' || name === 'id_ed25519') return true
  return ['.db', '.db-wal', '.db-shm', '.log', '.pem', '.key'].some(suffix => lower.endsWith(suffix))
}

export function classifyPublicPath(input) {
  const path = normalizePath(input)
  if (hasSensitiveName(path)) throw new Error(`sensitive export path: ${path}`)
  if (PRIVATE_EXACT.has(path) || PRIVATE_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return 'private'
  }
  if (path.startsWith('docs/')) return 'public'
  if (PUBLIC_ROOT_FILES.has(path) || PUBLIC_EXACT.has(path)) return 'public'
  if (PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix))) return 'public'
  throw new Error(`unclassified tracked path: ${path}`)
}

function validateEntry(entry) {
  if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
    throw new Error(`unsupported git entry: ${entry?.path ?? 'unknown'}`)
  }
  return { ...entry, path: normalizePath(entry.path) }
}

export function planPublicExport(entries) {
  const paths = new Set()
  const publicEntries = []
  for (const input of entries) {
    const entry = validateEntry(input)
    if (paths.has(entry.path)) throw new Error(`duplicate git entry: ${entry.path}`)
    paths.add(entry.path)
    if (classifyPublicPath(entry.path) === 'public') publicEntries.push(entry)
  }
  return publicEntries.sort((left, right) => left.path.localeCompare(right.path))
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validateOutputPath(workspaceRoot, outputDir) {
  const workspace = resolve(workspaceRoot)
  const output = resolve(outputDir)
  if (output === workspace || !OUTPUT_PATTERN.test(basename(output))) {
    throw new Error('unsafe public export output path')
  }
  return { workspace, output }
}

async function writePublicBlob(output, entry, content) {
  const target = join(output, ...entry.path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, { flag: 'wx' })
  if (entry.mode === '100755') await chmod(target, 0o755)
}

export async function buildPublicFileManifest(entries, readBlob, writeBlob = null) {
  const files = []
  for (const entry of planPublicExport(entries)) {
    const content = await readBlob(entry)
    if (!Buffer.isBuffer(content)) throw new Error(`invalid git blob: ${entry.path}`)
    if (writeBlob) await writeBlob(entry, content)
    files.push({ path: entry.path, sha256: sha256(content) })
  }
  return files
}

export async function stagePublicExport(options) {
  const { output } = validateOutputPath(options.workspaceRoot, options.outputDir)
  const commit = String(options.sourceCommit ?? '').toLowerCase()
  if (!COMMIT_PATTERN.test(commit)) throw new Error('invalid source commit')
  await mkdir(output, { recursive: false })
  try {
    const files = await buildPublicFileManifest(
      options.entries,
      options.readBlob,
      (entry, content) => writePublicBlob(output, entry, content),
    )
    const manifest = { schema_version: 1, source_commit: commit, file_count: files.length, files }
    await writeFile(join(output, 'PUBLIC_EXPORT.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx',
    })
    return manifest
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}

function gitOutput(workspaceRoot, args, encoding = null) {
  return execFileSync('git', args, {
    cwd: workspaceRoot,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export function listGitEntries(workspaceRoot, commit) {
  const output = gitOutput(workspaceRoot, ['ls-tree', '-r', '-z', '--full-tree', commit])
  return output.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(line)
    if (!match) throw new Error('invalid git tree entry')
    return { mode: match[1], type: match[2], object: match[3], path: match[4] }
  })
}

export function readGitBlob(workspaceRoot, commit, path) {
  return gitOutput(workspaceRoot, ['show', `${commit}:${path}`])
}

function parseArgs(argv) {
  const options = { output: '', commit: 'HEAD' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--output') options.output = argv[++index] ?? ''
    else if (arg === '--commit') options.commit = argv[++index] ?? ''
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.output) throw new Error('--output is required')
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const workspaceRoot = gitOutput(process.cwd(), ['rev-parse', '--show-toplevel'], 'utf8').trim()
  const sourceCommit = gitOutput(workspaceRoot, ['rev-parse', `${options.commit}^{commit}`], 'utf8').trim()
  const entries = listGitEntries(workspaceRoot, sourceCommit)
  const manifest = await stagePublicExport({
    workspaceRoot,
    outputDir: options.output,
    sourceCommit,
    entries,
    readBlob: entry => readGitBlob(workspaceRoot, sourceCommit, entry.path),
  })
  process.stdout.write(`public export staged: ${manifest.file_count} files from ${sourceCommit.slice(0, 12)}\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`public export failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
