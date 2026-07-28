#!/usr/bin/env node
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const SUPPORTED_NODE_MAJOR = 22

function runtimeLabel(identity) {
  return `Node ${identity.nodeVersion} (ABI ${identity.moduleAbi}, ${identity.platform}/${identity.architecture})`
}

function remediation() {
  return 'Select Node 22 and run npm ci before retrying.'
}

export function currentRuntimeIdentity() {
  return {
    nodeVersion: process.version,
    moduleAbi: String(process.versions.modules ?? 'unknown'),
    platform: process.platform,
    architecture: process.arch,
  }
}

export function assertSupportedRuntime(identity) {
  const major = Number.parseInt(identity.nodeVersion.replace(/^v/, '').split('.')[0], 10)
  if (major !== SUPPORTED_NODE_MAJOR) {
    throw new Error(
      `runtime gate failed: Tokember supports Node 22.x; got ${runtimeLabel(identity)}. ${remediation()}`,
    )
  }
  return identity
}

export function verifyNativeRuntime(options = {}) {
  const identity = assertSupportedRuntime(options.identity ?? currentRuntimeIdentity())
  let database
  try {
    const Database = (options.loadDatabase ?? (() => require('better-sqlite3')))()
    database = new Database(':memory:')
    const row = database.prepare('SELECT 1 AS ok').get()
    if (row?.ok !== 1) throw new Error('unexpected native smoke result')
    database.close()
    return identity
  } catch {
    try { database?.close() } catch { /* keep the diagnostic fixed and path-free */ }
    throw new Error(
      `runtime gate failed: better-sqlite3 is not loadable with ${runtimeLabel(identity)}. ${remediation()}`,
    )
  }
}

function main() {
  const identity = verifyNativeRuntime()
  process.stdout.write(`runtime gate passed: ${runtimeLabel(identity)}\n`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
