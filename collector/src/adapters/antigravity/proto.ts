// Adapted from getagentseal/codeburn's MIT-licensed Antigravity provider.
// This module keeps only the protobuf fields needed by Tokember UsageRecord.

import { basename } from 'path'

import { openReadOnly } from '../sqlite-util.js'
import type { UsageRecord } from '../types.js'
import { canonicalAntigravityModel } from './model.js'

interface ProtoField {
  number: number
  wireType: number
  value?: bigint
  bytes?: Uint8Array
}

interface ProtoVarint {
  value: bigint
  offset: number
}

export interface GenMetadataRow {
  idx: number
  data: Uint8Array | string
}

const decoder = new TextDecoder('utf-8', { fatal: false })

function readVarint(data: Uint8Array, start: number): ProtoVarint | null {
  let value = 0n
  let shift = 0n
  let offset = start
  while (offset < data.length) {
    const byte = BigInt(data[offset]!)
    offset += 1
    value |= (byte & 0x7fn) << shift
    if ((byte & 0x80n) === 0n) return { value, offset }
    shift += 7n
    if (shift > 70n) return null
  }
  return null
}

function parseFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < data.length) {
    const key = readVarint(data, offset)
    if (!key) break
    offset = key.offset
    const number = Number(key.value >> 3n)
    const wireType = Number(key.value & 0x7n)
    if (!Number.isSafeInteger(number) || number <= 0) break
    if (wireType === 0) {
      const item = readVarint(data, offset)
      if (!item) break
      fields.push({ number, wireType, value: item.value })
      offset = item.offset
      continue
    }
    const width = wireType === 1 ? 8 : wireType === 5 ? 4 : null
    if (width != null) {
      if (offset + width > data.length) break
      fields.push({ number, wireType, bytes: data.subarray(offset, offset + width) })
      offset += width
      continue
    }
    if (wireType !== 2) break
    const length = readVarint(data, offset)
    if (!length) break
    offset = length.offset
    const size = Number(length.value)
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length) break
    fields.push({ number, wireType, bytes: data.subarray(offset, offset + size) })
    offset += size
  }
  return fields
}

function field(fields: readonly ProtoField[], number: number): ProtoField | undefined {
  return fields.find(item => item.number === number)
}

function bytes(item: ProtoField | undefined): Uint8Array {
  return item?.bytes ?? new Uint8Array()
}

function text(item: ProtoField | undefined): string | undefined {
  if (!item?.bytes?.length) return undefined
  const value = decoder.decode(item.bytes)
  return value && !/[\u0000-\u0008\u000E-\u001F\u007F\uFFFD]/.test(value)
    ? value
    : undefined
}

function positiveInteger(item: ProtoField | undefined): number {
  const value = item?.value == null ? 0 : Number(item.value)
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

function metadataAttributes(chatFields: readonly ProtoField[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of chatFields.filter(candidate => candidate.number === 20)) {
    const pair = parseFields(bytes(item))
    const key = text(field(pair, 1))
    const value = text(field(pair, 2))
    if (key && value) result.set(key, value)
  }
  return result
}

function modelFromChat(chatFields: readonly ProtoField[]): string {
  const attributes = metadataAttributes(chatFields)
  const display = text(field(chatFields, 21))
  const raw = text(field(chatFields, 19)) ?? attributes.get('model_enum') ?? display ?? 'unknown'
  return canonicalAntigravityModel(raw, display)
}

function dataBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

export function recordFromGenMetadataRow(
  cascadeId: string,
  row: GenMetadataRow,
  fallbackTimestamp: string,
): UsageRecord | null {
  const root = parseFields(dataBytes(row.data))
  const chat = parseFields(bytes(field(root, 1)))
  const usage = parseFields(bytes(field(chat, 4)))
  if (usage.length === 0) return null
  const input = positiveInteger(field(usage, 2)) || positiveInteger(field(usage, 1))
  const totalOutput = positiveInteger(field(usage, 3))
  let output = positiveInteger(field(usage, 9))
  const reasoning = positiveInteger(field(usage, 10))
  if (output === 0 && reasoning === 0) output = totalOutput
  else if (totalOutput > 0 && output + reasoning !== totalOutput) {
    output = Math.max(0, totalOutput - reasoning)
  }
  if (input === 0 && totalOutput === 0) return null
  const candidateId = text(field(usage, 11))
  const responseId = candidateId && !/\s/.test(candidateId) ? candidateId : String(row.idx)
  return {
    provider: 'antigravity',
    model: modelFromChat(chat),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: reasoning,
    cost_usd: 0,
    timestamp: fallbackTimestamp,
    source_file: cascadeId,
    dedup_key: `antigravity:${cascadeId}:${responseId}`,
    attribution: { status: 'captured', session: cascadeId },
  }
}

export async function parseAntigravitySqlite(
  filePath: string,
  fallbackTimestamp: string,
): Promise<UsageRecord[]> {
  if (!filePath.toLowerCase().endsWith('.db')) return []
  const cascadeId = basename(filePath).replace(/\.db$/i, '')
  let handle
  try {
    handle = await openReadOnly(filePath)
    const rows = handle.db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx')
      .all() as unknown as GenMetadataRow[]
    const records = rows
      .map(row => recordFromGenMetadataRow(cascadeId, row, fallbackTimestamp))
      .filter((record): record is UsageRecord => record != null)
    return [...new Map(records.map(record => [record.dedup_key, record])).values()]
  } catch {
    return []
  } finally {
    await handle?.cleanup()
  }
}
