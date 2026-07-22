import { randomUUID } from 'crypto'
import { mkdir, open, rename, unlink } from 'fs/promises'
import { dirname } from 'path'

type RenameFile = typeof rename

const REPLACE_ATTEMPTS = 6
const RETRYABLE_REPLACE_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM'])

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt))
}

async function replaceWithRetry(options: {
  temporary: string
  path: string
  renameFile: RenameFile
}): Promise<void> {
  for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
    try {
      await options.renameFile(options.temporary, options.path)
      return
    } catch (error) {
      const retryable = RETRYABLE_REPLACE_CODES.has(errorCode(error) ?? '')
      if (!retryable || attempt === REPLACE_ATTEMPTS - 1) throw error
      await retryDelay(attempt)
    }
  }
}

export async function atomicWriteText(
  path: string,
  contents: string,
  renameFile: RenameFile = rename,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await replaceWithRetry({ temporary, path, renameFile })
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
