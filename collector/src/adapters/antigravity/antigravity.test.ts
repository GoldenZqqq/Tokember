import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'

import {
  collectAntigravity,
  createAntigravityWarningBudget,
  discoverAntigravitySources,
} from './index.js'
import {
  emptyIncrementalSourceState,
  type IncrementalSourceState,
} from '../../collector-state.js'
import { IncrementalCursor } from '../../incremental-cursor.js'
import { CollectionObserver } from '../types.js'
import { getAntigravityCachePath } from './cache.js'
import { recordFromGenMetadataRow } from './proto.js'
import {
  extractGeneratorMetadata,
  parseAntigravityServerCandidate,
  recordsFromGeneratorMetadata,
} from './rpc.js'
import type { AntigravityCache } from './types.js'

function varint(value: number): number[] {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return bytes
}

function scalar(number: number, value: number): number[] {
  return [...varint(number << 3), ...varint(value)]
}

function embedded(number: number, value: number[] | Uint8Array | string): number[] {
  const data = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value]
  return [...varint((number << 3) | 2), ...varint(data.length), ...data]
}

function metadataFixture(): Uint8Array {
  const usage = [
    ...scalar(2, 30_265), ...scalar(3, 730),
    ...scalar(9, 659), ...scalar(10, 71), ...embedded(11, 'response-1'),
  ]
  const chat = [
    ...embedded(4, usage),
    ...embedded(19, 'MODEL_INTERNAL'),
    ...embedded(21, 'Gemini 3.1 Pro (High)'),
  ]
  return Uint8Array.from(embedded(1, chat))
}

async function runIncrementalAntigravity(state: IncrementalSourceState) {
  const cursor = new IncrementalCursor(state)
  const observer = new CollectionObserver()
  const records = await collectAntigravity(undefined, observer, cursor)
  return {
    records,
    state: cursor.snapshot(),
    scanned: observer.snapshot().scanned,
  }
}

test('Tokember cache directory takes precedence over the legacy alias', () => {
  assert.equal(getAntigravityCachePath({
    TOKEMBER_CACHE_DIR: 'tokember-cache',
    AI_BURN_CACHE_DIR: 'legacy-cache',
  }), join('tokember-cache', 'antigravity-cache.json'))
})

test('protobuf metadata maps native Antigravity tokens and stable response ids', () => {
  const record = recordFromGenMetadataRow('cascade-1', {
    idx: 0, data: metadataFixture(),
  }, '2026-07-15T12:00:00.000Z')
  assert.deepEqual(record, {
    provider: 'antigravity', model: 'gemini-3.1-pro-high',
    input_tokens: 30_265, output_tokens: 659,
    cache_read_tokens: 0, cache_creation_tokens: 0,
    reasoning_tokens: 71, cost_usd: 0,
    timestamp: '2026-07-15T12:00:00.000Z',
    source_file: 'cascade-1', dedup_key: 'antigravity:cascade-1:response-1',
    attribution: { status: 'captured', session: 'cascade-1' },
  })
})

test('RPC helpers support Windows extension flags and wrapped metadata', () => {
  const candidate = parseAntigravityServerCandidate(
    'antigravity language_server --extension_server_port=43123 '
      + '--extension_server_csrf_token=abcdefghijklmnop --app-data-dir=antigravity-ide',
  )
  assert.deepEqual(candidate, {
    port: 43123, csrfToken: 'abcdefghijklmnop', app: 'antigravity-ide',
  })
  const metadata = extractGeneratorMetadata({ response: { generatorMetadata: [null, {
    chatModel: { usage: {
      model: 'internal', inputTokens: '100', outputTokens: '30',
      responseOutputTokens: '20', thinkingOutputTokens: '10', responseId: 'r1',
    } },
  }] } })
  assert.equal(metadata.length, 1)
  const records = recordsFromGeneratorMetadata(
    'cascade', metadata, { internal: 'gemini-3-pro' }, '2026-07-15T12:00:00.000Z',
  )
  assert.equal(records[0]?.dedup_key, 'antigravity:cascade:r1')
  assert.equal(records[0]?.reasoning_tokens, 10)
})

test('Antigravity warning budget bounds details and reports suppressed totals', () => {
  const output: string[] = []
  const warnings = createAntigravityWarningBudget(message => output.push(message), 2)
  for (const id of ['one', 'two', 'three', 'four']) warnings.missingMetadata(id)
  for (const id of ['cache-one', 'cache-two', 'cache-three']) warnings.cacheFallback(id)
  warnings.flush()
  assert.deepEqual(output, [
    '  antigravity: no readable metadata for one',
    '  antigravity: no readable metadata for two',
    '  antigravity: RPC unavailable; using Tokember cache for cache-one',
    '  antigravity: RPC unavailable; using Tokember cache for cache-two',
    '  antigravity: suppressed 2 additional no-readable-metadata warning(s)',
    '  antigravity: suppressed 1 additional cache-fallback warning(s)',
  ])
})

test('native adapter discovers and parses current Antigravity SQLite sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-burn-antigravity-'))
  const previousHome = process.env.ANTIGRAVITY_HOME
  const previousCache = process.env.AI_BURN_CACHE_DIR
  process.env.ANTIGRAVITY_HOME = directory
  process.env.AI_BURN_CACHE_DIR = join(directory, 'cache')
  try {
    const conversations = join(directory, 'antigravity-cli', 'conversations')
    await mkdir(conversations, { recursive: true })
    await writeFile(join(conversations, 'ignored.txt'), '')
    const dbPath = join(conversations, 'cascade.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, metadataFixture())
    db.close()

    const sources = await discoverAntigravitySources([{
      dir: conversations, app: 'antigravity-cli', extensions: ['.db'],
    }])
    assert.deepEqual(sources, [{ path: dbPath, app: 'antigravity-cli' }])
    const records = await collectAntigravity()
    assert.equal(records.length, 1)
    assert.equal(records[0]?.model, 'gemini-3.1-pro-high')
    assert.equal(records[0]?.dedup_key, 'antigravity:cascade:response-1')
    const cache = JSON.parse(await readFile(
      join(directory, 'cache', 'antigravity-cache.json'), 'utf-8',
    )) as AntigravityCache
    assert.equal(cache.cascades.cascade.records.length, 1)
  } finally {
    if (previousHome == null) delete process.env.ANTIGRAVITY_HOME
    else process.env.ANTIGRAVITY_HOME = previousHome
    if (previousCache == null) delete process.env.AI_BURN_CACHE_DIR
    else process.env.AI_BURN_CACHE_DIR = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})

test('confirmed Antigravity state stays separate from parser cache on retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokember-antigravity-incremental-'))
  const previousHome = process.env.ANTIGRAVITY_HOME
  const previousCache = process.env.TOKEMBER_CACHE_DIR
  process.env.ANTIGRAVITY_HOME = directory
  process.env.TOKEMBER_CACHE_DIR = join(directory, 'cache')
  try {
    const conversations = join(directory, 'antigravity-cli', 'conversations')
    const dbPath = join(conversations, 'cascade.db')
    await mkdir(conversations, { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, metadataFixture())
    db.close()
    const first = await runIncrementalAntigravity(emptyIncrementalSourceState())
    const empty = await runIncrementalAntigravity(first.state)
    assert.deepEqual([first.records.length, empty.scanned], [1, 0])
    const future = new Date(Date.now() + 5_000)
    await utimes(dbPath, future, future)
    const unconfirmed = await runIncrementalAntigravity(empty.state)
    const replayedFromCache = await runIncrementalAntigravity(empty.state)
    assert.deepEqual(
      replayedFromCache.records.map(row => row.dedup_key),
      unconfirmed.records.map(row => row.dedup_key),
    )
    const confirmedEmpty = await runIncrementalAntigravity(unconfirmed.state)
    assert.equal(confirmedEmpty.scanned, 0)
  } finally {
    if (previousHome == null) delete process.env.ANTIGRAVITY_HOME
    else process.env.ANTIGRAVITY_HOME = previousHome
    if (previousCache == null) delete process.env.TOKEMBER_CACHE_DIR
    else process.env.TOKEMBER_CACHE_DIR = previousCache
    await rm(directory, { recursive: true, force: true })
  }
})
