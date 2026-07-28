import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  classifyPublicPath,
  listGitEntries,
  planPublicExport,
  readGitBlob,
  stagePublicExport,
} from './public-export.mjs'
import {
  decodePublicExportManifest,
  verifyPublicExportTree,
} from './verify-public-export.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function entry(path, content = path, mode = '100644') {
  return { path, content: Buffer.from(content), mode, type: 'blob' }
}

async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: root,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function initializeSource(root, files) {
  await writeFiles(root, files)
  git(root, ['init', '--quiet'])
  git(root, ['add', '--all'])
  git(root, [
    '-c', 'commit.gpgsign=false', '-c', 'user.name=Test',
    '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture',
  ])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

async function stageFromSource(source, output, commit) {
  return stagePublicExport({
    workspaceRoot: source,
    outputDir: output,
    sourceCommit: commit,
    entries: listGitEntries(source, commit),
    readBlob: item => readGitBlob(source, commit, item.path),
  })
}

test('public export classification includes product paths and excludes private operations', () => {
  assert.equal(classifyPublicPath('README.md'), 'public')
  assert.equal(classifyPublicPath('collector/src/index.ts'), 'public')
  assert.equal(classifyPublicPath('.github/workflows/ci.yml'), 'public')
  assert.equal(classifyPublicPath('.github/workflows/pages.yml'), 'public')
  assert.equal(classifyPublicPath('site/index.html'), 'public')
  assert.equal(classifyPublicPath('.github/workflows/deploy.yml'), 'private')
  assert.equal(classifyPublicPath('.trellis/workspace/codex/journal.md'), 'private')
  assert.equal(classifyPublicPath('docs/research/private-note.md'), 'private')
  assert.equal(classifyPublicPath('videos/tokember-launch-film/index.html'), 'private')
  assert.throws(() => classifyPublicPath('ai-burn.db'), /sensitive export path/)
  assert.throws(() => classifyPublicPath('unknown-root.txt'), /unclassified tracked path/)
})

test('public export plan is sorted and rejects links or duplicate paths', () => {
  const planned = planPublicExport([
    entry('web/src/main.tsx'),
    entry('.trellis/config.yaml'),
    entry('README.md'),
  ])
  assert.deepEqual(planned.map(item => item.path), ['README.md', 'web/src/main.tsx'])
  assert.throws(() => planPublicExport([
    { path: 'README.md', mode: '120000', type: 'blob' },
  ]), /unsupported git entry/)
  assert.throws(() => planPublicExport([
    entry('README.md'), entry('README.md'),
  ]), /duplicate git entry/)
})

test('staging writes only public blobs and a deterministic checksum manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-public-test-'))
  const output = join(root, 'tokember-public-export-test')
  const entries = [
    entry('README.md', 'Tokember\n'),
    entry('server/src/index.ts', 'export {}\n'),
    entry('site/index.html', '<main>Tokember</main>\n'),
    entry('.github/workflows/deploy.yml', 'private\n'),
  ]
  try {
    const manifest = await stagePublicExport({
      workspaceRoot: root,
      outputDir: output,
      sourceCommit: COMMIT,
      entries,
      readBlob: async item => item.content,
    })
    assert.equal(manifest.source_commit, COMMIT)
    assert.equal(manifest.file_count, 3)
    assert.deepEqual(manifest.files.map(item => item.path), [
      'README.md', 'server/src/index.ts', 'site/index.html',
    ])
    await assert.rejects(() => readFile(join(output, '.github/workflows/deploy.yml')))
    assert.equal(await readFile(join(output, 'README.md'), 'utf8'), 'Tokember\n')
    const written = JSON.parse(await readFile(join(output, 'PUBLIC_EXPORT.json'), 'utf8'))
    assert.deepEqual(written, manifest)
    assert.match(written.files[0].sha256, /^[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging refuses unsafe or existing output directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-public-test-'))
  const output = join(root, 'tokember-public-export-test')
  const options = {
    workspaceRoot: root,
    outputDir: output,
    sourceCommit: COMMIT,
    entries: [entry('README.md')],
    readBlob: async item => item.content,
  }
  try {
    await stagePublicExport(options)
    await assert.rejects(() => stagePublicExport(options), /EEXIST/)
    await assert.rejects(() => stagePublicExport({ ...options, outputDir: root }), /unsafe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('public export manifest decoder rejects malformed or unsafe entries', () => {
  const base = {
    schema_version: 1,
    source_commit: COMMIT,
    file_count: 2,
    files: [
      { path: 'README.md', sha256: 'a'.repeat(64) },
      { path: 'server/src/index.ts', sha256: 'b'.repeat(64) },
    ],
  }
  assert.deepEqual(decodePublicExportManifest(base), base)
  assert.throws(() => decodePublicExportManifest({ ...base, schema_version: 2 }), /schema_version/)
  assert.throws(() => decodePublicExportManifest({ ...base, file_count: 1 }), /file_count/)
  assert.throws(() => decodePublicExportManifest({
    ...base, files: [base.files[0], base.files[0]],
  }), /duplicate/)
  assert.throws(() => decodePublicExportManifest({
    ...base, files: [...base.files].reverse(),
  }), /sorted/)
  assert.throws(() => decodePublicExportManifest({
    ...base, files: [{ path: '../secret', sha256: 'a'.repeat(64) }], file_count: 1,
  }), /invalid export path/)
  assert.throws(() => decodePublicExportManifest({
    ...base, files: [{ path: 'README.md', sha256: 'short' }], file_count: 1,
  }), /sha256/)
})

test('public export verifier reports missing extra and changed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-public-verify-'))
  const output = join(root, 'tokember-public-export-verify')
  try {
    await stagePublicExport({
      workspaceRoot: root,
      outputDir: output,
      sourceCommit: COMMIT,
      entries: [entry('README.md', 'Tokember\n'), entry('server/src/index.ts', 'export {}\n')],
      readBlob: async item => item.content,
    })
    await verifyPublicExportTree({ publicRoot: output })

    await writeFile(join(output, 'README.md'), 'changed\n', 'utf8')
    await verifyPublicExportTree({ publicRoot: output, manifestOnly: true })
    await assert.rejects(() => verifyPublicExportTree({ publicRoot: output }), /hash mismatch: README\.md/)
    await writeFile(join(output, 'README.md'), 'Tokember\n', 'utf8')

    await rm(join(output, 'server', 'src', 'index.ts'))
    await assert.rejects(() => verifyPublicExportTree({ publicRoot: output }), /missing: server\/src\/index\.ts/)
    await writeFiles(output, { 'server/src/index.ts': 'export {}\n', 'docs/extra.md': 'extra\n' })
    await assert.rejects(() => verifyPublicExportTree({ publicRoot: output }), /extra: docs\/extra\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('public export verifier compares the declared private source commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokember-public-source-'))
  const source = join(root, 'source')
  const output = join(root, 'tokember-public-export-source')
  try {
    const commit = await initializeSource(source, {
      'README.md': 'Tokember\n',
      'server/src/index.ts': 'export {}\n',
    })
    await stageFromSource(source, output, commit)
    await verifyPublicExportTree({ publicRoot: output, sourceRoot: source })

    await writeFile(join(source, 'README.md'), 'new source\n', 'utf8')
    git(source, ['add', 'README.md'])
    git(source, [
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Test',
      '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'change source',
    ])
    const nextCommit = git(source, ['rev-parse', 'HEAD']).trim()
    const manifestPath = join(output, 'PUBLIC_EXPORT.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, source_commit: nextCommit }, null, 2)}\n`)
    await assert.rejects(
      () => verifyPublicExportTree({ publicRoot: output, sourceRoot: source }),
      /source manifest mismatch/,
    )

    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, source_commit: 'f'.repeat(40) }, null, 2)}\n`)
    await assert.rejects(
      () => verifyPublicExportTree({ publicRoot: output, sourceRoot: source }),
      /source commit unavailable/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
