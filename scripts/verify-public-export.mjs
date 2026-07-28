#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildPublicFileManifest,
  classifyPublicPath,
  listGitEntries,
  readGitBlob,
  sha256,
} from './public-export.mjs'

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/
const MANIFEST_NAME = 'PUBLIC_EXPORT.json'

function objectRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid public export ${field}`)
  }
  return value
}

function manifestPath(value) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) {
    throw new Error('invalid export path')
  }
  if (classifyPublicPath(value) !== 'public') throw new Error(`private export path: ${value}`)
  return value
}

export function decodePublicExportManifest(input) {
  const value = objectRecord(input, 'manifest')
  if (value.schema_version !== 1) throw new Error('invalid public export schema_version')
  if (typeof value.source_commit !== 'string' || !COMMIT_PATTERN.test(value.source_commit)) {
    throw new Error('invalid public export source_commit')
  }
  if (!Number.isSafeInteger(value.file_count) || value.file_count < 0) {
    throw new Error('invalid public export file_count')
  }
  if (!Array.isArray(value.files) || value.file_count !== value.files.length) {
    throw new Error('public export file_count mismatch')
  }

  const paths = new Set()
  const files = value.files.map((inputFile, index) => {
    const file = objectRecord(inputFile, `files[${index}]`)
    const path = manifestPath(file.path)
    if (paths.has(path)) throw new Error(`duplicate public export path: ${path}`)
    if (index > 0 && value.files[index - 1].path.localeCompare(path) >= 0) {
      throw new Error('public export files must be sorted')
    }
    if (typeof file.sha256 !== 'string' || !HASH_PATTERN.test(file.sha256)) {
      throw new Error(`invalid public export sha256: ${path}`)
    }
    paths.add(path)
    return { path, sha256: file.sha256 }
  })
  return { schema_version: 1, source_commit: value.source_commit, file_count: files.length, files }
}

async function hasOwnGitDirectory(root) {
  try {
    const entry = await lstat(join(root, '.git'))
    return entry.isDirectory() || entry.isFile()
  } catch {
    return false
  }
}

function gitTrackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).split('\0').filter(Boolean)
}

async function directoryFiles(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && entry.name === '.git') continue
    const target = join(directory, entry.name)
    const path = relative(root, target).split(sep).join('/')
    if (entry.isSymbolicLink()) throw new Error(`unsupported public tree entry: ${path}`)
    if (entry.isDirectory()) files.push(...await directoryFiles(root, target))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`unsupported public tree entry: ${path}`)
  }
  return files
}

async function listPublicFiles(root) {
  const files = await (await hasOwnGitDirectory(root) ? gitTrackedFiles(root) : directoryFiles(root))
  return files.filter(path => path !== MANIFEST_NAME).sort((left, right) => left.localeCompare(right))
}

function assertExactPaths(manifest, actualPaths) {
  const expectedPaths = manifest.files.map(file => file.path)
  const expected = new Set(expectedPaths)
  const actual = new Set(actualPaths)
  const missing = expectedPaths.filter(path => !actual.has(path))
  const extra = actualPaths.filter(path => !expected.has(path))
  if (missing.length) throw new Error(`public export tree missing: ${missing.join(', ')}`)
  if (extra.length) throw new Error(`public export tree extra: ${extra.join(', ')}`)
}

async function assertFileHashes(publicRoot, manifest) {
  for (const file of manifest.files) {
    const target = join(publicRoot, ...file.path.split('/'))
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`unsupported public tree entry: ${file.path}`)
    }
    const actual = sha256(await readFile(target))
    if (actual !== file.sha256) throw new Error(`public export hash mismatch: ${file.path}`)
  }
}

async function readManifest(publicRoot) {
  let value
  try {
    value = JSON.parse(await readFile(join(publicRoot, MANIFEST_NAME), 'utf8'))
  } catch {
    throw new Error('invalid public export manifest JSON')
  }
  return decodePublicExportManifest(value)
}

async function sourceManifest(sourceRoot, sourceCommit) {
  let entries
  try {
    entries = listGitEntries(sourceRoot, sourceCommit)
  } catch {
    throw new Error('public export source commit unavailable')
  }
  const files = await buildPublicFileManifest(
    entries,
    entry => readGitBlob(sourceRoot, sourceCommit, entry.path),
  )
  return { schema_version: 1, source_commit: sourceCommit, file_count: files.length, files }
}

export async function verifyPublicExportTree(options) {
  const publicRoot = resolve(options.publicRoot)
  const manifest = await readManifest(publicRoot)
  if (options.manifestOnly) return manifest

  const actualPaths = await listPublicFiles(publicRoot)
  assertExactPaths(manifest, actualPaths)
  await assertFileHashes(publicRoot, manifest)

  if (options.sourceRoot) {
    const expected = await sourceManifest(resolve(options.sourceRoot), manifest.source_commit)
    if (JSON.stringify(expected) !== JSON.stringify(manifest)) {
      throw new Error('public export source manifest mismatch')
    }
  }
  return manifest
}

function parseArgs(argv) {
  const options = { publicRoot: '', sourceRoot: '', manifestOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--manifest-only') options.manifestOnly = true
    else if (arg === '--public-root') options.publicRoot = argv[++index] ?? ''
    else if (arg === '--source-root') options.sourceRoot = argv[++index] ?? ''
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.publicRoot) throw new Error('--public-root is required')
  if (options.manifestOnly && options.sourceRoot) {
    throw new Error('--manifest-only cannot be combined with --source-root')
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await verifyPublicExportTree(options)
  const mode = options.manifestOnly ? 'manifest valid' : 'tree verified'
  process.stdout.write(`public export ${mode}: ${manifest.file_count} files from ${manifest.source_commit.slice(0, 12)}\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`public export verification failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
