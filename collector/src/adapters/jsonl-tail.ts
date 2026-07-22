import { createReadStream } from 'fs'

const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024

export interface JsonlTailResult {
  lines: string[]
  safe_offset_bytes: number
  bytes_read: number
  trailing_bytes: number
}

function assertOffset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('JSONL offset must be a non-negative integer')
  }
}

function lineText(value: Buffer): string {
  const withoutCarriageReturn = value.at(-1) === 0x0d
    ? value.subarray(0, value.length - 1)
    : value
  return withoutCarriageReturn.toString('utf-8')
}

export async function readJsonlTail(
  path: string,
  startOffset = 0,
): Promise<JsonlTailResult> {
  assertOffset(startOffset)
  const lines: string[] = []
  let pending = Buffer.alloc(0)
  let safeOffset = startOffset
  let bytesRead = 0
  const stream = createReadStream(path, { start: startOffset })

  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytesRead += chunk.length
      const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      let lineStart = 0
      for (let index = 0; index < data.length; index++) {
        if (data[index] !== 0x0a) continue
        lines.push(lineText(data.subarray(lineStart, index)))
        safeOffset += index - lineStart + 1
        lineStart = index + 1
      }
      pending = data.subarray(lineStart)
      if (pending.length > MAX_PENDING_LINE_BYTES) {
        throw new Error('JSONL line exceeds the supported size')
      }
    }
  } finally {
    stream.destroy()
  }

  return {
    lines,
    safe_offset_bytes: safeOffset,
    bytes_read: bytesRead,
    trailing_bytes: pending.length,
  }
}
