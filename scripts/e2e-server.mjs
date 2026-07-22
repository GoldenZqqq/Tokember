import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateDir = join(root, '.tmp', 'e2e')
const dbPath = join(stateDir, 'tokember.db')
mkdirSync(stateDir, { recursive: true })
for (const suffix of ['', '-shm', '-wal']) rmSync(`${dbPath}${suffix}`, { force: true })

Object.assign(process.env, {
  PORT: '3157',
  DB_PATH: dbPath,
  NODE_ENV: 'development',
  TOKEMBER_API_KEY: 'e2e-write-key',
  TOKEMBER_ADMIN_PASSWORD: 'e2e-admin-password',
  TOKEMBER_VIEWER_PASSWORD: 'e2e-viewer-password',
  TOKEMBER_CORS_ORIGINS: 'http://127.0.0.1:4173',
  TOKEMBER_ALLOW_LEGACY_API_KEY: 'true',
})

await import('../server/src/index.ts')
