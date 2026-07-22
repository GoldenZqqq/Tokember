import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { atomicWriteText } from './atomic-file.js'

test('atomic writer retries transient Windows replace failures without deleting target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-atomic-file-'))
  const path = join(directory, 'state.json')
  let attempts = 0
  try {
    await writeFile(path, 'confirmed', 'utf-8')
    await atomicWriteText(path, 'candidate', async (from, to) => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('temporarily locked') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      assert.equal(await readFile(to, 'utf-8'), 'confirmed')
      await rename(from, to)
    })
    assert.ok(attempts >= 3)
    assert.equal(await readFile(path, 'utf-8'), 'candidate')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
