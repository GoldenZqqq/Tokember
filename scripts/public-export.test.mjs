import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  classifyPublicPath,
  planPublicExport,
  stagePublicExport,
} from './public-export.mjs'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function entry(path, content = path, mode = '100644') {
  return { path, content: Buffer.from(content), mode, type: 'blob' }
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
