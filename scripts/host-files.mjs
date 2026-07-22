import { randomBytes } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function atomicWrite(path, content, mode) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(temporary, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  await chmod(temporary, mode)
  await rename(temporary, path)
}

export async function privilegedWrite(path, content, options) {
  const mode = options.mode ?? 0o644
  try {
    await atomicWrite(path, content, mode)
    return false
  } catch {
    const name = `.systemd-${process.pid}-${randomBytes(4).toString('hex')}.conf`
    const staged = join(options.appRoot, name)
    await atomicWrite(staged, content, 0o600)
    try {
      await options.run('sudo', ['install', '-d', '-m', '0755', dirname(path)])
      await options.run('sudo', ['install', '-m', mode.toString(8).padStart(4, '0'), staged, path])
      return true
    } finally {
      await rm(staged, { force: true })
    }
  }
}

export async function privilegedDirectory(path, options) {
  try {
    await mkdir(path, { recursive: true, mode: options.mode })
    await chmod(path, options.mode)
    return false
  } catch {
    await options.run('sudo', [
      'install', '-d', '-m', options.mode.toString(8).padStart(4, '0'), path,
    ])
    return true
  }
}
